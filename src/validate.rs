//! From syntax tree to static HTML IR, in three steps:
//!
//! 1. **Script and props.** Evaluate the script's build-time bindings in order, then each prop's
//!    default in the script's scope, then apply build-time prop values (`--props`).
//! 2. **Resolve** (static, every branch): every name in every `{…}` must refer to a loop
//!    variable, a prop or a script binding — checked even in branches this build won't render,
//!    so a typo can't hide behind a condition. Literal URLs are checked here too.
//! 3. **Lower** (evaluate, taken branches only): conditions pick a branch, loops expand, slots
//!    fill, and dynamic values are escaped and safety-checked.
//!
//! Inside the template, names resolve innermost-first: loop variables, then props, then script
//! bindings. So in `<zb-header title={title}><h1>{title}</h1>`, `{title}` is the *prop* (which
//! defaults to the script's `title`), and a build-time override reaches the template.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::{
    ast::{self, AttributeValue, Part as AstPart, PropDefault},
    diagnostic::{Diagnostic, Span},
    expression::{self, Expression},
    ir::{self, Node, Part},
};

pub(crate) const URL_ATTRIBUTES: &[&str] = &[
    "action",
    "background",
    "cite",
    "codebase",
    "data",
    "formaction",
    "href",
    "longdesc",
    "manifest",
    "poster",
    "profile",
    "src",
    "xlink:href",
    "usemap",
];
pub(crate) const BOOLEAN_ATTRIBUTES: &[&str] = &[
    "allowfullscreen",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "controls",
    "default",
    "defer",
    "disabled",
    "formnovalidate",
    "hidden",
    "inert",
    "ismap",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "selected",
];
const RESERVED_CUSTOM_ELEMENTS: &[&str] = &[
    "annotation-xml",
    "color-profile",
    "font-face",
    "font-face-src",
    "font-face-uri",
    "font-face-format",
    "font-face-name",
    "missing-glyph",
];

/// A script binding as the build sees it.
#[derive(Clone, Debug)]
enum Local<'v> {
    /// Borrowed when it is a prop's value, or a path into one (`const sorted = … : rows`).
    Value(Cow<'v, Value>),
    /// An arrow function the server can call (`const money = (cents) => …`).
    Function(crate::pure::Val),
    /// Declared, but its value only exists at runtime (a function, an import, a call result…).
    Runtime,
}

/// Markers in the template's name scopes, naming the directive that pushed each.
const SCOPE_EACH: &str = "#each";
const SCOPE_THEN: &str = "#then";
const SCOPE_CATCH: &str = "#catch";

struct Prop<'t> {
    /// Borrowed from the component's declaration, as the attribute is unless it differs.
    name: &'t str,
    attribute: Cow<'t, str>,
    default: Option<Value>,
    value: Value,
    /// Partial rendering: the value is computed in the browser.
    unknown: bool,
}

thread_local! {
    /// Partial rendering: what only the browser can compute is left for it (see
    /// [`validate_partial`]).
    static PARTIAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn partial() -> bool {
    PARTIAL.with(std::cell::Cell::get)
}

thread_local! {
    /// URLs and srcsets from values that a render left out because they weren't safe, said in a
    /// sentence each, for the server to warn about (`take_omitted`).
    static OMITTED: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Note an attribute left out of the HTML because its value wasn't a safe URL. Only the start of
/// the value is kept (enough to recognise `data:` or `javascript:`): it may be a user's.
fn omit_unsafe(attribute: &str, value: &str) {
    let start: String = value.trim_start().chars().take(24).collect();
    let more = if value.trim_start().chars().count() > 24 {
        "…"
    } else {
        ""
    };
    OMITTED.with(|omitted| {
        omitted.borrow_mut().push(format!(
            "left `{attribute}` out of the HTML: its value isn't a safe URL (`{start}{more}`)"
        ));
    });
}

/// Note a spread key left out of the HTML because it can't be an attribute (or CSS property)
/// name: it's a value's key, maybe a user's, and written raw it would be markup.
/// What a spread leaves out of an element, as data, though the template could write it:
/// an animation's values and target (`<set attributeName="href" to="javascript:…">` is a link to
/// a URL nothing checks), and a `<meta>`'s `http-equiv` (a refresh is a redirect to anywhere).
pub(crate) fn spread_never_sets(tag: &str, name: &str) -> bool {
    let tag = tag.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    (matches!(
        tag.as_str(),
        "set" | "animate" | "animatemotion" | "animatetransform"
    ) && matches!(
        name.as_str(),
        "to" | "from" | "by" | "values" | "attributename"
    )) || (tag == "meta" && name == "http-equiv")
}

/// Note a spread's `style` property left out of the HTML because its value isn't a single CSS
/// value (`red;}` would end the declaration, a nested object isn't one).
fn omit_css_value(property: &str, value: &Value) {
    let text = value.to_string();
    let start: String = text.chars().take(24).collect();
    let more = if text.chars().count() > 24 { "…" } else { "" };
    OMITTED.with(|omitted| {
        omitted.borrow_mut().push(format!(
            "left the spread's `style` property `{property}` out of the HTML: its value isn't a single CSS value (`{start}{more}`)"
        ));
    });
}

fn omit_name(what: &str, key: &str) {
    let start: String = key.chars().take(24).collect();
    let more = if key.chars().count() > 24 { "…" } else { "" };
    OMITTED.with(|omitted| {
        omitted.borrow_mut().push(format!(
            "left the spread's key `{start}{more}` out of the HTML: it isn't {what}"
        ));
    });
}

/// An attribute name a spread may write: a letter, `_` or `:` first, then letters, digits and
/// `_ . : -` (XML's names, which every HTML attribute fits).
fn is_attribute_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == ':')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// A CSS property name a spread's `style` may write: a custom property (`--x`) or letters and
/// hyphens after a letter.
fn is_css_property_name(name: &str) -> bool {
    if let Some(custom) = name.strip_prefix("--") {
        return !custom.is_empty()
            && custom
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    }
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// What renders since the last call left out (see `omit_unsafe`), emptying the list.
pub fn take_omitted() -> Vec<String> {
    OMITTED.with(|omitted| std::mem::take(&mut *omitted.borrow_mut()))
}

/// A place partial rendering left for the browser, and, for an attribute, which one.
/// A place partial rendering leaves for the browser: where, the attribute (if it's one), and,
/// for a gap inside a child component, the child's tag, file and where in it (the span is then
/// the child's tag in the parent).
pub type Gap = (Span, Option<String>, Option<ChildGap>);

#[derive(Clone, Debug, PartialEq)]
pub struct ChildGap {
    pub tag: String,
    pub path: String,
    pub span: Span,
}

thread_local! {
    /// While `zubra check --server` runs: where partial rendering left something for the browser,
    /// and, for an attribute, which one.
    static GAPS: std::cell::RefCell<Option<Vec<Gap>>> = const { std::cell::RefCell::new(None) };
}

thread_local! {
    /// Server ids (`id()`): how many hosts of each tag this render has given a base, and the
    /// prefix for this render (`idPrefix`, so separate renders on one page don't collide).
    static ID_COUNTS: std::cell::RefCell<HashMap<String, usize>> = std::cell::RefCell::new(HashMap::new());
    static ID_PREFIX: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
    /// Context values the components being rendered provide, by context key, innermost last.
    static PROVIDED: std::cell::RefCell<Vec<(String, Value)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Run `render` with `prefix` before every id base it gives a host (`r2-` makes `r2-zb-field-s1`).
pub fn with_id_prefix<T>(prefix: &str, render: impl FnOnce() -> T) -> T {
    let previous = ID_PREFIX.with(|current| current.replace(prefix.to_owned()));
    let result = render();
    ID_PREFIX.with(|current| current.replace(previous));
    result
}

/// Run `render` with `values` (context key → value) already provided, as if a component above
/// everything rendered provided them: a page's values (`@zubra/server`'s `page.provide()`).
pub fn with_provided<T>(values: Vec<(String, Value)>, render: impl FnOnce() -> T) -> T {
    let count = values.len();
    PROVIDED.with(|provided| provided.borrow_mut().extend(values));
    let result = render();
    PROVIDED.with(|provided| {
        let mut provided = provided.borrow_mut();
        let keep = provided.len() - count;
        provided.truncate(keep);
    });
    result
}

/// The next id base for a host of `tag` in this render: `<prefix><tag>-s<n>`, in document order.
/// The `s` keeps them apart from the bases the element counts itself (`<tag>-<n>`), for
/// elements made in the browser.
fn next_id_base(tag: &str) -> String {
    let n = ID_COUNTS.with(|counts| {
        let mut counts = counts.borrow_mut();
        let count = counts.entry(tag.to_owned()).or_insert(0);
        *count += 1;
        *count
    });
    let prefix = ID_PREFIX.with(|prefix| prefix.borrow().clone());
    format!("{prefix}{tag}-s{n}")
}

thread_local! {
    /// Which of GAPS the latest gap was (a list row repeats the same one).
    static LAST_GAP: std::cell::Cell<usize> = const { std::cell::Cell::new(usize::MAX) };
}

fn gap(span: Span) {
    GAPS.with(|gaps| {
        if let Some(gaps) = gaps.borrow_mut().as_mut() {
            let at = gaps
                .iter()
                .position(|(at, _, child)| *at == span && child.is_none())
                .unwrap_or_else(|| {
                    gaps.push((span, None, None));
                    gaps.len() - 1
                });
            LAST_GAP.with(|last| last.set(at));
        }
    });
}

/// The latest gap was this attribute's value.
fn gap_attribute(name: &str) {
    GAPS.with(|gaps| {
        let at = LAST_GAP.with(std::cell::Cell::get);
        if let Some((_, attribute, _)) =
            gaps.borrow_mut().as_mut().and_then(|gaps| gaps.get_mut(at))
        {
            attribute.get_or_insert_with(|| name.to_owned());
        }
    });
}

/// A child component's gaps, reported at its tag in the parent (`at`), each saying where in the
/// child it is. Its own child components' gaps keep the file they're in.
fn gaps_in_child(at: Span, tag: &str, path: &str, found: Vec<Gap>) {
    for (span, attribute, inner) in found {
        let child = inner.unwrap_or(ChildGap {
            tag: tag.to_owned(),
            path: path.to_owned(),
            span,
        });
        GAPS.with(|gaps| {
            if let Some(gaps) = gaps.borrow_mut().as_mut() {
                let entry = (at, attribute, Some(child));
                if !gaps.contains(&entry) {
                    gaps.push(entry);
                }
            }
        });
    }
}

/// Run `render` (a partial HTML render) recording what it leaves for the browser.
pub fn record_gaps<T>(render: impl FnOnce() -> T) -> (T, Vec<Gap>) {
    let previous = GAPS.with(|gaps| gaps.replace(Some(Vec::new())));
    let result = render();
    let gaps = GAPS.with(|gaps| gaps.replace(previous)).unwrap_or_default();
    (result, gaps)
}

thread_local! {
    /// Props a streaming server hasn't got values for yet: rendered as unknown (see `pending`).
    static PENDING: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Set the pending props for the renders that follow (returns the previous list, to restore).
pub fn set_pending(names: Vec<String>) -> Vec<String> {
    PENDING.with(|pending| pending.replace(names))
}

fn pending(name: &str) -> bool {
    PENDING.with(|pending| pending.borrow().iter().any(|pending| pending == name))
}

/// Like [`validate`], but what only the browser can compute (runtime-only values, JavaScript
/// expressions, defaults computed in the browser) is left for the element instead of being an
/// error: text renders empty, attributes are left out, and conditionals and lists render as
/// empty regions marked `<?zb [??>`, which the element fills when it starts.
pub fn validate_partial<'t>(
    component: &'t ast::ComponentAst,
    values: Value,
    slot_values: &'t HashMap<String, Vec<ast::Node>>,
    slots_rendered: bool,
) -> Result<ir::Component<'t>, Diagnostic> {
    let previous = PARTIAL.with(|flag| flag.replace(true));
    let result = validate(component, values, slot_values, slots_rendered);
    PARTIAL.with(|flag| flag.set(previous));
    result
}

/// `slots_rendered`: the slot content is HTML a server already rendered (`slotSource: "html"`),
/// kept as written: a tag in it is never expanded as one of this component's children, at any
/// depth, as it was rendered already (a router's page, put in its layout's slot).
pub fn validate<'t>(
    component: &'t ast::ComponentAst,
    values: Value,
    slot_values: &'t HashMap<String, Vec<ast::Node>>,
    slots_rendered: bool,
) -> Result<ir::Component<'t>, Diagnostic> {
    // The props are moved into the render, not copied: a list of rows is the bulk of a request.
    let Value::Object(overrides) = values else {
        return Err(Diagnostic::new(
            crate::codes::PROPS_NOT_OBJECT,
            Span::new(1, 1),
            "component props must be a JSON object",
        ));
    };
    // Each render numbers its hosts' id bases from 1.
    ID_COUNTS.with(|counts| counts.borrow_mut().clear());
    let supply = if slots_rendered {
        Supply::Rendered(slot_values)
    } else {
        Supply::Templates(slot_values)
    };
    lower_component(component, overrides, &supply, None)
}

/// [`analyze`] for a child component, worked out once for as long as its tree is kept however
/// many times the child is used (a badge in every row of a table, on every render).
fn interface_of(child: &ast::ChildComponent) -> Result<std::rc::Rc<Interface>, Diagnostic> {
    if let Some(found) = child.interface.0.get() {
        return Ok(std::rc::Rc::clone(found));
    }
    let interface = std::rc::Rc::new(analyze(&child.ast)?);
    Ok(std::rc::Rc::clone(
        child.interface.0.get_or_init(|| interface),
    ))
}

/// Content supplied to a component's slots: template fragments (`--slots`), lowered in the
/// component's own scope, or nodes a parent component already lowered in *its* scope.
enum Supply<'a> {
    Templates(&'a HashMap<String, Vec<ast::Node>>),
    /// As `Templates`, for HTML a server already rendered: lowered without expanding any tag as a
    /// child component (it was expanded when it was rendered).
    Rendered(&'a HashMap<String, Vec<ast::Node>>),
    Lowered(HashMap<String, Vec<Node<'a>>>),
}

impl Supply<'_> {
    fn names(&self) -> Vec<&String> {
        match self {
            Supply::Templates(map) | Supply::Rendered(map) => map.keys().collect(),
            Supply::Lowered(map) => map.keys().collect(),
        }
    }

    /// Whether content was given for slot `name`, as the element's `hasSlot` decides: an element,
    /// or text that isn't only whitespace. Anything computed counts as content (it usually is).
    fn filled(&self, name: &str) -> bool {
        fn template(nodes: &[ast::Node]) -> bool {
            nodes.iter().any(|node| match node {
                ast::Node::Text(parts) => parts.iter().any(|part| match part {
                    ast::Part::Literal(text) => !text.trim().is_empty(),
                    ast::Part::Expression { .. } => true,
                }),
                _ => true,
            })
        }
        fn lowered(nodes: &[Node<'_>]) -> bool {
            nodes.iter().any(|node| match node {
                Node::Element(_) => true,
                Node::Text(parts) => parts.iter().any(|part| match part {
                    ir::Part::Literal(text) => !text.trim().is_empty(),
                    ir::Part::Escaped(text) => !text.trim().is_empty(),
                }),
                _ => false,
            })
        }
        match self {
            Supply::Templates(map) | Supply::Rendered(map) => {
                map.get(name).is_some_and(|nodes| template(nodes))
            }
            Supply::Lowered(map) => map.get(name).is_some_and(|nodes| lowered(nodes)),
        }
    }
}

fn lower_component<'t>(
    component: &'t ast::ComponentAst,
    overrides: serde_json::Map<String, Value>,
    supply: &Supply<'t>,
    host_id: Option<&str>,
) -> Result<ir::Component<'t>, Diagnostic> {
    validate_custom_element(&component.tag, component.tag_span)?;
    // `const inputId = id()`: the element's ids start from the host's own `id`, or a base the
    // server gives it and writes on the host (`data-zb-id`), which the element then uses.
    let id_base = component
        .script
        .server_ids
        .then(|| host_id.map_or_else(|| next_id_base(&component.tag), str::to_owned));
    // What the server knows that the script computes by a call: ids (`id()`) and the context
    // values components above provide (`inject()`), or a context's default. Unknown: the browser's.
    let mut known: HashMap<String, Option<Value>> = HashMap::new();
    // The values that came from a provider, by the inject call's number, for the host
    // (`data-zb-inject`): the element starts from them, so it doesn't show the default first.
    let mut injected = serde_json::Map::new();
    let mut inject_number = 0;
    // `const hasFooter = hasSlot('footer')`: whether content was given for that slot. The ones
    // that were go on the host (`data-zb-filled`), so the element starts from the same answer
    // and keeps the markup instead of removing it before it has seen its slotted content.
    let mut filled: Vec<&str> = Vec::new();
    for (binding, slot) in &component.script.has_slot {
        let answer = supply.filled(slot);
        if answer && !filled.contains(&slot.as_str()) {
            filled.push(slot);
        }
        known.insert(binding.clone(), Some(Value::Bool(answer)));
    }
    for binding in &component.script.bindings {
        if let Some(k) = binding.id_call {
            known.insert(
                binding.name.clone(),
                id_base
                    .as_ref()
                    .map(|base| Value::String(format!("{base}-{k}"))),
            );
        }
        if let Some(local) = &binding.inject {
            inject_number += 1;
            let context = component
                .contexts
                .iter()
                .find(|context| &context.local == local);
            let provided = context.and_then(|context| {
                PROVIDED.with(|provided| {
                    provided
                        .borrow()
                        .iter()
                        .rev()
                        .find(|(key, _)| key == &context.key)
                        .map(|(_, value)| value.clone())
                })
            });
            if let Some(value) = &provided {
                injected.insert(inject_number.to_string(), value.clone());
            }
            known.insert(
                binding.name.clone(),
                provided.or_else(|| context.and_then(|context| context.default.clone())),
            );
        }
    }

    let prop_names: Vec<&str> = component
        .props
        .iter()
        .map(|prop| prop.name.as_str())
        .collect();
    // Defaults first (they can use script bindings), then the script with the props' values.
    let defaults = evaluate_script_with(&component.script, &prop_names, None, &known)?;
    let props = evaluate_props(component, &defaults, overrides)?;
    let locals = evaluate_script_with(&component.script, &prop_names, Some(&props), &known)?;
    // What this component provides, for the components rendered inside it (not for itself, as
    // with the Context Protocol), when the server can evaluate the value.
    let mut pushed = 0;
    for (local, source) in &component.script.provides {
        let Some(context) = component
            .contexts
            .iter()
            .find(|context| &context.local == local)
        else {
            continue;
        };
        let lookup = |name: &str| match find_local(&locals, name) {
            Some(Local::Value(value)) => Some(crate::pure::Val::Json(Value::clone(value))),
            Some(Local::Function(function)) => Some(function.clone()),
            Some(Local::Runtime) => None,
            None => props
                .iter()
                .find(|prop| prop.name == name && !prop.unknown)
                .map(|prop| crate::pure::Val::Json(prop.value.clone())),
        };
        if let Ok(value) =
            crate::pure::evaluate(source, &lookup).and_then(crate::pure::Val::into_json)
        {
            PROVIDED.with(|provided| provided.borrow_mut().push((context.key.clone(), value)));
            pushed += 1;
        }
    }
    let lowered = lower_rest(
        component,
        &props,
        &locals,
        supply,
        id_base.as_ref(),
        host_id,
        filled,
    );
    PROVIDED.with(|provided| {
        let mut provided = provided.borrow_mut();
        let keep = provided.len() - pushed;
        provided.truncate(keep);
    });
    lowered.map(|mut lowered| {
        if !injected.is_empty() {
            lowered.host_attributes.push((
                Cow::Borrowed("data-zb-inject"),
                Value::Object(injected).to_string(),
            ));
        }
        lowered
    })
}

