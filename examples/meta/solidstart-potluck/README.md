# Saturday potluck: SolidStart 2

![Potluck sign-up](../../../demos/shots/solidstart-potluck.jpg)

This one needs a server, so it isn't in the [live demos](https://zubra-js.github.io/zubra/); the commands below run it.

A potluck sign-up in SolidStart 2 (on Vite and Nitro). The page shows who's bringing what, and
has a form that posts to a server `action`. It works without JavaScript and submits in place
with it. The components:
- `dish-board`, its own;
- `choice-cards` (the course) and `quantity-stepper` (how many people), from the registry and
  form-associated.

Solid uses custom elements directly: `prop:` sets a property and `on:` listens for an event.

```jsx
<choice-cards name="course" label="Course" prop:items={items} prop:value={course()} on:valuechange={(event) => setCourse(event.detail)} />
```

```sh
cargo build                 # from the repository root (the CLI stands in for @zubra/compiler's WebAssembly build)
cd examples/meta/solidstart-potluck
npm install
npm run dev                 # or: npm run build && npm start
```

## What it found

- **Solid's hydration tolerates light DOM.** Solid claims only the nodes it marked, and leaves
  an element's own children alone. That's unlike React, Vue and Svelte (`../README.md`). So
  `dish-board` is light DOM; the registry's two controls are shadow DOM.
- **Solid renders the hosts with no inner markup**, and `prop:` values are properties, so they
  aren't in the server HTML either. The Zubra plugin adds `zb-props` to the hosts in the server
  build, and `src/middleware.js` runs `zubra.injectShadowRoots` on each page with
  `lightDom: true`, so the board's children and the controls' shadow roots are in the page.
  Without JavaScript the action gets the course and head count, and the sign-up goes through.
- **The template wants Node.js 24** (`engines`). It builds and runs on 22, which CI uses.

## As a hosted demo

`HOSTED_DEMO=1` (as `deploy/solidstart-potluck/Dockerfile` sets it) makes it safe to put in
public: every page says `Demo: data resets daily.`, `src/middleware.js` puts the guard from
`src/lib/hosted.js` in front of SolidStart (bodies of at most 16 KiB, 30 writes a minute from each
visitor, the visitor being the `TRUST_PROXIES`-th address from the end of `X-Forwarded-For`), the
action takes at most 100 sign-ups with short names and dishes, `POST /reset` is off, and the
sign-ups go back to the seed every `DEMO_RESET_MINUTES` (1440: at midnight UTC) and on each start.
SolidStart's server functions refuse cross-site posts themselves (`Sec-Fetch-Site`, else `Origin`
against `Host`), which holds behind a proxy that keeps `Host`. `test/hosted.test.js` covers it.
