//! The JavaScript backend: a module that defines the custom element.
//!
//! The output is a template plus a list of *parts* — the places in that template that change —
//! each with the expression that computes it:
//!
//! ```js
//! export default $define("zb-header", {
//!   props: { title: { attribute: "title", default: "Mikey Nichols" } },
//!   template: "\n  <header>…<h1></h1>…</header>\n",
//!   setup($p) {
//!     /* the component's <script>, verbatim */
//!     return [{ path: [0, 0, 0], text: () => $t($p.title) }];
//!   },
//! });
//! ```
//!
//! A fresh element clones the template; an element whose markup came from the server is walked
//! by the same paths, so hydration binds to the existing DOM instead of re-rendering it. Paths
//! count only elements and comments: the browser merges and drops text nodes, so text can't be
//! addressed by position. Dynamic text that is an element's only child is bound through that
//! element; dynamic text beside other nodes follows an empty-comment anchor (emitted by both
//! backends — see `validate::needs_text_anchor`).

use crate::{
    ast::{self, AttributeValue, ComponentAst, Node, Part},
    diagnostic::{Diagnostic, Span},
    expression::Expression,
    parser::is_event_attribute,
    validate::{self, needs_text_anchor, Interface, BOOLEAN_ATTRIBUTES, URL_ATTRIBUTES},
};

pub(crate) const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

pub struct Options<'a> {
    /// Module specifier the output imports the runtime from.
    pub runtime: &'a str,
    /// Shown in the generated header comment.
    pub source_name: &'a str,
    /// Rewrite `.zb` imports to this extension (`".js"` for CLI output); `None` keeps them,
    /// for bundler plugins that load `.zb` files themselves.
    pub component_extension: Option<&'a str>,
    /// How the `<style>` reaches the page: `None` inlines it in the module; `Some` imports it
    /// through the bundler's CSS pipeline (so Tailwind, PostCSS and preprocessors run on it).
    pub style_imports: Option<StyleImports<'a>>,
    /// Where a light-DOM component's stylesheet is served, for a page that already carries it
    /// (a server's `<style>` in the head): the module then has the address and not the text
    /// (`stylesHref`, with `inPage`), and the runtime fetches it only for an element that turns
    /// up inside a shadow root, where the page's CSS doesn't reach. A shadow component keeps
    /// its text: every one of its roots needs the sheet at once.
    pub styles_href: Option<&'a str>,
    /// For the browser DevTools (`--devtools`): the component's path, recorded with its host tag's
    /// location as the definition's `source`, with each part's line and column in it (`at`) and the script's
    /// signals by name (`$dev`). `None` emits none of it.
    pub devtools: Option<&'a str>,
    /// Import each block's and slot's binder from its own entry (`@zubra/runtime/each`, …) in
    /// place of the runtime's main one: for a server that maps `@zubra/runtime` to the core and
    /// sends a page only the binders its components use (`@zubra/server`).
    pub binder_entries: bool,
    /// For an app that never renders on a server (`--client-only`; @zubra/unplugin's
    /// `hydrate: false`): leave out what takes over server markup (`hydrating: $hydrate`), so a
    /// bundler leaves the runtime's `hydrate.js` out too. Such an element renders fresh over any
    /// children it starts with, treating them as the page's own.
    pub client_only: bool,
}

/// Module specifiers for a component's stylesheet, as the bundler serves it.
#[derive(Clone, Copy, Debug)]
pub struct StyleImports<'a> {
    /// Imported for its side effect: the bundler adds the CSS to the page (light DOM).
    pub stylesheet: &'a str,
    /// Imported as a string, for a shadow root (Vite's `?inline`).
    pub inline: &'a str,
}

/// `<zb-window>` and `<zb-document>`: listeners on the window or document while rendered.
pub(crate) fn is_global_listener(name: &str) -> bool {
    name.eq_ignore_ascii_case("zb-window") || name.eq_ignore_ascii_case("zb-document")
}

