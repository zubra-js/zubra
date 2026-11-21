//! `{...object}` in a start tag: parsing, the HTML output, the JavaScript output's part, JSX, and
//! where a spread isn't allowed.
use zubra::{
    compile, compile_html_with, compile_html_with_options, compile_js, compile_js_with, Diagnostic,
};

fn js(source: &str) -> String {
    compile_js(source, "@zubra/runtime", "x.zb").unwrap()
}

#[test]
fn a_known_spread_renders_its_attributes_and_the_element_s_own_win() {
    let source = r#"<script>
  const attrs = { href: "/a", title: "theirs", "aria-expanded": false, hidden: true, disabled: false, className: "b", style: { color: "red", fontSize: "2px" }, onClick: null }
</script>
<x-link><a class="a" title="own" {...attrs}>go</a></x-link>"#;
    let html = compile(source, "{}").unwrap();
    assert!(
        html.contains(r#"<a class="a b" title="own" href="/a" aria-expanded="false" hidden style="color: red; font-size: 2px">go</a>"#),
        "{html}"
    );
}

#[test]
fn a_spread_known_only_in_the_browser_is_left_for_the_element() {
    let source = r#"<script>
  function attrs() { return { href: document.baseURI } }
</script>
<x-link><a class="a" {...attrs()}>go</a></x-link>"#;
    let html = zubra::compile_html_with_options(
        source,
        "x.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &zubra::filesystem,
    )
    .unwrap();
    assert!(html.contains(r#"<a class="a">go</a>"#), "{html}");
    let output = js(source);
    assert!(
        output.contains(r#"{ path: [0], spread: () => (attrs()), own: ["class"], bind: $spread }"#),
        "{output}"
    );
}

#[test]
fn what_an_attribute_couldn_t_do_a_known_spread_can_t() {
    // (A spread's `style` it can't write is left out: see the test below.)
    let source = "<script>\n  const attrs = [1, 2]\n</script>\n<x-a><a {...attrs}>go</a></x-a>";
    let error = compile(source, "{}").unwrap_err();
    assert!(
        error.message.contains("spreads an object"),
        "{}",
        error.message
    );
}

// Found by the pre-6.0 audit: a spread's `style` that was text, or held a value like `red;}`,
// failed the whole render; a spread's object is data, so the bad part is left out instead.
#[test]
fn a_spread_leaves_out_a_style_it_cant_write() {
    for (attrs, expected) in [
        (
            r#"{ style: "color: red", title: "t" }"#,
            r#"<a title="t">go</a>"#,
        ),
        (r#"{ style: 7, title: "t" }"#, r#"<a title="t">go</a>"#),
        (
            r#"{ style: { color: "red;}", fontSize: "2px" } }"#,
            r#"<a style="font-size: 2px">go</a>"#,
        ),
        (
            r#"{ style: { color: "red; background: url(x)" } }"#,
            r#"<a>go</a>"#,
        ),
        (
            r#"{ style: { color: { nested: 1 }, margin: "0" } }"#,
            r#"<a style="margin: 0">go</a>"#,
        ),
    ] {
        let source = format!(
            "<script>\n  const attrs = {attrs}\n</script>\n<x-a><a {{...attrs}}>go</a></x-a>"
        );
        let html =
            compile(&source, "{}").unwrap_or_else(|error| panic!("{attrs}: {}", error.message));
        assert!(html.contains(expected), "{attrs}: {html}");
    }
    // From the props, the way a server renders a visitor's data.
    let source = "<x-a attrs={{}}><a {...attrs}>go</a></x-a>";
    let html = compile(source, r#"{"attrs":{"style":"color:red","title":"t"}}"#).unwrap();
    assert!(html.contains(r#"<a title="t">go</a>"#), "{html}");
    let html = compile(
        source,
        r#"{"attrs":{"style":{"color":"red;}","margin":"0"}}}"#,
    )
    .unwrap();
    assert!(html.contains(r#"<a style="margin: 0">go</a>"#), "{html}");
    // A style the author writes is still checked as before.
    let error = compile(
        "<x-a tone=\"\"><a style:color={tone}>go</a></x-a>",
        r#"{"tone":"red;}"}"#,
    )
    .unwrap_err();
    assert!(
        error.message.contains("isn't a single CSS value"),
        "{}",
        error.message
    );
}

#[test]
fn unsafe_spread_styles_are_omitted_without_failing_the_render() {
    let source = r#"<x-a attrs={{}}><a {...attrs}>go</a></x-a>"#;
    for (attrs, expected) in [
        (
            r#"{"style":{"color":"red; background:url(x)","fontSize":"2px","width":{"x":1}}}"#,
            r#"<a style="font-size: 2px">"#,
        ),
        (
            r#"{"style":"color:red","title":"kept"}"#,
            r#"<a title="kept">"#,
        ),
    ] {
        let props = format!(r#"{{"attrs":{attrs}}}"#);
        let html = compile(source, &props).unwrap();
        assert!(html.contains(expected), "{html}");
        let request = serde_json::json!({
            "command": "compile", "emit": "html", "path": "x.zb",
            "files": { "x.zb": source },
            "props": serde_json::from_str::<serde_json::Value>(&props).unwrap()
        });
        let reply: serde_json::Value =
            serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
        assert!(
            reply["omitted"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "{reply}"
        );
    }
}

#[test]
fn a_spread_leaves_out_an_unsafe_url_as_the_browser_does() {
    let source = "<script>\n  const attrs = { href: \"javascript:alert(1)\", title: \"t\" }\n</script>\n<x-a><a {...attrs}>go</a></x-a>";
    let html = compile(source, "{}").unwrap();
    assert!(html.contains(r#"<a title="t">go</a>"#), "{html}");
}

#[test]
fn a_spread_isn_t_allowed_on_the_host_or_a_directive() {
    let host =
        zubra::compile_js("<x-a {...attrs}><p>hi</p></x-a>", "@zubra/runtime", "x.zb").unwrap_err();
    assert!(
        host.message
            .contains("the host tag declares the component's props"),
        "{}",
        host.message
    );
    let directive = compile_js(
        "<script>const x = {}</script><x-a><zb-if test={true} {...x}><p>hi</p></zb-if></x-a>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(
        directive.message.contains("is a directive"),
        "{}",
        directive.message
    );
    let bare = compile_js(
        "<script>const x = {}</script><x-a><p {x}>hi</p></x-a>",
        "@zubra/runtime",
        "x.zb",
    )
    .unwrap_err();
    assert!(
        bare.message.contains("must spread an object"),
        "{}",
        bare.message
    );
}

#[test]
fn every_name_in_a_spread_is_checked() {
    let error = compile_js("<x-a><p {...atrs}>hi</p></x-a>", "@zubra/runtime", "x.zb").unwrap_err();
    assert!(error.message.contains("atrs"), "{}", error.message);
}

#[test]
fn jsx_spreads_onto_elements_and_components() {
    let source = "export default function XPill({ attrs = {} }) {\n  return <button type=\"button\" {...attrs} className=\"pill\">x</button>;\n}\n";
    let output = compile_js(source, "@zubra/runtime", "x-pill.zb.jsx").unwrap();
    assert!(
        output.contains(r#"spread: () => $p.attrs, own: ["type", "class"], bind: $spread"#),
        "{output}"
    );
    let component = "import Badge from './badge.zb';\nexport default function XWrap({ attrs = {} }) {\n  return <Badge {...attrs} />;\n}\n";
    let output = compile_js_with(
        component,
        "x-wrap.zb.jsx",
        "@zubra/runtime",
        None,
        &|specifier: &str, _from: &str| {
            assert_eq!(specifier, "./badge.zb");
            Ok(("badge.zb".to_owned(), BADGE.to_owned()))
        },
    )
    .unwrap();
    assert!(
        output.contains(r#"own: [], props: ["count", "label"], bind: $spread"#),
        "{output}"
    );
}

// ---- a spread onto a zubra component ------------------------------------------------------

const BADGE: &str = r#"<my-badge label="new" count={0}>
  <b>{label}</b> <i>{count}</i>
</my-badge>"#;

fn loader(specifier: &str, _from: &str) -> Result<(String, String), String> {
    match specifier {
        "./badge.zb" => Ok(("badge.zb".to_owned(), BADGE.to_owned())),
        _ => Err("not found".to_owned()),
    }
}

fn parent(spread: &str, extra: &str) -> String {
    format!(
        "<script>\n  import './badge.zb'\n  const rest = {spread}\n</script>\n<my-page><my-badge {extra} {{...rest}}></my-badge></my-page>"
    )
}

fn html(source: &str) -> Result<String, Diagnostic> {
    compile_html_with(source, "page.zb", "{}", "{}", &loader)
}

#[test]
fn a_known_spread_onto_a_component_passes_its_props_and_the_rest_to_the_host() {
    let output = html(&parent(
        r#"{ label: "sale", count: 3, title: "hi", "data-x": "1" }"#,
        "",
    ))
    .unwrap();
    assert!(output.contains("<b>sale</b>"), "{output}");
    assert!(output.contains("<i>3</i>"), "{output}");
    assert!(output.contains(r#"title="hi""#), "{output}");
    assert!(output.contains(r#"data-x="1""#), "{output}");
    // The same page as the props written out, with the other entries as attributes.
    let written = "<script>\n  import './badge.zb'\n</script>\n<my-page><my-badge label=\"sale\" count={3} title=\"hi\" data-x=\"1\"></my-badge></my-page>";
    let written = html(written).unwrap();
    for part in [
        "<b>sale</b> <i>3</i>",
        "title=\"hi\"",
        "data-x=\"1\"",
        "label=\"sale\"",
        "count=\"3\"",
    ] {
        assert_eq!(
            output.matches(part).count(),
            written.matches(part).count(),
            "{part}: {output} vs {written}"
        );
    }
    assert_eq!(
        output.matches("label=").count(),
        1,
        "a prop is not also a second attribute: {output}"
    );
}

#[test]
fn an_explicit_prop_wins_over_the_spread_in_either_order() {
    let output = html(&parent(
        r#"{ label: "from spread", count: 3 }"#,
        r#"label="own""#,
    ))
    .unwrap();
    assert!(output.contains("<b>own</b>"), "{output}");
    assert!(output.contains("<i>3</i>"), "{output}");
    let before = "<script>\n  import './badge.zb'\n  const rest = { label: \"from spread\" }\n</script>\n<my-page><my-badge {...rest} label=\"own\"></my-badge></my-page>";
    assert!(html(before).unwrap().contains("<b>own</b>"));
}

#[test]
fn an_explicit_prop_only_known_in_the_browser_still_wins_over_a_known_spread() {
    let source = "<script>\n  import './badge.zb'\n  const rest = { label: \"from spread\" }\n  function later() { return document.title }\n</script>\n<my-page><my-badge label={later()} {...rest}></my-badge></my-page>";
    let output = compile_html_with_options(
        source,
        "page.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &loader,
    )
    .unwrap();
    // The browser sets the prop; the server doesn't guess it from the spread.
    assert!(output.contains("<b>new</b>"), "{output}");
    assert!(!output.contains("from spread"), "{output}");
}

#[test]
fn a_spread_prop_is_type_checked_like_a_written_one() {
    let error = html(&parent(r#"{ count: "three" }"#, "")).unwrap_err();
    assert!(
        error.message.contains("prop `count` must be"),
        "{}",
        error.message
    );
}

#[test]
fn kebab_case_keys_name_props_too_and_null_is_the_default() {
    let source = "<script>\n  import './chip.zb'\n  const rest = { \"is-open\": true, count: null }\n</script>\n<my-page><my-chip {...rest}></my-chip></my-page>";
    let chip = "<my-chip is-open={false} count={7}><p>{isOpen} {count}</p></my-chip>";
    let output = compile_html_with(source, "page.zb", "{}", "{}", &|_: &str, _: &str| {
        Ok(("chip.zb".to_owned(), chip.to_owned()))
    })
    .unwrap();
    assert!(output.contains("<p>true 7</p>"), "{output}");
}

#[test]
fn a_spread_known_only_in_the_browser_names_the_props_for_the_binder() {
    let source = "<script>\n  import './badge.zb'\n  function rest() { return { label: document.title } }\n</script>\n<my-page><my-badge class=\"a\" {...rest()}></my-badge></my-page>";
    let output = compile_js_with(source, "page.zb", "@zubra/runtime", None, &loader).unwrap();
    assert!(
        output.contains(
            r#"spread: () => (rest()), own: ["class"], props: ["count", "label"], bind: $spread"#
        ),
        "{output}"
    );
    // The server leaves it to the browser: the child renders its defaults, with no error for
    // a required prop the spread may carry.
    let output = compile_html_with_options(
        source,
        "page.zb",
        "{}",
        "{}",
        zubra::HtmlOptions {
            slot_source: zubra::SlotSource::Template,
            partial: true,
            pending: Vec::new(),
        },
        &loader,
    )
    .unwrap();
    assert!(output.contains("<b>new</b>"), "{output}");
}

// ---- required props, two spreads, and the JavaScript output's checks ----------------------

/// `name` has no default, so it's required (as a JSX component's parameter without one is).
const TAG: &str = r#"<my-tag name count={0}>
  <b>{name}</b> <i>{count}</i>
</my-tag>"#;

fn tag_loader(specifier: &str, _from: &str) -> Result<(String, String), String> {
    match specifier {
        "./tag.zb" => Ok(("tag.zb".to_owned(), TAG.to_owned())),
        _ => Err("not found".to_owned()),
    }
}

fn tag_page(script: &str, attributes: &str) -> String {
    format!("<script>\n  import './tag.zb'\n{script}\n</script>\n<my-page rest={{{{}}}}><my-tag {attributes}></my-tag></my-page>")
}

#[test]
fn a_spread_may_give_a_required_prop() {
    // The spread is the parent's prop, known only in the browser: it may carry `name`, so
    // neither output refuses the tag for not writing it. (This is what a converted React
    // component looks like: `<Button {...rest}>`, where Button's params have no defaults.)
    let source = tag_page("", "{...rest}");
    let output = compile_js_with(&source, "page.zb", "@zubra/runtime", None, &tag_loader).unwrap();
    assert!(output.contains(r#"props: ["count", "name"]"#), "{output}");
    // A spread known at build time that has the key.
    let known = tag_page(r#"  const given = { name: "a" }"#, "{...given}");
    compile_js_with(&known, "page.zb", "@zubra/runtime", None, &tag_loader).unwrap();
    let html = compile_html_with(&known, "page.zb", "{}", "{}", &tag_loader).unwrap();
    assert!(html.contains("<b>a</b>"), "{html}");
    // Written out in the tag, where no name is read: both outputs know it.
    let literal = tag_page("", r#"{...{ name: "a" }}"#);
    compile_js_with(&literal, "page.zb", "@zubra/runtime", None, &tag_loader).unwrap();
    assert!(
        compile_html_with(&literal, "page.zb", "{}", "{}", &tag_loader)
            .unwrap()
            .contains("<b>a</b>")
    );
}

#[test]
fn a_known_spread_without_the_required_prop_is_still_an_error() {
    // No spread at all: as before.
    for (attributes, script) in [
        ("", ""),
        // Known, and it doesn't have `name`.
        ("{...{ count: 2 }}", ""),
        // `null` isn't a value: the default, and a required prop has none.
        ("{...{ name: null }}", ""),
    ] {
        let source = tag_page(script, attributes);
        let error =
            compile_js_with(&source, "page.zb", "@zubra/runtime", None, &tag_loader).unwrap_err();
        assert!(
            error.message.contains("requires the prop `name`"),
            "{attributes}: {}",
            error.message
        );
        let error = compile_html_with(&source, "page.zb", "{}", "{}", &tag_loader).unwrap_err();
        assert!(
            error.message.contains("requires the prop `name`"),
            "{attributes}: {}",
            error.message
        );
    }
    // The HTML output knows the parent's constants too.
    let source = tag_page("  const given = { count: 2 }", "{...given}");
    let error = compile_html_with(&source, "page.zb", "{}", "{}", &tag_loader).unwrap_err();
    assert!(
        error.message.contains("requires the prop `name`"),
        "{}",
        error.message
    );
}

#[test]
fn the_javascript_output_type_checks_a_known_spread_too() {
    let source = tag_page("", r#"{...{ name: "a", count: "three" }}"#);
    let error =
        compile_js_with(&source, "page.zb", "@zubra/runtime", None, &tag_loader).unwrap_err();
    assert!(
        error.message.contains("prop `count` must be"),
        "{}",
        error.message
    );
    // The tag's own prop wins, so the spread's value for it isn't checked.
    let source = tag_page("", r#"count={1} {...{ name: "a", count: "three" }}"#);
    compile_js_with(&source, "page.zb", "@zubra/runtime", None, &tag_loader).unwrap();
}

#[test]
fn of_two_spreads_the_later_one_wins_as_in_the_browser() {
    let source = tag_page(
        r#"  const first = { name: "first", count: 1 }
  const second = { name: "second" }"#,
        "{...first} {...second}",
    );
    let html = compile_html_with(&source, "page.zb", "{}", "{}", &tag_loader).unwrap();
    assert!(html.contains("<b>second</b> <i>1</i>"), "{html}");
    // `null` in the later one: back to the default, not the earlier spread's value.
    let source = tag_page(
        r#"  const first = { name: "first", count: 1 }
  const second = { count: null }"#,
        "{...first} {...second}",
    );
    let html = compile_html_with(&source, "page.zb", "{}", "{}", &tag_loader).unwrap();
    assert!(html.contains("<b>first</b> <i>0</i>"), "{html}");
    // The tag's own prop still wins over both, wherever it's written.
    let source = tag_page(
        r#"  const first = { name: "first" }
  const second = { name: "second" }"#,
        r#"{...first} name="own" {...second}"#,
    );
    let html = compile_html_with(&source, "page.zb", "{}", "{}", &tag_loader).unwrap();
    assert!(html.contains("<b>own</b>"), "{html}");
}

#[test]
fn a_spread_key_that_isn_t_a_name_is_left_out_not_written_as_markup() {
    // Security audit Z3: keys come from a value (maybe a user's), and were written raw.
    let source = r#"<x-link attrs={{}}><a {...attrs}>go</a></x-link>"#;
    let props = r#"{ "attrs": {
        "title": "kept",
        "x onmouseover=alert(1) y": "1",
        "a\"><script>alert(2)</script>": "1",
        "data-ok": "yes",
        "style": { "color": "blue", "color:red;background:url(//evil)": "1", "--brand": "green", "--x;y": "1" }
    } }"#;
    let html = compile(source, props).unwrap();
    // The host carries its props as escaped JSON; the element the spread writes is what matters.
    let link = &html[html.find("<a ").expect("the link")..];
    assert!(!link.contains("onmouseover"), "{link}");
    assert!(!link.contains("<script>"), "{link}");
    assert!(!link.contains("evil"), "{link}");
    assert!(!link.contains("--x"), "{link}");
    assert!(
        html.contains(
            r#"<a title="kept" data-ok="yes" style="color: blue; --brand: green">go</a>"#
        ),
        "{html}"
    );
}

#[test]
fn every_html_attribute_name_a_spread_writes_still_passes() {
    let source = r#"<script>
  const attrs = { "aria-label": "a", "data-x.y_z": "b", "xml:lang": "en", "_private": "c", tabindex: 0 }
</script>
<x-link><a {...attrs}>go</a></x-link>"#;
    let html = compile(source, "{}").unwrap();
    assert!(
        html.contains(r#"aria-label="a" data-x.y_z="b" xml:lang="en" _private="c" tabindex="0""#),
        "{html}"
    );
}

#[test]
fn a_spread_never_sets_an_animations_values_or_a_metas_http_equiv() {
    // As props (a visitor's data): left out, not an error.
    let source = r#"<x-anim anim={{}} meta={{}}><svg><a href="/ok"><set {...anim}/><text>t</text></a></svg><meta {...meta}></x-anim>"#;
    let props = r#"{"anim": {"attributeName": "href", "to": "javascript:alert(1)", "values": "javascript:alert(1)", "begin": "0s"}, "meta": {"http-equiv": "refresh", "content": "0;url=https://evil.example/"}}"#;
    let html = compile(source, props).unwrap();
    assert!(html.contains(r#"<set begin="0s">"#), "{html}");
    // (The host tag carries the props themselves; what matters is what the children say.)
    let children = &html[html.find("<svg>").unwrap()..];
    assert!(!children.contains("javascript:"), "{html}");
    assert!(!children.contains("http-equiv"), "{html}");
    // A literal http-equiv stays; a spread must not fill in its content.
    let source = r#"<x-meta attrs={{}}><meta http-equiv="refresh" {...attrs}></x-meta>"#;
    let html = compile(
        source,
        r#"{"attrs": {"content": "0;url=https://evil.example/"}}"#,
    )
    .unwrap();
    assert!(html.contains("http-equiv=\"refresh\""), "{html}");
    assert!(!html.contains("content="), "{html}");
    // `animate`, `animateMotion`, `animateTransform` too; other elements keep `to` and `values`.
    let source = r#"<x-anim anim={{}}><svg><animate {...anim}/><animateTransform {...anim}/><g {...anim}/></svg></x-anim>"#;
    let html = compile(source, r#"{"anim": {"to": "x", "values": "y"}}"#).unwrap();
    let children = &html[html.find("<svg>").unwrap()..];
    assert_eq!(children.matches("to=").count(), 1, "{html}");
    assert_eq!(children.matches("values=").count(), 1, "{html}");
}

#[test]
fn what_a_spread_cant_set_is_left_out_not_a_failed_render() {
    // Spread objects are often a visitor's data: one stored `onclick` or `srcdoc` must not make
    // every render that spreads it fail. Left out, as the runtime leaves it out.
    let source = "<x-a attrs={{}}><a {...attrs}>go</a><iframe {...attrs}></iframe></x-a>";
    let props = r#"{"attrs": {"onclick": "alert(1)", "innerHTML": "<b>x</b>", "srcdoc": "<script>x</script>", "ping": "/account/delete", "title": "kept"}}"#;
    let html = compile(source, props).unwrap();
    let children = &html[html.find("<a").unwrap()..];
    for key in ["onclick", "<b>", "srcdoc", "ping"] {
        assert!(!children.contains(key), "{key}: {html}");
    }
    assert_eq!(children.matches(r#"title="kept""#).count(), 2, "{html}");
    // The same from the script's own constant.
    let source = "<script>\n  const attrs = { onclick: 'alert(1)', title: 'kept' }\n</script>\n<x-a><a {...attrs}>go</a></x-a>";
    let html = compile(source, "{}").unwrap();
    assert!(
        !html.contains("onclick") && html.contains(r#"title="kept""#),
        "{html}"
    );
}
