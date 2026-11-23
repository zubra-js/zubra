# Diagnostics

Every error and warning the compiler reports has a stable code: `error[ZB2001]: unknown reference` in a terminal, `"code": "ZB2001"` in `zubra check --format json` (from both CLIs), in the `diagnostics` of a `zubra request` / `zubra serve` / WebAssembly response, and as the `code` of the language server's diagnostics, which links to its row here.

**The codes are Stable** (see [stability.md](stability.md)): a code keeps its meaning for the life of a major, is never reused for something else, and is never renumbered. A tool, a CI annotation or an editor setting should key on the code. **The message text is Supported**: it says what to write instead, and may be reworded in a minor.

A code names a kind of problem, so several messages can share one (each `zb-else`, `zb-then` or `zb-case` out of place is `ZB2004`). Severity isn't part of the code: `zubra check --server` reports `ZB5001` as an error for `checked`, `selected`, `value` and `disabled`, and as a warning otherwise. `zubra check --deny-warnings` fails on any warning.

Type errors from `npx zubra check --types` carry TypeScript's own codes (`TS2322`), not these.

The ranges: ZB1xxx parsing (ZB15xx the JSX front end), ZB2xxx the template (ZB21xx safety), ZB3xxx the script (ZB31xx TypeScript, ZB32xx routes and collections), ZB4xxx props and their types, ZB5xxx server rendering, ZB6xxx output targets, ZB7xxx imports, ZB8xxx tools, ZB9xxx internal errors. `src/codes.rs` is the registry; `tests/diagnostics.rs` checks that every code is unique, listed here with this meaning, and given to every diagnostic.

## Parsing (ZB1xxx)

| Code | Meaning |
|---|---|
| <a id="zb1001"></a>`ZB1001` | Syntax from before v0.3: the `component:` header, `{{ … }}`, or a directive's old name. |
| <a id="zb1002"></a>`ZB1002` | The file isn't one host element with at most one `<script>` and one `<style>` before it. |
| <a id="zb1003"></a>`ZB1003` | `<style>` takes only `layer` and `lang`, each with a valid quoted value. |
| <a id="zb1004"></a>`ZB1004` | `<script>` takes no attribute but `lang="ts"`. |
| <a id="zb1005"></a>`ZB1005` | Malformed markup: an unterminated tag, attribute value or comment, or a missing `>`. |
| <a id="zb1006"></a>`ZB1006` | An element, `<script>` or `<style>` is never closed. |
| <a id="zb1007"></a>`ZB1007` | A closing tag doesn't match the open element, or closes nothing. |
| <a id="zb1008"></a>`ZB1008` | A doctype or processing instruction where a template can't have one. |
| <a id="zb1009"></a>`ZB1009` | An attribute value that is neither quoted text nor a `{…}` expression. |
| <a id="zb1010"></a>`ZB1010` | An attribute (or `let:` name) given twice on one element. |
| <a id="zb1011"></a>`ZB1011` | Markup nested deeper than the compiler's limit. |
| <a id="zb1012"></a>`ZB1012` | The component's description contains `-->`. |
| <a id="zb1101"></a>`ZB1101` | A `{…}` expression, or a string in it, is never closed. |
| <a id="zb1102"></a>`ZB1102` | A template expression isn't valid JavaScript. |
| <a id="zb1103"></a>`ZB1103` | Markup inside an attribute's `{…}`. |
| <a id="zb1104"></a>`ZB1104` | An empty `{}` expression or `{...}` spread. |
| <a id="zb1105"></a>`ZB1105` | A `{…}` in a start tag that isn't a `{...attributes}` spread. |
| <a id="zb1106"></a>`ZB1106` | Markup in `{…}` that isn't `cond && <x/>`, `cond ? <x/> : <y/>` or `items.map((item, i) => <x/>)`. |
| <a id="zb1107"></a>`ZB1107` | An element rendered by `{…}` braces that also has `zb-if` or `zb-else`. |
| <a id="zb1501"></a>`ZB1501` | A JSX component file doesn't default-export its component as a named function. |
| <a id="zb1502"></a>`ZB1502` | A JSX component file doesn't parse. |
| <a id="zb1503"></a>`ZB1503` | A JSX component calls `emit()`; it fires events by calling its `on…` props. |
| <a id="zb1504"></a>`ZB1504` | A module-level `let` in a JSX component file, which every element would share. |
| <a id="zb1505"></a>`ZB1505` | A JSX component file exports something besides its component. |
| <a id="zb1506"></a>`ZB1506` | A statement at the top of a JSX component file that isn't an import, function, constant or type. |
| <a id="zb1507"></a>`ZB1507` | The JSX component function has no name to make its tag from. |
| <a id="zb1508"></a>`ZB1508` | The JSX component's name makes a tag with no hyphen. |
| <a id="zb1509"></a>`ZB1509` | The component function is async or a generator. |
| <a id="zb1510"></a>`ZB1510` | The component function doesn't end with one `return` of its JSX. |
| <a id="zb1511"></a>`ZB1511` | An attribute on a JSX component's host other than `shadow` and `form-associated`. |
| <a id="zb1512"></a>`ZB1512` | The props aren't one destructured parameter of plain names (no rest, renaming, nested patterns, or default for `children` or an event). |
| <a id="zb1513"></a>`ZB1513` | A declaration in the component function that isn't one name per `let` (state) or `const` (derived). |
| <a id="zb1514"></a>`ZB1514` | JSX where it can't be compiled: only returned, in `&&` / `? :` branches and in `.map()` callbacks. |
| <a id="zb1515"></a>`ZB1515` | JSX in an attribute (a render prop); use a named slot. |
| <a id="zb1516"></a>`ZB1516` | A `.map()` callback that doesn't take the item and optionally its index, as plain names. |
| <a id="zb1517"></a>`ZB1517` | `children` used other than rendered as `{children}`. |
| <a id="zb1518"></a>`ZB1518` | A member expression as a tag (`<a.B>`). |
| <a id="zb1519"></a>`ZB1519` | An event prop passed on instead of called to fire the event. |

