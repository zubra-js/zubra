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
    assert_error(
        "<zb-box tone=\"\"><div style:color={tone}></div></zb-box>",
        r#"{"tone":"red}</style><script>alert(1)</script>"}"#,
        "isn't a single CSS value",
    );
    assert_error(
        "<zb-box tone=\"\"><div style:background-image={tone}></div></zb-box>",
        r#"{"tone":"url(https://evil.test/x)"}"#,
        "isn't a single CSS value",
    );
    assert_error(
        "<zb-box tone=\"\"><div style:background={tone}></div></zb-box>",
        r#"{"tone":"image-set(\"https://evil.test/x\" 1x)"}"#,
        "isn't a single CSS value",
    );
}
