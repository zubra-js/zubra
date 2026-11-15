# @zubra/router

Serve Zubra components as pages, for apps with no host framework. A component says where it lives with `'use route <path>'`; an exported `load` runs on the server before it renders, and what it returns becomes its props.

```html
<script>
  'use route /farms/:id'
  import { farms } from '../db.js'
  export async function load({ params }) {
    const farm = await farms.get(params.id)
    return { name: farm.name }
  }
</script>
<farm-page name="">
  <h1>{name}</h1>
</farm-page>
```

```js
import { createServer } from 'node:http';
import { createZubra } from '@zubra/server';
import { createRouter } from '@zubra/router';

const zubra = createZubra({ components: 'components' });
const router = await createRouter({ zubra, components: 'components' });

createServer(async (req, res) => {
  if (zubra.handle(req, res)) return;         // the components' browser modules
  if (await router.handle(req, res)) return;  // a GET or HEAD to a route
  // …the app's own routes and files…
  await router.notFound(req, res);            // the 404 page
}).listen(3000);
```

`router.listener` is a route or the 404 page, for `createServer` on its own, and `router.fetch(request)` answers fetch-style servers (a `Response`, or `null` when the path isn't a route; `router.notFoundResponse(request)` is the 404).

## Routes

- `'use route /farms/:id'` names a path in [URLPattern](https://developer.mozilla.org/docs/Web/API/URL_Pattern_API) syntax: `:id`, `:path*`, `:tab?`.
- In a `routes/` folder inside the components folder, a bare `'use route'` takes its path from its place: `routes/index.zb` is `/`, `routes/farms/[id].zb` is `/farms/:id`, `routes/docs/[...path].zb` is `/docs/:path*`. A written path there must agree with the folder.
- A path with text in a segment is tried before one with a parameter there, and a parameter before a wildcard.
- Two routes with one path, and a parameter that neither `load` nor a prop reads, are errors: the compiler reports a written path's, `createRouter` a folder's and the duplicates.
- With `@zubra/router` not installed, `@zubra/server` refuses to render a `'use route'` component and says what to install.

## Layouts

A layout is a component with a `<zb-slot></zb-slot>` where the page goes.

- **`app.zb`** in the components folder is the shell: the layout around every page. It needs no directive (it can say `'use layout /'` to export a `load`).
- **`'use layout /farm'`** wraps `/farm` and every page below it (whole segments: not `/farmers`), inside the shell. In `routes/`, a `layout.zb` with a bare `'use layout'` takes its folder as its prefix (`routes/farm/layout.zb`). Layouts nest to any depth, outermost first.
- **`'use layout /farm root'`** starts over: pages under `/farm` are inside it and not inside `app.zb` or any layout above it. For a section with its own frame, like a dashboard beside a public site.
- A layout or page that declares a `route` prop is given `{ path, pattern, params }`, to mark where you are: `aria-current={route.path === '/farm/stock' ? 'page' : null}`.
- A layout can export its own `load`; the loads run outermost first (see below).

The router writes the document around them: `<!doctype html>`, `<html lang>`, a `<head>` with the charset, the viewport and the components' CSS, and the scripts. `createRouter({ lang: 'en-GB', head: '<link rel="stylesheet" href="/site.css">' })` sets the language and adds to the head; `head` can be a function of `{ url, request, route }`.

A layout with no default slot, two layouts for one prefix, and a `layout.zb` whose written prefix disagrees with its folder are errors at `createRouter`.

## `load`

`load({ params, url, request, route, context, result })` runs on the server only. The compiler takes it, and whatever only it imports, out of the browser module; it isn't an action, so nothing can post to it.

- **`context`** is what `createRouter({ context })` returns for the request: the signed-in person, a database handle. Give it the function `createActions({ context })` has, so actions and pages see the same thing. It is made once per request.
- **`result`** is an action's answer after a post without JavaScript, once (`{ action, value }`, or `null`). Pass `createRouter({ actions })` the app's `createActions()`; the router sends the header that clears it.

What it returns:

- **Props.** The props the page declares are taken from the result; anything else stays on the server (the compiler warns about a key a page returns that isn't one of its props). A parameter the page declares as a prop is passed too.
- **`title`**: the document's `<title>`. The innermost one wins, so a page's over its layout's.
- **`notFound()`**: a 404.
- **`redirect('/cart')`**: 303 to there (`redirect(to, 301)` for another status).
- **`show('sign-in', { next: '/door' })`**: another component at the same URL, in this one's place, with those props (`{ status: 403 }` as a third argument sets the response's). For a sign-in form or a "this page is for farmers" notice.

```html
<script>
  'use route /door'
  import { show } from '@zubra/router'
  export async function load({ context }) {
    if (!context.staff) return show('sign-in', { next: '/door' })
    return { who: context.staff.name }
  }
</script>
```

A layout's `load` works the same way, and for its whole section: what it returns reaches every layout and page inside it that declares the prop, and when it answers with `notFound()`, `redirect()` or `show()`, the loads inside it don't run. A `show()` from a layout takes the layout's place, inside the layouts over it; from a `root` layout, that is the app's shell.

## Errors

An unknown path (`router.notFound(req, res)` at the end of the app's handlers, or `router.listener`), `notFound()`, and a `load` that throws render inside `app.zb`, with status 404 or 500. `error.zb`, if the app has one, goes in the shell's slot with a `status` prop; otherwise a heading does. A shell that declares an `error` prop is given `{ status }`. The message never reaches the browser; `onError(error, request)` is told. With no shell, or when the shell can't render, the response is plain text.

## What it doesn't do

Client-side navigation: links load pages. Posts: those are `@zubra/actions`, or the app's own handler. Static files, sessions and caching are the app's server's. `docs/router.md` in the repository has the whole reference.