## The template (ZB2xxx)

| Code | Meaning |
|---|---|
| <a id="zb2001"></a>`ZB2001` | A name the template or a default reads that nothing declares. |
| <a id="zb2002"></a>`ZB2002` | An assignment to something that isn't a prop or state (a `let`). |
| <a id="zb2003"></a>`ZB2003` | An element a template can't contain, such as `<script>` or `<style>`. |
| <a id="zb2004"></a>`ZB2004` | A directive element outside the parent it belongs in (`zb-else` outside `zb-if`, `zb-then` outside `zb-await`, `zb-case` outside `zb-switch`, …). |
| <a id="zb2005"></a>`ZB2005` | A `zb-else-if` or `zb-else` out of place in its `zb-if` chain. |
| <a id="zb2006"></a>`ZB2006` | An element with more than one of `zb-if`, `zb-else-if` and `zb-else`. |
| <a id="zb2007"></a>`ZB2007` | A `zb-switch` whose children aren't `zb-case` elements and an optional final `zb-else`. |
| <a id="zb2008"></a>`ZB2008` | A `zb-await` whose pending, `zb-then` and `zb-catch` parts are out of order or repeated. |
| <a id="zb2009"></a>`ZB2009` | An attribute, spread or listener a directive element doesn't take. |
| <a id="zb2010"></a>`ZB2010` | A directive element without an attribute it requires. |
| <a id="zb2011"></a>`ZB2011` | An attribute that takes an expression (`name={…}`) given text or nothing. |
| <a id="zb2012"></a>`ZB2012` | An attribute that takes no value given one. |
| <a id="zb2013"></a>`ZB2013` | An attribute that must be quoted static text given an expression. |
| <a id="zb2014"></a>`ZB2014` | An unknown attribute with the reserved `zb-` prefix. |
| <a id="zb2015"></a>`ZB2015` | An `as`, `index` or `let:` name that isn't an identifier or a destructuring pattern. |
| <a id="zb2016"></a>`ZB2016` | `let:` on an element other than `<zb-each>` or `<zb-then>`. |
| <a id="zb2017"></a>`ZB2017` | `is={[]}`, which never matches. |
| <a id="zb2018"></a>`ZB2018` | A list `key` given as text instead of an expression. |
| <a id="zb2019"></a>`ZB2019` | `zb-animate` or `animate` where it can't go, or a `zb-each … animate` without a key. |
| <a id="zb2020"></a>`ZB2020` | Content inside an element that can't have any. |
| <a id="zb2021"></a>`ZB2021` | A `zb-slot` name that isn't `default` or an identifier. |
| <a id="zb2022"></a>`ZB2022` | A `zb-slot` inside `zb-each`, `zb-then` or `zb-catch`. |
| <a id="zb2023"></a>`ZB2023` | Slot content that expands into itself. |
| <a id="zb2024"></a>`ZB2024` | Content for a slot the component doesn't have. |
| <a id="zb2025"></a>`ZB2025` | Text given to a shadow component's named slot, which takes elements. |
| <a id="zb2026"></a>`ZB2026` | A tag that isn't a valid custom-element name. |
| <a id="zb2027"></a>`ZB2027` | A `style` attribute that interpolates text, or `style={…}` that isn't an object literal. |
| <a id="zb2028"></a>`ZB2028` | A `class:` or `style:` attribute that doesn't name a class or CSS property. |
| <a id="zb2029"></a>`ZB2029` | An inline event-handler attribute (`onclick="…"`). |
| <a id="zb2030"></a>`ZB2030` | An event attribute whose name or modifiers aren't valid. |
| <a id="zb2031"></a>`ZB2031` | A two-way binding on a native element, or to something that isn't a `let` or a prop. |
| <a id="zb2032"></a>`ZB2032` | A `ref` that isn't a `let` or a function. |
| <a id="zb2033"></a>`ZB2033` | A listener for an event the child component never fires. |
| <a id="zb2034"></a>`ZB2034` | React's name for an attribute (`className`, `htmlFor`) that HTML doesn't have. |
| <a id="zb2035"></a>`ZB2035` | A camelCase attribute on a child component that matches none of its props (HTML lowercases attribute names). |
| <a id="zb2036"></a>`ZB2036` | A `{...spread}` of something other than an object. |
| <a id="zb2037"></a>`ZB2037` | A spread entry the attribute can't take (a `style` string, an object for a plain attribute). |
| <a id="zb2038"></a>`ZB2038` | A boolean attribute given text, or a value other than true or false. |
| <a id="zb2039"></a>`ZB2039` | An unknown element with the reserved `zb-` prefix. |
| <a id="zb2101"></a>`ZB2101` | A URL attribute whose value isn't a relative, `http`, `https`, `mailto` or `tel` URL. |
| <a id="zb2102"></a>`ZB2102` | Interpolation where nothing could check it (`srcdoc`, `ping`, `<meta http-equiv>`, an animated link). |
| <a id="zb2103"></a>`ZB2103` | A style value that isn't a single CSS value. |

