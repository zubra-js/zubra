# {{title}}

A server-rendered app with [Zubra](https://github.com/journey-to-code-org/zubra) components. A Zubra component is one `.zb` file (a script, styles and a template) that compiles to a standard custom element. Here a Node server renders each page with the components already in the HTML, serves their browser modules, and runs the functions they mark `'use server'`. There is no bundler and no build step.

## Commands

`npm run dev` runs the app at http://localhost:3000: it restarts when `server.js` or anything in `src/` changes, so an edited component or `'use server'` function is there when the page is reloaded (data kept in memory, like `src/notes.js`, starts over), and a component that doesn't compile shows its error in the page as well as the terminal. `npm start` is the same server with `NODE_ENV=production` (components compiled once and cached). `npm test` starts the server and uses the page in Chromium, with JavaScript and with it turned off (`npx playwright install chromium` once). `npx zubra check src/components/*.zb` checks every component and prints each error with a caret and a fix; it should print `no errors` after every change, and adding `--server` also lists what a component's server HTML leaves for the browser.

## Where things are

| Path | What |
|---|---|
| `server.js` | The server. Three steps per request, in this order: `actions.handle` (a form posted to a server function), `zubra.handle` (the components' modules under `/_zubra/`), then the page. `home()` renders the page. |
| `src/components/*.zb` | The components. The file's name is the element's tag. |
| `src/notes.js` | The data: an array in memory, read and written only on the server. |
| `src/style.css` | The page's styles, inlined into the page, and the colours as custom properties (`--text`, `--muted`, `--line`, `--panel`, `--code`, `--accent`, `--page`) that the components read. |
| `test/app.test.js` | The browser test. Add to it for each page and component you write. |
| `skills/` | How to write a component, use one from a page, and render on a server, in full. |

## The components that came with the app

Each is a small, commented example of one idea. Copy the shape from the one closest to what you're building.

| File | Shows |
|---|---|
| `guest-book.zb` | A form whose `action` is a `'use server'` function; `onaction` with what it returned; a list that starts from a prop (`from(saved)`) and follows the answer. Works without JavaScript. |
| `hello-counter.zb` | Props with defaults, state, a derived value, a two-way prop (`count:model`); rendered on the server with a value and continuing in the browser. |
| `todo-list.zb` | A list (`zb-each` with `key`), conditions (`zb-if` / `zb-else`), text input, mutating state. |
| `rating-input.zb` | A form control (`form-associated`): submits under its `name`, resets, validates. |
| `async-tip.zb` | Async data: `resource()` and `<zb-await>` with pending, then and catch. |
| `example-card.zb` | Slots: a default slot with fallback, a named slot, `hasSlot()`. |
| `zubra-examples.zb` | Components using components (`import './todo-list.zb'`), and a parent reading a child form. |
| `zubra-welcome.zb` | A component that is only props and markup. |

`zubra-welcome.zb`, `zubra-examples.zb` and `example-card.zb` are the starter page. When the app gets its own page, delete them, take them out of `home()` in `server.js`, and delete the examples test in `test/app.test.js`. Keep or delete the rest as the app needs.

## Tasks

| Task | Read first |
|---|---|
| Write or change a component | `skills/zubra-component/SKILL.md` |
| Render a page, add a server function, stream, or serve from another host | `skills/zubra-server/SKILL.md` |
| Use a component from a framework or a plain script | `skills/zubra-consume/SKILL.md` |

## Rendering a page

```js
const page = zubra.page();                                   // one per request
const body = page.render('guest-book', { saved: notes });    // HTML, with the props as given
res.end(page.finish(`<!doctype html><html><head>…</head><body>${body}${actions.script()}</body></html>`));
```

- **One `zubra.page()` per request, for both `render()` and `finish()`.** `finish()` adds the CSS and modules of the components that object rendered. A page finished by another object shows its HTML and never comes alive (the server warns in development).
- **Props are the camelCase names**: `page.render('hello-counter', { count: 2 })`. An unknown or missing prop is an error that names it.
- **What renders on the server**: props, `const`s computed from them, `zb-if`, `zb-each`, slots, and expressions the compiler can evaluate the same way a browser would. What only a browser can know (`Date`, `Intl`, a `function` called in the template) is left for the browser to fill in; `npx zubra check --server <file>` lists it.
- **`let` state renders with its starting value**, and the browser carries on from there without redrawing.

## A function on the server

```html
<script>
  import { addNote } from '../notes.js'      // server only: not sent to the browser

  export async function add(formData) {
    'use server'
    return { notes: addNote(String(formData.get('text'))) }
  }
</script>
<guest-book saved={[]}>
  <form action={add} onaction={(event) => (list = event.detail.value.notes)}>…</form>
</guest-book>
```

- `'use server'` as the function's first statement keeps it, and what only it imports, on the server. It gets the form's `FormData` and returns JSON.
- **With JavaScript** the form posts in the background and fires `action` on itself with `event.detail.value`. **Without**, it posts normally, the server redirects back, and `actions.result(req, setHeader)` in `server.js` has the returned value once, to render the page with.
- Validate in the function and return `{ error }`; never trust what the browser sent.
- After a post, the page shows what the component does with the answer. A list that should grow is state that starts from the prop: `let list = from(saved)`, then `list = notes` in `onaction`.

## A component in one screen

```html
<!--
  What it is, in a sentence: this comment becomes its description in the typings.
  @fires valuechange - The value changed; `detail` is the new value.
-->
<script>
  import { onMount } from '@zubra/runtime'

  let open = false                        // a top-level let is state: assign or mutate it
  const label = open ? 'Close' : 'Open'   // a const that reads state or props stays in sync
  function toggle() { open = !open }      // props are plain names here too: `value = 3`
  onMount(() => () => {})                 // runs in the browser; may return a cleanup
</script>
<style>
  button { font: inherit; }               /* scoped to this component */
</style>
<my-thing value:model={0} max={5} label-text="Pick">   <!-- the host tag: the element and its props -->
  <button type="button" onclick={toggle} class:on={open}>{label}</button>
  <p zb-if={open}>{labelText}: {value} of {max}</p>
</my-thing>
```

- **The host tag declares the props**, each with its default: `max={5}` is a number, `label-text="Pick"` a string, `items={[]}` an array, a bare `name` is required. A kebab-case attribute is a camelCase prop (`label-text` → `labelText`).
- **`name:model`** makes a prop two-way: assigning it fires `<name>change` with the new value, which is what frameworks bind to. Use it for a control's value; don't fire that event by hand.
- **Nothing re-renders.** The script runs once per element, and an assignment updates only the text, attribute or list row that read it.
- **`let x = prop` reads the prop once.** `{prop}` in the template and a `const` computed from it follow the prop; for state that should start over when the prop changes, `let x = from(prop)` (from `@zubra/runtime`).
- **Template**: `{expr}` in text and attributes; `onclick={fn}` with modifiers (`onsubmit.prevent`, `onkeydown.enter`); `class:name={bool}`; `style:prop={value}`; `<zb-each items={list} as="item" key={item.id}>`; `zb-if` / `zb-else-if` / `zb-else` on neighbouring elements; `<zb-slot>` for children.
- **Events out**: `emit('itemselect', detail)` from `@zubra/runtime`, the name lowercase with no dashes.
- **Other components**: `import './other-thing.zb'` in the script, then `<other-thing>` in the template. Without the import the tag is an unknown element: it stays empty and nothing warns.
- **TypeScript**: `<script lang="ts">` with an `interface Props` types the props. One file at a time: the others can stay as they are.

## Updating a rendered component from a script

`el.count = 3` (the camelCase property) or `el.setAttribute('count', '3')`, and `el.addEventListener('countchange', (event) => event.detail)`. A misspelt property (`el.cuont = 3`) is an ordinary property nobody reads, with no error, so check the spelling first when an update does nothing. A script that may run before the component's module has loaded waits for `customElements.whenDefined('hello-counter')`.

## Rules that save time

- Name every element with a hyphen, and put it at `src/components/<tag>.zb`.
- Give internal elements specific class names (`tl-left`, not `active` or `card`): in light DOM the page's own CSS reaches in.
- Always give `zb-each` a `key` when rows can be removed or reordered.
- A component takes data in through props and sends it out through events. Data it needs comes from `server.js` as props, or from a `'use server'` function.
- After changing a component: `npx zubra check src/components/*.zb`, then `npm test`.

The full reference is https://github.com/journey-to-code-org/zubra#readme, and the tutorial is https://journey-to-code-org.github.io/zubra/docs/.
