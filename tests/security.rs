//! XSS boundaries for the HTML emitter. Props are data: text and attributes are escaped,
//! unsafe URLs are left out, and a style value cannot close a style element.
use zubra::compile;

fn assert_error(source: &str, props: &str, expected: &str) {
    let diagnostic = compile(source, props).expect_err("expected a compile error");
    assert!(
        diagnostic.message.contains(expected),
        "expected {expected:?}, got {:?}",
        diagnostic.message
    );
}

#[test]
fn text_and_quoted_attributes_escape_markup() {
    let html = compile(
        "<zb-note text title><p title={title}>{text}</p><div data-val={text}></div></zb-note>",
        r#"{"text":"\"><script>alert(1)</script>","title":"onmouseover=alert(1)"}"#,
    )
    .unwrap();
    assert!(
        html.contains("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"),
        "{html}"
    );
    assert!(html.contains("title=\"onmouseover=alert(1)\""), "{html}");
    assert!(
        html.contains("data-val=\"&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\""),
        "{html}"
    );
    assert!(!html.contains("<script>"), "{html}");
    assert!(!html.contains("<img"), "{html}");
}

#[test]
fn user_text_cannot_spoof_a_hydration_marker_or_close_a_script() {
    let html = compile(
        "<zb-note text><p>{text}</p></zb-note>",
        r#"{"text":"<?zb [?> <!-- </script><script>alert(1)</script>"}"#,
    )
    .unwrap();
    assert!(!html.contains("<?zb"), "{html}");
    assert!(!html.contains("<!--"), "{html}");
    assert!(!html.contains("<script"), "{html}");
    assert!(html.contains("&lt;?zb"), "{html}");
    assert!(html.contains("&lt;/script&gt;"), "{html}");
}

#[test]
fn unsafe_url_props_are_left_out_of_href_src_action_and_formaction() {
    let html = compile(
        "<zb-link href src action formaction><a href={href}>go</a><img src={src}><form action={action}><button formaction={formaction}>send</button></form></zb-link>",
        r#"{"href":"javascript:alert(1)","src":"data:text/html,x","action":"vbscript:x","formaction":"JavaScript:alert(1)"}"#,
    )
    .unwrap();
    // The host repeats each prop as an attribute (a custom element doesn't navigate). The
    // elements that would navigate must not carry the URL.
    assert!(html.contains("<a>go</a>"), "{html}");
    assert!(!html.contains("<a href"), "{html}");
    assert!(html.contains("<img>"), "{html}");
    assert!(!html.contains("<img src"), "{html}");
    assert!(html.contains("<form>"), "{html}");
    assert!(!html.contains("<form action"), "{html}");
    assert!(html.contains("<button>send</button>"), "{html}");
    assert!(!html.contains("<button formaction"), "{html}");
}

#[test]
fn a_character_reference_cannot_hide_a_javascript_url() {
    let html = compile(
        "<zb-link href><a href={href}>go</a></zb-link>",
        r#"{"href":"javascript&#58;alert(1)"}"#,
    )
    .unwrap();
    assert!(html.contains("<a>go</a>"), "{html}");
    assert!(!html.contains("<a href"), "{html}");
    // One escape of the host prop: the parser sees `javascript&#58;…`, not `javascript:`.
    assert!(
        html.contains("href=\"javascript&amp;#58;alert(1)\""),
        "{html}"
    );
    assert!(!html.contains("href=\"javascript:"), "{html}");
}

#[test]
fn a_single_quoted_attribute_cannot_become_a_second_attribute() {
    let html = compile(
        "<zb-card name><details title='\"{name}\"'>x</details><span title='she said \"hello\"'>y</span><b title=\"a&amp;b\">z</b></zb-card>",
        r#"{"name":" ontoggle=alert(1) open "}"#,
    )
    .unwrap();
    assert!(
        html.contains("<details title=\"&quot; ontoggle=alert(1) open &quot;\">x</details>"),
        "{html}"
    );
    assert!(
        html.contains("title=\"she said &quot;hello&quot;\""),
        "{html}"
    );
    assert!(html.contains("title=\"a&amp;b\""), "{html}");
    assert!(!html.contains("title=\"a&amp;amp;b\""), "{html}");
}

