//! `'use route <path>'` and `'use layout <prefix>'`: pages and layouts `@zubra/router` serves,
//! and their server-only `load`. The browser module never sees `load` or what only it imports;
//! `--emit server` and `--emit interface` say what the component is.

use zubra::{compile, compile_interface, compile_js, compile_server};

const FARM: &str = r#"<script>
  'use route /farms/:id'
  import { db } from './db.js';
  import { label } from './label.js';
  export async function load({ params }) {
    const farm = await db.farm(params.id, label('farm'));
    if (!farm) return { status: 404 };
    return { farm };
  }
  const heading = label('heading');
</script>
<farm-page farm={null}>
  <h1>Farm</h1>
</farm-page>"#;

fn error(source: &str) -> zubra::Diagnostic {
    compile(source, "{}").expect_err("should not compile")
}

#[test]
fn load_and_its_server_only_imports_never_reach_the_browser() {
    let js = compile_js(FARM, "@zubra/runtime", "farm-page.zb").unwrap();
    assert!(!js.contains("db.js"), "{js}");
    assert!(!js.contains("db.farm"), "{js}");
    assert!(!js.contains("function load"), "{js}");
    assert!(!js.contains("404"), "{js}");
    // An import the rest of the script uses too stays.
    assert!(js.contains("./label.js"), "{js}");
    // The server HTML renders as before.
    let html = compile(FARM, "{}").unwrap();
    assert!(html.contains("<h1>"), "{html}");
}

#[test]
fn the_server_module_carries_the_route_and_load() {
    let server = compile_server(FARM).unwrap();
    assert!(server.contains("import { db } from './db.js'"), "{server}");
    assert!(
        server.contains("import { label } from './label.js'"),
        "{server}"
    );
    assert!(
        server.contains(
            r#"export const route = {"kind":"page","pattern":"/farms/:id","params":["id"],"root":false};"#
        ),
        "{server}"
    );
    assert!(
        server.contains("export async function load({ params })"),
        "{server}"
    );
    // `load` is not an action: nothing can post to it.
    assert!(server.contains("export const actions = {};"), "{server}");
}

#[test]
fn the_interface_says_it_is_a_route() {
    let interface: serde_json::Value =
        serde_json::from_str(&compile_interface(FARM).unwrap()).unwrap();
    assert_eq!(interface["route"]["kind"], "page");
    assert_eq!(interface["route"]["pattern"], "/farms/:id");
    assert_eq!(interface["route"]["params"], serde_json::json!(["id"]));
    assert_eq!(interface["route"]["load"], true);
    // A component that isn't one says so.
    let plain: serde_json::Value =
        serde_json::from_str(&compile_interface("<x-y></x-y>").unwrap()).unwrap();
    assert!(plain["route"].is_null());
}