/// The rest of [`lower_component`], once the script is evaluated (and its context provided).
fn lower_rest<'t>(
    component: &'t ast::ComponentAst,
    props: &[Prop<'t>],
    locals: &[(&'t str, Local<'_>)],
    supply: &Supply<'t>,
    id_base: Option<&String>,
    host_id: Option<&str>,
    filled: Vec<&str>,
) -> Result<ir::Component<'t>, Diagnostic> {
    let context = Context {
        component,
        locals,
        props,
        supply,
        shadow: component.shadow,
    };

    // 2. Resolve everything, including branches and slots this build won't render.
    let mut declared_slots = HashSet::new();
    collect_slots(&component.nodes, &mut declared_slots);
    for name in supply.names() {
        if !declared_slots.contains(name) {
            return Err(Diagnostic::new(
                crate::codes::UNKNOWN_SLOT,
                Span::new(1, 1),
                format!("slot `{name}` is not declared by this component"),
            ));
        }
    }
    let mut scopes = Vec::new();
    // Whether the template's names resolve depends on the template and on the names in scope,
    // not on their values: once it has passed with these names, it passes with them again.
    // (A component's names are the same for every render; the check is that they are.)
    let in_scope = || {
        props
            .iter()
            .map(|prop| prop.name)
            .chain(locals.iter().map(|(name, _)| *name))
    };
    let passed = component
        .resolved
        .0
        .get()
        .is_some_and(|names| names.iter().map(String::as_str).eq(in_scope()));
    if !passed {
        context.resolve_nodes(&component.nodes, &mut scopes)?;
        let _ = component
            .resolved
            .0
            .set(in_scope().map(str::to_owned).collect());
    }
    if let Supply::Templates(templates) | Supply::Rendered(templates) = supply {
        for nodes in templates.values() {
            context.resolve_nodes(nodes, &mut scopes)?;
        }
    }

    // 3. Lower the branches that are taken.
    let mut state = LowerState::default();
    let mut nodes = context.lower_nodes(&component.nodes, &mut state)?;
    // A shadow component's styles go in its declarative shadow root (nothing else can style it
    // before its JavaScript runs); a light-DOM component's go in the page (`--emit css`).
    if let Some(style) = &component.style {
        if let Some(lang) = &style.lang {
            return Err(Diagnostic::new(crate::codes::STYLE_LANG_NEEDS_BUNDLER,
                style.span,
                format!("`<style lang=\"{lang}\">` needs a bundler to compile it: use @zubra/unplugin (Vite)"),
            ));
        }
        if component.shadow {
            let css = crate::styles::stylesheet(component).unwrap_or_default();
            nodes.insert(
                0,
                Node::Element(ir::Element {
                    name: Cow::Borrowed("style"),
                    attributes: vec![ir::Attribute {
                        name: Cow::Borrowed("data-zubra"),
                        value: None,
                    }],
                    children: vec![Node::Text(Part::Literal(Cow::Owned(css)).into())],
                }),
            );
        }
    }
    let light_children = std::mem::take(&mut state.light);

    let mut host_attributes: Vec<(Cow<'t, str>, String)> = props
        .iter()
        .filter(|prop| !prop.unknown && prop.default.as_ref() != Some(&prop.value))
        .filter_map(|prop| host_attribute(prop).map(|value| (prop.attribute.clone(), value)))
        .collect();
    if let (Some(base), None) = (id_base, host_id) {
        host_attributes.push((Cow::Borrowed("data-zb-id"), base.clone()));
    }
    // The slots that were given content (`data-zb-filled`): the ones `hasSlot` asked about, for
    // either kind of component. A light-DOM component with slots names every one, and has the
    // attribute with none filled too: its children are then the server's markup for sure, where
    // children shaped like its template could be the page's own content for a slot. The element
    // goes by it when the markup's markers were stripped.
    let mut filled = filled;
    let mut rest: Vec<&str> = Vec::new();
    if !component.shadow {
        rest = declared_slots
            .iter()
            .map(String::as_str)
            .filter(|slot| !filled.contains(slot) && supply.filled(slot))
            .collect();
        rest.sort_unstable();
    }
    filled.extend(rest);
    if !filled.is_empty() || (!component.shadow && !declared_slots.is_empty()) {
        host_attributes.push((Cow::Borrowed("data-zb-filled"), filled.join(" ")));
    }

    Ok(ir::Component {
        tag: component.tag.clone(),
        shadow: component.shadow,
        host_attributes,
        nodes,
        light_children,
    })
}

/// What the JavaScript backend needs: the prop interface and the script's names, after the
/// same script evaluation and resolver checks the HTML backend runs.
/// A prop's TypeScript type, when the component says it: `@prop {T} value` in its description;
/// `declare const value: T`; `value={initial}` where `const initial: T = …`; or
/// `size={Size.Small}`, a member of the script's enum `Size`.
pub(crate) fn declared_type(component: &crate::ast::ComponentAst, prop: &str) -> Option<String> {
    // The description's: `@prop {Type} name`.
    if let Some(text) = component
        .prop_docs
        .iter()
        .find(|doc| doc.name == prop)
        .and_then(|doc| doc.declared.as_ref())
    {
        return Some(text.clone());
    }
    if let Some((_, text, _)) = component
        .script
        .prop_types
        .iter()
        .find(|(name, _, _)| name == prop)
    {
        return Some(text.clone());
    }
    let declaration = component
        .props
        .iter()
        .find(|declaration| declaration.name == prop)?;
    match &declaration.default {
        PropDefault::Expression(expression::Expression::Identifier(name), _) => {
            component.script.declared_types.get(name).cloned()
        }
        PropDefault::Expression(expression::Expression::Member { object, .. }, _) => {
            match object.as_ref() {
                expression::Expression::Identifier(name)
                    if component
                        .script
                        .enums
                        .iter()
                        .any(|info| &info.name == name && !info.declared) =>
                {
                    Some(name.clone())
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// The enum a prop's type is, when it's exactly one of the script's (`size: Size`).
pub(crate) fn prop_enum<'c>(
    component: &'c crate::ast::ComponentAst,
    prop: &str,
) -> Option<&'c crate::enums::EnumInfo> {
    let declared = declared_type(component, prop)?;
    let name = declared.trim();
    // Merged declarations: the last one has every member's value in `members` of its own, so
    // put them together.
    component
        .script
        .enums
        .iter()
        .rev()
        .find(|info| info.name == name && !info.declared)
}

/// Every member of the script's enum `name`, across merged declarations.
pub(crate) fn enum_members(
    component: &crate::ast::ComponentAst,
    name: &str,
) -> Vec<(String, Option<crate::enums::EnumValue>)> {
    component
        .script
        .enums
        .iter()
        .filter(|info| info.name == name && !info.declared)
        .flat_map(|info| info.members.iter().cloned())
        .collect()
}

/// Attribute text for an enum prop: a member whose value prints as `raw` (`"4"`, `"large"`), or
/// failing that, the member named `raw` (`"Large"`). `None` when it's neither.
pub(crate) fn enum_value(
    members: &[(String, Option<crate::enums::EnumValue>)],
    raw: &str,
) -> Option<Value> {
    let to_value = |value: &crate::enums::EnumValue| match value {
        crate::enums::EnumValue::Number(number) => {
            serde_json::Number::from_f64(*number).map_or(Value::Null, Value::Number)
        }
        crate::enums::EnumValue::String(text) => Value::String(text.clone()),
    };
    let printed = |value: &crate::enums::EnumValue| match value {
        crate::enums::EnumValue::Number(number) => crate::enums::js_number(*number),
        crate::enums::EnumValue::String(text) => text.clone(),
    };
    members
        .iter()
        .filter_map(|(_, value)| value.as_ref())
        .find(|value| printed(value) == raw)
        .or_else(|| {
            members
                .iter()
                .find(|(name, _)| name == raw)
                .and_then(|(_, value)| value.as_ref())
        })
        .map(to_value)
}

/// The enum members a prop's attribute accepts, as a JavaScript object literal
/// (`{ Small: 0, Large: 4 }`): what the runtime and `--emit element` parse attributes with.
pub(crate) fn enum_literal(component: &crate::ast::ComponentAst, prop: &str) -> Option<String> {
    let info = prop_enum(component, prop)?;
    let entries: Vec<String> = enum_members(component, &info.name)
        .iter()
        .filter_map(|(name, value)| {
            Some(format!(
                "{}: {}",
                crate::enums::member_key(name),
                value.as_ref()?.literal()
            ))
        })
        .collect();
    Some(format!("{{ {} }}", entries.join(", ")))
}

/// A prop typed with an enum the module doesn't export: consumers can't name its values. With
/// a string member that's an error (TypeScript accepts no string where the enum is expected);
/// with only numbers, a warning (numbers still type-check). `(diagnostic, is_error)`.
pub(crate) fn enum_props(component: &crate::ast::ComponentAst) -> Vec<(Diagnostic, bool)> {
    let mut found = Vec::new();
    for prop in &component.props {
        let Some(declared) = declared_type(component, &prop.name) else {
            continue;
        };
        let words: Vec<&str> = declared
            .split(|character: char| {
                !(character.is_alphanumeric() || character == '_' || character == '$')
            })
            .collect();
        let mut seen = Vec::new();
        // (An imported enum is exported by the module it comes from.)
        for info in component
            .script
            .enums
            .iter()
            .filter(|info| !info.declared && info.origin.is_none())
        {
            if info.exported
                || !words.contains(&info.name.as_str())
                || seen.contains(&info.name)
                || component
                    .script
                    .enums
                    .iter()
                    .any(|other| other.name == info.name && other.exported)
            {
                continue;
            }
            seen.push(info.name.clone());
            let members = enum_members(component, &info.name);
            let strings = members
                .iter()
                .any(|(_, value)| !matches!(value, Some(crate::enums::EnumValue::Number(_))));
            let diagnostic = Diagnostic::new(crate::codes::PROP_ENUM_NOT_EXPORTED,
                prop.span,
                if strings {
                    format!(
                        "prop `{}` is typed with the enum `{}`, which the component doesn't export, so no consumer can pass a value TypeScript accepts",
                        prop.name, info.name
                    )
                } else {
                    format!(
                        "prop `{}` is typed with the enum `{}`, which the component doesn't export: consumers can pass numbers, but not `{}.<member>`",
                        prop.name, info.name, info.name
                    )
                },
            )
            .with_help(format!("write `export enum {}`", info.name));
            found.push((diagnostic, strings));
        }
    }
    found
}

pub struct Interface {
    pub props: Vec<PropInterface>,
    /// The events the component fires (see [`crate::events`]).
    pub events: Vec<crate::events::EventInterface>,
    /// The description comment without its `@fires` lines.
    pub description: Option<String>,
    /// Every name the script declares (build-time and runtime-only).
    pub script_names: Vec<String>,
}

pub struct PropInterface {
    pub name: String,
    /// The TypeScript type, when the component declares it (see [`declared_type`]).
    pub declared: Option<String>,
    /// What the prop is for: the text of its `@prop` line in the description.
    pub description: Option<String>,
    pub attribute: String,
    /// `None` for a required prop, or one whose default is only known at runtime.
    pub default: Option<Value>,
    /// A default computed in the browser (it uses script names that only exist there).
    pub runtime_default: Option<expression::Expression>,
    /// Two-way (`value:model`): assigning it inside the component fires `<prop>change`.
    pub model: bool,
}

impl Interface {
    /// A two-way prop's `<prop>change` event carries the prop's type.
    fn with_model_events(mut self) -> Self {
        for prop in self.props.iter().filter(|prop| prop.model) {
            let name = format!("{}change", prop.name.to_ascii_lowercase());
            let detail = crate::emit_interface::prop_type(prop);
            // (Unless the description says what it carries: `@fires {Type} valuechange`.)
            if let Some(event) = self
                .events
                .iter_mut()
                .find(|event| event.name == name && !event.declared)
            {
                event.detail = detail;
            }
        }
        self
    }
}

impl PropInterface {
    pub fn required(&self) -> bool {
        self.default.is_none() && self.runtime_default.is_none()
    }
}

pub fn analyze(component: &ast::ComponentAst) -> Result<Interface, Diagnostic> {
    validate_custom_element(&component.tag, component.tag_span)?;
    let prop_names: Vec<&str> = component
        .props
        .iter()
        .map(|prop| prop.name.as_str())
        .collect();
    let locals = evaluate_script_with(&component.script, &prop_names, None, &HashMap::new())?;
    let mut props = Vec::new();
    let mut runtime_defaults = HashSet::new();
    for declaration in &component.props {
        if props
            .iter()
            .any(|prop: &Prop| prop.name == declaration.name)
        {
            return Err(Diagnostic::new(
                crate::codes::DUPLICATE_PROP,
                declaration.span,
                format!("duplicate prop `{}`", declaration.name),
            ));
        }
        let default = match prop_default(declaration, &locals)? {
            None => None,
            Some(Ok(value)) => Some(value),
            // Computed in the browser, per element, after the script runs.
            Some(Err(_)) => {
                runtime_defaults.insert(declaration.name.clone());
                None
            }
        };
        props.push(Prop {
            name: &declaration.name,
            attribute: kebab_cow(&declaration.name),
            value: default.clone().unwrap_or(Value::Null),
            default,
            unknown: false,
        });
    }
    let templates = HashMap::new();
    let supply = Supply::Templates(&templates);
    let context = Context {
        component,
        locals: &locals,
        props: &props,
        supply: &supply,
        shadow: component.shadow,
    };
    context.resolve_nodes(&component.nodes, &mut Vec::new())?;
    for (name, _, span) in &component.script.prop_types {
        if !props.iter().any(|prop| prop.name == name) {
            let names: Vec<&str> = props.iter().map(|prop| prop.name).collect();
            return Err(with_suggestion(
                Diagnostic::new(crate::codes::DECLARE_CONST_NO_PROP, *span, format!("`declare const {name}` types a prop, but there's no prop `{name}` on the host tag")),
                name,
                &names,
            ));
        }
    }
    if let Some((error, _)) = enum_props(component).into_iter().find(|(_, error)| *error) {
        return Err(error);
    }
    let (events, description) = crate::events::events(component)?;
    Ok(Interface {
        events,
        description,
        props: props
            .into_iter()
            .map(|prop| {
                let declared = declared_type(component, prop.name);
                let runtime_default = runtime_defaults
                    .contains(prop.name)
                    .then(|| {
                        component
                            .props
                            .iter()
                            .find(|declaration| declaration.name == prop.name)
                            .and_then(|declaration| match &declaration.default {
                                PropDefault::Expression(expression, _) => Some(expression.clone()),
                                _ => None,
                            })
                    })
                    .flatten();
                let model = component
                    .props
                    .iter()
                    .any(|declaration| declaration.name == prop.name && declaration.model);
                let description = component
                    .prop_docs
                    .iter()
                    .find(|doc| doc.name == prop.name)
                    .and_then(|doc| doc.description.clone());
                PropInterface {
                    name: prop.name.to_owned(),
                    declared,
                    description,
                    attribute: prop.attribute.into_owned(),
                    default: prop.default,
                    runtime_default,
                    model,
                }
            })
            .collect(),
        script_names: locals
            .into_iter()
            .map(|(name, _)| name.to_owned())
            .collect(),
    }
    .with_model_events())
}

/// Dynamic text that shares its parent with other nodes, or sits directly inside an `zb-if`
/// branch or `zb-each` row (which has no element of its own), gets an empty-comment anchor
/// before it in both backends, so the JavaScript side can find it in server-rendered markup.
/// Text that is an element's only child is bound through the element and needs no anchor.
/// A list's items: lent from a value that outlives the render, or its own.
enum Rows<'a> {
    Lent(std::slice::Iter<'a, Value>),
    Owned(std::vec::IntoIter<Value>),
}

impl<'a> Iterator for Rows<'a> {
    type Item = Cow<'a, Value>;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Rows::Lent(items) => items.next().map(Cow::Borrowed),
            Rows::Owned(items) => items.next().map(Cow::Owned),
        }
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        match self {
            Rows::Lent(items) => items.size_hint(),
            Rows::Owned(items) => items.size_hint(),
        }
    }
}

impl ExactSizeIterator for Rows<'_> {}

/// About how many lowered nodes `nodes` make, to reserve before lowering them (a `<tr>`'s
/// cells otherwise grow its list three or four times): a node each, an anchor for a text with
/// a value, and a `zb-if`'s markers and its larger branch. A list's rows are reserved once its
/// items are known (`lower_region_into`).
fn output_hint(nodes: &[ast::Node]) -> usize {
    nodes
        .iter()
        .map(|node| match node {
            ast::Node::Text(parts) => {
                1 + usize::from(
                    parts
                        .iter()
                        .any(|part| matches!(part, AstPart::Expression { .. })),
                )
            }
            ast::Node::If {
                consequent,
                alternate,
                ..
            } => 2 + output_hint(consequent).max(output_hint(alternate)),
            ast::Node::Each { .. } => 2,
            _ => 1,
        })
        .sum()
}

pub(crate) fn needs_text_anchor(siblings: &[ast::Node], node: &ast::Node, block_top: bool) -> bool {
    (block_top || siblings.len() > 1)
        && matches!(node, ast::Node::Text(parts) if parts.iter().any(|part| matches!(part, AstPart::Expression { .. })))
}

// ---- 1. script and props -------------------------------------------------------------------

/// The script's bindings. A prop's name is the prop in the script (2.0): with `values` (the
/// props' values, once known) a binding that reads one is evaluated with it; before that (prop
/// defaults can use script bindings) it's runtime-only.
fn evaluate_script_with<'s, 'v>(
    script: &'s ast::Script,
    prop_names: &[&str],
    values: Option<&'v [Prop]>,
    known: &HashMap<String, Option<Value>>,
) -> Result<Vec<(&'s str, Local<'v>)>, Diagnostic> {
    let mut locals: Vec<(&'s str, Local<'v>)> = Vec::new();
    let mut seen: HashSet<&'s str> = HashSet::new();
    for name in &script.runtime_names {
        if !seen.insert(name) {
            return Err(Diagnostic::new(
                crate::codes::DUPLICATE_DECLARATION,
                Span::new(1, 1),
                format!("`{name}` is declared more than once in <script>"),
            ));
        }
        locals.push((name, Local::Runtime));
    }
    // `function f(…) { … }`: one the server can call, when it's within what it evaluates
    // (`pure.rs`: no `this`, no effects beyond its own `let`s). Otherwise it stays the browser's.
    for (name, source) in &script.functions {
        if let Some(function) = crate::pure::function(source) {
            locals.push((name, Local::Function(function)));
        }
    }
    // Imports whose values are known (enums from TypeScript modules): values at build time.
    for binding in &script.imported_values {
        if let Some(Ok(value)) = binding.init.as_ref().map(|init| init.evaluate(&|_| None)) {
            locals.push((&binding.name, Local::Value(Cow::Owned(value))));
        }
    }
    for binding in &script.bindings {
        if !seen.insert(&binding.name) {
            return Err(Diagnostic::new(
                crate::codes::DUPLICATE_DECLARATION,
                binding.span,
                format!("`{}` is declared more than once in <script>", binding.name),
            ));
        }
        // Ids and injected context: what the server knows (see `lower_component`).
        if let Some(value) = known.get(&binding.name) {
            let local = match value {
                Some(value) => Local::Value(Cow::Owned(value.clone())),
                None => Local::Runtime,
            };
            locals.push((&binding.name, local));
            continue;
        }
        let local = match &binding.init {
            // Outside the subset: an arrow function the server can call, or a value the server
            // can compute anyway (`items.filter(…).length`, `Math.round(…)`), or runtime-only.
            None => match &binding.source {
                Some(source) => match crate::pure::function(source) {
                    Some(function) => Local::Function(function),
                    None => {
                        let prop = |name: &str| {
                            values.and_then(|values| {
                                values
                                    .iter()
                                    .find(|prop| prop.name == name && !prop.unknown)
                            })
                        };
                        let lookup = |name: &str| match find_local(&locals, name) {
                            Some(Local::Value(value)) => {
                                Some(crate::pure::Val::Json(Value::clone(value)))
                            }
                            Some(Local::Function(function)) => Some(function.clone()),
                            Some(Local::Runtime) => None,
                            None if prop_names.contains(&name) => {
                                prop(name).map(|prop| crate::pure::Val::Json(prop.value.clone()))
                            }
                            None => None,
                        };
                        // The same names, lent where they last the render: a prop's value, or
                        // a binding that is one.
                        let lend = |name: &str| -> Option<&'v Value> {
                            match find_local(&locals, name) {
                                Some(Local::Value(Cow::Borrowed(value))) => Some(*value),
                                Some(_) => None,
                                None if prop_names.contains(&name) => {
                                    prop(name).map(|prop| &prop.value)
                                }
                                None => None,
                            }
                        };
                        match crate::pure::evaluate_answer(source, &lookup, &lend) {
                            Ok(crate::pure::Answer::Lent(value)) => {
                                Local::Value(Cow::Borrowed(value))
                            }
                            Ok(crate::pure::Answer::Val(value)) => match value.into_json() {
                                Ok(value) => Local::Value(Cow::Owned(value)),
                                Err(_) => Local::Runtime,
                            },
                            Err(_) => Local::Runtime,
                        }
                    }
                },
                None => Local::Runtime,
            },
            Some(init) => {
                // A binding can use bindings declared before it (and runtime names, which make
                // it runtime-only too).
                let mut runtime = false;
                let mut unknown = None;
                let prop = |name: &str| {
                    values.and_then(|values| values.iter().find(|prop| prop.name == name))
                };
                init.for_each_identifier(&mut |name| match find_local(&locals, name) {
                    Some(Local::Runtime | Local::Function(_)) => runtime = true,
                    Some(Local::Value(_)) => {}
                    None if prop(name).is_some_and(|prop| !prop.unknown) => {}
                    None if prop(name).is_some() || prop_names.contains(&name) => runtime = true,
                    // The browser's globals exist only at runtime.
                    None if RUNTIME_GLOBALS.contains(&name) => runtime = true,
                    None => {
                        unknown.get_or_insert_with(|| name.to_owned());
                    }
                });
                if let Some(name) = unknown {
                    let names: Vec<&str> = locals.iter().map(|(name, _)| *name).collect();
                    return Err(with_suggestion(
                        Diagnostic::new(
                            crate::codes::USED_BEFORE_DECLARED,
                            binding.span,
                            format!(
                                "`{name}` is used before it is declared (in `{}`)",
                                binding.name
                            ),
                        ),
                        &name,
                        &names,
                    ));
                }
                if runtime {
                    Local::Runtime
                } else {
                    let lookup = |name: &str| match find_local(&locals, name) {
                        Some(Local::Value(value)) => Some(Value::clone(value)),
                        Some(Local::Runtime | Local::Function(_)) => None,
                        None => prop(name).map(|prop| prop.value.clone()),
                    };
                    Local::Value(Cow::Owned(init.evaluate(&lookup).map_err(|message| {
                        Diagnostic::new(
                            crate::codes::SERVER_EVALUATION,
                            binding.span,
                            format!("in `{}`: {message}", binding.name),
                        )
                    })?))
                }
            }
        };
        locals.push((&binding.name, local));
    }
    Ok(locals)
}