## The script (ZB3xxx)

| Code | Meaning |
|---|---|
| <a id="zb3001"></a>`ZB3001` | The `<script>` doesn't parse. |
| <a id="zb3002"></a>`ZB3002` | `var` in a component script. |
| <a id="zb3003"></a>`ZB3003` | An export from a component script. |
| <a id="zb3004"></a>`ZB3004` | A name declared more than once in `<script>`. |
| <a id="zb3005"></a>`ZB3005` | A name used before its declaration. |
| <a id="zb3006"></a>`ZB3006` | A name starting with `$`, which is reserved for compiled code. |
| <a id="zb3007"></a>`ZB3007` | A `@zubra/runtime` hook used without importing it. |
| <a id="zb3008"></a>`ZB3008` | State assigned by destructuring instead of `name = …`. |
| <a id="zb3009"></a>`ZB3009` | An assignment to a value derived from props or state. |
| <a id="zb3010"></a>`ZB3010` | State that follows a prop declared with `const` instead of `let`. |
| <a id="zb3011"></a>`ZB3011` | `peers()` called more than once in a component. |
| <a id="zb3012"></a>`ZB3012` | A form API used by a component without `form-associated` on its host. |
| <a id="zb3013"></a>`ZB3013` | An unknown `'use …'` directive. |
| <a id="zb3014"></a>`ZB3014` | An `emit` call the compiler can't read: call `emit("name", detail)` directly, with a literal name. |
| <a id="zb3015"></a>`ZB3015` | An event name that isn't lowercase letters and digits. |
| <a id="zb3016"></a>`ZB3016` | An emitted event the description doesn't document with `@fires`. |
| <a id="zb3017"></a>`ZB3017` | A `@fires` the script never emits. |
| <a id="zb3018"></a>`ZB3018` | A `@prop` or `@fires` type in the description that is unclosed or isn't a TypeScript type. |
| <a id="zb3019"></a>`ZB3019` | A `@prop` in the description for a prop the host doesn't declare. |
| <a id="zb3020"></a>`ZB3020` | A prop documented twice in the description. |
| <a id="zb3101"></a>`ZB3101` | TypeScript that can't be reduced to JavaScript by removing its types. |
| <a id="zb3102"></a>`ZB3102` | A type imported without `type` under `verbatimModuleSyntax`. |
| <a id="zb3103"></a>`ZB3103` | An imported `const enum` member the compiler can't work out. |
| <a id="zb3201"></a>`ZB3201` | A `'use route'` or `'use layout'` path that isn't valid. |
| <a id="zb3202"></a>`ZB3202` | A route parameter that neither `load` nor a prop reads. |
| <a id="zb3203"></a>`ZB3203` | A component with more than one route, layout or collection. |
| <a id="zb3204"></a>`ZB3204` | A `'use collection'` without a valid name or `by` list. |
| <a id="zb3205"></a>`ZB3205` | A collection keyed by a prop the host doesn't declare. |
| <a id="zb3206"></a>`ZB3206` | A `documents()` list that isn't the whole value of a top-level `let`. |

