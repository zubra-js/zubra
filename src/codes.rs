//! Every diagnostic's stable code (`ZB1001`), and what it means.
//!
//! The codes are the Stable contract (docs/stability.md): tools read them from `zubra check
//! --format json`, the request protocol and the language server, while the message text may change
//! in a minor. A code is never reused for something else, and never renumbered. Each is listed in
//! docs/diagnostics.md, and `tests/diagnostics.rs` checks that the two agree.
//!
//! The ranges: ZB1xxx parsing (ZB15xx the JSX front end), ZB2xxx the template (ZB21xx safety),
//! ZB3xxx the script (ZB31xx TypeScript, ZB32xx routes and collections), ZB4xxx props and their
//! types, ZB5xxx server rendering, ZB6xxx output targets, ZB7xxx imports, ZB8xxx tools (fmt,
//! convert, refactor), ZB9xxx internal errors.

/// A diagnostic's stable code: `ZB2001` is `Code(2001)` (a number, so a `Diagnostic` stays small).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct Code(pub u16);

impl Code {
    /// `ZB2001`.
    pub fn as_str(self) -> &'static str {
        ALL.iter()
            .find(|(_, code, _)| number(code) == self.0)
            .map_or("ZB0000", |(_, code, _)| code)
    }
}

impl std::fmt::Display for Code {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `"ZB2001"` → 2001, at compile time.
const fn number(code: &str) -> u16 {
    let bytes = code.as_bytes();
    let mut value = 0;
    let mut at = 2;
    while at < bytes.len() {
        value = value * 10 + (bytes[at] - b'0') as u16;
        at += 1;
    }
    value
}

macro_rules! codes {
    ($($name:ident = $code:literal, $meaning:literal;)*) => {
        $(#[doc = $meaning] pub const $name: Code = Code(number($code));)*
        /// Every code: (name, code, meaning).
        pub const ALL: &[(&str, &str, &str)] = &[$((stringify!($name), $code, $meaning)),*];
    };
}

codes! {
    // Parse: ZB1000-ZB1999
    OBSOLETE_SYNTAX = "ZB1001", "Syntax from before v0.3: the `component:` header, `{{ … }}`, or a directive's old name.";
    COMPONENT_STRUCTURE = "ZB1002", "The file isn't one host element with at most one `<script>` and one `<style>` before it.";
    STYLE_TAG_ATTRIBUTES = "ZB1003", "`<style>` takes only `layer` and `lang`, each with a valid quoted value.";
    SCRIPT_TAG_ATTRIBUTES = "ZB1004", "`<script>` takes no attribute but `lang=\"ts\"`.";
    MARKUP_SYNTAX = "ZB1005", "Malformed markup: an unterminated tag, attribute value or comment, or a missing `>`.";
    UNCLOSED_ELEMENT = "ZB1006", "An element, `<script>` or `<style>` is never closed.";
    MISMATCHED_CLOSING_TAG = "ZB1007", "A closing tag doesn't match the open element, or closes nothing.";
    UNSUPPORTED_MARKUP = "ZB1008", "A doctype or processing instruction where a template can't have one.";
    ATTRIBUTE_VALUE_FORM = "ZB1009", "An attribute value that is neither quoted text nor a `{…}` expression.";
    DUPLICATE_ATTRIBUTE = "ZB1010", "An attribute (or `let:` name) given twice on one element.";
    TOO_DEEP = "ZB1011", "Markup nested deeper than the compiler's limit.";
    DESCRIPTION_CLOSES_COMMENT = "ZB1012", "The component's description contains `-->`.";
    EXPRESSION_UNTERMINATED = "ZB1101", "A `{…}` expression, or a string in it, is never closed.";
    EXPRESSION_SYNTAX = "ZB1102", "A template expression isn't valid JavaScript.";
    MARKUP_IN_ATTRIBUTE = "ZB1103", "Markup inside an attribute's `{…}`.";
    EMPTY_EXPRESSION = "ZB1104", "An empty `{}` expression or `{...}` spread.";
    START_TAG_BRACES = "ZB1105", "A `{…}` in a start tag that isn't a `{...attributes}` spread.";
    BRACED_MARKUP_FORM = "ZB1106", "Markup in `{…}` that isn't `cond && <x/>`, `cond ? <x/> : <y/>` or `items.map((item, i) => <x/>)`.";
    BRACES_AND_CONDITION = "ZB1107", "An element rendered by `{…}` braces that also has `zb-if` or `zb-else`.";
    JSX_DEFAULT_EXPORT = "ZB1501", "A JSX component file doesn't default-export its component as a named function.";
    JSX_SYNTAX = "ZB1502", "A JSX component file doesn't parse.";
    JSX_EMIT = "ZB1503", "A JSX component calls `emit()`; it fires events by calling its `on…` props.";
    JSX_MODULE_STATE = "ZB1504", "A module-level `let` in a JSX component file, which every element would share.";
    JSX_EXTRA_EXPORT = "ZB1505", "A JSX component file exports something besides its component.";
    JSX_TOP_LEVEL = "ZB1506", "A statement at the top of a JSX component file that isn't an import, function, constant or type.";
    JSX_UNNAMED = "ZB1507", "The JSX component function has no name to make its tag from.";
    JSX_TAG_NEEDS_HYPHEN = "ZB1508", "The JSX component's name makes a tag with no hyphen.";
    JSX_ASYNC = "ZB1509", "The component function is async or a generator.";
    JSX_RETURN = "ZB1510", "The component function doesn't end with one `return` of its JSX.";
    JSX_HOST_ATTRIBUTE = "ZB1511", "An attribute on a JSX component's host other than `shadow` and `form-associated`.";
    JSX_PROPS = "ZB1512", "The props aren't one destructured parameter of plain names (no rest, renaming, nested patterns, or default for `children` or an event).";
    JSX_DECLARATION = "ZB1513", "A declaration in the component function that isn't one name per `let` (state) or `const` (derived).";
    JSX_PLACEMENT = "ZB1514", "JSX where it can't be compiled: only returned, in `&&` / `? :` branches and in `.map()` callbacks.";
    JSX_RENDER_PROP = "ZB1515", "JSX in an attribute (a render prop); use a named slot.";
    JSX_LIST_CALLBACK = "ZB1516", "A `.map()` callback that doesn't take the item and optionally its index, as plain names.";
    JSX_CHILDREN = "ZB1517", "`children` used other than rendered as `{children}`.";
    JSX_MEMBER_TAG = "ZB1518", "A member expression as a tag (`<a.B>`).";
    JSX_EVENT_PROP = "ZB1519", "An event prop passed on instead of called to fire the event.";
    // Template: ZB2000-ZB2999
    UNKNOWN_REFERENCE = "ZB2001", "A name the template or a default reads that nothing declares.";
    ASSIGN_READONLY = "ZB2002", "An assignment to something that isn't a prop or state (a `let`).";
    FORBIDDEN_ELEMENT = "ZB2003", "An element a template can't contain, such as `<script>` or `<style>`.";
    DIRECTIVE_PLACEMENT = "ZB2004", "A directive element outside the parent it belongs in (`zb-else` outside `zb-if`, `zb-then` outside `zb-await`, `zb-case` outside `zb-switch`, …).";
    IF_CHAIN_ORDER = "ZB2005", "A `zb-else-if` or `zb-else` out of place in its `zb-if` chain.";
    CONDITION_CONFLICT = "ZB2006", "An element with more than one of `zb-if`, `zb-else-if` and `zb-else`.";
    SWITCH_STRUCTURE = "ZB2007", "A `zb-switch` whose children aren't `zb-case` elements and an optional final `zb-else`.";
    AWAIT_STRUCTURE = "ZB2008", "A `zb-await` whose pending, `zb-then` and `zb-catch` parts are out of order or repeated.";
    DIRECTIVE_ATTRIBUTE = "ZB2009", "An attribute, spread or listener a directive element doesn't take.";
    DIRECTIVE_MISSING_ATTRIBUTE = "ZB2010", "A directive element without an attribute it requires.";
    ATTRIBUTE_NEEDS_EXPRESSION = "ZB2011", "An attribute that takes an expression (`name={…}`) given text or nothing.";
    ATTRIBUTE_TAKES_NO_VALUE = "ZB2012", "An attribute that takes no value given one.";
    STATIC_ATTRIBUTE = "ZB2013", "An attribute that must be quoted static text given an expression.";
    UNKNOWN_ZB_ATTRIBUTE = "ZB2014", "An unknown attribute with the reserved `zb-` prefix.";
    BINDING_PATTERN = "ZB2015", "An `as`, `index` or `let:` name that isn't an identifier or a destructuring pattern.";
    LET_PLACEMENT = "ZB2016", "`let:` on an element other than `<zb-each>` or `<zb-then>`.";
    EMPTY_IS = "ZB2017", "`is={[]}`, which never matches.";
    KEY_NEEDS_EXPRESSION = "ZB2018", "A list `key` given as text instead of an expression.";
    ANIMATE_PLACEMENT = "ZB2019", "`zb-animate` or `animate` where it can't go, or a `zb-each … animate` without a key.";
    ELEMENT_CANT_HAVE_CONTENT = "ZB2020", "Content inside an element that can't have any.";
    SLOT_NAME_INVALID = "ZB2021", "A `zb-slot` name that isn't `default` or an identifier.";
    SLOT_PLACEMENT = "ZB2022", "A `zb-slot` inside `zb-each`, `zb-then` or `zb-catch`.";
    RECURSIVE_SLOT = "ZB2023", "Slot content that expands into itself.";
    UNKNOWN_SLOT = "ZB2024", "Content for a slot the component doesn't have.";
    SHADOW_NAMED_SLOT_TEXT = "ZB2025", "Text given to a shadow component's named slot, which takes elements.";
    INVALID_TAG_NAME = "ZB2026", "A tag that isn't a valid custom-element name.";
    STYLE_ATTRIBUTE_FORM = "ZB2027", "A `style` attribute that interpolates text, or `style={…}` that isn't an object literal.";
    CLASS_STYLE_NAME = "ZB2028", "A `class:` or `style:` attribute that doesn't name a class or CSS property.";
    INLINE_HANDLER = "ZB2029", "An inline event-handler attribute (`onclick=\"…\"`).";
    EVENT_ATTRIBUTE = "ZB2030", "An event attribute whose name or modifiers aren't valid.";
    TWO_WAY_BINDING = "ZB2031", "A two-way binding on a native element, or to something that isn't a `let` or a prop.";
    REF_FORM = "ZB2032", "A `ref` that isn't a `let` or a function.";
    UNKNOWN_EVENT = "ZB2033", "A listener for an event the child component never fires.";
    REACT_ATTRIBUTE_NAME = "ZB2034", "React's name for an attribute (`className`, `htmlFor`) that HTML doesn't have.";
    CAMEL_CASE_PROP = "ZB2035", "A camelCase attribute on a child component that matches none of its props (HTML lowercases attribute names).";
    SPREAD_NOT_OBJECT = "ZB2036", "A `{...spread}` of something other than an object.";
    SPREAD_VALUE = "ZB2037", "A spread entry the attribute can't take (a `style` string, an object for a plain attribute).";
    BOOLEAN_ATTRIBUTE_VALUE = "ZB2038", "A boolean attribute given text, or a value other than true or false.";
    UNKNOWN_ZB_ELEMENT = "ZB2039", "An unknown element with the reserved `zb-` prefix.";
    UNSAFE_URL = "ZB2101", "A URL attribute whose value isn't a relative, `http`, `https`, `mailto` or `tel` URL.";
    UNSAFE_INTERPOLATION = "ZB2102", "Interpolation where nothing could check it (`srcdoc`, `ping`, `<meta http-equiv>`, an animated link).";
    UNSAFE_CSS_VALUE = "ZB2103", "A style value that isn't a single CSS value.";
    // Script: ZB3000-ZB3999
    SCRIPT_SYNTAX = "ZB3001", "The `<script>` doesn't parse.";
    VAR_DECLARATION = "ZB3002", "`var` in a component script.";
    SCRIPT_EXPORT = "ZB3003", "An export from a component script.";
    DUPLICATE_DECLARATION = "ZB3004", "A name declared more than once in `<script>`.";
    USED_BEFORE_DECLARED = "ZB3005", "A name used before its declaration.";
    RESERVED_NAME = "ZB3006", "A name starting with `$`, which is reserved for compiled code.";
    HOOK_NOT_IMPORTED = "ZB3007", "A `@zubra/runtime` hook used without importing it.";
    ASSIGN_DESTRUCTURING = "ZB3008", "State assigned by destructuring instead of `name = …`.";
    ASSIGN_DERIVED = "ZB3009", "An assignment to a value derived from props or state.";
    FOLLOW_NEEDS_LET = "ZB3010", "State that follows a prop declared with `const` instead of `let`.";
    PEERS_TWICE = "ZB3011", "`peers()` called more than once in a component.";
    FORM_API_NEEDS_FORM_ASSOCIATED = "ZB3012", "A form API used by a component without `form-associated` on its host.";
    UNKNOWN_SCRIPT_DIRECTIVE = "ZB3013", "An unknown `'use …'` directive.";
    EMIT_FORM = "ZB3014", "An `emit` call the compiler can't read: call `emit(\"name\", detail)` directly, with a literal name.";
    EVENT_NAME = "ZB3015", "An event name that isn't lowercase letters and digits.";
    EVENT_UNDOCUMENTED = "ZB3016", "An emitted event the description doesn't document with `@fires`.";
    DOC_EVENT_NEVER_EMITTED = "ZB3017", "A `@fires` the script never emits.";
    DOC_TYPE = "ZB3018", "A `@prop` or `@fires` type in the description that is unclosed or isn't a TypeScript type.";
    DOC_UNKNOWN_PROP = "ZB3019", "A `@prop` in the description for a prop the host doesn't declare.";
    DOC_PROP_TWICE = "ZB3020", "A prop documented twice in the description.";
    TS_NOT_ERASABLE = "ZB3101", "TypeScript that can't be reduced to JavaScript by removing its types.";
    TYPE_IMPORT_VERBATIM = "ZB3102", "A type imported without `type` under `verbatimModuleSyntax`.";
    CONST_ENUM_NOT_CONSTANT = "ZB3103", "An imported `const enum` member the compiler can't work out.";
    ROUTE_PATTERN = "ZB3201", "A `'use route'` or `'use layout'` path that isn't valid.";
    ROUTE_PARAM_UNUSED = "ZB3202", "A route parameter that neither `load` nor a prop reads.";
    SCRIPT_DIRECTIVE_CONFLICT = "ZB3203", "A component with more than one route, layout or collection.";
    COLLECTION_FORM = "ZB3204", "A `'use collection'` without a valid name or `by` list.";
    COLLECTION_KEY_NOT_PROP = "ZB3205", "A collection keyed by a prop the host doesn't declare.";
    DOCUMENTS_NEEDS_LET = "ZB3206", "A `documents()` list that isn't the whole value of a top-level `let`.";
    // Types and props: ZB4000-ZB4999
    INVALID_JSON = "ZB4001", "Props or slots given (`--props`, `--slots`) that aren't valid JSON.";
    PROPS_NOT_OBJECT = "ZB4002", "Props given that aren't a JSON object.";
    SLOTS_NOT_OBJECT = "ZB4003", "Slots given that aren't a JSON object.";
    SLOT_NOT_STRING = "ZB4004", "A slot given whose content isn't a template string.";
    UNKNOWN_PROP = "ZB4005", "A prop the component doesn't declare.";
    MISSING_REQUIRED_PROP = "ZB4006", "A required prop with no value.";
    PROP_TYPE_MISMATCH = "ZB4007", "A prop value whose type isn't its default's.";
    DUPLICATE_PROP = "ZB4008", "A prop declared twice.";
    PROP_NAME_CASE = "ZB4009", "A prop name with uppercase letters (HTML lowercases attribute names).";
    PROP_NAME_INVALID = "ZB4010", "A prop name that isn't lowercase letters, digits and single hyphens.";
    PROP_DEFAULT_INTERPOLATES = "ZB4011", "A prop default that interpolates; write the whole default as `{…}`.";
    DEFAULT_USES_RUNTIME = "ZB4012", "A prop default that uses something that only exists at runtime.";
    SCRIPT_REDECLARES_PROP = "ZB4013", "A script declaration with a prop's name.";
    PROPS_INTERFACE_EXTRA = "ZB4014", "An `interface Props` member with no prop on the host.";
    PROP_NOT_IN_INTERFACE = "ZB4015", "A prop missing from `interface Props`.";
    DECLARE_CONST_NO_PROP = "ZB4016", "A `declare const` that types a prop the host doesn't declare.";
    PROP_TYPED_TWICE = "ZB4017", "A prop given a type both in the script and by `@prop` in the description.";
    PROP_ENUM_NOT_EXPORTED = "ZB4018", "A prop typed with an enum the component doesn't export.";
    PROP_SHADOWS_BUILTIN = "ZB4019", "A prop named like a built-in property every element has.";
    HOST_CLASS_PROP = "ZB4020", "`class` on the host, which declares a prop named `class`.";
    HOST_ATTRIBUTE = "ZB4021", "An attribute that can't go on the host tag.";
    HOST_SPREAD = "ZB4022", "A `{...spread}` on the host tag.";
    HOST_RESET_NEEDS_SHADOW = "ZB4023", "`host-reset` without `shadow`.";
    // Server: ZB5000-ZB5999
    SERVER_GAP = "ZB5001", "Part of the component is computed in the browser, so the server's HTML leaves it out (`check --server`).";
    SERVER_EVALUATION = "ZB5002", "An expression the compiler can't evaluate for the server's HTML.";
    RUNTIME_ONLY_IN_HTML = "ZB5003", "Something that only exists at runtime, rendered into static HTML.";
    VALUE_NOT_TEXT = "ZB5004", "A value that can't be written as text.";
    EACH_ITEMS_NOT_ARRAY = "ZB5005", "`zb-each` items that aren't an array.";
    DUPLICATE_KEY = "ZB5006", "Two `zb-each` rows with the same key.";
    KEY_TYPE = "ZB5007", "A `zb-each` key that isn't a string or a number.";
    CHILD_DEFAULT_IN_BROWSER = "ZB5008", "A child component's default computed in the browser, so its server HTML needs the prop passed.";
    LOAD_EXPORT = "ZB5009", "`load` exported where it can't be: outside a route or layout, or with `'use server'`.";
    LOAD_CALLED = "ZB5010", "The script calls `load`, which runs on the server only.";
    LOAD_RETURNS_UNDECLARED = "ZB5011", "`load` returns a key the component doesn't declare as a prop.";
    SERVER_READS_BROWSER = "ZB5012", "Server code that reads the script's browser state.";
    DUPLICATE_EXPORT = "ZB5013", "`load` or a server action exported twice.";
    // Output: ZB6000-ZB6999
    ELEMENT_UNSUPPORTED = "ZB6001", "A feature `--emit element` can't compile without `@zubra/runtime` (shadow DOM, `zb-await`, outlets, spreads, collections, runtime imports).";
    STYLE_LANG_NEEDS_BUNDLER = "ZB6002", "`<style lang=\"…\">` (Sass, Less, …), which needs a bundler such as @zubra/unplugin.";
    // Imports: ZB7000-ZB7999
    DUPLICATE_TAG_DEFINITION = "ZB7001", "Two imported components define the same tag.";
    IMPORT_NEEDS_FILE = "ZB7002", "A component with imports compiled from text, with no file to resolve them from.";
    IMPORT_UNREADABLE = "ZB7003", "An imported component that can't be loaded.";
    IMPORT_CYCLE = "ZB7004", "Components that import each other in a cycle.";
    DUPLICATE_IMPORT = "ZB7005", "The same component imported more than once.";
    SELF_IMPORT = "ZB7006", "A component that imports itself.";
    UNKNOWN_COMPONENT_TAG = "ZB7007", "A JSX tag that names no imported component.";
    SOURCE_UNREADABLE = "ZB7008", "A component's source file can't be read.";
    COMPONENT_NOT_IMPORTED = "ZB7009", "A tag naming the component in a file beside this one, which this file doesn't import.";
    COMPONENT_TAG_TYPO = "ZB7010", "A tag close to an imported component's tag, but not it.";
    // Tools: ZB8000-ZB8999
    FMT_JSX = "ZB8001", "`zubra fmt` given a JSX component, which Prettier formats.";
    FMT_SYNTAX = "ZB8002", "Markup the formatter can't read.";
    FMT_UNPARSEABLE_OUTPUT = "ZB8003", "The formatter wrote markup that doesn't parse, so the file is left as it was (a bug: please report it).";
    CONVERT_SYNTAX = "ZB8101", "The file to convert doesn't parse.";
    CONVERT_PRIMITIVE_LIBRARY = "ZB8102", "A React component built on a third-party primitive library, which has no HTML to convert to.";
    CONVERT_NO_SUCH_EXPORT = "ZB8103", "`--component` names an export the file doesn't have.";
    CONVERT_SEVERAL_COMPONENTS = "ZB8104", "A file that exports several components, converted without `--component`.";
    CONVERT_NO_COMPONENT = "ZB8105", "A file with no default-exported function component.";
    CONVERT_UNNAMED = "ZB8106", "A component function with no name to make a tag from.";
    CONVERT_ONE_WORD_NAME = "ZB8107", "A one-word component name; a custom element's name needs a hyphen (`--prefix`).";
    CONVERT_UNFINISHED = "ZB8108", "Part of a React component that isn't converted, left to finish by hand.";
    CONVERT_NO_ELEMENT_CLASS = "ZB8201", "A file with no class that extends `HTMLElement`.";
    CONVERT_NO_TAG = "ZB8202", "A custom element module that never names its tag.";
    CONVERT_NOT_ELEMENT_SHAPE = "ZB8203", "A class that isn't in the shape `--emit element` writes.";
    CONVERT_ELEMENT_UNFINISHED = "ZB8204", "Part of a custom element that isn't converted back to `.zb`.";
    REFACTOR_REFUSED = "ZB8301", "A selection the extract-component refactor can't extract.";
    // Internal: ZB9000-ZB9999
    INTERNAL = "ZB9001", "An internal compiler error: please report it.";
}