fn find_local<'l, 'v>(locals: &'l [(&str, Local<'v>)], name: &str) -> Option<&'l Local<'v>> {
    locals
        .iter()
        .rev()
        .find(|(local, _)| *local == name)
        .map(|(_, local)| local)
}

/// The props' values: each given one moved out of `overrides` (what's left there afterwards is
/// a prop the component doesn't declare), the others their defaults.
fn evaluate_props<'t>(
    component: &'t ast::ComponentAst,
    locals: &[(&str, Local<'_>)],
    mut overrides: serde_json::Map<String, Value>,
) -> Result<Vec<Prop<'t>>, Diagnostic> {
    let mut props = Vec::with_capacity(component.props.len());
    for (at, declaration) in component.props.iter().enumerate() {
        if component.props[..at]
            .iter()
            .any(|earlier| earlier.name == declaration.name)
        {
            return Err(Diagnostic::new(
                crate::codes::DUPLICATE_PROP,
                declaration.span,
                format!("duplicate prop `{}`", declaration.name),
            ));
        }
        let default = prop_default(declaration, locals)?;
        if pending(&declaration.name) {
            // A value a streaming server will have later: unknown for now, so what reads it is
            // left as an empty region, filled when the value arrives.
            props.push(Prop {
                name: &declaration.name,
                attribute: kebab_cow(&declaration.name),
                default: default.and_then(Result::ok),
                value: Value::Null,
                unknown: true,
            });
            continue;
        }
        let given = overrides.remove(&declaration.name);
        let was_given = given.is_some();
        // An enum prop given as text (an attribute, or `--props`): a member's value, or its
        // name (`size="Large"`), is the member's value, as the browser reads it.
        let enum_given = match &given {
            Some(Value::String(raw)) => prop_enum(component, &declaration.name)
                .and_then(|info| enum_value(&enum_members(component, &info.name), raw)),
            _ => None,
        };
        let value = match (enum_given.or(given), &default) {
            (Some(value), Some(Ok(default))) => {
                if !same_type(default, &value) {
                    return Err(Diagnostic::new(
                        crate::codes::PROP_TYPE_MISMATCH,
                        declaration.span,
                        format!(
                            "prop `{}` must be {} (like its default), found {}",
                            declaration.name,
                            expression::type_name(default),
                            expression::type_name(&value)
                        ),
                    ));
                }
                value
            }
            (Some(value), _) => value,
            (None, Some(Ok(default))) => default.clone(),
            (None, Some(Err(_))) if partial() => Value::Null,
            (None, Some(Err(runtime))) => {
                return Err(Diagnostic::new(
                    crate::codes::DEFAULT_USES_RUNTIME,
                    declaration.span,
                    format!(
                        "the default for prop `{}` uses `{runtime}`, which only exists at runtime",
                        declaration.name
                    ),
                )
                .with_help(format!(
                    "pass `{}` with --props to render static HTML",
                    declaration.name
                )));
            }
            (None, None) => {
                return Err(Diagnostic::new(
                    crate::codes::MISSING_REQUIRED_PROP,
                    declaration.span,
                    format!("missing required prop `{}`", declaration.name),
                ));
            }
        };
        let unknown = !was_given && matches!(default, Some(Err(_)));
        props.push(Prop {
            name: &declaration.name,
            attribute: kebab_cow(&declaration.name),
            default: default.and_then(Result::ok),
            value,
            unknown,
        });
    }
    for name in overrides.keys() {
        if !props.iter().any(|prop| prop.name == name) {
            let names: Vec<&str> = props.iter().map(|prop| prop.name).collect();
            return Err(with_suggestion(
                // At the host tag, where the props are declared (the file may start with a comment).
                Diagnostic::new(
                    crate::codes::UNKNOWN_PROP,
                    component.tag_span,
                    format!("unknown prop `{name}`"),
                ),
                name,
                &names,
            ));
        }
    }
    Ok(props)
}

/// A prop's default: `None` if required, `Some(Err(name))` if it depends on a runtime-only
/// script name, `Some(Ok(value))` otherwise.
fn prop_default(
    declaration: &ast::PropDecl,
    locals: &[(&str, Local<'_>)],
) -> Result<Option<Result<Value, String>>, Diagnostic> {
    Ok(match &declaration.default {
        PropDefault::Required => None,
        PropDefault::Text(text) => Some(Ok(Value::String(text.clone()))),
        PropDefault::Expression(expression, span) => {
            let names: Vec<&str> = locals.iter().map(|(name, _)| *name).collect();
            let mut problem = None;
            let runtime = expression.is_runtime();
            expression.for_each_identifier(&mut |name| {
                if problem.is_some() {
                    return;
                }
                match find_local(locals, name) {
                    Some(Local::Value(_)) => {}
                    Some(Local::Runtime | Local::Function(_)) => {
                        problem = Some(Err(name.to_owned()))
                    }
                    None if runtime && RUNTIME_GLOBALS.contains(&name) => {}
                    None => problem = Some(Ok(name.to_owned())),
                }
            });
            // A runtime expression (`{Date.now()}`) is computed in the browser, like a default
            // that uses a runtime-only script value.
            if runtime && problem.is_none() {
                let text = expression.to_js_with(&|name| name.to_owned());
                problem = Some(Err(text[1..text.len() - 1].to_owned()));
            }
            match problem {
                Some(Ok(unknown)) => {
                    return Err(with_suggestion(
                        Diagnostic::new(
                            crate::codes::UNKNOWN_REFERENCE,
                            *span,
                            format!(
                                "unknown reference `{unknown}` in the default for prop `{}`",
                                declaration.name
                            ),
                        ),
                        &unknown,
                        &names,
                    ));
                }
                Some(Err(runtime)) => Some(Err(runtime)),
                None => {
                    let lookup = |name: &str| match find_local(locals, name) {
                        Some(Local::Value(value)) => Some(Value::clone(value)),
                        _ => None,
                    };
                    Some(Ok(expression.evaluate(&lookup).map_err(|message| {
                        Diagnostic::new(crate::codes::SERVER_EVALUATION, *span, message)
                    })?))
                }
            }
        }
    })
}

fn same_type(default: &Value, value: &Value) -> bool {
    default.is_null() || std::mem::discriminant(default) == std::mem::discriminant(value)
}

pub(crate) fn kebab(name: &str) -> String {
    kebab_cow(name).into_owned()
}

/// [`kebab`], borrowing a name that has no uppercase letter (most props: `status`, `rows`).
pub(crate) fn kebab_cow(name: &str) -> Cow<'_, str> {
    if !name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Cow::Borrowed(name);
    }
    let mut output = String::new();
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            output.push('-');
            output.push(character.to_ascii_lowercase());
        } else {
            output.push(character);
        }
    }
    Cow::Owned(output)
}

/// How a prop value is written on the host so a runtime can pick it up again
/// (the same encoding the element parses: JSON for arrays/objects).
fn host_attribute(prop: &Prop) -> Option<String> {
    match &prop.value {
        Value::Null => None,
        Value::Bool(true) => Some(String::new()),
        // Absent means the default; only a default-true boolean needs an explicit "false".
        Value::Bool(false) => (prop.default == Some(Value::Bool(true))).then(|| "false".to_owned()),
        Value::String(text) => Some(text.clone()),
        Value::Number(_) => expression::to_display_string(&prop.value).ok(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(&prop.value).ok(),
    }
}

// ---- 2. resolve / 3. lower -----------------------------------------------------------------

/// `'t`: the templates rendered, which the lowered tree borrows its names and literal text from;
/// `'a`: the values they're rendered with.
struct Context<'a, 't> {
    component: &'t ast::ComponentAst,
    locals: &'a [(&'t str, Local<'a>)],
    props: &'a [Prop<'t>],
    supply: &'a Supply<'t>,
    /// Shadow-DOM components use native `<slot>` elements.
    shadow: bool,
}

#[derive(Default)]
struct LowerState<'a, 't> {
    /// Shadow-DOM components: supplied slot content, rendered as the host's light-DOM children.
    light: Vec<Node<'t>>,
    /// Loop variables, innermost last. A list's item is lent where the list itself outlives the
    /// render (a prop, a script value, or an item of one): a row is then read where it is, not
    /// copied for each pass over it.
    scopes: Vec<Vec<(Cow<'t, str>, Cow<'a, Value>)>>,
    /// Emptied scopes and key sets of lists already lowered, for the next list to use: a list
    /// inside a list's rows (a row's cells) would otherwise make its own for every row.
    spare_scopes: Vec<Vec<(Cow<'t, str>, Cow<'a, Value>)>>,
    spare_keys: Vec<HashSet<RowKey<'a>>>,
    active_slots: HashSet<String>,
    /// Lowering HTML a server already rendered ([`Supply::Rendered`]): no tag is a child component.
    rendered: bool,
}

