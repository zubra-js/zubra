# Actions: forms that post to server functions

A component can export a function marked `'use server'`. Its form posts to it, with or without JavaScript, and the function's code never reaches the browser.

```html
<!-- login-form.zb -->
<script>
  import { users } from '../users.js';   // only the server function uses it: it stays on the server

  let message = '';

  export async function login(formData) {
    'use server';
    const email = formData.get('email');
    if (!(await users.has(email))) return { error: 'Invalid login' };
    return { ok: true };
  }
</script>

<login-form>
  <form action={login} onaction={(event) => (message = event.detail.value?.error ?? 'Welcome')}>
    <input name="email" type="email" required />
    <button>Log in</button>
    <p>{message}</p>
  </form>
</login-form>
```

## What the compiler writes

Read the output; it's the whole mechanism.

- **The HTML and the template** get a plain form: `<form action="/_zb/action/login-form/login" method="post">`. `method="post"` is added unless you write a method yourself.
- **The browser module** has `const login = "/_zb/action/login-form/login";` where the function was. The function, the `'use server'` string and `users.js` are gone. The script can still use the name (`fetch(login, …)`).
- **`zubra compile login-form.zb --emit server`** writes the server half: the imports the function needs, the function, and `actions`, which maps its URL to it.

Only a `'use server'` function can be exported from a component script; any other `export` is an error.

## Serving them: `@zubra/actions`

```js
import { createActions } from '@zubra/actions';
const actions = await createActions({ components: 'components' });

// Node's http
if (await actions.handle(req, res)) return;
// fetch-style servers (Bun, Deno)
const response = await actions.fetch(request);
```

Or an adapter: `@zubra/actions/hono` (`app.use(await actions(options))`), `@zubra/actions/express` (mount it before any body parser), `@zubra/actions/fastify` (`app.register(actions, options)`).

Put `actions.script()` on pages with action forms. It's a small module that sends those forms with `fetch` instead of navigating. In production, the default (development is `NODE_ENV=development` or `createActions({ production: false })`), it is served minified, about half the bytes, and cached for an hour; `createActions({ compress: true })` sends it in Brotli or gzip.

### Without a disk: Cloudflare Workers

`createActions` compiles the components folder when it starts, and a Worker has neither the folder nor a way to import code it generates. Build the server functions ahead of time instead, and bundle them like any other module:

```sh
npx zubra-actions build components --out src/actions   # src/actions/index.js exports `actions`
```

```js
import { actions } from './actions/index.js';
import { createActions } from '@zubra/actions/edge';

const forms = createActions({ actions, context: ({ request, env }) => ({ user: who(request, env.SECRET) }) });

export default {
  async fetch(request, env) {
    return (await forms.fetch(request, { env })) ?? page(request, forms.result(request));
  },
};
```