#[test]
fn a_layout_has_a_prefix_and_can_be_a_root() {
    let source = r#"<script>
  'use layout /farm root'
  export function load({ context }) { return { person: context.person }; }
</script>
<farm-shell person={null}><zb-slot></zb-slot></farm-shell>"#;
    let interface: serde_json::Value =
        serde_json::from_str(&compile_interface(source).unwrap()).unwrap();
    assert_eq!(interface["route"]["kind"], "layout");
    assert_eq!(interface["route"]["pattern"], "/farm");
    assert_eq!(interface["route"]["root"], true);
    // The interface names the slots, so the router can tell a layout has somewhere for its page.
    assert_eq!(interface["slots"], serde_json::json!(["default"]));
    let named: serde_json::Value = serde_json::from_str(
        &compile_interface(r#"<x-y><zb-slot name="side"></zb-slot></x-y>"#).unwrap(),
    )
    .unwrap();
    assert_eq!(named["slots"], serde_json::json!(["side"]));
    let plain =
        r#"<script>'use layout /farm'</script><farm-shell><zb-slot></zb-slot></farm-shell>"#;
    let interface: serde_json::Value =
        serde_json::from_str(&compile_interface(plain).unwrap()).unwrap();
    assert_eq!(interface["route"]["root"], false);
    assert!(
        error(r#"<script>'use layout /farm alone'</script><x-y></x-y>"#)
            .message
            .contains("only `root`")
    );
}

#[test]
fn a_parameter_nothing_reads_is_an_error() {
    let unread = r#"<script>
  'use route /farms/:id/:tab'
  export async function load({ params }) { return { farm: params.id }; }
</script>
<farm-page farm={null}></farm-page>"#;
    let diagnostic = error(unread);
    assert!(
        diagnostic
            .message
            .contains("has the parameter `tab`, which neither `load` nor a prop reads"),
        "{}",
        diagnostic.message
    );
    // Read by load, in either shape.
    for load in [
        "export function load({ params }) { return { a: params.id + params.tab }; }",
        "export function load({ params: { id, tab } }) { return { a: id + tab }; }",
        // Passed on whole: the compiler can't see which it reads, so it trusts it.
        "export function load({ params }) { return find(params); }",
        "export function load(request) { return find(request); }",
    ] {
        let source = format!(
            "<script>\n  'use route /farms/:id/:tab'\n  {load}\n</script>\n<farm-page a=\"\"></farm-page>"
        );
        compile(&source, "{}").unwrap_or_else(|error| panic!("{load}: {}", error.message));
    }
    // No load: the parameters are props.
    let props = r#"<script>'use route /farms/:id'</script><farm-page id=""></farm-page>"#;
    compile(props, "{}").unwrap();
    let missing = r#"<script>'use route /farms/:id'</script><farm-page></farm-page>"#;
    assert!(error(missing).message.contains("parameter `id`"));
}

#[test]
fn load_belongs_to_a_route_and_is_not_an_action() {
    let no_route = r#"<script>
  export async function load() { return {}; }
</script>
<x-y></x-y>"#;
    assert!(error(no_route)
        .message
        .contains("only a route or a layout can export `load`"));
    let marked = r#"<script>
  'use route /'
  export async function load() { 'use server'; return {}; }
</script>
<x-y></x-y>"#;
    assert!(error(marked).message.contains("anyone can post to"));
    let called = r#"<script>
  'use route /'
  export async function load() { return {}; }
  const again = () => load();
</script>
<x-y></x-y>"#;
    assert!(error(called).message.contains("can't call it"));
}

#[test]
fn route_directives_are_checked() {
    // Bare: the path comes from its place in a `routes/` folder (@zubra/router).
    let bare: serde_json::Value = serde_json::from_str(
        &compile_interface(
            r#"<script>'use route'
  export function load({ params }) { return { name: params.id }; }
</script><x-y name=""></x-y>"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(bare["route"]["pattern"].is_null());
    assert_eq!(bare["route"]["reads"], serde_json::json!(["id"]));
    let root: serde_json::Value = serde_json::from_str(
        &compile_interface(r#"<script>'use layout root'</script><x-y><zb-slot></zb-slot></x-y>"#)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(root["route"]["root"], true);
    assert!(error(r#"<script>'use route farms'</script><x-y></x-y>"#)
        .message
        .contains("starts with `/`"));
    assert!(
        error(r#"<script>'use route /a/:id/:id'</script><x-y id=""></x-y>"#)
            .message
            .contains("twice")
    );
    assert!(
        error(r#"<script>'use route /a'; 'use layout /a'</script><x-y></x-y>"#)
            .message
            .contains("one route or one layout")
    );
    // Known now: no warning.
    assert!(zubra::warnings(r#"<script>'use route /'</script><x-y></x-y>"#).is_empty());
    let help = |directive: &str| {
        let source = format!("<script>'{directive}'</script>\n<x-y></x-y>");
        zubra::warnings(&source)
            .into_iter()
            .next()
            .and_then(|warning| warning.help)
            .unwrap_or_default()
    };
    assert!(help("use rout /farms").contains("did you mean 'use route /farms'?"));
    assert!(help("use page /farms").contains("did you mean 'use route /farms'?"));
    assert!(help("use layuot /farm").contains("did you mean 'use layout /farm'?"));
    assert!(help("use cache").contains("@zubra/router"));
}

#[test]
fn a_key_load_returns_that_is_not_a_prop_is_a_warning() {
    let page = |load: &str| {
        format!(
            "<script>\n  'use route /farms/:id'\n  export async function load({{ params }}) {{\n    {load}\n  }}\n</script>\n<farm-page farm={{null}}></farm-page>"
        )
    };
    let messages = |source: &str| -> Vec<String> {
        zubra::warnings(source)
            .into_iter()
            .map(|warning| warning.message)
            .collect()
    };
    let dropped = messages(&page(
        "if (!params.id) return { farm: null }; return { farm: 1, frm: 2, title: 'A farm' };",
    ));
    assert_eq!(dropped.len(), 1, "{dropped:?}");
    assert!(
        dropped[0].contains("`load` returns `frm`, which <farm-page> doesn't declare as a prop"),
        "{dropped:?}"
    );
    // What the compiler can't see, it says nothing about: a spread, a variable, a call, and a
    // function inside load, which returns to its own caller.
    for quiet in [
        "const rest = { x: params.id }; return { farm: 1, ...rest };",
        "const answer = { nope: params.id }; return answer;",
        "return notFound(params.id);",
        "const each = [params.id].map((id) => { return { nope: id }; }); return { farm: each };",
    ] {
        assert!(messages(&page(quiet)).is_empty(), "{quiet}");
    }
    // A layout's keys reach the pages under it, so they aren't checked against its own props.
    let layout = "<script>\n  'use layout /farm'\n  export function load() { return { person: 1 }; }\n</script>\n<farm-shell><zb-slot></zb-slot></farm-shell>";
    assert!(messages(layout).is_empty());
}