enum Binding<'v> {
    Value(&'v Value),
    Function(&'v crate::pure::Val),
    Runtime,
}

impl<'a, 't: 'a> Context<'a, 't> {
    fn names_in_scope<'s>(&'s self, scopes: &'s [Vec<String>]) -> Vec<&'s str> {
        scopes
            .iter()
            .flatten()
            .map(String::as_str)
            .filter(|name| !name.starts_with('#'))
            .chain(self.props.iter().map(|prop| prop.name))
            .chain(self.locals.iter().map(|(name, _)| *name))
            .collect()
    }

    fn resolve_expression(
        &self,
        expression: &Expression,
        span: Span,
        scopes: &[Vec<String>],
    ) -> Result<(), Diagnostic> {
        let mut unknown = None;
        let runtime = expression.is_runtime();
        expression.for_each_identifier(&mut |name| {
            // A runtime expression may use the browser's globals, as a script may.
            let global = runtime && (RUNTIME_GLOBALS.contains(&name) || name == "undefined");
            if unknown.is_none() && !global && !self.names_in_scope(scopes).contains(&name) {
                unknown = Some(name.to_owned());
            }
        });
        for name in expression.written_names() {
            // Props and state (a script's top-level `let`) can be assigned.
            let prop = self.props.iter().any(|prop| prop.name == name)
                || self
                    .component
                    .script
                    .bindings
                    .iter()
                    .any(|binding| binding.mutable && binding.name == name);
            let looped = scopes.iter().flatten().any(|scope| scope == name);
            if looped || !prop {
                // A name that exists nowhere is a typo, not a name that can't be assigned: say
                // that, with the closest name (a browser global exists, so it falls through).
                let global = runtime && (RUNTIME_GLOBALS.contains(&name) || name == "undefined");
                let names = self.names_in_scope(scopes);
                if !looped && !global && !names.contains(&name) {
                    return Err(with_suggestion(
                        Diagnostic::new(
                            crate::codes::UNKNOWN_REFERENCE,
                            span,
                            format!("unknown reference `{name}`"),
                        ),
                        name,
                        &names,
                    ));
                }
                return Err(Diagnostic::new(crate::codes::ASSIGN_READONLY,
                    span,
                    format!("`{name}` can't be assigned here: a template can assign props and state (a `let`) only"),
                )
                .with_help(if looped {
                    "a list item is read-only; change the list instead".to_owned()
                } else {
                    format!("declare `{name}` with `let` in <script> to make it state, or call a function from <script> that updates it")
                }));
            }
        }
        match unknown {
            None => Ok(()),
            Some(name) => Err(with_suggestion(
                Diagnostic::new(
                    crate::codes::UNKNOWN_REFERENCE,
                    span,
                    format!("unknown reference `{name}`"),
                ),
                &name,
                &self.names_in_scope(scopes),
            )),
        }
    }

    fn resolve_parts(
        &self,
        parts: &'t [AstPart],
        scopes: &[Vec<String>],
    ) -> Result<(), Diagnostic> {
        for part in parts {
            if let AstPart::Expression { expression, span } = part {
                self.resolve_expression(expression, *span, scopes)?;
            }
        }
        Ok(())
    }

    // Scopes pushed by directives carry a marker naming the directive, so an error inside one can
    // name it. (`#` can't start an identifier, so these never resolve a name.)
    fn resolve_nodes(
        &self,
        nodes: &'t [ast::Node],
        scopes: &mut Vec<Vec<String>>,
    ) -> Result<(), Diagnostic> {
        for node in nodes {
            match node {
                ast::Node::Text(parts) => self.resolve_parts(parts, scopes)?,
                ast::Node::Element(element) if element.name.eq_ignore_ascii_case("zb-case") => {
                    return Err(Diagnostic::new(
                        crate::codes::DIRECTIVE_PLACEMENT,
                        element.span,
                        "zb-case is only valid as a child of zb-switch",
                    ));
                }
                ast::Node::Element(element) if element.name.eq_ignore_ascii_case("zb-pending") => {
                    return Err(Diagnostic::new(
                        crate::codes::DIRECTIVE_PLACEMENT,
                        element.span,
                        "zb-pending is only valid as the first child of zb-await",
                    ));
                }
                ast::Node::Element(element) => {
                    for attribute in &element.attributes {
                        match &attribute.value {
                            AttributeValue::None => {}
                            AttributeValue::Text(parts) => self.resolve_parts(parts, scopes)?,
                            AttributeValue::Expression(expression, span) => {
                                self.resolve_expression(expression, *span, scopes)?;
                            }
                        }
                        check_attribute_statically(attribute)?;
                        check_animation_value(element, attribute)?;
                        check_meta_value(element, attribute)?;
                    }
                    self.resolve_nodes(&element.children, scopes)?;
                }
                ast::Node::If {
                    test,
                    test_span,
                    consequent,
                    alternate,
                    ..
                } => {
                    self.resolve_expression(test, *test_span, scopes)?;
                    self.resolve_nodes(consequent, scopes)?;
                    self.resolve_nodes(alternate, scopes)?;
                }
                ast::Node::Each {
                    items,
                    items_span,
                    item,
                    index,
                    key,
                    lets,
                    children,
                    ..
                } => {
                    self.resolve_expression(items, *items_span, scopes)?;
                    scopes.push(
                        bound_names(item)
                            .into_iter()
                            .chain(index.clone())
                            .chain([SCOPE_EACH.to_owned()])
                            .collect(),
                    );
                    let result = self
                        .resolve_lets(lets, scopes)
                        .and_then(|()| match key {
                            Some((key, key_span)) => {
                                self.resolve_expression(key, *key_span, scopes)
                            }
                            None => Ok(()),
                        })
                        .and_then(|()| self.resolve_nodes(children, scopes));
                    scopes.pop();
                    result?;
                }
                ast::Node::Slot { fallback, span, .. } => {
                    // The innermost directive that binds names (and so may render its content
                    // more than once, or later than the element starts).
                    if let Some(inside) = scopes
                        .last()
                        .and_then(|scope| scope.iter().find(|name| name.starts_with('#')))
                    {
                        return Err(if inside == SCOPE_EACH {
                            Diagnostic::new(crate::codes::SLOT_PLACEMENT,
                                *span,
                                "zb-slot can't be inside zb-each: slotted content can only be in one place",
                            )
                            .with_help("put the slot outside the list, or pass each row's content as a prop")
                        } else {
                            let branch = &inside[1..];
                            Diagnostic::new(crate::codes::SLOT_PLACEMENT,
                                *span,
                                format!("zb-slot can't be inside zb-{branch}: slotted content is placed when the element starts, before the value settles"),
                            )
                            .with_help(format!("put the slot outside zb-await (beside it, or around it), or render the slotted markup inside zb-{branch} from a prop"))
                        });
                    }
                    self.resolve_nodes(fallback, scopes)?;
                }
                ast::Node::Else { span, .. } => {
                    return Err(Diagnostic::new(
                        crate::codes::DIRECTIVE_PLACEMENT,
                        *span,
                        "zb-else is only valid as a direct child of zb-if",
                    ));
                }
                ast::Node::Await {
                    value,
                    value_span,
                    pending,
                    then,
                    catch,
                    delay,
                    ..
                } => {
                    self.resolve_expression(value, *value_span, scopes)?;
                    if let Some((delay, span)) = delay {
                        self.resolve_expression(delay, *span, scopes)?;
                    }
                    self.resolve_nodes(pending, scopes)?;
                    for (branch, caught) in then
                        .iter()
                        .map(|b| (b, false))
                        .chain(catch.iter().map(|b| (b, true)))
                    {
                        let mut names: Vec<String> = branch
                            .name
                            .iter()
                            .flat_map(|name| bound_names(name))
                            .collect();
                        // `retry()` in zb-catch runs the value again (4.2).
                        if caught {
                            names.push("retry".to_owned());
                        }
                        names.push(if caught { SCOPE_CATCH } else { SCOPE_THEN }.to_owned());
                        scopes.push(names);
                        let result = self
                            .resolve_lets(&branch.lets, scopes)
                            .and_then(|()| self.resolve_nodes(&branch.children, scopes));
                        scopes.pop();
                        result?;
                    }
                }
                ast::Node::Settled { caught, branch } => {
                    return Err(Diagnostic::new(
                        crate::codes::DIRECTIVE_PLACEMENT,
                        branch.span,
                        format!(
                            "zb-{} is only valid as a direct child of zb-await",
                            if *caught { "catch" } else { "then" }
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    /// `let:` names: each expression resolved in the scope so far, then its name added to it.
    fn resolve_lets(
        &self,
        lets: &[ast::Let],
        scopes: &mut [Vec<String>],
    ) -> Result<(), Diagnostic> {
        for binding in lets {
            self.resolve_expression(&binding.value, binding.span, scopes)?;
            if let Some(scope) = scopes.last_mut() {
                scope.push(binding.name.clone());
            }
        }
        Ok(())
    }

    /// The value `name` has, when it outlives this render's state: a prop, a script value, or a
    /// loop variable lent from one. `None` for anything else, a loop variable that owns its value
    /// included (it hides whatever it shadows).
    fn lasting(&self, name: &str, state: &LowerState<'a, 't>) -> Option<&'a Value> {
        for scope in state.scopes.iter().rev() {
            if let Some((_, value)) = scope.iter().rev().find(|(local, _)| local == name) {
                return match value {
                    Cow::Borrowed(value) => Some(*value),
                    Cow::Owned(_) => None,
                };
            }
        }
        if let Some(prop) = self.props.iter().find(|prop| prop.name == name) {
            return (!prop.unknown).then_some(&prop.value);
        }
        match find_local(self.locals, name) {
            Some(Local::Value(value)) => Some(&**value),
            _ => None,
        }
    }

    fn binding<'s>(&'s self, name: &str, state: &'s LowerState<'a, 't>) -> Option<Binding<'s>> {
        for scope in state.scopes.iter().rev() {
            if let Some((_, value)) = scope.iter().rev().find(|(local, _)| local == name) {
                return Some(Binding::Value(value));
            }
        }
        if let Some(prop) = self.props.iter().find(|prop| prop.name == name) {
            if prop.unknown {
                return Some(Binding::Runtime);
            }
            return Some(Binding::Value(&prop.value));
        }
        find_local(self.locals, name).map(|local| match local {
            Local::Value(value) => Binding::Value(value),
            Local::Function(function) => Binding::Function(function),
            Local::Runtime => Binding::Runtime,
        })
    }

    /// [`Self::evaluate`], or `None` when rendering partially and only the browser can compute
    /// the value.
    fn evaluate_known(
        &self,
        expression: &Expression,
        span: Span,
        state: &LowerState<'a, 't>,
    ) -> Result<Option<Value>, Diagnostic> {
        if partial() {
            // `hydrated()` written in the template, not first bound in the script: false on the
            // server, as `const live = hydrated()` is. Before anything else reads the call.
            if let Expression::Runtime { source, .. } = expression {
                if let Some(known) = self.without_hydrated(source) {
                    return self.evaluate_known(&known, span, state);
                }
            }
            let mut runtime = expression.is_runtime();
            let mut runtime_name = false;
            expression.for_each_identifier(&mut |name| {
                runtime_name |= matches!(self.binding(name, state), Some(Binding::Runtime));
            });
            runtime |= runtime_name;
            // JavaScript outside the subset that the server can still compute.
            if runtime && !runtime_name {
                if let Some(value) = self.pure_value(expression, state) {
                    return Ok(Some(value));
                }
            }
            if runtime {
                // `live && …` / `!live || …`: a known first operand can decide it alone (the
                // progressive-enhancement pattern, where `live` is hydrated()'s false).
                if let Expression::Runtime { source, .. } = expression {
                    if let Some(value) = self.short_circuit(source, state) {
                        return Ok(Some(value));
                    }
                }
                gap(span);
                return Ok(None);
            }
        }
        self.evaluate(expression, span, state).map(Some)
    }

    /// A runtime expression the server evaluates anyway (`pure.rs`), or `None`.
    fn pure_value(&self, expression: &Expression, state: &LowerState<'a, 't>) -> Option<Value> {
        let Expression::Runtime { source, .. } = expression else {
            return None;
        };
        let lookup = |name: &str| match self.binding(name, state) {
            Some(Binding::Value(value)) => Some(crate::pure::Val::Json(value.clone())),
            Some(Binding::Function(function)) => Some(function.clone()),
            _ => None,
        };
        let lend = |name: &str| match self.binding(name, state) {
            Some(Binding::Value(value)) => Some(value),
            _ => None,
        };
        crate::pure::evaluate_lent(source, &lookup, Some(&lend))
            .and_then(crate::pure::Val::into_json)
            .ok()
    }

    /// `source` with each call to `hydrated()` (by the names it's imported as) written as
    /// `false`, parsed; `None` when it calls none.
    fn without_hydrated(&self, source: &str) -> Option<Expression> {
        let calls = hydrated_calls(source, &self.component.script.hydrated);
        let changed = !calls.is_empty();
        let mut text = source.to_owned();
        for (start, end) in calls.into_iter().rev() {
            text.replace_range(start..end, "false");
        }
        if !changed {
            return None;
        }
        // Parsed as the template parser does: the build-time subset, or else JavaScript for the
        // browser (which the short-circuit rule can still decide on the server).
        expression::parse(&text).ok().or_else(|| {
            let names = crate::runtime_expression::parse(&text).ok()?;
            Some(Expression::Runtime {
                source: text,
                names,
            })
        })
    }

    /// `name && rest`, `!name && rest`, `name || rest`, `!name || rest`, where `name` is known
    /// at render time (or a literal) and decides the result without `rest`.
    fn short_circuit(&self, source: &str, state: &LowerState<'a, 't>) -> Option<Value> {
        let text = source.trim_start();
        let (negated, text) = match text.strip_prefix('!') {
            Some(rest) if !rest.starts_with('=') => (true, rest.trim_start()),
            _ => (false, text),
        };
        let length = text
            .char_indices()
            .take_while(|(_, character)| {
                character.is_alphanumeric() || *character == '_' || *character == '$'
            })
            .map(|(index, character)| index + character.len_utf8())
            .last()?;
        let (name, rest) = text.split_at(length);
        if name
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_digit())
        {
            return None;
        }
        let rest = rest.trim_start();
        let and = rest.starts_with("&&") && !rest.starts_with("&&=");
        let or = rest.starts_with("||") && !rest.starts_with("||=");
        if !and && !or {
            return None;
        }
        // A literal first operand (`hydrated()` written in the template becomes `false`).
        let literal = match name {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        };
        let value = match (&literal, self.binding(name, state)) {
            (Some(value), _) => value,
            (None, Some(Binding::Value(value))) => value,
            _ => return None,
        };
        let value = if negated {
            Value::Bool(!expression::is_truthy(value))
        } else {
            value.clone()
        };
        let truthy = expression::is_truthy(&value);
        ((and && !truthy) || (or && truthy)).then_some(value)
    }

    fn evaluate(
        &self,
        expression: &Expression,
        span: Span,
        state: &LowerState<'a, 't>,
    ) -> Result<Value, Diagnostic> {
        let mut runtime = None;
        expression.for_each_identifier(&mut |name| {
            if runtime.is_none() && matches!(self.binding(name, state), Some(Binding::Runtime)) {
                runtime = Some(name.to_owned());
            }
        });
        if runtime.is_none() && expression.is_runtime() {
            if let Some(value) = self.pure_value(expression, state) {
                return Ok(value);
            }
        }
        if let Some(name) = runtime {
            return Err(Diagnostic::new(crate::codes::RUNTIME_ONLY_IN_HTML,
                span,
                format!("`{name}` only exists at runtime, so it can't be rendered into static HTML"),
            )
            .with_help("pass the value as a prop, leave it to the element with `--partial`, or compute it with what the server evaluates (an arrow function, not a `function` declaration)"));
        }
        let lend = |name: &str| match self.binding(name, state) {
            Some(Binding::Value(value)) => Some(value),
            _ => None,
        };
        expression
            .evaluate_lent(&lend)
            .map_err(|message| Diagnostic::new(crate::codes::SERVER_EVALUATION, span, message))
    }

    /// Text with its values; partially rendered text the browser fills in is empty.
    fn lower_parts(
        &self,
        parts: &'t [AstPart],
        state: &LowerState<'a, 't>,
    ) -> Result<ir::Parts<'t>, Diagnostic> {
        // Most text is one part: no list for it.
        if let [part] = parts {
            return Ok(ir::Parts::One(
                self.lower_part(part, state)?
                    .unwrap_or_else(|| Part::Escaped(String::new())),
            ));
        }
        Ok(match self.lower_known_parts(parts, state)? {
            Some(lowered) => lowered.into(),
            None => Part::Escaped(String::new()).into(),
        })
    }

    /// Text with its values, or `None` when one is computed in the browser.
    fn lower_known_parts(
        &self,
        parts: &'t [AstPart],
        state: &LowerState<'a, 't>,
    ) -> Result<Option<Vec<Part<'t>>>, Diagnostic> {
        let mut lowered = Vec::with_capacity(parts.len());
        for part in parts {
            let Some(part) = self.lower_part(part, state)? else {
                return Ok(None);
            };
            lowered.push(part);
        }
        Ok(Some(lowered))
    }

    /// One part of a text, or `None` when its value is computed in the browser.
    fn lower_part(
        &self,
        part: &'t AstPart,
        state: &LowerState<'a, 't>,
    ) -> Result<Option<Part<'t>>, Diagnostic> {
        let (expression, span) = match part {
            AstPart::Literal(text) => return Ok(Some(Part::Literal(Cow::Borrowed(text)))),
            AstPart::Expression { expression, span } => (expression, *span),
        };
        // A path into a value that outlives the render (`{row.name}` in a list of a prop) is
        // read where it is: one copy, into the text, not two.
        let text = match expression.lent(&|name| self.lasting(name, state)) {
            Some(value) => expression::to_display_string(value),
            None => {
                let Some(value) = self.evaluate_known(expression, span, state)? else {
                    return Ok(None);
                };
                expression::into_display_string(value)
            }
        };
        text.map(|text| Some(Part::Escaped(text)))
            .map_err(|message| Diagnostic::new(crate::codes::VALUE_NOT_TEXT, span, message))
    }

    fn lower_nodes(
        &self,
        nodes: &'t [ast::Node],
        state: &mut LowerState<'a, 't>,
    ) -> Result<Vec<Node<'t>>, Diagnostic> {
        self.lower_block(nodes, state, false)
    }

    /// `block_top`: these nodes are the top level of an `zb-if` branch or `zb-each` row.
    /// `let:` values for the innermost scope, evaluated in order (each may use the ones before).
    fn lower_lets(
        &self,
        lets: &'t [ast::Let],
        state: &mut LowerState<'a, 't>,
    ) -> Result<(), Diagnostic> {
        for binding in lets {
            let value = self.evaluate(&binding.value, binding.span, state)?;
            if let Some(scope) = state.scopes.last_mut() {
                scope.push((Cow::Borrowed(binding.name.as_str()), Cow::Owned(value)));
            }
        }
        Ok(())
    }

    fn lower_block(
        &self,
        nodes: &'t [ast::Node],
        state: &mut LowerState<'a, 't>,
        block_top: bool,
    ) -> Result<Vec<Node<'t>>, Diagnostic> {
        let mut output = Vec::with_capacity(output_hint(nodes));
        self.lower_block_into(nodes, state, block_top, &mut output)?;
        Ok(output)
    }

    /// [`Self::lower_block`], onto the end of `output`: a branch or a list's rows go straight
    /// into the list they're part of, not through a list of their own copied into it.
    fn lower_block_into(
        &self,
        nodes: &'t [ast::Node],
        state: &mut LowerState<'a, 't>,
        block_top: bool,
        output: &mut Vec<Node<'t>>,
    ) -> Result<(), Diagnostic> {
        for node in nodes {
            if needs_text_anchor(nodes, node, block_top) {
                output.push(Node::Anchor);
            }
            // Text and elements, most of any template, are one node each: straight into the
            // output, not through a list of one.
            match node {
                ast::Node::Text(parts) => output.push(Node::Text(self.lower_parts(parts, state)?)),
                ast::Node::Element(element) => output.push(self.lower_element(element, state)?),
                ast::Node::If { .. } | ast::Node::Each { .. } => {
                    self.lower_region_into(node, state, output)?
                }
                _ => output.extend(self.lower_node(node, state)?),
            }
        }
        Ok(())
    }

    /// A `zb-if` or `zb-each`, onto the end of `output`.
    fn lower_region_into(
        &self,
        node: &'t ast::Node,
        state: &mut LowerState<'a, 't>,
        output: &mut Vec<Node<'t>>,
    ) -> Result<(), Diagnostic> {
        match node {
            ast::Node::If {
                test,
                test_span,
                consequent,
                alternate,
                ..
            } => {
                let Some(value) = self.evaluate_known(test, *test_span, state)? else {
                    output.push(Node::OpenClient);
                    output.push(Node::Close);
                    return Ok(());
                };
                let branch = if expression::is_truthy(&value) {
                    consequent
                } else {
                    alternate
                };
                // Region markers let the JavaScript side find (and later replace) the branch.
                output.push(Node::Open);
                self.lower_block_into(branch, state, true, output)?;
                output.push(Node::Close);
                Ok(())
            }
            ast::Node::Each {
                items,
                items_span,
                item,
                index,
                key,
                lets,
                children,
                ..
            } => {
                // A `let:` the server can't evaluate leaves the list to the browser.
                let browser_only = lets.iter().any(|binding| binding.value.is_runtime());
                // A list that outlives the render (a prop, a script value, a field of an outer
                // row lent the same way) is read where it is: its rows are lent to their scopes.
                let lent = if browser_only {
                    None
                } else {
                    match items.lent(&|name| self.lasting(name, state)) {
                        Some(Value::Array(list)) => Some(list),
                        _ => None,
                    }
                };
                let rows = if let Some(list) = lent {
                    Rows::Lent(list.iter())
                } else {
                    let Some(value) = (if browser_only {
                        None
                    } else {
                        self.evaluate_known(items, *items_span, state)?
                    }) else {
                        output.push(Node::OpenClient);
                        output.push(Node::Close);
                        return Ok(());
                    };
                    let Value::Array(list) = value else {
                        return Err(Diagnostic::new(
                            crate::codes::EACH_ITEMS_NOT_ARRAY,
                            *items_span,
                            format!(
                                "zb-each items must be an array, found {}",
                                expression::type_name(&value)
                            ),
                        ));
                    };
                    Rows::Owned(list.into_iter())
                };
                // A region for the list, and one per row.
                output.reserve(rows.len() * 3 + 2);
                output.push(Node::Open);
                let mut keys = state.spare_keys.pop().unwrap_or_default();
                if key.is_some() {
                    keys.reserve(rows.len());
                }
                // One scope for every row in turn, emptied between them, not one made per row
                // (nor per list: an emptied one is kept for the next).
                let mut spare = state.spare_scopes.pop().unwrap_or_default();
                for (position, entry) in rows.enumerate() {
                    let mut scope = std::mem::take(&mut spare);
                    destructure_entry(item, entry, &mut scope);
                    if let Some(index) = index {
                        scope.push((
                            Cow::Borrowed(index.as_str()),
                            Cow::Owned(Value::from(position)),
                        ));
                    }
                    state.scopes.push(scope);
                    if let Err(error) = self.lower_lets(lets, state) {
                        state.scopes.pop();
                        return Err(error);
                    }
                    if let Some((key, key_span)) = key {
                        // Read where it is when it can be (`row.id` of a prop's rows).
                        let value = match key.lent(&|name| self.lasting(name, state)) {
                            Some(value) => Ok(Some(Cow::Borrowed(value))),
                            None => self
                                .evaluate_known(key, *key_span, state)
                                .map(|value| value.map(Cow::Owned)),
                        };
                        let checked = value.and_then(|value| match value {
                            // Computed in the browser, which checks it there.
                            None => Ok(()),
                            Some(value) => match RowKey::of(value) {
                                Ok(row_key) if keys.contains(&row_key) => Err(Diagnostic::new(
                                    crate::codes::DUPLICATE_KEY,
                                    *key_span,
                                    format!(
                                        "duplicate zb-each key {} (row {})",
                                        row_key.shown(),
                                        position + 1
                                    ),
                                )),
                                Ok(row_key) => {
                                    keys.insert(row_key);
                                    Ok(())
                                }
                                Err(found) => Err(Diagnostic::new(
                                    crate::codes::KEY_TYPE,
                                    *key_span,
                                    format!(
                                        "zb-each key must be a string or number, found {found}"
                                    ),
                                )),
                            },
                        });
                        if let Err(error) = checked {
                            state.scopes.pop();
                            return Err(error);
                        }
                    }
                    output.push(Node::Open);
                    let lowered = self.lower_block_into(children, state, true, output);
                    if let Some(mut scope) = state.scopes.pop() {
                        scope.clear();
                        spare = scope;
                    }
                    lowered?;
                    output.push(Node::Close);
                }
                keys.clear();
                state.spare_keys.push(keys);
                state.spare_scopes.push(spare);
                output.push(Node::Close);
                Ok(())
            }
            _ => unreachable!("only zb-if and zb-each are regions here"),
        }
    }

    /// An element: a placeholder for a listeners-only one, a child component rendered, or the
    /// element with its attributes and children.
    fn lower_element(
        &self,
        element: &'t ast::Element,
        state: &mut LowerState<'a, 't>,
    ) -> Result<Node<'t>, Diagnostic> {
        if crate::emit_js::is_global_listener(&element.name) {
            // Listeners only: a placeholder the element finds them by.
            return Ok(Node::Anchor);
        }
        if !state.rendered {
            if let Some(child) = self.component.child(&element.name) {
                return self.lower_child(element, child, state);
            }
        }
        let custom = element.name.contains('-');
        let mut attributes = Vec::with_capacity(element.attributes.len());
        for attribute in &element.attributes {
            if attribute.name == crate::parser::SPREAD {
                continue; // after the element's own (an explicit attribute wins)
            }
            if let Some(lowered) = self.lower_attribute(attribute, state, custom)? {
                attributes.push(lowered);
            }
        }
        self.lower_directives(element, &mut attributes, state)?;
        for attribute in &element.attributes {
            if attribute.name == crate::parser::SPREAD {
                self.lower_spread(element, attribute, &mut attributes, state, &[])?;
            }
        }
        let mut lowered = ir::Element {
            name: Cow::Borrowed(element.name.as_str()),
            attributes,
            children: self.lower_nodes(&element.children, state)?,
        };
        form_value_as_html(&mut lowered);
        Ok(Node::Element(lowered))
    }

    fn lower_node(
        &self,
        node: &'t ast::Node,
        state: &mut LowerState<'a, 't>,
    ) -> Result<Vec<Node<'t>>, Diagnostic> {
        match node {
            ast::Node::Text(parts) => Ok(vec![Node::Text(self.lower_parts(parts, state)?)]),
            ast::Node::Element(element) => Ok(vec![self.lower_element(element, state)?]),
            ast::Node::If { .. } | ast::Node::Each { .. } => {
                let mut output = Vec::new();
                self.lower_region_into(node, state, &mut output)?;
                Ok(output)
            }
            ast::Node::Slot {
                name,
                fallback,
                span,
            } => {
                if !state.active_slots.insert(name.clone()) {
                    return Err(Diagnostic::new(
                        crate::codes::RECURSIVE_SLOT,
                        *span,
                        format!("recursive slot expansion for `{name}`"),
                    ));
                }
                // Supplied content, lowered: templates in this component's scope (as a block),
                // or nodes the parent already lowered in its own.
                let supplied = match self.supply {
                    Supply::Templates(templates) => templates
                        .get(name)
                        .map(|nodes| self.lower_block(nodes, state, !self.shadow))
                        .transpose()?,
                    Supply::Rendered(templates) => match templates.get(name) {
                        Some(nodes) => {
                            let outer = std::mem::replace(&mut state.rendered, true);
                            let lowered = self.lower_block(nodes, state, !self.shadow);
                            state.rendered = outer;
                            Some(lowered?)
                        }
                        None => None,
                    },
                    Supply::Lowered(lowered) => lowered.get(name).cloned(),
                };
                let output = if self.shadow {
                    // A native <slot>; supplied content goes in the host's light DOM.
                    let fallback = self.lower_nodes(fallback, state)?;
                    if let Some(lowered) = supplied {
                        state.light.extend(assign_to_slot(name, lowered, *span)?);
                    }
                    let attributes = if name == "default" {
                        Vec::new()
                    } else {
                        vec![ir::Attribute {
                            name: Cow::Borrowed("name"),
                            value: Some(vec![Part::Literal(Cow::Borrowed(name))]),
                        }]
                    };
                    Ok(vec![Node::Element(ir::Element {
                        name: Cow::Borrowed("slot"),
                        attributes,
                        children: fallback,
                    })])
                } else {
                    // A region; `<?zb [!?>` marks supplied content, which stays static, as
                    // opposed to fallback content, which the JavaScript side binds.
                    let mut output = Vec::new();
                    match supplied {
                        Some(lowered) => {
                            output.push(Node::OpenProjected);
                            // A styled component's styles stop at what callers put in its slots.
                            let styled = self.component.style.is_some();
                            output.extend(lowered.into_iter().map(|node| match node {
                                Node::Element(mut element) if styled => {
                                    element.attributes.retain(|attribute| {
                                        attribute.name != crate::styles::SLOTTED
                                    });
                                    element.attributes.push(ir::Attribute {
                                        name: Cow::Borrowed(crate::styles::SLOTTED),
                                        value: Some(vec![Part::Literal(Cow::Borrowed(
                                            self.component.tag.as_str(),
                                        ))]),
                                    });
                                    Node::Element(element)
                                }
                                node => node,
                            }));
                        }
                        None => {
                            output.push(Node::Open);
                            output.extend(self.lower_block(fallback, state, true)?);
                        }
                    }
                    output.push(Node::Close);
                    Ok(output)
                };
                state.active_slots.remove(name);
                output
            }
            ast::Node::Else { span, .. } => Err(Diagnostic::new(
                crate::codes::DIRECTIVE_PLACEMENT,
                *span,
                "zb-else is only valid as a direct child of zb-if",
            )),
            // A value known at build time isn't a promise: the `zb-then` content, with it.
            // Otherwise the server can't wait for the value: it renders the pending content in
            // a region the element renders itself when the value settles.
            ast::Node::Await {
                value,
                value_span,
                pending,
                then,
                ..
            } => {
                let mut runtime = value.is_runtime();
                value.for_each_identifier(&mut |name| {
                    runtime |= matches!(self.binding(name, state), Some(Binding::Runtime));
                });
                if !runtime {
                    let resolved = self.evaluate(value, *value_span, state)?;
                    let mut output = vec![Node::Open];
                    if let Some(branch) = then {
                        state.scopes.push(
                            branch
                                .name
                                .iter()
                                .flat_map(|name| destructure(name, &resolved))
                                .map(|(name, value)| (Cow::Owned(name), Cow::Owned(value)))
                                .collect(),
                        );
                        let lowered = self
                            .lower_lets(&branch.lets, state)
                            .and_then(|()| self.lower_block(&branch.children, state, true));
                        state.scopes.pop();
                        output.extend(lowered?);
                    }
                    output.push(Node::Close);
                    return Ok(output);
                }
                let mut output = vec![Node::OpenClient];
                output.extend(self.lower_block(pending, state, true)?);
                output.push(Node::Close);
                Ok(output)
            }
            ast::Node::Settled { caught, branch } => Err(Diagnostic::new(
                crate::codes::DIRECTIVE_PLACEMENT,
                branch.span,
                format!(
                    "zb-{} is only valid as a direct child of zb-await",
                    if *caught { "catch" } else { "then" }
                ),
            )),
        }
    }

    /// A child component used in this template: rendered inline from its own definition, with
    /// props passed as values (type-checked against the child's defaults) and the element's
    /// content — lowered here, in this component's scope — as the child's slot content.
    fn lower_child(
        &self,
        element: &'t ast::Element,
        child: &'t ast::ChildComponent,
        state: &mut LowerState<'a, 't>,
    ) -> Result<Node<'t>, Diagnostic> {
        let interface =
            interface_of(child).map_err(|error| error.in_file(&child.path, &child.source))?;
        let mut overrides = serde_json::Map::new();
        let mut attributes = Vec::new();
        let mut spreads = Vec::new();
        for attribute in &element.attributes {
            if attribute.name == crate::parser::SPREAD {
                spreads.push(attribute);
                continue; // after the element's own (an explicit prop or attribute wins)
            }
            let prop_name = camel_cow(&attribute.name);
            let lower = ascii_lowercase(&attribute.name);
            check_child_event(&child.ast.tag, &interface, attribute)?;
            if let Some(prop) = interface.props.iter().find(|prop| prop.name == prop_name) {
                let (value, span) = match &attribute.value {
                    AttributeValue::None => (Value::Bool(true), attribute.span),
                    AttributeValue::Text(parts) => match self.lower_known_parts(parts, state)? {
                        Some(lowered) => (Value::String(joined(&lowered)), attribute.span),
                        None => continue, // the child renders its default; the parent sets it
                    },
                    AttributeValue::Expression(expression, span) => {
                        match self.evaluate_known(expression, *span, state)? {
                            Some(value) => (value, *span),
                            None => continue,
                        }
                    }
                };
                check_child_prop_type(&child.ast.tag, prop, &value, span)?;
                overrides.insert(prop.name.clone(), value);
            } else if matches!(attribute.value, AttributeValue::Expression(..))
                && !crate::parser::is_event_attribute(&lower)
                && !is_global_attribute(&lower)
                && !is_host_directive(&lower)
            {
                return Err(unknown_child_prop(&child.ast.tag, &interface, attribute));
            } else if let Some(lowered) = self.lower_attribute(attribute, state, true)? {
                attributes.push(lowered);
            }
        }
        self.lower_directives(element, &mut attributes, state)?;
        // `{...object}` on a component: the entries that are the child's props are passed as
        // props (the element's own win), the rest are attributes of its host, as on any
        // element. An object known only in the browser is left for it.
        // Made only when there is a spread (most children have none).
        let spread = !spreads.is_empty();
        let prop_names: Vec<String> = match spread {
            true => interface
                .props
                .iter()
                .map(|prop| prop.name.clone())
                .collect(),
            false => Vec::new(),
        };
        // What the tag itself gives: a later spread replaces an earlier one's value, as in
        // JavaScript (and as the browser's binder does), but never the tag's own.
        let written: Vec<String> = match spread {
            true => overrides.keys().cloned().collect(),
            false => Vec::new(),
        };
        let mut spread_keys = SpreadKeys::Known(Vec::new());
        for attribute in spreads {
            let AttributeValue::Expression(expression, span) = &attribute.value else {
                continue;
            };
            let entries = match self.evaluate_known(expression, *span, state)? {
                Some(Value::Object(entries)) => entries,
                known => {
                    if known.is_none() {
                        spread_keys = SpreadKeys::Unknown; // the browser's to give
                    }
                    self.lower_spread(element, attribute, &mut attributes, state, &[])?;
                    continue;
                }
            };
            for (key, value) in &entries {
                let Some(prop) = interface
                    .props
                    .iter()
                    .find(|prop| spread_key_is_prop(key, &prop.name))
                else {
                    continue;
                };
                let given = written.contains(&prop.name)
                    || element.attributes.iter().any(|other| {
                        other.name != crate::parser::SPREAD && camel_cow(&other.name) == prop.name
                    });
                if given {
                    continue; // the tag's own prop wins, in either order
                }
                if value.is_null() {
                    // A value that isn't one: the child's default, whatever an earlier spread gave.
                    overrides.remove(&prop.name);
                    if let SpreadKeys::Known(keys) = &mut spread_keys {
                        keys.retain(|known| !spread_key_is_prop(known, &prop.name));
                    }
                    continue;
                }
                check_child_prop_type(&child.ast.tag, prop, value, *span)?;
                overrides.insert(prop.name.clone(), value.clone());
                if let SpreadKeys::Known(keys) = &mut spread_keys {
                    keys.push(key.clone());
                }
            }
            self.lower_spread(element, attribute, &mut attributes, state, &prop_names)?;
        }
        check_child_required(&child.ast.tag, &interface, element, &spread_keys)?;
        for prop in &interface.props {
            if prop.runtime_default.is_some() && !overrides.contains_key(&prop.name) && !partial() {
                return Err(Diagnostic::new(crate::codes::CHILD_DEFAULT_IN_BROWSER,
                    element.span,
                    format!(
                        "<{}> computes the default for `{}` in the browser; pass `{}` here to render it as HTML",
                        child.ast.tag, prop.attribute, prop.attribute
                    ),
                ));
            }
        }

        // The element's content becomes the child's slot content, grouped by `slot="…"`.
        let content = self.lower_block(&element.children, state, !child.ast.shadow)?;
        let mut declared = HashSet::new();
        collect_slots(&child.ast.nodes, &mut declared);
        let mut groups: HashMap<String, Vec<Node<'t>>> = HashMap::new();
        let mut depth = 0usize;
        let mut current: Cow<'_, str> = Cow::Borrowed("default");
        for node in content {
            if depth == 0 {
                current = match &node {
                    Node::Element(element) => element
                        .attributes
                        .iter()
                        .find(|attribute| attribute.name == "slot")
                        .and_then(|attribute| attribute.value.as_deref())
                        .map_or(Cow::Borrowed("default"), |parts| Cow::Owned(joined(parts))),
                    _ => Cow::Borrowed("default"),
                };
                if matches!(&node, Node::Text(parts) if parts.iter().all(|part| match part {
                    Part::Literal(text) => text.trim().is_empty(),
                    Part::Escaped(text) => text.trim().is_empty(),
                })) {
                    continue;
                }
            }
            match node {
                Node::Open | Node::OpenProjected => depth += 1,
                Node::Close => depth = depth.saturating_sub(1),
                _ => {}
            }
            if !declared.contains(current.as_ref()) {
                return Err(Diagnostic::new(
                    crate::codes::UNKNOWN_SLOT,
                    element.span,
                    format!("<{}> has no slot named `{current}`", child.ast.tag),
                ));
            }
            groups
                .entry(current.clone().into_owned())
                .or_default()
                .push(node);
        }

        // The child's own gaps are in its file: reported at its tag here, saying where in it.
        // A host with a written `id` bases its ids on it, as the element does.
        let host_id = element
            .attributes
            .iter()
            .find_map(|attribute| match &attribute.value {
                AttributeValue::Text(parts) if attribute.name == "id" => parts
                    .iter()
                    .map(|part| match part {
                        ast::Part::Literal(text) => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Option<String>>(),
                _ => None,
            });
        // What this reads of the child's props once it's rendered (its two-way props, for the
        // form's fallback below); the rest are moved into the render.
        let models: serde_json::Map<String, Value> = interface
            .props
            .iter()
            .filter(|prop| prop.model)
            .filter_map(|prop| {
                overrides
                    .get(&prop.name)
                    .map(|value| (prop.name.clone(), value.clone()))
            })
            .collect();
        let recording = GAPS.with(|gaps| gaps.borrow().is_some());
        let rendered = if recording {
            let (rendered, found) = record_gaps(|| {
                lower_component(
                    &child.ast,
                    overrides,
                    &Supply::Lowered(groups),
                    host_id.as_deref(),
                )
            });
            gaps_in_child(element.span, &child.ast.tag, &child.path, found);
            rendered
        } else {
            lower_component(
                &child.ast,
                overrides,
                &Supply::Lowered(groups),
                host_id.as_deref(),
            )
        }
        .map_err(|error| error.in_file(&child.path, &child.source))?;
        for (name, value) in rendered.host_attributes {
            attributes.push(ir::Attribute {
                name,
                value: (!value.is_empty()).then(|| vec![Part::Escaped(value)]),
            });
        }
        let mut children = if rendered.shadow {
            let mut children = vec![Node::Element(ir::Element {
                name: Cow::Borrowed("template"),
                attributes: vec![ir::Attribute {
                    name: Cow::Borrowed("shadowrootmode"),
                    value: Some(vec![Part::Literal(Cow::Borrowed("open"))]),
                }],
                children: rendered.nodes,
            })];
            children.extend(rendered.light_children);
            children
        } else {
            rendered.nodes
        };
        // A form control with a `name` submits through ElementInternals, which needs JavaScript.
        // Until then a hidden input carries the value it was rendered with, so the form submits
        // the same thing; the element removes it when it starts (as on @zubra/server's
        // framework path, and in the same place: the host's last child).
        // Not when the value is only known in the browser (the child rendered its default, which
        // the form must not submit in its place), or when the child sets its own form value.
        let value_unknown = interface
            .props
            .iter()
            .filter(|prop| prop.model)
            .any(|prop| {
                !models.contains_key(&prop.name)
                    && element.attributes.iter().any(|attribute| {
                        let given = attribute.name.split(':').next().unwrap_or_default();
                        attribute.name != crate::parser::SPREAD && camel_cow(given) == prop.name
                    })
            })
            || matches!(spread_keys, SpreadKeys::Unknown);
        // It imports formValue from the runtime (the word in a comment or a string doesn't count).
        let own_form_value = child.ast.script.imports.iter().any(|import| {
            import.specifier == "@zubra/runtime"
                && import
                    .text
                    .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
                    .any(|word| word == "formValue")
        });
        if child.ast.form_associated && !value_unknown && !own_form_value {
            if let Some(input) = fallback_input(&attributes, &interface, &models) {
                children.push(input);
            }
        }
        Ok(Node::Element(ir::Element {
            name: Cow::Borrowed(element.name.as_str()),
            attributes,
            children,
        }))
    }

    /// `class:name` and `style:name`, merged into the `class` and `style` attributes. A value only
    /// the browser knows (partial rendering) is left for the element to set.
    fn lower_directives(
        &self,
        element: &'t ast::Element,
        attributes: &mut Vec<ir::Attribute<'t>>,
        state: &LowerState<'a, 't>,
    ) -> Result<(), Diagnostic> {
        let mut classes = Vec::new();
        let mut styles = Vec::new();
        for attribute in &element.attributes {
            let AttributeValue::Expression(expression, span) = &attribute.value else {
                continue;
            };
            let lower = ascii_lowercase(&attribute.name);
            let Some((kind, _)) = lower
                .split_once(':')
                .filter(|(kind, _)| *kind == "class" || *kind == "style")
            else {
                continue;
            };
            let Some(value) = self.evaluate_known(expression, *span, state)? else {
                continue;
            };
            if kind == "class" {
                if expression::is_truthy(&value) {
                    classes.push(attribute.name[6..].to_owned());
                }
                continue;
            }
            if value.is_null() || value == Value::Bool(false) {
                continue;
            }
            let text = expression::to_display_string(&value)
                .map_err(|message| Diagnostic::new(crate::codes::VALUE_NOT_TEXT, *span, message))?;
            if !is_safe_css_value(&text) {
                return Err(Diagnostic::new(crate::codes::UNSAFE_CSS_VALUE,
                    *span,
                    format!("`{}`'s value `{text}` isn't a single CSS value (it can't contain `;`, braces, `<`, a backslash, or url())", attribute.name),
                ));
            }
            styles.push(format!("{}: {text}", &attribute.name[6..]));
        }
        let mut merge = |name: &str, extra: Vec<String>, separator: &str| {
            if extra.is_empty() {
                return;
            }
            let joined = extra.join(separator);
            match attributes
                .iter_mut()
                .find(|attribute| attribute.name.eq_ignore_ascii_case(name))
            {
                Some(attribute) => {
                    let mut parts = attribute.value.take().unwrap_or_default();
                    let existing = joined_parts(&parts);
                    let glue = if existing.trim().is_empty() {
                        ""
                    } else if separator == "; " && !existing.trim_end().ends_with(';') {
                        "; "
                    } else {
                        " "
                    };
                    parts.push(Part::Escaped(format!("{glue}{joined}")));
                    attribute.value = Some(parts);
                }
                None => attributes.push(ir::Attribute {
                    name: Cow::Owned(name.to_owned()),
                    value: Some(vec![Part::Escaped(joined)]),
                }),
            }
        };
        merge("class", classes, " ");
        merge("style", styles, "; ");
        Ok(())
    }

    /// `{...object}` in the HTML output: its entries as attributes, when the object is known at
    /// build time (otherwise left for the element), with the checks an attribute gets. Listeners
    /// and properties aren't markup; `class` merges; `style` is an object, and what it can't write is
    /// left out with a warning.
    fn lower_spread(
        &self,
        element: &'t ast::Element,
        attribute: &'t ast::Attribute,
        attributes: &mut Vec<ir::Attribute<'t>>,
        state: &LowerState<'a, 't>,
        props: &[String],
    ) -> Result<(), Diagnostic> {
        let AttributeValue::Expression(expression, span) = &attribute.value else {
            return Ok(());
        };
        let Some(value) = self.evaluate_known(expression, *span, state)? else {
            gap_attribute("{...}");
            return Ok(()); // set by the element
        };
        let entries = match value {
            Value::Null => return Ok(()),
            Value::Object(entries) => entries,
            other => {
                return Err(Diagnostic::new(
                    crate::codes::SPREAD_NOT_OBJECT,
                    *span,
                    format!(
                        "{{...}} spreads an object of attributes (found {})",
                        expression::type_name(&other)
                    ),
                ))
            }
        };
        let own: Vec<String> = element
            .attributes
            .iter()
            .filter(|other| other.name != crate::parser::SPREAD)
            .map(|other| other.name.to_ascii_lowercase())
            .collect();
        // A `<meta http-equiv>` already redirects or sets a policy. A spread may not supply
        // its `content`, including when `http-equiv` itself is in the spread and gets left out.
        let meta_content = element.name.eq_ignore_ascii_case("meta")
            && (element
                .attributes
                .iter()
                .any(|attr| attr.name.eq_ignore_ascii_case("http-equiv"))
                || entries
                    .iter()
                    .any(|(key, _)| key.eq_ignore_ascii_case("http-equiv")));
        for (key, value) in entries {
            if props.iter().any(|prop| spread_key_is_prop(&key, prop)) {
                continue; // a prop of the child, passed as one
            }
            let lower = key.to_ascii_lowercase();
            // A spread's object is data, often a visitor's: what it can't set is left out, as the
            // runtime leaves it out, not an error that would fail every render spreading it.
            if lower.len() > 2 && lower.starts_with("on") {
                if value.is_string() {
                    omit_name("a handler (pass a function, not text)", &key);
                }
                continue; // listeners exist only in the browser
            }
            if [
                "innerhtml",
                "outerhtml",
                "innertext",
                "textcontent",
                "srcdoc",
                "ping",
                "dangerouslysetinnerhtml",
                "children",
            ]
            .contains(&lower.as_str())
            {
                omit_name("one a spread may set", &key);
                continue;
            }
            let name = match lower.as_str() {
                "classname" => "class".to_owned(),
                "htmlfor" => "for".to_owned(),
                _ if lower.starts_with("aria-") || lower.starts_with("data-") => key.clone(),
                _ => lower.clone(),
            };
            if !is_attribute_name(&name) {
                omit_name("an attribute name", &key);
                continue;
            }
            if spread_never_sets(&element.name, &name) || (meta_content && name == "content") {
                omit_name("one a spread may set here", &key);
                continue;
            }
            if name == "style" {
                let Value::Object(properties) = value else {
                    if !value.is_null() && value != Value::Bool(false) {
                        omit_name(
                            "an object of CSS properties, which a spread's `style` is",
                            &key,
                        );
                    }
                    continue;
                };
                let mut declarations = Vec::new();
                for (property, value) in properties {
                    if value.is_null() || value == Value::Bool(false) {
                        continue;
                    }
                    let css = if property.starts_with("--") {
                        property.clone()
                    } else {
                        kebab_case(&property)
                    };
                    if !is_css_property_name(&css) {
                        omit_name("a CSS property name", &property);
                        continue;
                    }
                    if own.contains(&format!("style:{css}")) {
                        continue;
                    }
                    // A value, maybe a visitor's: one that isn't a single CSS value is left out
                    // (as the runtime leaves it out), not an error failing every render.
                    let Some(text) = expression::to_display_string(&value)
                        .ok()
                        .filter(|text| is_safe_css_value(text))
                    else {
                        omit_css_value(&css, &value);
                        continue;
                    };
                    declarations.push(format!("{css}: {text}"));
                }
                if !declarations.is_empty() {
                    merge_attribute(attributes, "style", &declarations.join("; "), "; ");
                }
                continue;
            }
            if name == "class" {
                let text = expression::to_display_string(&value).map_err(|message| {
                    Diagnostic::new(crate::codes::VALUE_NOT_TEXT, *span, message)
                })?;
                if !text.trim().is_empty() {
                    merge_attribute(attributes, "class", text.trim(), " ");
                }
                continue;
            }
            if own.contains(&name.to_ascii_lowercase())
                || attributes
                    .iter()
                    .any(|existing| existing.name.eq_ignore_ascii_case(&name))
            {
                continue; // the element's own attribute wins
            }
            let rendered = match &value {
                Value::Null | Value::Bool(false) if !name.starts_with("aria-") => continue,
                Value::Bool(true) if !name.starts_with("aria-") => None,
                Value::Bool(flag) => Some(flag.to_string()),
                Value::Array(_) | Value::Object(_) => {
                    return Err(Diagnostic::new(
                        crate::codes::SPREAD_VALUE,
                        *span,
                        format!("a spread can't write an object to the `{name}` attribute"),
                    ));
                }
                other => Some(expression::to_display_string(other).map_err(|message| {
                    Diagnostic::new(crate::codes::VALUE_NOT_TEXT, *span, message)
                })?),
            };
            if let Some(text) = &rendered {
                let lower_name = name.to_ascii_lowercase();
                if URL_ATTRIBUTES.contains(&lower_name.as_str()) || lower_name == "srcset" {
                    if text.trim().is_empty() {
                        continue;
                    }
                    // A value, not the author's text: left out, as the browser leaves it out.
                    let safe = if lower_name == "srcset" {
                        is_safe_srcset(text)
                    } else {
                        is_safe_url(text)
                    };
                    if !safe {
                        omit_unsafe(&name, text);
                        continue;
                    }
                }
            }
            attributes.push(ir::Attribute {
                name: name.into(),
                value: rendered.map(|text| vec![Part::Escaped(text)]),
            });
        }
        Ok(())
    }

    fn lower_attribute(
        &self,
        attribute: &'t ast::Attribute,
        state: &LowerState<'a, 't>,
        custom_element: bool,
    ) -> Result<Option<ir::Attribute<'t>>, Diagnostic> {
        let lower = ascii_lowercase(&attribute.name);
        if lower == "ref" || lower.starts_with("class:") || lower.starts_with("style:") {
            // References exist only in the browser; directives are merged by lower_directives.
            return Ok(None);
        }
        if crate::parser::is_event_attribute(&lower)
            && matches!(attribute.value, AttributeValue::Expression(..))
        {
            // Handlers are functions: they exist only in the JavaScript output. (A handler
            // written as text can only be in server-rendered slot HTML, which is kept.)
            return Ok(None);
        }
        let is_boolean = BOOLEAN_ATTRIBUTES.contains(&&*lower);
        let is_url = URL_ATTRIBUTES.contains(&&*lower);
        let is_srcset = lower == "srcset" || lower == "imagesrcset";
        let value = match &attribute.value {
            AttributeValue::None => None,
            AttributeValue::Text(parts) => {
                let Some(lowered) = self.lower_known_parts(parts, state)? else {
                    gap_attribute(&attribute.name);
                    return Ok(None); // set by the element
                };
                let dynamic = parts
                    .iter()
                    .any(|part| matches!(part, AstPart::Expression { .. }));
                // A URL built from values: an unsafe one is left out of the HTML, as the
                // element leaves it out (and says so in the console) when it starts. Values can
                // come from a page's users; one of them must not be able to fail the render.
                if is_url && dynamic && !is_safe_url(&joined(&lowered)) {
                    omit_unsafe(&attribute.name, &joined(&lowered));
                    return Ok(None);
                }
                if is_srcset && dynamic {
                    let text = joined(&lowered);
                    if text.trim().is_empty() {
                        return Ok(None);
                    }
                    if !is_safe_srcset(&text) {
                        omit_unsafe(&attribute.name, &text);
                        return Ok(None);
                    }
                }
                Some(lowered)
            }
            AttributeValue::Expression(expression, span) => {
                let Some(value) = self.evaluate_known(expression, *span, state)? else {
                    gap_attribute(&attribute.name);
                    return Ok(None); // set by the element
                };
                if is_boolean {
                    return match value {
                        Value::Bool(true) => Ok(Some(ir::Attribute { name: Cow::Borrowed(attribute.name.as_str()), value: None })),
                        Value::Bool(false) => Ok(None),
                        other => Err(Diagnostic::new(crate::codes::BOOLEAN_ATTRIBUTE_VALUE,
                            *span,
                            format!(
                                "`{}` is a boolean attribute, so {{…}} must be true or false (found {})",
                                attribute.name,
                                expression::type_name(&other)
                            ),
                        )),
                    };
                }
                if value.is_null() {
                    return Ok(None);
                }
                // Custom elements take arrays and objects as JSON attributes.
                let text = match &value {
                    Value::Array(_) | Value::Object(_) if custom_element => {
                        serde_json::to_string(&value).expect("JSON serializes")
                    }
                    _ => expression::to_display_string(&value).map_err(|message| {
                        Diagnostic::new(crate::codes::VALUE_NOT_TEXT, *span, message)
                    })?,
                };
                // An unsafe value is left out, as the browser leaves it out (see above).
                if is_url && !is_safe_url(&text) {
                    omit_unsafe(&attribute.name, &text);
                    return Ok(None);
                }
                // No candidates yet (a prop's "" default): no attribute. An unsafe one: left out.
                if is_srcset && text.trim().is_empty() {
                    return Ok(None);
                }
                if is_srcset && !is_safe_srcset(&text) {
                    omit_unsafe(&attribute.name, &text);
                    return Ok(None);
                }
                Some(vec![Part::Escaped(text)])
            }
        };
        Ok(Some(ir::Attribute {
            name: Cow::Borrowed(attribute.name.as_str()),
            value,
        }))
    }
}

