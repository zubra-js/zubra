<p align="center"><img src="brand/zubra-tile.svg" width="96" height="96" alt="Zubra"></p>

# Zubra

Zubra is a compiler for Web Components. You write a component as HTML with `{expr}` bindings and a `<script>`. Zubra turns it into server-rendered HTML and a small custom element that hydrates that HTML. React, Vue and any other framework can then use the element without integration code.

**[Try it in your browser](https://zubra-js.github.io/zubra/playground/)** · [Tutorial](docs/guide/README.md) · [Reference](docs/reference.md) · [Live demos](https://zubra-js.github.io/zubra/) · [Documentation site](https://zubra-js.github.io/zubra/docs/)

```sh
npm create zubra@latest                          # a working app for your framework, or none
npm create zubra@latest -- --framework server    # a server-rendered app: a Node server, a form, no bundler
```

The app it writes has a starter page of small components to read and copy from (a counter, a list, a form control, async data, slots), a dev server that updates components in place, a browser test and an `AGENTS.md` for coding agents ([what's in it](docs/guide/starter-app.md)).

**Status: 6.x, long-term support.** 6.0.0 starts a long-term-support line: everything [Stability](docs/stability.md) marks Stable (the `.zb` format, the compiled ABI, the CLI, the typings and manifest, the hydration markers and the Stable npm entries) is frozen for 6.x and changes only in a major, not before 7.0, and 6.x gets security and critical fixes for 18 months after 6.0.0. The number counts breaking changes, not years in use: majors came close together before 6.0, while Zubra followed new standards as they landed. Coming from 5.x? [Migrating to 6.0](docs/migrating-to-6.0.md): most apps need no change.

## Built with Zubra

These applications run on the published packages, outside this repository. One component library is shared across five frameworks, a Rust static-site generator pre-renders a widget from that library, and the server apps are complete HTML before any JavaScript runs.

- **[open.parlor](https://github.com/journey-to-code-org/open.parlor)** ([live](https://open-parlor.up.railway.app)) is a family games site of fifty-six card, board, word and arcade games, with houses and tournaments. React, Vue, Svelte, Solid and Angular each own a different part of the site and share one `.zb` component library; the game rooms run on `@zubra/sync`. Its conformance suite runs 214 checks in Chrome, Firefox and WebKit. Each fixture is written the way that framework's own documentation would write it, and a difference is filed as an issue. [The last run](https://journey-to-code-org.github.io/open.parlor/conformance/) is published check by check, with the fixtures to try by hand.

  [![Zubra conformance in open.parlor](https://img.shields.io/endpoint?url=https://journey-to-code-org.github.io/open.parlor/conformance/badge.json)](https://journey-to-code-org.github.io/open.parlor/conformance/)

- **[open.blog](https://github.com/journey-to-code-org/open.blog)** is a static-site generator written in Rust. A theme can ship a portable widget, including open.parlor's `<card-room>`. With the `zubra` command installed where the site builds, the build runs `zubra compile` on the widget's `.zb` source and writes that HTML into the page, so a reader with JavaScript off still sees the widget and a link to the parlor.

- **[Potomac Solutions](https://potomac.solutions)** builds apps for small businesses on Zubra and runs a demo of each in production, for made-up businesses with data cleared overnight. They find conformance problems that only show up on a real host, behind a real proxy. The demos:
  - [Hickory Hollow Bakehouse](https://counter.potomac.solutions) ([source](https://github.com/potomac-solutions/counter)): order ahead from a bakery.
  - [Lakeside Paddle & Pedal](https://outfitter.potomac.solutions) ([source](https://github.com/potomac-solutions/outfitter)): kayak, board and bike rentals.
  - [Backbone Mountain Taxidermy](https://work-ticket.potomac.solutions) ([source](https://github.com/potomac-solutions/work-ticket)): jobs tracked by tag number.
  - [Front Desk](https://potomac-solutions.github.io/front-desk/) ([source](https://github.com/potomac-solutions/front-desk)): one server for two businesses, the salon [Yough Valley Hair Co.](https://salon.potomac.solutions) and the [Pine Hollow Volunteer Fire Company](https://fire-company.potomac.solutions).
  - [Old Depot Antiques](https://showroom.potomac.solutions) ([source](https://github.com/potomac-solutions/showroom)): one-of-a-kind stock, held or sold live.
  - [Hemlock Ridge Cinema 8](https://cinestack.potomac.solutions) ([source](https://github.com/potomac-solutions/CineStack)): seats chosen through `@zubra/actions`.
  - [Tailgate](https://tailgate.potomac.solutions) ([source](https://github.com/potomac-solutions/tailgate)): a farm-to-door market.
  - [Apex Auto Supply](https://apex-auto.potomac.solutions) ([source](https://github.com/potomac-solutions/apex-auto)): a call desk for the parts counter.

  The landing page lists them under "Built with Zubra" (`demos/built-with.js`).

- **[Call Store](https://github.com/mnichols08/call-store-)** is a parts-counter call desk built for Southern Auto Supply. **[Tailgate](https://github.com/potomac-solutions/tailgate)** ([live](https://tailgate.potomac.solutions)) is a farm-to-door market: one cart across several farms, one payment, and a driver for each farm's order. Both render every page with `@zubra/server` and post forms through `@zubra/actions`, so the pages are complete HTML with JavaScript off and pick up live updates when it runs. Tailgate keeps a farmer's stock and storefront in `@zubra/sync`, edited on the device and synced when the connection returns.

## A component

```html
<!-- copy-button.zb -->
<script>
  let copied = false                               // state: assigning it updates the DOM

  async function copy() {
    await navigator.clipboard.writeText(text)      // `text` is a prop, by name
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
</script>
<style>
  button.done { color: green; }                    /* scoped to this component, in light DOM */
</style>
<copy-button text label="Copy">                    <!-- the host tag: the element and its props -->
  <button type="button" onclick={copy} class:done={copied}>
    {copied ? "Copied!" : label}
  </button>
</copy-button>
```

```sh
zubra compile copy-button.zb --props props.json   # the HTML a server sends (whitespace aside), for {"text":"npm create zubra"}:
#   <copy-button text="npm create zubra"><button type="button">Copy</button></copy-button>
zubra compile copy-button.zb --emit js             # the custom element that hydrates it
```

```html
<copy-button text="npm create zubra"></copy-button>      <!-- plain HTML -->
```
```tsx
<CopyButton text="npm create zubra" />                   // React or Vue, through @zubra/unplugin: same file, typed
```

The reactivity is the point, not a feature. `let` is state, and the template is bound to it:

```html
<script>
  let count = 0
</script>
<click-counter>
  <button onclick={() => count++}>Clicked {count} times</button>
</click-counter>
```

Nothing re-renders: `count++` updates one text node. The script runs once per element, the way Solid and Svelte 5 work: signals, on Zubra's own engine.

<details>
<summary>The same element written by hand (about 45 lines)</summary>

```js
const template = document.createElement("template");
template.innerHTML = `<style>button.done { color: green; }</style><button type="button"></button>`;

class CopyButton extends HTMLElement {
  static observedAttributes = ["text", "label"];
  #copied = false;
  #timer = null;
  #button;
  #onClick = () => this.copy();              // a stored reference, so removeEventListener works

  constructor() {
    super();
    this.attachShadow({ mode: "open" }).append(template.content.cloneNode(true));
    this.#button = this.shadowRoot.querySelector("button");
  }
  get text() { return this.getAttribute("text") ?? ""; }
  set text(v) { this.setAttribute("text", v); }
  get label() { return this.getAttribute("label") ?? "Copy"; }
  set label(v) { this.setAttribute("label", v); }

  connectedCallback() {
    this.#button.addEventListener("click", this.#onClick);
    this.#render();
  }
  disconnectedCallback() {
    this.#button.removeEventListener("click", this.#onClick);
    clearTimeout(this.#timer);
  }
  attributeChangedCallback() { this.#render(); }

  async copy() {
    await navigator.clipboard.writeText(this.text);
    this.#copied = true;
    this.#render();                           // every state change has to remember this
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#copied = false; this.#render(); }, 1500);
  }
  #render() {
    this.#button.textContent = this.#copied ? "Copied!" : this.label;
    this.#button.classList.toggle("done", this.#copied);
  }
}
customElements.define("copy-button", CopyButton);
```

It needs shadow DOM to scope one style rule, has no server HTML, and has to avoid by hand the two bugs most hand-written elements have (a forgotten `#render()`, a listener removed with a different reference). The compiler writes all of it.
</details>

The by-hand version is the platform's own API with nothing in the way. The compiled output is the same behaviour in two pieces: a short description of this component (the module `--emit js` prints) and one class every component shares (`defineElement` in `runtime/src/element.js`). [Read the output](docs/guide/08-read-the-output.md) maps each rule in the by-hand version to where Zubra handles it.

## Why Zubra

- **One component, every consumer.** The output is a standard custom element with server HTML, typings and React and Vue wrappers, so a component library or design system works in more than one framework, in a CMS, an older app, a static site, or behind a server that isn't JavaScript. If one app on one framework is the only consumer, you don't need it: [Who Zubra is for](docs/who-this-is-for.md) says why, and [What crosses the boundary](docs/what-crosses-the-boundary.md) says which components fit through an element.
- **Nothing is hidden.** `zubra compile` prints the HTML and the JavaScript module it generates, and every part of them exists because of a rule of the platform. [Read the output](docs/guide/08-read-the-output.md) goes through one component's real output and the nine rules behind it.
- **Built on what the platform is standardizing.** Template parts in the shape of DOM Parts, the Context Protocol, form-associated custom elements and declarative shadow DOM, so the runtime shrinks as native features ship. Reactivity follows the TC39 Signals proposal's model on an engine of Zubra's own; the proposal's API itself is an experimental mode (`engine: 'signals'`, see `runtime/README.md`).
- **Measured against the alternatives.** [Compared with Lit and Stencil](docs/compared-with-lit-and-stencil.md) and [Compared with WebUI, FAST, Enhance and WebC](docs/compared-with-html-first.md) say where each is the better choice, with what each sends to the browser and how fast each server renders.

## Packages

Zubra is the compiler and its runtime: `.zb` in, elements, server HTML, typings and framework wrappers out. Everything else is optional and separate, and nothing in the compiler needs it:

| Package | What it adds | Needed when |
|---|---|---|
| `@zubra/unplugin` | `.zb` imports in Vite, Rollup, webpack, esbuild, Rspack; React and Vue wrappers; Astro | Your app has a bundler |
| `@zubra/server` | Components in Express, Fastify, Hono or any template engine; the SSR bridge for meta-frameworks | A JavaScript server renders pages |
| `@zubra/actions` | `'use server'` functions over plain form POST | A component owns a form endpoint |
| `@zubra/sync` | `'use collection'`: state kept in IndexedDB, synced across tabs and devices | A component's state must survive reloads or work offline |
| `@zubra/router` | `'use route'`: a component served as a page, with a server-only `load` | An app with no host framework needs pages |
| `create-zubra`, the VS Code extension, the registry | A starter, editor support, 26 components to copy | Convenience |

Each sibling is a separate install that the compiler reports by name when a component uses a directive it serves ([why the compiler knows them by name](docs/compared-with-lit-and-stencil.md#why-the-compiler-knows-use-server-and-use-collection-by-name)). A compiler alone, with `zubra compile --emit element`, is one file and no dependency.

## Documentation

- **[The guide](docs/guide/README.md)**: a tutorial from a first component to server rendering, forms and local state, with pages for React, Vue, Svelte and Angular developers.
- **[The reference](docs/reference.md)**: every rule of the format and the tools. [Writing a component](docs/reference.md#writing-a-component), [JSX components](docs/reference.md#jsx-components), [Directives](docs/reference.md#directives), [Classes, styles, events and references](docs/reference.md#classes-styles-events-and-references), [Script, state and hooks](docs/reference.md#script-state-and-hooks), [Async data](docs/reference.md#async-data), [Slots](docs/reference.md#slots), [Styles](docs/reference.md#styles), [Events](docs/reference.md#events), [Components using components](docs/reference.md#components-using-components), [Forms](docs/reference.md#forms), [Context](docs/reference.md#context), [Server rendering and hydration](docs/reference.md#server-rendering-and-hydration), [Using components in an app](docs/reference.md#using-components-in-an-app), [Sharing components](docs/reference.md#sharing-components), [Moving in from React](docs/reference.md#moving-in-from-react), [Editors and tooling without Rust](docs/reference.md#editors-and-tooling-without-rust), [One file, no runtime: `--emit element`](docs/reference.md#one-file-no-runtime---emit-element), [Describing components to tools](docs/reference.md#describing-components-to-tools), [Safety](docs/reference.md#safety), [Install the CLI without Node or Rust](docs/reference.md#install-the-cli-without-node-or-rust), [The CLI](docs/reference.md#the-cli), [Standards](docs/reference.md#standards).
- **Topics**: [server rendering](docs/server-rendering.md), [Actions](docs/actions.md), [Sync](docs/sync.md), [the router](docs/router.md), [TypeScript](docs/typescript.md), [security](docs/security.md), [performance](docs/performance.md), [browser support](docs/browser-support.md), [editor support](docs/editor-support.md) and [the framework matrix](docs/framework-matrix.md).
- **[Stability](docs/stability.md)**: what 6.x promises, and every package's tier. **[Migrating to 6.0](docs/migrating-to-6.0.md)**: the move from 5.x.
- `CHANGELOG.md` for what each release changed.

## Stability

6.x is a long-term-support line. Until 7.0, nothing Stable breaks:
- the authoring formats (`.zb`: script semantics, host tag and flags, `{expr}`, directives, slots, keys, imports, `emit`; JSX components);
- the compiled ABI (`abi: 5`), the hydration markers, and the typings and Custom Elements Manifest the compiler writes;
- the CLI's commands, flags and exit codes;
- every npm entry marked Stable, including the runtime's documented exports.

Patch releases (6.0.x) are bug and security fixes only; a minor (6.x.0) adds, or changes something Supported, with a reason in `CHANGELOG.md`; Experimental pieces (signals mode, `@zubra/runtime/track`, `@zubra/runtime/outlet`, `@zubra/unplugin/rspack`) may change in any release. [Stability](docs/stability.md) has the whole promise and every package's tier, and [Migrating to 6.0](docs/migrating-to-6.0.md) the move from 5.x.

The generated JavaScript's internal shape (`$define()`'s arguments, parts) is not public API. It is versioned (`abi`): a runtime refuses modules compiled for an `abi` it can't read with an error that says to recompile, instead of misbehaving.

Browser support: `docs/browser-support.md`.

## Repository and tests

- `src/`: the compiler (Rust): scanner, parser, script analysis with oxc, resolver and lowering, HTML renderer, JavaScript and interface emitters, CLI.
- `runtime/`: `@zubra/runtime`, with the React, Vue and Angular adapters and the server registry.
- `plugin/`: `@zubra/unplugin`, with the Astro integration.
- `compiler/`: `@zubra/compiler`, the compiler as WebAssembly; `wasm/` is its Rust shim.
- `server/`: `@zubra/server`, components rendered by Express, Fastify, Hono, any template engine and edge workers.
- `actions/`, `sync/`, `router/`: the siblings `@zubra/actions` (`'use server'`), `@zubra/sync` (`'use collection'`) and `@zubra/router` (`'use route'`).
- `sync-server/`: `zubra-sync`, the Sync log as one Rust binary, for servers that aren't Node.
- `clients/`: the Python, Ruby and PHP packages that render components from those servers.
- `macros/`: `include_zb!`, a component compiled at `cargo build` and embedded in a Rust server (experimental, not published).
- `editors/`: the language server, the VS Code extension and the browser DevTools extension.
- `prettier-plugin/`: `prettier-plugin-zubra`, which formats `.zb` files (experimental, not on npm yet).
- `create/`: `create-zubra`, the starter (`npm create zubra`), with a template per framework and the example components, `AGENTS.md` and browser test they share (`templates/shared/`).
- `playground/`: the in-browser playground.
- `demos/`: the demo gallery: `demos/build.mjs` builds the landing page, the documentation site, the playground and every static example under one base path, `.github/workflows/pages.yml` publishes it to GitHub Pages, and `demos/shots/` holds every example's screenshot (`demos/screenshots.mjs` for the static ones; the others' tests take theirs with `ZUBRA_SHOTS`).
- `docs/guide/`: the tutorial.
- `site/`: the landing page and the documentation site, built with Eleventy (`npm ci` there first). The page compiles its sample component and its own Copy button (a `.zb` file) when it's built and reads the by-hand version out of this README, so the code it shows is the real output. The docs render the Markdown in `docs/`, this README and the CHANGELOG (`site/src/_data/nav.js` lists the pages, and a link to a file that doesn't exist fails the build). `demos/build.mjs` runs it.
- `docs/who-this-is-for.md`, `docs/what-crosses-the-boundary.md`, `docs/server-rendering.md`: where Zubra fits, which components fit through an element, and the server story with its gaps.
- `registry/`: the components `zubra add` copies, with their accessibility tests.

Install Rust 1.97 or newer and Node 20 or newer.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
(cd runtime && npm ci && npm test)       # unit tests, incl. Signals differential tests
(cd runtime && npm run test:browser)     # Chromium: components, hydration, slots, events, adapters, leaks, benchmarks
(cd runtime && npm run test:tools)       # manifest schema, TypeScript checks, size budgets
(cd plugin && npm ci && npm test)        # real apps: React, Vue, Svelte, Solid, Lit, Astro, Tailwind; Rollup, webpack, esbuild
(cd compiler && npm test)                # render API (and, with zubra.wasm built, parity with the CLI)
(cd server && npm ci && npm test)        # @zubra/server: Express, Fastify, Hono, template engines, the edge
(cd actions && npm ci && npm test)       # 'use server': the contract, the adapters, with and without JavaScript
(cd router && npm ci && npm test)        # 'use route': the table, layouts, load, pages in Chromium
(cd sync && npm ci && npm test)          # 'use collection': reloads, tabs, devices, in Chromium
(cd sync && npm run test:binary)         # the same, against zubra-sync (cargo build -p zubra-sync first)
(cd prettier-plugin && npm ci && npm test)  # the Prettier plugin
(cd clients/python && python -m unittest discover -s tests)  # and clients/ruby, clients/php: see each README
node --test docs/test/*.test.js          # the docs: framework pages' snippets, stability tiers
(cd create && npm test)                  # the starter's command line
node --test "registry/test/*.test.js"    # the registry's components: keyboard and screen-reader behaviour
(cd examples/frameworks && npm ci && npm test)  # the framework apps, and every starter's own browser test
node --test "playground/test/*.test.js"  # the playground in Chromium
node demos/build.mjs --base /zubra/ && node --test "demos/test/*.test.js"  # the demo gallery, served as Pages serves it
```

The browser and plugin suites need Playwright's Chromium (`npx playwright install chromium`). `.github/workflows/ci.yml` runs every suite on each push. Behaviour is mutation-checked: each feature's code was deliberately broken in turn to confirm a test fails.

## License

ISC. See `LICENSE`.
