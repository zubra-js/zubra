# Garden plots: Axum

![Garden plots](../../../demos/shots/axum-garden.jpg)

The [Flask garden](../flask-garden) from a Rust server: the same pages, the same five `.zb` components (it `include_zb!`s the Flask example's files), and **no Node.js and no child process**. The components are checked when the binary is built, and rendered in the server's own process.

It's hosted at <https://axum-garden-production.up.railway.app/> (its data resets daily), and the commands below run it yourself.

```sh
cd examples/backends/axum-garden
cargo run                       # http://127.0.0.1:3000   (ADDRESS=0.0.0.0:8080 to change it)
```

Break a component and `cargo build` says so, with the file and line:

```
error: include_zb!("../flask-garden/components/plot-map.zb"): error: unknown reference `colums`
  --> ../flask-garden/components/plot-map.zb:12:15
```

## What's where

| | |
|---|---|
| `src/lib.rs` | The routes, the page layout, and `COMPONENTS`: five `include_zb!` calls. `Page::render("plot-map", json!({…}))` is `Component::render`. |
| `src/store.rs` | Plots, reservations, the waitlist and harvests, **in memory** (the Flask example uses SQLite; this example is about the components). |
| `src/hosted.rs` | `HOSTED_DEMO=1`, the public demo: the Flask example's banner and limits (16 KiB bodies, 30 writes a minute per visitor, 500 waitlist entries and harvests), and a reset every `DEMO_RESET_MINUTES` (a day). `TRUST_PROXIES` is how many proxies append to `X-Forwarded-For`. |
| `tests/garden.rs` | The pages and forms over HTTP, and the comparison below. |
| `tests/hosted.rs` | The hosted mode, with a clock the test moves. |

It uses [`zubra::Component`](../../../src/bundle.rs) (render, CSS, browser module) and [`zubra-macros`](../../../macros). The CSS of the components a page used goes in its `<head>`, their modules at the end of the body, and `@zubra/runtime`'s ES modules are served from this repository's `runtime/src` (set `ZUBRA_RUNTIME` to another folder), as in the Flask example.

## Same HTML as Flask

With the Flask example running, `tests/garden.rs` fetches every page from both servers and compares the HTML, ignoring whitespace between tags (Jinja and `format!` lay out differently). It also posts the same forms to both (an invalid signup, one with quotes to escape, a good one) and compares the replies, and requires each component's browser module to be byte-identical:

```sh
(cd ../flask-garden && python app.py) &                      # port 5000
FLASK_GARDEN_URL=http://127.0.0.1:5000 cargo test
```

A second Flask garden run as the demo (`HOSTED_DEMO=1 TRUST_PROXIES=1 PORT=5001 python app.py`, at `FLASK_GARDEN_HOSTED_URL=http://127.0.0.1:5001`) is compared the same way: the pages with the banner, and the answers to a large body and to too many writes.

Without its variable, each comparison says it is skipping and the rest run. CI runs the first with Flask up (the "Non-JS backend examples" job).