/// HTML ignores a `value` attribute on `<select>` and `<textarea>`, so before JavaScript the
/// page would show the wrong choice or an empty box. In the HTML output, a select's value
/// marks the matching `<option selected>` (by its `value`, or its text when it has none), and a
/// textarea's value becomes its content. (The element sets the `value` property when it starts.)
fn form_value_as_html(element: &mut ir::Element) {
    // Compared without a lowered copy: this runs for every element of every render.
    let textarea = element.name.eq_ignore_ascii_case("textarea");
    if !textarea && !element.name.eq_ignore_ascii_case("select") {
        return;
    }
    let Some(position) = element
        .attributes
        .iter()
        .position(|attribute| attribute.name.eq_ignore_ascii_case("value"))
    else {
        return;
    };
    let value = element
        .attributes
        .remove(position)
        .value
        .map(|parts| joined(&parts))
        .unwrap_or_default();
    if textarea {
        element.children = vec![Node::Text(Part::Escaped(value).into())];
        return;
    }
    fn text(nodes: &[Node]) -> String {
        nodes
            .iter()
            .map(|node| match node {
                Node::Text(parts) => joined(parts),
                Node::Element(element) => text(&element.children),
                _ => String::new(),
            })
            .collect()
    }
    fn mark(nodes: &mut [Node], value: &str) {
        for node in nodes {
            let Node::Element(element) = node else {
                continue;
            };
            match element.name.to_ascii_lowercase().as_str() {
                "optgroup" => mark(&mut element.children, value),
                "option" => {
                    let own = element
                        .attributes
                        .iter()
                        .find(|attribute| attribute.name.eq_ignore_ascii_case("value"))
                        .map(|attribute| {
                            attribute.value.as_deref().map(joined).unwrap_or_default()
                        });
                    let matches = match own {
                        Some(own) => own == value,
                        None => {
                            text(&element.children)
                                .split_whitespace()
                                .collect::<Vec<_>>()
                                .join(" ")
                                == value
                        }
                    };
                    element
                        .attributes
                        .retain(|attribute| !attribute.name.eq_ignore_ascii_case("selected"));
                    if matches {
                        element.attributes.push(ir::Attribute {
                            name: "selected".into(),
                            value: None,
                        });
                    }
                }
                _ => {}
            }
        }
    }
    mark(&mut element.children, &value);
}