## Props and their types (ZB4xxx)

| Code | Meaning |
|---|---|
| <a id="zb4001"></a>`ZB4001` | Props or slots given (`--props`, `--slots`) that aren't valid JSON. |
| <a id="zb4002"></a>`ZB4002` | Props given that aren't a JSON object. |
| <a id="zb4003"></a>`ZB4003` | Slots given that aren't a JSON object. |
| <a id="zb4004"></a>`ZB4004` | A slot given whose content isn't a template string. |
| <a id="zb4005"></a>`ZB4005` | A prop the component doesn't declare. |
| <a id="zb4006"></a>`ZB4006` | A required prop with no value. |
| <a id="zb4007"></a>`ZB4007` | A prop value whose type isn't its default's. |
| <a id="zb4008"></a>`ZB4008` | A prop declared twice. |
| <a id="zb4009"></a>`ZB4009` | A prop name with uppercase letters (HTML lowercases attribute names). |
| <a id="zb4010"></a>`ZB4010` | A prop name that isn't lowercase letters, digits and single hyphens. |
| <a id="zb4011"></a>`ZB4011` | A prop default that interpolates; write the whole default as `{…}`. |
| <a id="zb4012"></a>`ZB4012` | A prop default that uses something that only exists at runtime. |
| <a id="zb4013"></a>`ZB4013` | A script declaration with a prop's name. |
| <a id="zb4014"></a>`ZB4014` | An `interface Props` member with no prop on the host. |
| <a id="zb4015"></a>`ZB4015` | A prop missing from `interface Props`. |
| <a id="zb4016"></a>`ZB4016` | A `declare const` that types a prop the host doesn't declare. |
| <a id="zb4017"></a>`ZB4017` | A prop given a type both in the script and by `@prop` in the description. |
| <a id="zb4018"></a>`ZB4018` | A prop typed with an enum the component doesn't export. |
| <a id="zb4019"></a>`ZB4019` | A prop named like a built-in property every element has. |
| <a id="zb4020"></a>`ZB4020` | `class` on the host, which declares a prop named `class`. |
| <a id="zb4021"></a>`ZB4021` | An attribute that can't go on the host tag. |
| <a id="zb4022"></a>`ZB4022` | A `{...spread}` on the host tag. |
| <a id="zb4023"></a>`ZB4023` | `host-reset` without `shadow`. |

## Server rendering (ZB5xxx)