pub fn emit(component: &ComponentAst, options: &Options<'_>) -> Result<String, Diagnostic> {
    let interface = validate::analyze(component)?;
    for name in &interface.script_names {
        if name.starts_with('$') {
            return Err(Diagnostic::new(
                crate::codes::RESERVED_NAME,
                component.tag_span,
                format!("`{name}`: names starting with $ are reserved for compiled code"),
            ));
        }
    }
    let children = child_infos(component)?;
    // 2.0's script semantics: props by name, `let` as state, derived `const`s.
    let prop_names: Vec<String> = interface
        .props
        .iter()
        .map(|prop| prop.name.clone())
        .collect();
    // The local names `state`, `computed` and `inject` have, imported from the runtime.
    let makers: Vec<String> = component
        .script
        .imports
        .iter()
        .filter(|import| import.specifier == "@zubra/runtime")
        .flat_map(|import| {
            let names = import
                .text
                .split_once('{')
                .and_then(|(_, rest)| rest.split_once('}'))
                .map_or("", |(names, _)| names);
            names
                .split(',')
                .filter_map(|name| {
                    let mut words = name.split_whitespace();
                    let imported = words.next()?;
                    let local = match (words.next(), words.next()) {
                        (Some("as"), Some(local)) => local,
                        _ => imported,
                    };
                    // `__zubra…` names come from JSX lowering, which writes its own `.get()`s.
                    (matches!(
                        imported,
                        "state" | "computed" | "inject" | "hasSlot" | "hydrated"
                    ) && !local.starts_with("__zubra"))
                    .then(|| local.to_owned())
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // Every name the script's imports bind (the body has them taken out), and its module-level
    // declarations, which are plain names in the same way.
    let imported: Vec<String> = component
        .script
        .imports
        .iter()
        .flat_map(|import| crate::reactive::imported_names(&import.text))
        .chain(module_names(component))
        .collect();
    let script = crate::reactive::rewrite_script(
        &component.script.body,
        &prop_names,
        &makers,
        &imported,
        &component.script.from,
        &component.script.resource,
        component
            .script
            .start
            .unwrap_or(crate::diagnostic::Span::new(1, 1)),
    )?;
    let mut emitter = Emitter {
        state: &script.state,
        derived: &script.derived,
        signals: &script.signals,
        interface: &interface,
        children: &children,
        shadow: component.shadow,
        scopes: Vec::new(),
        base: Vec::new(),
        trail: Vec::new(),
        template: String::new(),
        parts: Vec::new(),
        slot_paths: Vec::new(),
        locations: options.devtools.is_some(),
        span: None,
    };
    emitter.nodes(&component.nodes, &[], false)?;

    let mut out = String::new();
    out.push_str(&format!(
        "// Generated by zubra from {}. Do not edit.\nimport {{ $component as $define, $r, $t }} from {};\n",
        options.source_name,
        json(options.runtime)
    ));
    // `@zubra/runtime` → `@zubra/runtime/<entry>`; a file (`/vendor/zubra/index.js`) → its sibling.
    let entry = |name: &str| match options.runtime.rsplit_once('/') {
        Some((directory, file)) if file.ends_with(".js") || file.ends_with(".mjs") => {
            format!("{directory}/{name}.js")
        }
        _ => format!("{}/{name}", options.runtime.trim_end_matches('/')),
    };
    for import in &component.script.imports {
        let mut text = import.text.clone();
        // The script's own runtime imports come from where the module's do (`runtime`): one
        // copy of the runtime, and no bare specifier left for an import map to resolve.
        if options.runtime != RUNTIME {
            let rewritten = if import.specifier == RUNTIME {
                Some(options.runtime.to_owned())
            } else {
                import
                    .specifier
                    .strip_prefix(RUNTIME)
                    .and_then(|rest| rest.strip_prefix('/'))
                    .map(entry)
            };
            if let Some(rewritten) = rewritten {
                text.replace_range(import.specifier_range.clone(), &json(&rewritten));
            }
        }
        // A component import loads the compiled module, which defines the element.
        if let (Some(extension), Some(component)) = (
            options.component_extension,
            crate::components::component_extension(&import.specifier),
        ) {
            let rewritten = format!(
                "{}{extension}",
                &import.specifier[..import.specifier.len() - component.len()]
            );
            text.replace_range(import.specifier_range.clone(), &json(&rewritten));
        }
        out.push_str(&text);
        if !text.trim_end().ends_with(';') {
            out.push(';');
        }
        out.push('\n');
    }
    if !script.state.is_empty() || !script.derived.is_empty() {
        out.push_str(&format!(
            "import {{ state as {}, computed as {} }} from {};\n",
            crate::reactive::STATE,
            crate::reactive::COMPUTED,
            json(options.runtime)
        ));
    }
    // The stylesheet: inlined, or through the bundler.
    let mut styles = None;
    let mut in_page = false;
    let mut href = None;
    // A light-DOM component whose stylesheet the bundler puts in the page: no text in the module.
    let mut from_page = false;
    if let Some(style) = &component.style {
        match options.style_imports {
            Some(imports) if component.shadow => {
                out.push_str(&format!("import $styles from {};\n", json(imports.inline)));
                styles = Some("$styles".to_owned());
            }
            Some(imports) => {
                // Light DOM: the bundler puts the CSS in the page, and that's the only copy. An
                // element inside someone else's shadow root (a Lit app, say), where page CSS
                // doesn't reach, gets this component's rules copied from the page's stylesheets
                // (`stylesFromPage`, the runtime's `$pageStyles`).
                out.push_str(&format!("import {};\n", json(imports.stylesheet)));
                from_page = true;
                in_page = true;
            }
            None => {
                if let Some(lang) = &style.lang {
                    return Err(Diagnostic::new(crate::codes::STYLE_LANG_NEEDS_BUNDLER,
                        style.span,
                        format!("`<style lang=\"{lang}\">` needs a bundler to compile it: use @zubra/unplugin (Vite)"),
                    ));
                }
                styles = crate::styles::stylesheet(component).map(|css| json(&css));
                if let (Some(address), false, true) =
                    (options.styles_href, component.shadow, styles.is_some())
                {
                    href = Some(json(address));
                }
            }
        }
    }
    // `export enum`s, lowered: the module exports them for its consumers.
    for declaration in &component.script.module_declarations {
        out.push('\n');
        out.push_str(declaration.text.trim_end_matches(';'));
        out.push_str(";\n");
    }
    out.push_str(&format!(
        "\nexport const tag = {};\n\nexport default $define(tag, {{\n  props: {{\n",
        json(&component.tag)
    ));
    for prop in &interface.props {
        let default = prop
            .default
            .as_ref()
            .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
        // An enum prop's attribute takes a member's value or its name.
        let members = validate::enum_literal(component, &prop.name)
            .map_or_else(String::new, |members| format!(", enum: {members}"));
        out.push_str(&format!(
            "    {}: {{ attribute: {}, default: {default}, required: {}{}{members} }},\n",
            json(&prop.name),
            json(&prop.attribute),
            prop.required(),
            if prop.model { ", model: true" } else { "" }
        ));
    }
    let mut slots: Vec<String> = {
        let mut names = std::collections::HashSet::new();
        validate::collect_slots(&component.nodes, &mut names);
        names.into_iter().collect()
    };
    slots.sort();
    let list =
        |names: &mut dyn Iterator<Item = &str>| names.map(json).collect::<Vec<_>>().join(", ");
    out.push_str(&format!(
        "  }},\n  abi: 5,\n  shadow: {},\n  form: {},\n{}{}{}  slots: [{}],\n{}  events: [{}],\n{}{}{}  template: {},\n  setup($p, $emit{}) {{\n",
        component.shadow,
        component.form_associated,
        // A form-associated component imports the form controls' API and callbacks; every
        // component, what takes over server markup, unless its app never renders on a server.
        if component.form_associated {
            "  forming: $form,\n"
        } else {
            ""
        },
        if options.client_only {
            ""
        } else {
            "  hydrating: $hydrate,\n"
        },
        // A shadow component's root, sheets and slot following.
        if component.shadow {
            "  shadowing: $shadow,\n"
        } else {
            ""
        },
        list(&mut slots.iter().map(String::as_str)),
        // A light-DOM component with slots imports what places content in them; one without
        // keeps the page's children out of sight with what the runtime always has.
        if !component.shadow && !slots.is_empty() {
            "  slotting: $slotted,\n"
        } else {
            ""
        },
        list(&mut interface.events.iter().map(|event| event.name.as_str())),
        // `roots`: what server markup for a template that is only regions starts with.
        region_roots(&component.nodes).map_or_else(String::new, |roots| format!(
            "  roots: [{}],\n",
            roots.iter().map(|name| json(name)).collect::<Vec<_>>().join(", ")
        )),
        // `--devtools`: the file and the host tag's place in it, for the panel's "Open in editor".
        options.devtools.map_or_else(String::new, |path| format!(
            "  source: {{ file: {}, at: [{}, {}] }},\n",
            json(path),
            component.tag_span.line,
            component.tag_span.column
        )),
        // `styled`: the runtime marks slotted content, where light-DOM styles stop.
        match (component.style.is_some(), styles) {
            (false, _) => String::new(),
            (true, None) if from_page => {
                "  styled: true,\n  stylesFromPage: $pageStyles,\n  inPage: true,\n".to_owned()
            }
            (true, None) => "  styled: true,\n".to_owned(),
            (true, Some(_)) if href.is_some() => format!(
                "  styled: true,\n  stylesHref: {},\n  inPage: true,\n",
                href.as_deref().unwrap_or_default()
            ),
            (true, Some(styles)) if in_page => format!("  styled: true,\n  styles: {styles},\n  inPage: true,\n"),
            (true, Some(styles)) => format!("  styled: true,\n  styles: {styles},\n"),
        },
        json(&emitter.template),
        // `$dev` comes after `$initial`, so a DevTools build names both.
        if options.devtools.is_some() { ", $initial, $dev" }
        else if interface.props.iter().any(|prop| prop.runtime_default.is_some()) { ", $initial" }
        else { "" }
    ));
    // `emit` from the runtime, bound to this element (handlers call it long after setup).
    if let Some(emit) = &component.script.emit {
        out.push_str(&format!("    const {emit} = $emit;\n"));
    }
    if !script.state.is_empty() {
        out.push_str(crate::reactive::HELPERS);
    }
    let body = script.body.trim_matches('\n');
    if !body.trim().is_empty() {
        out.push_str(body);
        out.push('\n');
    }
    // Defaults that use script values: computed now, unless the prop was already given.
    for prop in &interface.props {
        if let Some(default) = &prop.runtime_default {
            let runtime = default.is_runtime();
            let rewritten =
                reactive_expression(default, &script.state, &script.derived, &script.signals);
            let default = rewritten.as_ref().unwrap_or(default);
            let value = default.to_js_with(&|name| {
                if runtime {
                    name.to_owned()
                } else {
                    format!("$r({name})")
                }
            });
            out.push_str(&format!(
                "    $initial({}, () => {value});\n",
                json(&prop.name)
            ));
        }
    }
    // 'use collection': the state's fields are a document in a local store (@zubra/sync), keyed
    // by props; `ephemeral()` state stays out.
    if let Some(collection) = &component.script.collection {
        let fields: Vec<&str> = script
            .state
            .iter()
            .filter(|name| {
                !component.script.ephemeral.contains(name)
                    && !component.script.presence.contains(name)
                    && component.script.peers.as_ref() != Some(*name)
            })
            .map(String::as_str)
            .collect();
        let mut call = format!(
            "{COLLECTION}({}, {}, $p, {{ {} }}",
            json(&collection.name),
            serde_json::to_string(&collection.keys).unwrap_or_default(),
            fields.join(", ")
        );
        // Presence and peers only when the script uses them, so tier 0 stays one call.
        if !component.script.presence.is_empty() || component.script.peers.is_some() {
            call.push_str(&format!(
                ", {{ {} }}, {}",
                component.script.presence.join(", "),
                component.script.peers.as_deref().unwrap_or("null")
            ));
        }
        out.push_str(&format!("    {call});\n"));
    }
    // `--devtools`: the script's signals by name, for the panel (the runtime passes `$dev` only
    // in development).
    if options.devtools.is_some() {
        let mut names: Vec<&str> = Vec::new();
        for name in script
            .state
            .iter()
            .chain(&script.derived)
            .chain(&script.signals)
        {
            if !names.contains(&name.as_str()) {
                names.push(name);
            }
        }
        out.push_str(&format!("    $dev?.({{ {} }});\n", names.join(", ")));
    }
    out.push_str("    return [\n");
    for part in &emitter.parts {
        out.push_str("      ");
        out.push_str(&part.render());
        out.push_str(",\n");
    }
    out.push_str("    ];\n  },\n});\n");
    if component.script.collection.is_some() {
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        out.insert_str(
            header_end,
            &format!(
                "import {{ collection as {COLLECTION} }} from {};\n",
                json(crate::script::SYNC)
            ),
        );
    }
    // A block's or slot's binder (interface 5) is imported from the runtime only when a part names
    // it, so a bundler leaves out the binders an app's components don't use. (The module still
    // calls `$define`, the runtime's `$component` by another name: tools that rewrite
    // `export default $define(` in compiled output, older ones included, keep working.)
    let mut binders: Vec<&str> = [
        "$when",
        "$await",
        "$each",
        "$slot",
        "$modified",
        "$global",
        "$classes",
        "$toggle",
        "$style",
    ]
    .into_iter()
    .filter(|binder| out.contains(&format!("binder: {binder},")))
    .collect();
    // A URL attribute's check.
    for check in ["$url", "$srcset"] {
        if out.contains(&format!(": {check} }}")) || out.contains(&format!(": {check},")) {
            binders.push(check);
        }
    }
    if out.contains("\n  slotting: $slotted,\n") {
        binders.push("$slotted");
    }
    if out.contains("\n  forming: $form,\n") {
        binders.push("$form");
    }
    if out.contains("\n  hydrating: $hydrate,\n") {
        binders.push("$hydrate");
    }
    if out.contains("\n  shadowing: $shadow,\n") {
        binders.push("$shadow");
    }
    if options.binder_entries {
        // One import per entry, in a fixed order: `$slot` and `$slotted` are both slots.js's.
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        let mut lines = String::new();
        for (file, names) in [
            ("when", &["$when"][..]),
            ("await", &["$await"]),
            ("each", &["$each"]),
            ("slots", &["$slot", "$slotted"]),
            ("modifiers", &["$modified"]),
            ("form", &["$form"]),
            ("hydrate", &["$hydrate"]),
            (
                "parts",
                &[
                    "$global", "$classes", "$toggle", "$style", "$url", "$srcset",
                ],
            ),
            ("shadow", &["$shadow"]),
        ] {
            let used: Vec<&str> = names
                .iter()
                .copied()
                .filter(|name| binders.contains(name))
                .collect();
            if !used.is_empty() {
                lines.push_str(&format!(
                    "import {{ {} }} from {};\n",
                    used.join(", "),
                    json(&entry(file))
                ));
            }
        }
        out.insert_str(
            header_end + out[header_end..].find('\n').map_or(0, |at| at + 1),
            &lines,
        );
    } else if !binders.is_empty() {
        let names = format!("$component as $define, $r, $t, {}", binders.join(", "));
        out = out.replacen(
            "import { $component as $define, $r, $t }",
            &format!("import {{ {names} }}"),
            1,
        );
    }
    // `stylesFromPage` (a bundler's light-DOM component): from the runtime's main entry, beside
    // the binders (after them: the line they're added to is matched whole).
    if from_page {
        out = out.replacen(
            "import { $component as $define, $r, $t",
            "import { $component as $define, $r, $t, $pageStyles",
            1,
        );
    }
    // A spread's binder comes from `@zubra/runtime/spread`, imported only when the template uses one.
    if out.contains(&format!("bind: {SPREAD_BINDER}")) {
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        out.insert_str(
            header_end,
            &format!(
                "import {{ spread as {SPREAD_BINDER} }} from {};\n",
                json(&entry("spread"))
            ),
        );
    }
    // An async `resource()` fetcher's `tracked()` comes from `@zubra/runtime/track`, likewise.
    if out.contains(&format!(
        "{}(({}) => (",
        crate::reactive::TRACKED,
        crate::reactive::RUN
    )) {
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        out.insert_str(
            header_end,
            &format!(
                "import {{ tracked as {} }} from {};\n",
                crate::reactive::TRACKED,
                json(&entry("track"))
            ),
        );
    }
    // `<zb-outlet>` (experimental) is defined by `@zubra/runtime/outlet`, imported for its side
    // effect when a template has one, so it's defined before the template sets its `item`.
    if out.contains("<zb-outlet") {
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        out.insert_str(header_end, &format!("import {};\n", json(&entry("outlet"))));
    }
    // `animate`'s leave and glide come from `@zubra/runtime/motion`, likewise.
    if out.contains(ANIMATE) {
        let header_end = out.find('\n').map_or(0, |at| at + 1);
        out.insert_str(
            header_end,
            &format!("import * as {MOTION} from {};\n", json(&entry("motion"))),
        );
    }
    Ok(out)
}

/// The runtime's package name: what a script imports it as, and the default for `runtime`.
const RUNTIME: &str = "@zubra/runtime";

/// The local name of `@zubra/runtime/motion` in compiled modules, and how a part that animates says so.
const MOTION: &str = "$motion";
const ANIMATE: &str = ", animate: $motion";

/// The local name of `@zubra/sync`'s binder in compiled modules.
const COLLECTION: &str = "$collection";

/// The local name of `@zubra/runtime/spread`'s binder in compiled modules.
const SPREAD_BINDER: &str = "$spread";

/// The children `component` imports, as its emitter needs them.
/// The checks the HTML backend runs on a child component's attributes, with the values known at
/// build time (literals); values from props and state are checked in the browser.
pub(crate) fn check_child(element: &ast::Element, info: &ChildInfo) -> Result<(), Diagnostic> {
    for attribute in &element.attributes {
        validate::check_child_event(&element.name, &info.interface, attribute)?;
        if validate::is_unknown_child_attribute(&info.interface, attribute) {
            return Err(validate::unknown_child_prop(
                &element.name,
                &info.interface,
                attribute,
            ));
        }
        let prop_name = validate::camel(&attribute.name);
        let Some(prop) = info
            .interface
            .props
            .iter()
            .find(|prop| prop.name == prop_name)
        else {
            continue;
        };
        let known = match &attribute.value {
            AttributeValue::None => Some((serde_json::Value::Bool(true), attribute.span)),
            AttributeValue::Text(parts)
                if parts.iter().all(|part| matches!(part, Part::Literal(_))) =>
            {
                let text: String = parts
                    .iter()
                    .map(|part| match part {
                        Part::Literal(text) => html_escape::decode_html_entities(text).into_owned(),
                        Part::Expression { .. } => String::new(),
                    })
                    .collect();
                Some((serde_json::Value::String(text), attribute.span))
            }
            AttributeValue::Text(_) => {
                Some((serde_json::Value::String(String::new()), attribute.span))
            }
            AttributeValue::Expression(expression, span) => {
                let mut free = false;
                expression.for_each_identifier(&mut |_| free = true);
                if free {
                    None
                } else {
                    expression
                        .evaluate(&|_| None)
                        .ok()
                        .map(|value| (value, *span))
                }
            }
        };
        if let Some((value, span)) = known {
            validate::check_child_prop_type(&element.name, prop, &value, span)?;
        }
    }
    // `{...spread}`: one that reads no name is known here, and is checked like written props
    // (its values' types, and that it gives what's required); one that reads a prop or state is
    // the browser's, and may give anything.
    for (expression, span) in validate::spreads_of(element) {
        let mut free = false;
        expression.for_each_identifier(&mut |_| free = true);
        let Ok(serde_json::Value::Object(entries)) = expression.evaluate(&|_| None) else {
            continue;
        };
        if free {
            continue;
        }
        for (key, value) in &entries {
            let written = |prop: &validate::PropInterface| {
                element.attributes.iter().any(|attribute| {
                    attribute.name != crate::parser::SPREAD
                        && validate::camel(&attribute.name) == prop.name
                })
            };
            if let Some(prop) = info
                .interface
                .props
                .iter()
                .find(|prop| validate::spread_key_is_prop(key, &prop.name))
            {
                if !value.is_null() && !written(prop) {
                    validate::check_child_prop_type(&element.name, prop, value, span)?;
                }
            }
        }
    }
    validate::check_child_required(
        &element.name,
        &info.interface,
        element,
        &validate::SpreadKeys::of(element),
    )
}

pub(crate) fn child_infos(
    component: &ComponentAst,
) -> Result<Vec<(String, ChildInfo)>, Diagnostic> {
    component
        .children
        .iter()
        .map(|child| {
            let info = (|| {
                let interface = validate::analyze(&child.ast)?;
                let grandchildren = child_infos(&child.ast)?;
                let mut emitter = Emitter {
                    state: &[],
                    derived: &[],
                    signals: &[],
                    interface: &interface,
                    children: &grandchildren,
                    shadow: child.ast.shadow,
                    scopes: Vec::new(),
                    base: Vec::new(),
                    trail: Vec::new(),
                    template: String::new(),
                    parts: Vec::new(),
                    slot_paths: Vec::new(),
                    locations: false,
                    span: None,
                };
                emitter.nodes(&child.ast.nodes, &[], false)?;
                let slot_paths = std::mem::take(&mut emitter.slot_paths);
                drop(emitter);
                Ok(ChildInfo {
                    props: interface
                        .props
                        .iter()
                        .map(|prop| prop.name.clone())
                        .collect(),
                    interface,
                    shadow: child.ast.shadow,
                    slot_paths,
                })
            })()
            .map_err(|error: Diagnostic| error.in_file(&child.path, &child.source))?;
            Ok((child.ast.tag.clone(), info))
        })
        .collect()
}

fn json(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

/// One part: where it is (`path` in a fresh template; `hydrate` where it sits in server markup
/// when that differs — content projected into a child component's slot) and what it does.
#[derive(Clone)]
struct JsPart {
    path: Vec<usize>,
    /// Where it can sit in server markup: one place, or (a child that puts the slot in more than
    /// one branch of a `zb-if`) one per branch, each to be checked against the markup.
    hydrate: Option<Vec<Place>>,
    body: String,
    /// Where in the `.zb` file the part was written (only with `--devtools`).
    at: Option<Span>,
}

impl JsPart {
    fn at(path: &[usize], body: String) -> Self {
        Self {
            path: path.to_vec(),
            hydrate: None,
            body,
            at: None,
        }
    }

    fn render(&self) -> String {
        let at = self.at.map_or_else(String::new, |span| {
            format!(", at: [{}, {}]", span.line, span.column)
        });
        match self.hydrate.as_deref() {
            // One place: its path, as every part with one has always been written.
            Some([place]) if place.kinds.is_empty() => format!(
                "{{ path: {}, hydrate: {}, {}{at} }}",
                path_js(&self.path),
                path_js(&place.path),
                self.body
            ),
            // Several, or one that may not be there: each with what its steps must lead to in the
            // markup; the runtime takes the first that matches (none: the element renders fresh).
            Some(places) => format!(
                "{{ path: {}, hydrate: [{}], {}{at} }}",
                path_js(&self.path),
                places
                    .iter()
                    .map(|place| format!(
                        "{{ path: {}, kinds: [{}] }}",
                        path_js(&place.path),
                        // Unchecked steps are holes (`[, "[", "a"]`), which `every` skips.
                        place
                            .kinds
                            .iter()
                            .map(|kind| kind.as_deref().map(json).unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                    .collect::<Vec<_>>()
                    .join(", "),
                self.body
            ),
            None => format!("{{ path: {}, {}{at} }}", path_js(&self.path), self.body),
        }
    }
}

/// A place a part can sit in server markup: its path, and, where that's in doubt, what some of
/// its steps must lead to (`kinds[i]` for step `i`: a tag name, `[` for a region, `[!` for a
/// filled slot's region; `None` for a step that isn't checked).
#[derive(Clone)]
struct Place {
    path: Vec<usize>,
    kinds: Vec<Option<String>>,
}

fn path_js(path: &[usize]) -> String {
    format!(
        "[{}]",
        path.iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// Where a node was written, for `--devtools`: a text node's first expression, an element's or a
/// directive's opening tag.
fn node_span(node: &Node) -> Option<Span> {
    match node {
        Node::Text(parts) => parts.iter().find_map(|part| match part {
            Part::Expression { span, .. } => Some(*span),
            Part::Literal(_) => None,
        }),
        Node::Element(element) => Some(element.span),
        Node::If { span, .. }
        | Node::Each { span, .. }
        | Node::Slot { span, .. }
        | Node::Else { span, .. }
        | Node::Await { span, .. } => Some(*span),
        Node::Settled { branch, .. } => Some(branch.span),
    }
}

/// What a parent needs to know about a child component it uses.
pub(crate) struct ChildInfo {
    pub(crate) interface: Interface,
    pub(crate) props: Vec<String>,
    pub(crate) shadow: bool,
    /// Where each slot region is in the child's template (light DOM only), for hydrate paths.
    slot_paths: Vec<SlotPlace>,
}

/// A slot's region in a component's template: the slot's name, its path, and what each step of
/// that path leads to in server markup (tag names, `[` for a region, `[!` for the slot's own).
#[derive(Clone)]
struct SlotPlace {
    name: String,
    path: Vec<usize>,
    trail: Vec<String>,
}

/// The elements that can be a top-level node of server markup for a template that is only regions
/// (an `zb-if`/`zb-else` whose branches are a `<button>` and an `<a>`, say), for the runtime to
/// tell such markup from the page's own content without waiting for `remark.js`. `None` when it
/// can't say: the template has top-level elements or text of its own (the runtime checks those),
/// or a region may hold content it can't name (a slot, an `zb-await`, a text-only branch).
fn region_roots(nodes: &[ast::Node]) -> Option<Vec<String>> {
    let blank = |parts: &[ast::Part]| {
        parts
            .iter()
            .all(|part| matches!(part, ast::Part::Literal(text) if text.trim().is_empty()))
    };
    let mut roots = std::collections::BTreeSet::new();
    let mut regions = false;
    for node in nodes {
        match node {
            ast::Node::Text(parts) if blank(parts) => {}
            ast::Node::If { .. } | ast::Node::Each { .. } => {
                regions = true;
                if !branch_roots(std::slice::from_ref(node), &mut roots) {
                    return None;
                }
            }
            _ => return None,
        }
    }
    (regions && !roots.is_empty()).then(|| roots.into_iter().collect())
}

/// Collect the top-level element names of a region's blocks into `roots`; false if one can't be
/// named (a block with text on its own has no element to recognise its markup by).
fn branch_roots(nodes: &[ast::Node], roots: &mut std::collections::BTreeSet<String>) -> bool {
    for node in nodes {
        let known = match node {
            ast::Node::Text(parts) => parts
                .iter()
                .all(|part| matches!(part, ast::Part::Literal(text) if text.trim().is_empty())),
            ast::Node::Element(element) => {
                roots.insert(element.name.to_ascii_lowercase());
                true
            }
            ast::Node::If {
                consequent,
                alternate,
                ..
            } => branch_roots(consequent, roots) && branch_roots(alternate, roots),
            ast::Node::Each { children, .. } => branch_roots(children, roots),
            _ => false,
        };
        if !known {
            return false;
        }
    }
    true
}

struct Emitter<'a> {
    /// The script's state (`let`) and derived `const`s, read with `.get()` in runtime
    /// expressions.
    state: &'a [String],
    derived: &'a [String],
    /// The script's signal `const`s (`computed()`, `inject()`, `state()`): read like values.
    signals: &'a [String],
    interface: &'a Interface,
    children: &'a [(String, ChildInfo)],
    /// Shadow-DOM components compile zb-slot to a native <slot>.
    shadow: bool,
    /// Loop variables in scope, innermost last.
    /// Names in scope in a branch or row, each with the JavaScript that reads it: `$r(item)`
    /// for a row's item, `$r($b1_0).name` for a name a destructuring `as` binds.
    scopes: Vec<(String, String)>,
    /// This emitter's position in the component template (non-empty inside zb-if blocks), so
    /// slot regions can be recorded with full paths.
    base: Vec<usize>,
    /// What each step of `base` and of the element path being emitted leads to in server markup:
    /// an element's tag name, or `[` for a region. Recorded with each slot's place, so a parent can
    /// tell the branch the server rendered from another that has a slot at the same place.
    trail: Vec<String>,
    template: String,
    parts: Vec<JsPart>,
    slot_paths: Vec<SlotPlace>,
    /// `--devtools`: stamp each part with `span`, where the markup it comes from was written.
    locations: bool,
    span: Option<Span>,
}

impl<'a> Emitter<'a> {
    /// Add a part, with its source location when compiling for the DevTools.
    fn part(&mut self, mut part: JsPart) {
        if self.locations {
            part.at = self.span;
        }
        self.parts.push(part);
    }

    /// A block's function parameters for its `params` (names or `as` patterns), and the
    /// emitter that reads them.
    fn scoped(&self, params: &[String]) -> (Vec<String>, Emitter<'a>) {
        let depth = self.scopes.len();
        let mut names = Vec::new();
        let mut entries = Vec::new();
        for (i, param) in params.iter().enumerate() {
            if crate::ast::is_pattern(param) {
                let hidden = format!("$b{depth}_{i}");
                for (name, path) in crate::ast::bindings(param).unwrap_or_default() {
                    let mut js = format!("$r({hidden})");
                    for step in path {
                        match step {
                            crate::ast::Step::Key(key) if crate::parser::is_identifier(&key) => {
                                js = format!("{js}.{key}")
                            }
                            crate::ast::Step::Key(key) => js = format!("{js}[{}]", json(&key)),
                            crate::ast::Step::Index(index) => js = format!("{js}[{index}]"),
                        }
                    }
                    entries.push((name, js));
                }
                names.push(hidden);
            } else {
                entries.push((param.clone(), format!("$r({param})")));
                names.push(param.clone());
            }
        }
        (names, self.child(&entries))
    }

    fn child(&self, extra: &[(String, String)]) -> Emitter<'a> {
        let mut scopes = self.scopes.clone();
        scopes.extend(extra.iter().cloned());
        Emitter {
            state: self.state,
            derived: self.derived,
            signals: self.signals,
            interface: self.interface,
            children: self.children,
            shadow: self.shadow,
            scopes,
            base: self.base.clone(),
            trail: self.trail.clone(),
            template: String::new(),
            parts: Vec::new(),
            slot_paths: Vec::new(),
            locations: self.locations,
            span: self.span,
        }
    }

    fn child_info(&self, tag: &str) -> Option<&'a ChildInfo> {
        self.children
            .iter()
            .find(|(child, _)| child.eq_ignore_ascii_case(tag))
            .map(|(_, info)| info)
    }

    /// An expression as JavaScript: loop variables and script names go through `$r`, which
    /// unwraps signals (rows hold their item as a signal; `const count = state(0)` makes `{count}`
    /// reactive); props read from `$p`, whose getters are signal-backed. Loop variables shadow
    /// props, props shadow script names — the same order the HTML backend resolves.
    ///
    /// A runtime expression (beyond the build-time subset) is script code: its script names
    /// mean what they mean in the script, so a `state()` is read with `.get()` there.
    fn js(&self, expression: &Expression) -> String {
        let runtime = expression.is_runtime();
        let rewritten = reactive_expression(expression, self.state, self.derived, self.signals);
        let expression = rewritten.as_ref().unwrap_or(expression);
        expression.to_js_with(&|name| {
            if let Some((_, js)) = self.scopes.iter().rev().find(|(scope, _)| scope == name) {
                js.clone()
            } else if self.interface.props.iter().any(|prop| prop.name == name) {
                format!("$p.{name}")
            } else if runtime {
                // A script name, or a browser global.
                name.to_owned()
            } else {
                format!("$r({name})")
            }
        })
    }

    /// An event listener part's fields: the event, its handler, and its modifiers.
    fn listener(&self, lower: &str, expression: &Expression) -> String {
        let (event, modifiers) = crate::parser::event_parts(lower).unwrap_or_default();
        let mut fields = format!(
            "on: {}, handler: () => {}",
            json(&event),
            self.js(expression)
        );
        if modifiers != crate::parser::Modifiers::default() {
            let mut flags = Vec::new();
            for (on, name) in [
                (modifiers.prevent, "prevent"),
                (modifiers.stop, "stop"),
                (modifiers.once, "once"),
                (modifiers.self_only, "self"),
                (modifiers.capture, "capture"),
                (modifiers.passive, "passive"),
                (modifiers.shift, "shift"),
                (modifiers.ctrl, "ctrl"),
                (modifiers.alt, "alt"),
                (modifiers.meta, "meta"),
                (modifiers.primary, "mod"),
                (modifiers.submit, "submit"),
            ] {
                if on {
                    flags.push(format!("{name}: true"));
                }
            }
            if !modifiers.keys.is_empty() {
                flags.push(format!(
                    "keys: [{}]",
                    modifiers
                        .keys
                        .iter()
                        .map(|key| json(key))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            fields.push_str(&format!(", modifiers: {{ {} }}", flags.join(", ")));
            // What a modifier does is in the runtime's `$modified` binder, imported only by a
            // component that has one.
            fields = format!("binder: $modified, {fields}");
        }
        fields
    }

    /// Text parts as one string-valued JavaScript expression.
    fn text_js(&self, parts: &[Part]) -> String {
        let pieces: Vec<String> = parts
            .iter()
            .filter_map(|part| match part {
                Part::Literal(text) if text.is_empty() => None,
                Part::Literal(text) => Some(json(&html_escape::decode_html_entities(text))),
                Part::Expression { expression, .. } => Some(format!("$t({})", self.js(expression))),
            })
            .collect();
        match pieces.as_slice() {
            [] => "\"\"".to_owned(),
            [only] if only.starts_with("$t(") => only.clone(),
            _ => pieces.join(" + "),
        }
    }

    /// A branch or row: its own template, and a function from its loop variables to its parts.
    fn block(
        &mut self,
        nodes: &[Node],
        params: &[String],
        at: &[usize],
    ) -> Result<String, Diagnostic> {
        self.block_with(nodes, params, &[], at)
    }

    /// A block whose `let:` names read their expressions (4.3): derived, so each read is the
    /// expression's current value.
    fn block_with(
        &mut self,
        nodes: &[Node],
        params: &[String],
        lets: &[ast::Let],
        at: &[usize],
    ) -> Result<String, Diagnostic> {
        let (params, mut block) = self.scoped(params);
        for binding in lets {
            let js = format!("({})", block.js(&binding.value));
            block.scopes.push((binding.name.clone(), js));
        }
        block.base = self.base.iter().chain(at).copied().collect();
        // The block sits in a region: `at`'s last step.
        block.trail = self.trail.iter().cloned().chain(["[".to_owned()]).collect();
        block.nodes(nodes, &[], true)?;
        self.slot_paths.append(&mut block.slot_paths);
        Ok(format!(
            "{{ template: {}, parts: ({}) => [{}] }}",
            json(&block.template),
            params.join(", "),
            block
                .parts
                .iter()
                .map(JsPart::render)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    /// `block_top`: these nodes are the top level of a branch or row (see
    /// `validate::needs_text_anchor`).
    fn nodes(&mut self, nodes: &[Node], path: &[usize], block_top: bool) -> Result<(), Diagnostic> {
        let mut index = 0;
        let mut next = |path: &[usize]| {
            let mut at = path.to_vec();
            at.push(index);
            index += 1;
            at
        };
        for node in nodes {
            self.span = node_span(node).or(self.span);
            match node {
                Node::Text(parts) => {
                    let dynamic = parts
                        .iter()
                        .any(|part| matches!(part, Part::Expression { .. }));
                    if !dynamic {
                        for part in parts {
                            if let Part::Literal(text) = part {
                                self.template.push_str(text);
                            }
                        }
                    } else if needs_text_anchor(nodes, node, block_top) {
                        self.template.push_str("<!---->");
                        let anchor = next(path);
                        self.part(JsPart::at(
                            &anchor,
                            format!("anchor: () => {}", self.text_js(parts)),
                        ));
                    } else {
                        // The element's only child: bind the element's text.
                        self.part(JsPart::at(
                            path,
                            format!("text: () => {}", self.text_js(parts)),
                        ));
                    }
                }
                Node::Element(element) if is_global_listener(&element.name) => {
                    // <zb-window>/<zb-document>: a placeholder comment, and listeners there.
                    self.template.push_str("<!---->");
                    let at = next(path);
                    let lower = element.name.to_ascii_lowercase();
                    let target = lower.strip_prefix("zb-").unwrap_or(&lower);
                    for attribute in &element.attributes {
                        if let AttributeValue::Expression(expression, _) = &attribute.value {
                            self.span = Some(attribute.span);
                            let lower = attribute.name.to_ascii_lowercase();
                            // Its binder: `$modified`'s (which listens on the window or document
                            // too) if it has modifiers, `$global` if not.
                            let listener = self.listener(&lower, expression);
                            let body = match listener.strip_prefix("binder: $modified, ") {
                                Some(rest) => {
                                    format!("binder: $modified, global: {}, {rest}", json(target))
                                }
                                None => {
                                    format!("binder: $global, global: {}, {listener}", json(target))
                                }
                            };
                            self.part(JsPart::at(&at, body));
                        }
                    }
                }
                Node::Element(element) => {
                    let element_path = next(path);
                    self.element(element, &element_path)?;
                }
                Node::If {
                    test,
                    consequent,
                    alternate,
                    animate,
                    ..
                } => {
                    // An empty region in the template; the branch is rendered (or found in
                    // server markup) at runtime.
                    self.template.push_str("<!--[--><!--]-->");
                    let region = next(path);
                    let yes = self.block(consequent, &[], &region)?;
                    let no = if alternate.is_empty() {
                        "null".to_owned()
                    } else {
                        self.block(alternate, &[], &region)?
                    };
                    let animate = if *animate { ANIMATE } else { "" };
                    let body = format!(
                        "binder: $when, when: () => {}, blocks: [{yes}, {no}]{animate}",
                        self.js(test)
                    );
                    self.part(JsPart::at(&region, body));
                }
                Node::Each {
                    items,
                    item,
                    index: position,
                    key,
                    lets,
                    children,
                    animate,
                    ..
                } => {
                    self.template.push_str("<!--[--><!--]-->");
                    let region = next(path);
                    let params = vec![
                        item.clone(),
                        position.clone().unwrap_or_else(|| "$index".to_owned()),
                    ];
                    let row = self.block_with(children, &params, lets, &region)?;
                    // The key gets plain values (not row signals): it identifies a row.
                    let key = match key {
                        Some((key, _)) => {
                            let (names, mut scoped) = self.scoped(&params);
                            for binding in lets.iter() {
                                let js = format!("({})", scoped.js(&binding.value));
                                scoped.scopes.push((binding.name.clone(), js));
                            }
                            format!(", key: ({}) => {}", names.join(", "), scoped.js(key))
                        }
                        None => String::new(),
                    };
                    let animate = if *animate { ANIMATE } else { "" };
                    let body = format!(
                        "binder: $each, each: () => {}{key}, block: {row}{animate}",
                        self.js(items)
                    );
                    self.part(JsPart::at(&region, body));
                }
                Node::Slot {
                    name,
                    fallback,
                    span,
                } => {
                    if self.shadow {
                        // The platform's own <slot>, with the fallback as its children.
                        let attributes = if name == "default" {
                            Vec::new()
                        } else {
                            vec![ast::Attribute {
                                name: "name".to_owned(),
                                value: AttributeValue::Text(vec![Part::Literal(name.clone())]),
                                span: *span,
                            }]
                        };
                        let slot = ast::Element {
                            name: "slot".to_owned(),
                            attributes,
                            children: fallback.clone(),
                            span: *span,
                        };
                        let slot_path = next(path);
                        self.element(&slot, &slot_path)?;
                    } else {
                        // A region the runtime fills with the host's own children for this slot,
                        // or with the fallback block.
                        self.template.push_str("<!--[--><!--]-->");
                        let region = next(path);
                        self.slot_paths.push(SlotPlace {
                            name: name.clone(),
                            path: self.base.iter().chain(&region).copied().collect(),
                            trail: self
                                .trail
                                .iter()
                                .cloned()
                                .chain(["[!".to_owned()])
                                .collect(),
                        });
                        let fallback = if fallback.is_empty() {
                            "null".to_owned()
                        } else {
                            self.block(fallback, &[], &region)?
                        };
                        let body =
                            format!("binder: $slot, slot: {}, fallback: {fallback}", json(name));
                        self.part(JsPart::at(&region, body));
                    }
                }
                Node::Else { span, .. } => {
                    return Err(Diagnostic::new(
                        crate::codes::DIRECTIVE_PLACEMENT,
                        *span,
                        "zb-else is only valid as a direct child of zb-if",
                    ));
                }
                Node::Await {
                    value,
                    pending,
                    then,
                    catch,
                    delay,
                    keep,
                    ..
                } => {
                    self.template.push_str("<!--[--><!--]-->");
                    let region = next(path);
                    let pending = self.block(pending, &[], &region)?;
                    let mut settled = Vec::new();
                    for (branch, unnamed) in [(then, "$value"), (catch, "$error")] {
                        settled.push(match branch {
                            Some(branch) => {
                                let name =
                                    branch.name.clone().unwrap_or_else(|| unnamed.to_owned());
                                // zb-catch's block also gets `retry` (4.2).
                                let mut params = vec![name];
                                if unnamed == "$error" {
                                    params.push("retry".to_owned());
                                }
                                self.block_with(&branch.children, &params, &branch.lets, &region)?
                            }
                            None => "null".to_owned(),
                        });
                    }
                    let mut body = format!(
                        "binder: $await, await: () => {}, blocks: [{pending}, {}, {}]",
                        self.js(value),
                        settled[0],
                        settled[1]
                    );
                    if let Some((delay, _)) = delay {
                        body.push_str(&format!(", delay: () => {}", self.js(delay)));
                    }
                    if *keep {
                        body.push_str(", keep: true");
                    }
                    self.part(JsPart::at(&region, body));
                }
                Node::Settled { caught, branch } => {
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

    fn element(&mut self, element: &ast::Element, path: &[usize]) -> Result<(), Diagnostic> {
        let child = self.child_info(&element.name);
        if let Some(info) = child {
            check_child(element, info)?;
        }
        let custom = element.name.contains('-');
        self.template.push('<');
        self.template.push_str(&element.name);
        // What the element binds itself, which a spread leaves alone (an explicit attribute wins).
        let own: Vec<String> = element
            .attributes
            .iter()
            .filter(|attribute| attribute.name != crate::parser::SPREAD)
            .map(|attribute| {
                let lower = attribute.name.to_ascii_lowercase();
                match lower.split_once('.') {
                    Some((name, _)) if is_event_attribute(name) => name.to_owned(),
                    _ => lower,
                }
            })
            .collect();
        for attribute in &element.attributes {
            self.span = Some(attribute.span);
            if attribute.name == crate::parser::SPREAD {
                let AttributeValue::Expression(expression, _) = &attribute.value else {
                    unreachable!("a spread is always an expression");
                };
                // `bind`: the code that applies it, from its own runtime entry, so components
                // without a spread don't load it.
                // On a component, the entries that are its props are set as props.
                let props = child.map_or_else(String::new, |child| {
                    let mut names: Vec<_> = child.props.iter().collect();
                    names.sort();
                    format!(
                        ", props: [{}]",
                        names
                            .iter()
                            .map(|name| json(name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                });
                let body = format!(
                    "spread: () => {}, own: [{}]{props}, bind: {SPREAD_BINDER}",
                    self.js(expression),
                    own.iter()
                        .map(|name| json(name))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                self.part(JsPart::at(path, body));
                continue;
            }
            let lower = attribute.name.to_ascii_lowercase();
            let prop = validate::camel(&lower);
            // A prop of a known child component: always passed as a property value.
            if let Some(child) = child.filter(|child| child.props.contains(&prop)) {
                let _ = child;
                let compute = match &attribute.value {
                    AttributeValue::None => "true".to_owned(),
                    AttributeValue::Text(parts) => self.text_js(parts),
                    AttributeValue::Expression(expression, _) => self.js(expression),
                };
                self.part(JsPart::at(
                    path,
                    format!("property: {}, value: () => {compute}", json(&prop)),
                ));
                continue;
            }
            match &attribute.value {
                AttributeValue::None => {
                    self.template.push(' ');
                    self.template.push_str(&attribute.name);
                }
                AttributeValue::Text(parts)
                    if parts.iter().all(|part| matches!(part, Part::Literal(_))) =>
                {
                    self.template.push(' ');
                    self.template.push_str(&attribute.name);
                    self.template.push_str("=\"");
                    for part in parts {
                        if let Part::Literal(text) = part {
                            let mut escaped = String::new();
                            crate::render::escape_attribute_literal(text, &mut escaped);
                            self.template.push_str(&escaped);
                        }
                    }
                    self.template.push('"');
                }
                AttributeValue::Expression(expression, _) if is_event_attribute(&lower) => {
                    let body = self.listener(&lower, expression);
                    self.part(JsPart::at(path, body));
                }
                AttributeValue::Expression(expression, _) if lower.starts_with("class:") => {
                    let body = format!(
                        "binder: $toggle, toggle: {}, value: () => {}",
                        json(&attribute.name[6..]),
                        self.js(expression)
                    );
                    self.part(JsPart::at(path, body));
                }
                AttributeValue::Expression(expression, _) if lower.starts_with("style:") => {
                    let body = format!(
                        "binder: $style, style: {}, value: () => {}",
                        json(&attribute.name[6..]),
                        self.js(expression)
                    );
                    self.part(JsPart::at(path, body));
                }
                AttributeValue::Expression(expression, _) if lower == "ref" => {
                    let body = format!("ref: () => {}", self.js(expression));
                    self.part(JsPart::at(path, body));
                }
                value
                    if lower == "class"
                        && element
                            .attributes
                            .iter()
                            .any(|other| other.name.to_ascii_lowercase().starts_with("class:")) =>
                {
                    // A computed class next to class: toggles: its tokens are added and removed
                    // one by one, so the toggles' classes stay.
                    let compute = match value {
                        AttributeValue::Text(parts) => self.text_js(parts),
                        AttributeValue::Expression(expression, _) => self.js(expression),
                        AttributeValue::None => unreachable!("handled above"),
                    };
                    self.part(JsPart::at(
                        path,
                        format!("binder: $classes, classes: () => {compute}"),
                    ));
                }
                value => {
                    let compute = match value {
                        AttributeValue::Text(parts) => self.text_js(parts),
                        AttributeValue::Expression(expression, _) => self.js(expression),
                        AttributeValue::None => unreachable!("handled above"),
                    };
                    let kind = if BOOLEAN_ATTRIBUTES.contains(&lower.as_str()) {
                        ", boolean: true".to_owned()
                    } else if URL_ATTRIBUTES.contains(&lower.as_str()) {
                        // The check itself, imported where a component has one.
                        ", url: $url".to_owned()
                    } else if lower == "srcset" || lower == "imagesrcset" {
                        ", srcset: $srcset".to_owned()
                    } else if custom
                        && child.is_none()
                        && matches!(value, AttributeValue::Expression(..))
                    {
                        // Another library's custom element: a property if it has one, else an
                        // attribute (React 19's rule).
                        format!(", prop: {}", json(&prop))
                    } else {
                        String::new()
                    };
                    let body = format!(
                        "attribute: {}{kind}, value: () => {compute}",
                        json(&attribute.name)
                    );
                    self.part(JsPart::at(path, body));
                }
            }
        }
        self.template.push('>');
        if VOID_ELEMENTS.contains(&element.name.to_ascii_lowercase().as_str()) {
            return Ok(());
        }
        match child {
            // Content for a light-DOM child component's slots: emitted here (it's this
            // component's markup, in this component's scope), with hydrate paths that follow
            // each node to where the child projected it in server markup.
            Some(info) if !info.shadow => {
                let units = content_units(&element.children);
                let mut content = self.child(&[]);
                content.nodes(&element.children, &[], true)?;
                self.template.push_str(&content.template);
                for part in content.parts {
                    let locals = part.hydrate.clone().unwrap_or_else(|| {
                        vec![Place {
                            path: part.path.clone(),
                            kinds: Vec::new(),
                        }]
                    });
                    let mut hydrate = Vec::new();
                    // Whether a place has to be checked against the markup: when this part had
                    // checks of its own, or the child has the slot in more than one place, or
                    // another of its slots at the same place (in another branch).
                    let mut checked = locals.iter().any(|local| !local.kinds.is_empty());
                    for local in locals {
                        let Some((first, rest)) = local.path.split_first() else {
                            // A part bound to the content's own parent: can't happen at block top.
                            hydrate.push(Place {
                                path: path.to_vec(),
                                kinds: Vec::new(),
                            });
                            continue;
                        };
                        let Some((slot, position)) = units.get(*first) else {
                            return Err(Diagnostic::new(
                                crate::codes::INTERNAL,
                                element.span,
                                "internal error: slot content position out of range",
                            ));
                        };
                        // Every place the child has for this slot: one, or one per branch of a
                        // `zb-if` that has it (the server renders one branch).
                        let mut places: Vec<&SlotPlace> = Vec::new();
                        for place in &info.slot_paths {
                            if place.name == *slot
                                && !places.iter().any(|seen| seen.path == place.path)
                            {
                                places.push(place);
                            }
                        }
                        if places.is_empty() {
                            return Err(Diagnostic::new(
                                crate::codes::UNKNOWN_SLOT,
                                element.span,
                                format!("<{}> has no slot named `{slot}`", element.name),
                            ));
                        }
                        let others = |place: &SlotPlace| {
                            info.slot_paths
                                .iter()
                                .filter(|other| other.name != *slot && other.path == place.path)
                                .map(|other| other.trail.clone())
                                .collect::<Vec<_>>()
                        };
                        checked |= places.len() > 1
                            || places.iter().any(|place| !others(place).is_empty());
                        for place in places {
                            // A place another slot has, by the same steps, in another branch: no
                            // markup tells them apart, so it isn't offered (rendered fresh instead).
                            if others(place).contains(&place.trail) {
                                continue;
                            }
                            // This component's steps unchecked, then the child's to its slot, then
                            // the content's own (the local path's first step became the region's
                            // and the position).
                            let mut kinds: Vec<Option<String>> = vec![None; path.len()];
                            kinds.extend(place.trail.iter().cloned().map(Some));
                            kinds.extend(local.kinds.iter().cloned());
                            hydrate.push(Place {
                                path: path
                                    .iter()
                                    .chain(&place.path)
                                    .copied()
                                    .chain(std::iter::once(*position))
                                    .chain(rest.iter().copied())
                                    .collect(),
                                kinds,
                            });
                        }
                    }
                    // Nothing in doubt: the one place, unchecked, as parts have always been written.
                    if !checked {
                        for place in &mut hydrate {
                            place.kinds.clear();
                        }
                    }
                    // A slot of this component's own, right inside the child's tag: the content
                    // given to it keeps its `slot` attribute (the name it has here), so the part
                    // says which of the child's slots the content is in (`forward`), and the
                    // child routes it there instead of by that attribute.
                    let body = match (
                        part.path.as_slice(),
                        part.path.first().and_then(|first| units.get(*first)),
                    ) {
                        ([_], Some((into, _)))
                            if part.body.starts_with("binder: $slot, slot: ") =>
                        {
                            format!("{}, forward: {}", part.body, json(into))
                        }
                        _ => part.body,
                    };
                    // (Pushed as is: the part keeps where its own markup was written.)
                    self.parts.push(JsPart {
                        path: path.iter().chain(&part.path).copied().collect(),
                        hydrate: Some(hydrate),
                        body,
                        at: part.at,
                    });
                }
                // This component's own slots inside the content (a slot it forwards to the child):
                // where they sit in server markup is where the child projects that content, so
                // they're recorded there, with what each step leads to (this component's elements,
                // the child host, the child's own steps to its slot, then the content's).
                let host = self.trail.len();
                let at_host: Vec<String> = self
                    .trail
                    .iter()
                    .cloned()
                    .chain([element.name.to_ascii_lowercase()])
                    .collect();
                for forwarded in std::mem::take(&mut content.slot_paths) {
                    // A named slot too: its part says which of the child's slots it sits in
                    // (`forward`, below), and the content goes there whatever its own `slot`.
                    let local = &forwarded.path[self.base.len()..];
                    let kinds = &forwarded.trail[host..];
                    let (Some((first, rest)), Some((_, rest_kinds))) =
                        (local.split_first(), kinds.split_first())
                    else {
                        continue;
                    };
                    let Some((slot, position)) = units.get(*first) else {
                        return Err(Diagnostic::new(
                            crate::codes::INTERNAL,
                            element.span,
                            "internal error: slot content position out of range",
                        ));
                    };
                    let mut found = false;
                    let mut seen: Vec<&Vec<usize>> = Vec::new();
                    for place in info.slot_paths.iter().filter(|place| place.name == *slot) {
                        if seen.contains(&&place.path) {
                            continue;
                        }
                        seen.push(&place.path);
                        found = true;
                        self.slot_paths.push(SlotPlace {
                            name: forwarded.name.clone(),
                            path: self
                                .base
                                .iter()
                                .chain(path)
                                .chain(&place.path)
                                .copied()
                                .chain(std::iter::once(*position))
                                .chain(rest.iter().copied())
                                .collect(),
                            trail: at_host
                                .iter()
                                .chain(&place.trail)
                                .chain(&kinds[..1])
                                .chain(rest_kinds)
                                .cloned()
                                .collect(),
                        });
                    }
                    if !found {
                        return Err(Diagnostic::new(
                            crate::codes::UNKNOWN_SLOT,
                            element.span,
                            format!("<{}> has no slot named `{slot}`", element.name),
                        ));
                    }
                }
            }
            _ => {
                self.trail.push(element.name.to_ascii_lowercase());
                let done = self.nodes(&element.children, path, false);
                self.trail.pop();
                done?
            }
        }
        self.template.push_str("</");
        self.template.push_str(&element.name);
        self.template.push('>');
        Ok(())
    }
}

/// For content placed inside a light-DOM child component: for each position (as `nodes`
/// counts them with `block_top`), the slot it goes to and its position within that slot.
fn content_units(nodes: &[Node]) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    let mut units = Vec::new();
    let mut push = |slot: String| {
        let entry = counts.iter_mut().find(|(name, _)| *name == slot);
        let position = match entry {
            Some((_, count)) => {
                *count += 1;
                *count - 1
            }
            None => {
                counts.push((slot.clone(), 1));
                0
            }
        };
        units.push((slot, position));
    };
    for node in nodes {
        match node {
            Node::Text(parts) => {
                if needs_text_anchor(nodes, node, true)
                    && parts
                        .iter()
                        .any(|part| matches!(part, Part::Expression { .. }))
                {
                    push("default".to_owned());
                }
            }
            Node::Element(element) => {
                let slot = element
                    .attributes
                    .iter()
                    .find(|attribute| attribute.name == "slot")
                    .and_then(|attribute| match &attribute.value {
                        AttributeValue::Text(parts) => match parts.as_slice() {
                            [Part::Literal(text)] => Some(text.clone()),
                            _ => None,
                        },
                        _ => None,
                    })
                    .unwrap_or_else(|| "default".to_owned());
                push(slot);
            }
            Node::If { .. } | Node::Each { .. } | Node::Slot { .. } | Node::Await { .. } => {
                push("default".to_owned())
            }
            Node::Else { .. } | Node::Settled { .. } => {}
        }
    }
    units
}

/// A runtime expression with the script's state and derived values read with `.get()` (and
/// state assigned), or `None` when it doesn't use them.
fn reactive_expression(
    expression: &Expression,
    state: &[String],
    derived: &[String],
    signals: &[String],
) -> Option<Expression> {
    let Expression::Runtime { source, .. } = expression else {
        return None;
    };
    if state.is_empty() && derived.is_empty() && signals.is_empty() {
        return None;
    }
    let rewritten =
        crate::reactive::rewrite_template_expression(source, state, derived, signals).ok()??;
    let names = crate::runtime_expression::parse(&rewritten).ok()?;
    Some(Expression::Runtime {
        source: rewritten,
        names,
    })
}

/// The names a component's module declares outside its setup function (its `export enum`s).
pub(crate) fn module_names(component: &ComponentAst) -> impl Iterator<Item = String> + '_ {
    component
        .script
        .module_declarations
        .iter()
        .map(|declaration| declaration.name.clone())
}