/// Add `text` to an attribute (`class`, `style`), or add the attribute.
fn merge_attribute(attributes: &mut Vec<ir::Attribute>, name: &str, text: &str, separator: &str) {
    match attributes
        .iter_mut()
        .find(|attribute| attribute.name.eq_ignore_ascii_case(name))
    {
        Some(attribute) => {
            let mut parts = attribute.value.take().unwrap_or_default();
            let existing = joined_parts(&parts);
            let glue = if existing.trim().is_empty() {
                ""
            } else if separator == "; " && existing.trim_end().ends_with(';') {
                " "
            } else {
                separator
            };
            parts.push(Part::Escaped(format!("{glue}{text}")));
            attribute.value = Some(parts);
        }
        None => attributes.push(ir::Attribute {
            name: Cow::Owned(name.to_owned()),
            value: Some(vec![Part::Escaped(text.to_owned())]),
        }),
    }
}

/// Where `source` (a template expression) calls one of `names` with no arguments, as byte ranges
/// in source order: found in the parsed expression, so a name in a string, a template literal's
/// text or a comment isn't a call.
fn hydrated_calls(source: &str, names: &[String]) -> Vec<(usize, usize)> {
    use oxc_ast::ast::{CallExpression, Expression as Js};
    use oxc_ast_visit::{walk, Visit};

    struct Calls<'n> {
        names: &'n [String],
        found: Vec<(usize, usize)>,
    }
    impl<'a> Visit<'a> for Calls<'_> {
        fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
            if let Js::Identifier(callee) = &call.callee {
                if call.arguments.is_empty()
                    && self.names.iter().any(|name| callee.name == name.as_str())
                {
                    self.found
                        .push((call.span.start as usize, call.span.end as usize));
                    return;
                }
            }
            walk::walk_call_expression(self, call);
        }
    }
    if names.is_empty() || !names.iter().any(|name| source.contains(name.as_str())) {
        return Vec::new();
    }
    let allocator = oxc_allocator::Allocator::default();
    let Ok(expression) =
        oxc_parser::Parser::new(&allocator, source, oxc_span::SourceType::mjs()).parse_expression()
    else {
        return Vec::new();
    };
    let mut calls = Calls {
        names,
        found: Vec::new(),
    };
    calls.visit_expression(&expression);
    calls.found.sort_unstable();
    calls.found
}