- The answers are the Node entry's, from the same code: its tests send both entries the same posts and compare status, headers and body.
- `context` gets `{ request }` and whatever you pass as `fetch`'s second argument (`{ env, ctx }` in a Worker).
- The enhancing script isn't served from the Worker: copy `@zubra/actions/client` into your static assets as `/_zb/actions.js` (or pass its source as `client`).
- The build writes `<component>.server.js` for each component with server functions, with relative imports pointing back at the source, and `index.js`. Rebuild when a server function changes (add it to your `dev` and `deploy` scripts). It refuses two components defining one URL, as the Node entry does.
- With `@zubra/sync/durable`, a function that must not interleave with another request (the last item, a job two drivers claim) calls a method on the sync object: see [Sync on Workers](sync.md#on-cloudflare-workers-a-durable-object).

## The contract

It's HTTP, so any server can implement it, and `curl` can call an action.

| | With JavaScript | Without |
|---|---|---|
| Request | `fetch(action, { method: 'POST', body: new FormData(form), headers: { accept: 'application/json' } })` | the browser's own post, same body |
| Response | `200` with the return value as JSON (`500` with `{ "error": … }` if the function threw) | `303 See Other` back to the page it came from, with the result in a one-use cookie |
| In the page | the form fires `action` with `detail: { value }` (or `{ error, status }`) | the server reads `actions.result(request)` and renders it |

- The function receives the `FormData` and `{ request }`, plus whatever `createActions({ context })` returns for the request: `context: ({ request, req, c }) => ({ user: req.user, db })`, where `req` is Node's request (so what an auth middleware put on it is there; mount that middleware first) and `c` is Hono's context. If it returns a `Response`, that response is sent as it is. A redirect after success (`return Response.redirect(new URL('/done#top', request.url), 303)`) works on both paths: the browser's post follows it, and the script navigates there once (the server answers it `204` with a `zb-location` header, so the `#fragment` survives). Only an `http:` or `https:` location is passed on that way, and the script follows no other: a redirect to a visitor's `next` that says `javascript:…` would run on the page. Any other scheme goes out as the plain redirect, which neither `fetch` nor a browser follows, and a `zb-location` that isn't http(s) is ignored with a console warning. Check a visitor's `next` yourself all the same: it can still name another site.
- While a request is in flight the form has `aria-busy="true"`, so CSS can show it: `form[aria-busy="true"] button { opacity: .5 }`.
- `beforeaction` fires first and is cancelable (`detail: { formData }`).
- A form opts out of the script with `data-zb-native`. Forms in a shadow root aren't seen by the document's listener; call `enhance(shadowRoot)` from `@zubra/actions/client`.

## Files

A file input posts its file with the rest of the form: give the form `enctype="multipart/form-data"`, and the function gets a `File` from the `FormData`, on both paths (the script sends the form's own `FormData`).

```js
export async function addPhoto(formData) {
  'use server'
  const photo = formData.get('photo');
  if (!(photo instanceof File) || !photo.size) return { error: 'Choose a photo' };
  if (!photo.type.startsWith('image/')) return { error: 'Not an image' };
  await save(photo.name, new Uint8Array(await photo.arrayBuffer()));
}
```

- **A post is read up to `maxBytes`**, files and fields together: 10 MB by default (`createActions({ maxBytes: 2_000_000 })`, `Infinity` for no limit). A bigger one isn't kept (what's left of it is discarded as it arrives, so the browser still gets the answer) and the function doesn't run: the script's `action` event gets `{ error: 'Too large', status: 413 }`, and without JavaScript the page gets `{ error: 'Too large' }` back as the result. A post that declares its size is refused before any of it is read; one that doesn't is counted as it arrives.
- The whole post is in memory while the function runs, so keep the limit to what one request should hold. The type, the name and what's inside are the browser's say-so: check them like any other field.

## Without JavaScript

The page the form came from gets the result back once:

```js
const done = actions.result(req, (name, value) => res.setHeader(name, value)); // clears the cookie
// done: { action: '/_zb/action/login-form/login', value: { error: 'Invalid login' } } or null
page.render('login-form', { message: done?.value?.error ?? '' });
```

The adapters do this for you: `c.get('zubraAction')` (Hono), `res.locals.zubraAction` (Express), `request.zubraAction` (Fastify). A result bigger than a cookie holds (about 4 KB) reaches only the JavaScript path.

Only that page reads it: `result()` on any other path answers `null` and leaves the cookie for the page it's meant for. On HTTPS the cookie is `__Host-zb_result` and `Secure`, so a sibling subdomain or a plain-HTTP response can't plant a result of its own; on plain HTTP (local development) it's `__zb_result`. Over HTTPS only `__Host-zb_result` is read. Behind a proxy that ends TLS, requests reach the app as http: pass `createActions({ secure: true })` so the cookie is still `__Host-` and `Secure`. With no `Referer` (a browser setting, or a client that sends none) the post goes back to `/`.

## Showing what changed

A function's answer goes to the component, and the page shows whatever the component does with it. Nothing re-renders the page after a post made with JavaScript, so a list that should grow is state the component holds: it starts from the prop the server rendered with, and takes the function's answer.

```html
<script>
  import { from } from '@zubra/runtime'
  import { addNote } from '../notes.js'

  let list = from(saved)

  export async function add(formData) {
    'use server'
    return { notes: addNote(String(formData.get('text'))) }
  }
</script>
<guest-book saved={[]}>
  <form action={add} onaction={(event) => (list = event.detail.value.notes)}>
    <input name="text">
    <button>Sign</button>
  </form>
  <ul>
    <zb-each items={list} as="note"><li>{note}</li></zb-each>
  </ul>
</guest-book>
```

Without JavaScript the same form posts, the server redirects back, and the page is rendered again with the new `saved`. `npm create zubra@latest my-app -- --framework server` writes this component in a working app, with the server around it and a test that uses it both ways.

## Plain forms without the reload (experimental)

A form that posts to a route of your own, where the server changes something and redirects back, loads the whole page again. If the form says which parts of the page its post changes, by id, only those parts are replaced:

```html
<form method="post" action="/add" data-zb-updates="site said">…</form>

<nav id="site">Your order (2)</nav>
<div id="said" role="status"></div>
```

```js
html += actions.formsScript(); // <script type="module" src="/_zb/enhance-forms.js"></script>
```

The server doesn't change: it gets the same post and answers with the same redirect. The script sends the post with `fetch`, follows the redirect, and takes those parts' children from the new page; the address becomes the one the server sent. Everything else on the page stays as it is, components and what the visitor has typed included. The form gets an `updated` event when it's done.

The browser posts the form itself, as it would without the script, when the form has no `data-zb-updates` or has `data-zb-native`, when a named id isn't on the page or isn't on the new one, when the server sends the visitor to another page, and when the request fails. A post answered with this page and no redirect (a 422 with the problem in it) is merged the same way.

It needs nothing else from this package: with a bundler, `import '@zubra/actions/enhance-forms'`; at the edge, serve `enhance-forms.js` from your static assets or pass its source as `forms`. Forms inside a shadow root: `enhanceForms(shadowRoot)`. On the comparison's menu page on a slow phone, adding an item went from 525 ms to 264 ms.

## Security

- **Cross-site posts are refused** (by `Sec-Fetch-Site`, or `Origin` when that's missing, which must name this host by http or https, as behind a proxy that ends TLS), so a form on another site can't call an action with your users' cookies. Allow more origins with `origins: [...]`.
- **The client never decides anything.** A server function validates its `FormData` like any endpoint: the form's `required` and `type="email"` are conveniences, not checks.
- **A thrown error is never shown.** The client gets a generic error; `onError(error, request)` gets the real one.
- **Unknown actions are 404**, and only `'use server'` functions have URLs.
- **A post is read only up to `maxBytes`** (10 MB by default), so one request can't fill the server's memory.

## Limits, for now

- Endpoints live at `/_zb/action/`; mounting an app under a sub-path isn't configurable yet.
- An import that a server function uses and that only the *template* (not the script) also uses is dropped from the browser module. Use it in the script, or import it twice.