| Code | Meaning |
|---|---|
| <a id="zb5001"></a>`ZB5001` | Part of the component is computed in the browser, so the server's HTML leaves it out (`check --server`). |
| <a id="zb5002"></a>`ZB5002` | An expression the compiler can't evaluate for the server's HTML. |
| <a id="zb5003"></a>`ZB5003` | Something that only exists at runtime, rendered into static HTML. |
| <a id="zb5004"></a>`ZB5004` | A value that can't be written as text. |
| <a id="zb5005"></a>`ZB5005` | `zb-each` items that aren't an array. |
| <a id="zb5006"></a>`ZB5006` | Two `zb-each` rows with the same key. |
| <a id="zb5007"></a>`ZB5007` | A `zb-each` key that isn't a string or a number. |
| <a id="zb5008"></a>`ZB5008` | A child component's default computed in the browser, so its server HTML needs the prop passed. |
| <a id="zb5009"></a>`ZB5009` | `load` exported where it can't be: outside a route or layout, or with `'use server'`. |
| <a id="zb5010"></a>`ZB5010` | The script calls `load`, which runs on the server only. |
| <a id="zb5011"></a>`ZB5011` | `load` returns a key the component doesn't declare as a prop. |
| <a id="zb5012"></a>`ZB5012` | Server code that reads the script's browser state. |
| <a id="zb5013"></a>`ZB5013` | `load` or a server action exported twice. |

## Output targets (ZB6xxx)

| Code | Meaning |
|---|---|
| <a id="zb6001"></a>`ZB6001` | A feature `--emit element` can't compile without `@zubra/runtime` (shadow DOM, `zb-await`, outlets, spreads, collections, runtime imports). |
| <a id="zb6002"></a>`ZB6002` | `<style lang="…">` (Sass, Less, …), which needs a bundler such as @zubra/unplugin. |

## Imports (ZB7xxx)

| Code | Meaning |
|---|---|
| <a id="zb7001"></a>`ZB7001` | Two imported components define the same tag. |
| <a id="zb7002"></a>`ZB7002` | A component with imports compiled from text, with no file to resolve them from. |
| <a id="zb7003"></a>`ZB7003` | An imported component that can't be loaded. |
| <a id="zb7004"></a>`ZB7004` | Components that import each other in a cycle. |
| <a id="zb7005"></a>`ZB7005` | The same component imported more than once. |
| <a id="zb7006"></a>`ZB7006` | A component that imports itself. |
| <a id="zb7007"></a>`ZB7007` | A JSX tag that names no imported component. |
| <a id="zb7008"></a>`ZB7008` | A component's source file can't be read. |
| <a id="zb7009"></a>`ZB7009` | A tag naming the component in a file beside this one, which this file doesn't import. |
| <a id="zb7010"></a>`ZB7010` | A tag close to an imported component's tag, but not it. |

## Tools: fmt, convert, refactor (ZB8xxx)

| Code | Meaning |
|---|---|
| <a id="zb8001"></a>`ZB8001` | `zubra fmt` given a JSX component, which Prettier formats. |
| <a id="zb8002"></a>`ZB8002` | Markup the formatter can't read. |
| <a id="zb8003"></a>`ZB8003` | The formatter wrote markup that doesn't parse, so the file is left as it was (a bug: please report it). |
| <a id="zb8101"></a>`ZB8101` | The file to convert doesn't parse. |
| <a id="zb8102"></a>`ZB8102` | A React component built on a third-party primitive library, which has no HTML to convert to. |
| <a id="zb8103"></a>`ZB8103` | `--component` names an export the file doesn't have. |
| <a id="zb8104"></a>`ZB8104` | A file that exports several components, converted without `--component`. |
| <a id="zb8105"></a>`ZB8105` | A file with no default-exported function component. |
| <a id="zb8106"></a>`ZB8106` | A component function with no name to make a tag from. |
| <a id="zb8107"></a>`ZB8107` | A one-word component name; a custom element's name needs a hyphen (`--prefix`). |
| <a id="zb8108"></a>`ZB8108` | Part of a React component that isn't converted, left to finish by hand. |
| <a id="zb8201"></a>`ZB8201` | A file with no class that extends `HTMLElement`. |
| <a id="zb8202"></a>`ZB8202` | A custom element module that never names its tag. |
| <a id="zb8203"></a>`ZB8203` | A class that isn't in the shape `--emit element` writes. |
| <a id="zb8204"></a>`ZB8204` | Part of a custom element that isn't converted back to `.zb`. |
| <a id="zb8301"></a>`ZB8301` | A selection the extract-component refactor can't extract. |

## Internal errors (ZB9xxx)

| Code | Meaning |
|---|---|
| <a id="zb9001"></a>`ZB9001` | An internal compiler error: please report it. |