/// The hidden input that stands in for a form-associated child's value before JavaScript: its
/// `name` attribute, and its one two-way prop's value (given, or its default). None when there's
/// nothing to submit, as a native control with no name or an empty value submits nothing.
fn fallback_input<'t>(
    attributes: &[ir::Attribute<'t>],
    interface: &Interface,
    overrides: &serde_json::Map<String, Value>,
) -> Option<Node<'t>> {
    let name = attributes
        .iter()
        .find(|attribute| attribute.name.eq_ignore_ascii_case("name"))
        .and_then(|attribute| attribute.value.as_deref())
        .map(joined)
        .filter(|name| !name.is_empty())?;
    let mut models = interface.props.iter().filter(|prop| prop.model);
    let model = models.next()?;
    if models.next().is_some() {
        return None; // which one the form gets is the component's to say
    }
    let value = overrides
        .get(&model.name)
        .cloned()
        .or_else(|| model.default.clone())?;
    let text = match &value {
        Value::Null | Value::Bool(false) => return None,
        Value::Bool(true) => "on".to_owned(),
        Value::String(text) if text.is_empty() => return None,
        Value::Array(_) | Value::Object(_) => serde_json::to_string(&value).ok()?,
        other => expression::to_display_string(other).ok()?,
    };
    let attribute = |name: &str, value: String| ir::Attribute {
        name: Cow::Owned(name.to_owned()),
        value: Some(vec![Part::Escaped(value)]),
    };
    Some(Node::Element(ir::Element {
        name: Cow::Borrowed("input"),
        attributes: vec![
            attribute("type", "hidden".to_owned()),
            attribute("name", name),
            attribute("value", text),
            ir::Attribute {
                name: Cow::Borrowed("data-zb-fallback"),
                value: None,
            },
        ],
        children: Vec::new(),
    }))
}

/// `fontSize` → `font-size`.
fn kebab_case(name: &str) -> String {
    let mut out = String::new();
    for character in name.chars() {
        if character.is_ascii_uppercase() {
            out.push('-');
            out.push(character.to_ascii_lowercase());
        } else {
            out.push(character);
        }
    }
    out
}

fn joined_parts(parts: &[Part]) -> String {
    joined(parts)
}

/// One CSS value, safe to write into a style attribute: nothing that ends the declaration, opens
/// a block, escapes, or loads a URL.
fn is_safe_css_value(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    !text.contains([';', '{', '}', '<', '\\'])
        && !lower.contains("url(")
        && !lower.contains("image(")
        && !lower.contains("image-set(")
        && !lower.contains("expression(")
        && !lower.contains("@import")
}

fn joined(parts: &[Part]) -> String {
    parts
        .iter()
        .map(|part| match part {
            Part::Literal(text) => html_escape::decode_html_entities(text).into_owned(),
            Part::Escaped(text) => text.clone(),
        })
        .collect()
}

/// SVG `<set>` and `<animate>` can animate any attribute, `href` included, to the URL in their
/// `to`, `from`, `by` or `values`, which no URL check sees. A value from data there could make
/// a link `javascript:`, so it's a compile error, as in `srcdoc`; a literal one that animates
/// a URL attribute is checked like that attribute.
fn check_animation_value(
    element: &ast::Element,
    attribute: &ast::Attribute,
) -> Result<(), Diagnostic> {
    let tag = ascii_lowercase(&element.name);
    let lower = ascii_lowercase(&attribute.name);
    if !matches!(&*tag, "set" | "animate") || !matches!(&*lower, "to" | "from" | "by" | "values") {
        return Ok(());
    }
    match &attribute.value {
        AttributeValue::Expression(..) => Err(Diagnostic::new(crate::codes::UNSAFE_INTERPOLATION,
            attribute.span,
            format!("interpolation in <{tag} {lower}> is not supported: it can animate a link to a URL nothing checks"),
        )),
        AttributeValue::Text(parts) if parts.iter().any(|part| matches!(part, AstPart::Expression { .. })) => Err(Diagnostic::new(crate::codes::UNSAFE_INTERPOLATION,
            attribute.span,
            format!("interpolation in <{tag} {lower}> is not supported: it can animate a link to a URL nothing checks"),
        )),
        AttributeValue::Text(parts) => {
            let animates_url = element.attributes.iter().any(|other| {
                other.name.eq_ignore_ascii_case("attributename")
                    && matches!(&other.value, AttributeValue::Text(name) if URL_ATTRIBUTES.iter().any(|url| literal_text(name).trim().eq_ignore_ascii_case(url)))
            });
            let text = literal_text(parts);
            if animates_url && text.split(';').any(|value| !is_safe_url(value)) {
                return Err(Diagnostic::new(crate::codes::UNSAFE_URL, attribute.span, format!("unsafe URL in <{tag} {lower}>")));
            }
            Ok(())
        }
        AttributeValue::None => Ok(()),
    }
}

/// `<meta http-equiv="refresh" content="0;url={next}">` is a redirect to wherever the value
/// says, and other `http-equiv`s set the page's policies: their `content`, and `http-equiv`
/// itself, are the author's text only.
fn check_meta_value(element: &ast::Element, attribute: &ast::Attribute) -> Result<(), Diagnostic> {
    if !element.name.eq_ignore_ascii_case("meta") {
        return Ok(());
    }
    let dynamic = match &attribute.value {
        AttributeValue::Expression(..) => true,
        AttributeValue::Text(parts) => parts
            .iter()
            .any(|part| matches!(part, AstPart::Expression { .. })),
        AttributeValue::None => false,
    };
    let lower = ascii_lowercase(&attribute.name);
    let equiv = element
        .attributes
        .iter()
        .any(|other| other.name.eq_ignore_ascii_case("http-equiv"));
    if dynamic && (lower == "http-equiv" || (lower == "content" && equiv)) {
        return Err(Diagnostic::new(crate::codes::UNSAFE_INTERPOLATION,
            attribute.span,
            format!("interpolation in <meta http-equiv> `{lower}` is not supported: a refresh there is a redirect to wherever the value says"),
        )
        .with_help("redirect on the server (a `load` can return redirect(…)), or write the value in the template"));
    }
    Ok(())
}

/// The text of an attribute with no expressions in it.
fn literal_text(parts: &[AstPart]) -> String {
    parts
        .iter()
        .map(|part| match part {
            AstPart::Literal(text) => text.as_str(),
            _ => "",
        })
        .collect()
}