#[test]
fn imagesrcset_is_checked_like_srcset() {
    let html = compile(
        "<zb-pre src><link rel=\"preload\" as=\"image\" imagesrcset={src}></zb-pre>",
        r#"{"src":"javascript:alert(1) 1x, https://example.com/a.png"}"#,
    )
    .unwrap();
    assert!(
        html.contains("<link rel=\"preload\" as=\"image\">"),
        "{html}"
    );
    assert!(!html.contains("imagesrcset"), "{html}");
}

#[test]
fn a_style_value_cannot_break_out_of_css() {
    // A visitor's value (a profile's colour) that isn't one CSS value is left off the element,
    // with a warning, and the page renders: one of them can't fail the whole render (security
    // audit 6). The value never reaches the HTML.
    for (source, tone) in [
        (
            "<zb-box tone=\"\"><div style:color={tone}>x</div><p>rest</p></zb-box>",
            "red}</style><script>alert(1)</script>",
        ),
        (
            "<zb-box tone=\"\"><div style:background-image={tone}>x</div><p>rest</p></zb-box>",
            "url(https://evil.test/x)",
        ),
        (
            "<zb-box tone=\"\"><div style:background={tone}>x</div><p>rest</p></zb-box>",
            "image-set(\"https://evil.test/x\" 1x)",
        ),
    ] {
        let props = serde_json::json!({ "tone": tone }).to_string();
        let html = compile(source, &props).unwrap();
        assert!(html.contains("<div>x</div><p>rest</p>"), "{html}");
        assert!(
            !html.contains("style=") && !html.contains("<script"),
            "{html}"
        );
        let request = serde_json::json!({
            "command": "compile", "emit": "html", "path": "x.zb",
            "files": { "x.zb": source }, "props": { "tone": tone }
        });
        let reply: serde_json::Value =
            serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
        let omitted = reply["omitted"].as_array().cloned().unwrap_or_default();
        assert!(
            omitted.iter().any(|item| item
                .as_str()
                .is_some_and(|text| text.contains("isn't a single CSS value"))),
            "{reply}"
        );
    }
    // A literal is the author's own: still an error.
    assert_error(
        "<zb-box><div style:color={\"red; background: url(x)\"}></div></zb-box>",
        "{}",
        "isn't a single CSS value",
    );
}

#[test]
fn a_value_cannot_set_the_page_s_base_or_what_a_link_loads() {
    // `<base href>` decides where every relative URL on the page goes, the runtime's and the
    // components' scripts included: a visitor's `https://evil.example/` passes a URL check and
    // runs their script (security audit 6). A spread on `<link>` is a visitor's stylesheet.
    for source in [
        "<zb-x u=\"\"><base href={u}><a href=\"/account\">a</a></zb-x>",
        "<zb-x u=\"\"><base href=\"/{u}/\"></zb-x>",
        "<zb-x o={{}}><base {...o}></zb-x>",
        "<zb-x o={{}}><link {...o}></zb-x>",
        "<zb-x o={{}}><LINK {...o}></zb-x>",
        "<zb-x u=\"\"><BASE HREF={u}></zb-x>",
        "<zb-x o={{}}><Link {...o}></zb-x>",
    ] {
        let error = compile(source, "{}").expect_err(source);
        assert!(
            error.message.contains("<base href>") || error.message.contains("a spread can't go on"),
            "{source}: {}",
            error.message
        );
        assert!(
            zubra::compile_js(source, "@zubra/runtime", "x.zb").is_err(),
            "{source}: the browser's output is refused too"
        );
    }
    // The template's own base, and a link whose URL is a checked value, still compile.
    compile("<zb-x><base href=\"/app/\" target=\"_self\"></zb-x>", "{}").unwrap();
    let html = compile(
        "<zb-x u=\"\"><link rel=\"stylesheet\" href={u}></zb-x>",
        r#"{"u":"javascript:alert(1)"}"#,
    )
    .unwrap();
    assert!(html.contains("<link rel=\"stylesheet\">"), "{html}");
}