/// Checks that don't depend on values, applied to every branch.
fn check_attribute_statically(attribute: &ast::Attribute) -> Result<(), Diagnostic> {
    let lower = ascii_lowercase(&attribute.name);
    let dynamic_text = matches!(&attribute.value, AttributeValue::Text(parts)
        if parts.iter().any(|part| matches!(part, AstPart::Expression { .. })));
    let dynamic = dynamic_text || matches!(attribute.value, AttributeValue::Expression(..));
    if lower == "srcdoc" && dynamic {
        return Err(Diagnostic::new(
            crate::codes::UNSAFE_INTERPOLATION,
            attribute.span,
            "interpolation in srcdoc is not supported",
        ));
    }
    // `ping` makes every click on the link POST to the URLs it lists, with the visitor's cookies
    // when they are this site's (`/account/delete`): the template's text only.
    if lower == "ping" && dynamic {
        return Err(Diagnostic::new(crate::codes::UNSAFE_INTERPOLATION,
            attribute.span,
            "interpolation in ping is not supported: a click posts to every URL it lists, with the visitor's cookies",
        ));
    }
    if lower == "srcset" || lower == "imagesrcset" {
        // A dynamic srcset is checked candidate by candidate once its value is known: when
        // rendering on the server (lower_attribute) and in the browser (the runtime's isSafeSrcset).
        if dynamic {
            return Ok(());
        }
        return validate_srcset(attribute);
    }
    if BOOLEAN_ATTRIBUTES.contains(&&*lower) && dynamic_text {
        return Err(Diagnostic::new(
            crate::codes::BOOLEAN_ATTRIBUTE_VALUE,
            attribute.span,
            format!(
                "`{}` is a boolean attribute; bind it with {}={{…}} instead of quoted text",
                attribute.name, attribute.name
            ),
        ));
    }
    if URL_ATTRIBUTES.contains(&&*lower) {
        match &attribute.value {
            AttributeValue::None => {
                return Err(Diagnostic::new(
                    crate::codes::UNSAFE_URL,
                    attribute.span,
                    format!("URL attribute `{}` requires a value", attribute.name),
                ));
            }
            AttributeValue::Text(parts) if !dynamic_text => {
                let text: String = parts
                    .iter()
                    .map(|part| match part {
                        AstPart::Literal(text) => text.as_str(),
                        AstPart::Expression { .. } => "",
                    })
                    .collect();
                if !is_safe_url(&text) {
                    return Err(Diagnostic::new(
                        crate::codes::UNSAFE_URL,
                        attribute.span,
                        format!("unsafe URL in `{}` attribute", attribute.name),
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// A srcset's value: every candidate's URL is safe. Empty candidates (a trailing comma) are
/// skipped, as browsers do; a value with no candidate at all is rejected.
pub fn is_safe_srcset(value: &str) -> bool {
    let mut urls = value
        .split(',')
        .filter_map(|candidate| candidate.split_whitespace().next())
        .peekable();
    urls.peek().is_some() && urls.all(is_safe_url)
}

fn validate_srcset(attribute: &ast::Attribute) -> Result<(), Diagnostic> {
    let AttributeValue::Text(parts) = &attribute.value else {
        return Err(Diagnostic::new(
            crate::codes::UNSAFE_URL,
            attribute.span,
            "srcset requires a list of safe URL candidates",
        ));
    };
    let source: String = parts
        .iter()
        .map(|part| match part {
            AstPart::Literal(text) => text.as_str(),
            AstPart::Expression { .. } => "",
        })
        .collect();
    let candidates = source.split(',').collect::<Vec<_>>();
    if candidates.iter().any(|candidate| {
        candidate
            .split_whitespace()
            .next()
            .is_none_or(|url| !is_safe_url(url))
    }) {
        return Err(Diagnostic::new(
            crate::codes::UNSAFE_URL,
            attribute.span,
            "srcset contains an unsafe or empty URL candidate",
        ));
    }
    Ok(())
}

pub(crate) fn collect_slots(nodes: &[ast::Node], slots: &mut HashSet<String>) {
    for node in nodes {
        match node {
            ast::Node::Element(element) => collect_slots(&element.children, slots),
            ast::Node::If {
                consequent,
                alternate,
                ..
            } => {
                collect_slots(consequent, slots);
                collect_slots(alternate, slots);
            }
            ast::Node::Each { children, .. } | ast::Node::Else { children, .. } => {
                collect_slots(children, slots)
            }
            ast::Node::Await {
                pending,
                then,
                catch,
                ..
            } => {
                collect_slots(pending, slots);
                for branch in then.iter().chain(catch) {
                    collect_slots(&branch.children, slots);
                }
            }
            ast::Node::Settled { branch, .. } => collect_slots(&branch.children, slots),
            ast::Node::Slot { name, fallback, .. } => {
                slots.insert(name.clone());
                collect_slots(fallback, slots);
            }
            ast::Node::Text(_) => {}
        }
    }
}

/// `max-value` → `maxValue`.
pub(crate) fn camel(name: &str) -> String {
    camel_cow(name).into_owned()
}

/// [`camel`], borrowing a name that has no `-` (most attributes: `status`, `rows`).
pub(crate) fn camel_cow(name: &str) -> Cow<'_, str> {
    if !name.contains('-') {
        return Cow::Borrowed(name);
    }
    let mut output = String::new();
    let mut upper = false;
    for character in name.chars() {
        if character == '-' {
            upper = true;
        } else if upper {
            output.push(character.to_ascii_uppercase());
            upper = false;
        } else {
            output.push(character);
        }
    }
    Cow::Owned(output)
}

/// Attributes any element may carry, which aren't component props.
pub(crate) fn is_global_attribute(name: &str) -> bool {
    matches!(
        name,
        "id" | "class"
            | "slot"
            | "part"
            | "exportparts"
            | "title"
            | "hidden"
            | "lang"
            | "dir"
            | "tabindex"
            | "role"
            | "inert"
            | "autofocus"
            | "nonce"
            | "draggable"
            | "translate"
            | "is"
            | "name"
    ) || name.starts_with("data-")
        || name.starts_with("aria-")
}

/// Content for a named slot of a shadow-DOM component: each top-level element gets
/// `slot="name"` so the browser projects it; top-level text can't be assigned to a named slot.
fn assign_to_slot<'t>(
    name: &str,
    nodes: Vec<Node<'t>>,
    span: Span,
) -> Result<Vec<Node<'t>>, Diagnostic> {
    if name == "default" {
        return Ok(nodes);
    }
    nodes
        .into_iter()
        .map(|node| match node {
            Node::Element(mut element) => {
                element
                    .attributes
                    .retain(|attribute| attribute.name != "slot");
                element.attributes.push(ir::Attribute {
                    name: Cow::Borrowed("slot"),
                    value: Some(vec![Part::Literal(Cow::Owned(name.to_owned()))]),
                });
                Ok(Node::Element(element))
            }
            Node::Text(parts)
                if parts.iter().all(|part| match part {
                    Part::Literal(text) => text.trim().is_empty(),
                    Part::Escaped(text) => text.trim().is_empty(),
                }) =>
            {
                Ok(Node::Text(parts))
            }
            _ => Err(Diagnostic::new(
                crate::codes::SHADOW_NAMED_SLOT_TEXT,
                span,
                format!(
                    "content for the named slot `{name}` of a shadow component must be elements"
                ),
            )),
        })
        .collect()
}

fn validate_custom_element(tag: &str, span: Span) -> Result<(), Diagnostic> {
    let valid = tag.contains('-')
        && !tag.starts_with("xml")
        && tag
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && tag.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
        });
    if !valid || RESERVED_CUSTOM_ELEMENTS.contains(&tag) {
        let mut diagnostic = Diagnostic::new(
            crate::codes::INVALID_TAG_NAME,
            span,
            format!("`{tag}` is not a valid custom-element name"),
        );
        if !tag.contains('-') {
            diagnostic = diagnostic.with_help(format!(
                "custom element names need a hyphen, e.g. `{}-element`: the HTML spec reserves hyphen-less names for built-in elements (https://html.spec.whatwg.org/#valid-custom-element-name)",
                tag.to_ascii_lowercase()
            ));
        }
        return Err(diagnostic);
    }
    Ok(())
}

pub fn is_safe_url(value: &str) -> bool {
    let value = html_escape::decode_html_entities(value);
    // A browser reads `\` as `/` in an http(s) URL, so `/\evil.example` is `//evil.example`.
    let value = value.trim().replace('\\', "/");
    let value = value.as_str();
    if value.is_empty() || value.chars().any(char::is_control) || value.starts_with("//") {
        return false;
    }
    // A numeric reference without its `;` (`&#106avascript:`, `javascript&#58alert(1)`) isn't
    // decoded above, but a browser decodes it in an attribute. Before the path it can only be
    // hiding a scheme, so it's refused (cut at `/` and `?` only: `#` is part of the reference).
    if value
        .split(['/', '?'])
        .next()
        .unwrap_or_default()
        .contains("&#")
    {
        return false;
    }
    let before_path = value.split(['/', '?', '#']).next().unwrap_or_default();
    if let Some((scheme, _)) = before_path.split_once(':') {
        return matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto" | "tel"
        );
    }
    true
}

// ---- using a child component ---------------------------------------------------------------
//
// The checks both backends run on `<zb-child …>`, from the child's interface alone.

/// A listener for a near miss of one of the child's events is a typo: it would never run.
/// Other names may be native events, or bubble up from further inside.
pub(crate) fn check_child_event(
    tag: &str,
    interface: &Interface,
    attribute: &ast::Attribute,
) -> Result<(), Diagnostic> {
    let lower = ascii_lowercase(&attribute.name);
    if !crate::parser::is_event_attribute(&lower) {
        return Ok(());
    }
    let base = lower.split('.').next().unwrap_or(&lower);
    let event = &base[2..];
    if NATIVE_EVENTS.contains(&event)
        || interface
            .events
            .iter()
            .any(|declared| declared.name == event)
    {
        return Ok(());
    }
    let names: Vec<&str> = interface
        .events
        .iter()
        .map(|declared| declared.name.as_str())
        .collect();
    let error = with_suggestion(
        Diagnostic::new(
            crate::codes::UNKNOWN_EVENT,
            attribute.span,
            format!("<{tag}> never fires `{event}`"),
        ),
        event,
        &names,
    );
    if error.help.is_some() {
        Err(error)
    } else {
        Ok(())
    }
}

/// A value for a child's prop must have the type of the prop's default.
pub(crate) fn check_child_prop_type(
    tag: &str,
    prop: &PropInterface,
    value: &Value,
    span: Span,
) -> Result<(), Diagnostic> {
    match &prop.default {
        // A declared type (`declare const value: number | null`) says more than the default.
        _ if prop.declared.is_some() => Ok(()),
        Some(default) if !same_type(default, value) => Err(Diagnostic::new(
            crate::codes::PROP_TYPE_MISMATCH,
            span,
            format!(
                "<{tag}> prop `{}` must be {} (like its default), found {}",
                prop.name,
                expression::type_name(default),
                expression::type_name(value)
            ),
        )),
        _ => Ok(()),
    }
}

/// An expression attribute that isn't one of the child's props (nor a global, data-/aria- or
/// event attribute).
pub(crate) fn unknown_child_prop(
    tag: &str,
    interface: &Interface,
    attribute: &ast::Attribute,
) -> Diagnostic {
    let prop_name = camel(&attribute.name);
    let names: Vec<&str> = interface
        .props
        .iter()
        .map(|prop| prop.name.as_str())
        .collect();
    with_suggestion(
        Diagnostic::new(
            crate::codes::UNKNOWN_PROP,
            attribute.span,
            format!("<{tag}> has no prop `{prop_name}`"),
        ),
        &prop_name,
        &names,
    )
}

pub(crate) fn is_unknown_child_attribute(
    interface: &Interface,
    attribute: &ast::Attribute,
) -> bool {
    let lower = ascii_lowercase(&attribute.name);
    let prop_name = camel(&attribute.name);
    attribute.name != crate::parser::SPREAD
        && !interface.props.iter().any(|prop| prop.name == prop_name)
        && matches!(attribute.value, AttributeValue::Expression(..))
        && !crate::parser::is_event_attribute(&lower)
        && !is_global_attribute(&lower)
        && !is_host_directive(&lower)
}

/// `class:name` and `style:property` set the child's host element, as on any element: they're
/// not props.
pub(crate) fn is_host_directive(lower: &str) -> bool {
    lower.starts_with("class:") || lower.starts_with("style:")
}

/// What the `{...spread}`s on a component's tag are known to give at build time.
pub(crate) enum SpreadKeys {
    /// At least one spread is only known in the browser: it may give anything.
    Unknown,
    /// Every spread is known (or there is none): the keys they give a value other than `null`.
    Known(Vec<String>),
}

impl SpreadKeys {
    /// From the tag alone: a spread whose expression reads no name is known, any other isn't.
    /// (The HTML backend knows more, since it has the parent's props and state.)
    pub(crate) fn of(element: &ast::Element) -> Self {
        let mut keys = Vec::new();
        for (expression, _) in spreads_of(element) {
            let mut free = false;
            expression.for_each_identifier(&mut |_| free = true);
            match expression.evaluate(&|_| None) {
                Ok(Value::Object(entries)) if !free => keys.extend(
                    entries
                        .into_iter()
                        .filter(|(_, value)| !value.is_null())
                        .map(|(key, _)| key),
                ),
                Ok(Value::Null) if !free => {}
                _ => return Self::Unknown,
            }
        }
        Self::Known(keys)
    }
}

/// The `{...spread}` expressions on a tag, in order.
pub(crate) fn spreads_of(element: &ast::Element) -> impl Iterator<Item = (&Expression, Span)> {
    element
        .attributes
        .iter()
        .filter_map(|attribute| match &attribute.value {
            AttributeValue::Expression(expression, span)
                if attribute.name == crate::parser::SPREAD =>
            {
                Some((expression, *span))
            }
            _ => None,
        })
}

/// Every required prop of the child must be given: written on the tag, or by a `{...spread}`.
/// A spread only the browser knows may give it, so nothing is required of the tag then; a
/// spread known at build time has to have the key.
pub(crate) fn check_child_required(
    tag: &str,
    interface: &Interface,
    element: &ast::Element,
    spreads: &SpreadKeys,
) -> Result<(), Diagnostic> {
    let SpreadKeys::Known(keys) = spreads else {
        return Ok(());
    };
    for prop in &interface.props {
        let given = element.attributes.iter().any(|attribute| {
            attribute.name != crate::parser::SPREAD && camel_cow(&attribute.name) == prop.name
        }) || keys.iter().any(|key| spread_key_is_prop(key, &prop.name));
        if prop.required() && !given {
            return Err(Diagnostic::new(
                crate::codes::MISSING_REQUIRED_PROP,
                element.span,
                format!("<{tag}> requires the prop `{}`", prop.attribute),
            ));
        }
    }
    Ok(())
}

/// Globals a component script can read in the browser (a binding that uses one is runtime-only).
pub(crate) const RUNTIME_GLOBALS: &[&str] = &[
    "window",
    "self",
    "globalThis",
    "document",
    "navigator",
    "location",
    "history",
    "screen",
    "localStorage",
    "sessionStorage",
    "performance",
    "crypto",
    "console",
    "matchMedia",
    "Date",
    "Math",
    "JSON",
    "Number",
    "String",
    "Boolean",
    "Array",
    "Object",
    "Symbol",
    "BigInt",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "WeakRef",
    "Promise",
    "Intl",
    "URL",
    "URLSearchParams",
    "Reflect",
    "Proxy",
    "Error",
    "RegExp",
    "Infinity",
    "NaN",
    "Signal",
    "customElements",
    "structuredClone",
    "queueMicrotask",
    "requestAnimationFrame",
    "setTimeout",
    "setInterval",
    "fetch",
    "Event",
    "CustomEvent",
    "AbortController",
    "parseInt",
    "parseFloat",
    "encodeURIComponent",
    "encodeURI",
    "decodeURIComponent",
    "decodeURI",
];

/// Common DOM events an element can receive, so a listener for one is never taken for a typo.
const NATIVE_EVENTS: &[&str] = &[
    "abort",
    "animationend",
    "animationiteration",
    "animationstart",
    "auxclick",
    "beforeinput",
    "beforetoggle",
    "blur",
    "cancel",
    "change",
    "click",
    "close",
    "contextmenu",
    "copy",
    "cut",
    "dblclick",
    "drag",
    "dragend",
    "dragenter",
    "dragleave",
    "dragover",
    "dragstart",
    "drop",
    "error",
    "focus",
    "focusin",
    "focusout",
    "formdata",
    "input",
    "invalid",
    "keydown",
    "keypress",
    "keyup",
    "load",
    "mousedown",
    "mouseenter",
    "mouseleave",
    "mousemove",
    "mouseout",
    "mouseover",
    "mouseup",
    "paste",
    "pointercancel",
    "pointerdown",
    "pointerenter",
    "pointerleave",
    "pointermove",
    "pointerout",
    "pointerover",
    "pointerup",
    "reset",
    "resize",
    "scroll",
    "scrollend",
    "select",
    "selectionchange",
    "slotchange",
    "submit",
    "toggle",
    "touchcancel",
    "touchend",
    "touchmove",
    "touchstart",
    "transitionend",
    "wheel",
];

// ---- suggestions ---------------------------------------------------------------------------

pub(crate) fn with_suggestion(
    diagnostic: Diagnostic,
    name: &str,
    candidates: &[&str],
) -> Diagnostic {
    let best = candidates
        .iter()
        .filter(|candidate| **candidate != name)
        .map(|candidate| (edit_distance(name, candidate), *candidate))
        .filter(|(distance, candidate)| *distance <= (candidate.len().max(name.len()) / 3).max(1))
        .min();
    match best {
        Some((_, candidate)) => diagnostic.with_help(format!("did you mean `{candidate}`?")),
        None => diagnostic,
    }
}

/// Edit distance counting an adjacent swap as one edit (`nmae` → `name`), the commonest typo.
pub(crate) fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut table = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in table.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in table[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (table[i - 1][j] + 1)
                .min(table[i][j - 1] + 1)
                .min(table[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(table[i - 2][j - 2] + 1);
            }
            table[i][j] = best;
        }
    }
    table[a.len()][b.len()]
}

/// The names an `as` binds: itself, or a pattern's names.
fn bound_names(text: &str) -> Vec<String> {
    if crate::ast::is_pattern(text) {
        crate::ast::bindings(text)
            .map(|names| names.into_iter().map(|(name, _)| name).collect())
            .unwrap_or_default()
    } else {
        vec![text.trim().to_owned()]
    }
}

/// An `as` bound to a value known at build time: each name with the part of the value its path
/// reaches (`null` where the value has no such property or index, as JavaScript gives
/// `undefined`).
/// As [`destructure`], for a value that is ours to keep: a plain name takes it as it is,
/// without a copy (each row of a list, once per row).
/// A row's names (`as="row"`, or a pattern's) and their values, onto the end of `scope`.
fn destructure_entry<'t, 'v>(
    text: &'t str,
    value: Cow<'v, Value>,
    scope: &mut Vec<(Cow<'t, str>, Cow<'v, Value>)>,
) {
    if crate::ast::is_pattern(text) {
        scope.extend(
            destructure(text, &value)
                .into_iter()
                .map(|(name, value)| (Cow::Owned(name), Cow::Owned(value))),
        );
    } else {
        scope.push((Cow::Borrowed(text.trim()), value));
    }
}

/// A `zb-each` key, to tell two rows with one key apart without writing it out as text. Each
/// kind of number stays its own, as their JSON did (`1` and `1.0`, `0.0` and `-0.0`, are
/// different keys).
#[derive(PartialEq, Eq, Hash)]
enum RowKey<'v> {
    Unsigned(u64),
    Signed(i64),
    Float(u64),
    Text(Cow<'v, str>),
}

impl<'v> RowKey<'v> {
    /// The key; the value's type name when it can't be one.
    fn of(value: Cow<'v, Value>) -> Result<Self, &'static str> {
        Ok(match value {
            Cow::Borrowed(Value::String(text)) => RowKey::Text(Cow::Borrowed(text)),
            Cow::Owned(Value::String(text)) => RowKey::Text(Cow::Owned(text)),
            Cow::Borrowed(Value::Number(number)) => RowKey::number(number),
            Cow::Owned(Value::Number(number)) => RowKey::number(&number),
            other => return Err(expression::type_name(&other)),
        })
    }

    fn number(number: &serde_json::Number) -> Self {
        if let Some(n) = number.as_u64() {
            RowKey::Unsigned(n)
        } else if let Some(n) = number.as_i64() {
            RowKey::Signed(n)
        } else {
            RowKey::Float(number.as_f64().unwrap_or_default().to_bits())
        }
    }

    /// As the key's JSON reads (for a duplicate's error).
    fn shown(&self) -> String {
        match self {
            RowKey::Unsigned(n) => n.to_string(),
            RowKey::Signed(n) => n.to_string(),
            RowKey::Float(bits) => Value::from(f64::from_bits(*bits)).to_string(),
            RowKey::Text(text) => Value::from(text.as_ref()).to_string(),
        }
    }
}

fn destructure(text: &str, value: &Value) -> Vec<(String, Value)> {
    if !crate::ast::is_pattern(text) {
        return vec![(text.trim().to_owned(), value.clone())];
    }
    crate::ast::bindings(text)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, path)| {
            let mut current = value;
            for step in &path {
                current = match (step, current) {
                    (crate::ast::Step::Key(key), Value::Object(map)) => {
                        map.get(key).unwrap_or(&Value::Null)
                    }
                    (crate::ast::Step::Index(index), Value::Array(list)) => {
                        list.get(*index).unwrap_or(&Value::Null)
                    }
                    _ => &Value::Null,
                };
            }
            (name, current.clone())
        })
        .collect()
}

/// Whether a spread's key names `prop` (`isOpen` or `is-open`, in any case).
pub(crate) fn spread_key_is_prop(key: &str, prop: &str) -> bool {
    let normalize = |name: &str| name.replace('-', "").to_ascii_lowercase();
    normalize(key) == normalize(prop)
}

/// `name` in lowercase, copied only when it has an uppercase letter (names rarely do, and this
/// runs for every attribute of every element rendered).
fn ascii_lowercase(name: &str) -> Cow<'_, str> {
    if name.bytes().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Owned(name.to_ascii_lowercase())
    } else {
        Cow::Borrowed(name)
    }
}
