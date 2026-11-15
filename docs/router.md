# Router: components served as pages

For an app with no host framework. A component says which path it answers with `'use route'`, a `load` runs on the server before it renders, and layouts wrap the pages under them. Every page is a whole document from the server, and every link is an ordinary link. If you use Next, Nuxt, SvelteKit, Astro or another router, keep it: this package is for when there isn't one.

```html
<!-- components/farm-page.zb -->
<script>
  'use route /farms/:id'
  import { notFound } from '@zubra/router'
  import { farms } from '../db.js'   // only load uses it: it stays on the server

  export async function load({ params }) {
    const farm = await farms.get(params.id)
    if (!farm) return notFound()
    return { title: farm.name, name: farm.name, items: farm.items }
  }
</script>

<farm-page name="" items={[]}>
  <h1>{name}</h1>
  <zb-each items={items} as="item" key={item.id}><p>{item.label}</p></zb-each>
</farm-page>
```

```js
// server.js
import { createServer } from 'node:http';
import { createZubra } from '@zubra/server';
import { createRouter } from '@zubra/router';

const zubra = createZubra({ components: 'components' });
const router = await createRouter({ zubra, components: 'components' });

createServer(async (req, res) => {
  if (zubra.handle(req, res)) return;          // the components' browser modules
  if (await router.handle(req, res)) return;   // a GET or HEAD to a route
  // …the app's own routes and files…
  await router.notFound(req, res);             // the 404 page
}).listen(3000);
```

The router is one more handler in the app's own server, like `zubra.handle` and `actions.handle`: `handle(req, res)` answers a route and resolves `true`, or resolves `false` and leaves the request to what comes next. `router.listener` is the whole thing for `createServer` (a route, or the 404 page), and `router.fetch(request)` answers fetch-style servers with a `Response`, or `null` (`router.notFoundResponse(request)` is the 404 there).

## What the compiler does

- `'use route <path>'` and `'use layout <prefix>'` are directives it knows, like `'use server'` and `'use collection'`. Without `@zubra/router` installed, `@zubra/server` refuses to render such a component and says what to install.
- `load` is allowed only in a route or a layout. It, and every import only it uses, is left out of the browser module, exactly as a `'use server'` function is. It is not an action: it has no URL, and marking it `'use server'` or calling it from the rest of the script is an error.
- Every parameter in the path must be read by `load` (`params.id`, or `{ params: { id } }`) or be a prop of the component. One that neither reads is an error naming it.
- A page whose `load` returns a key that isn't one of its props gets a warning: that key never reaches the page.

## Routes

- **By directive:** `'use route /farms/:id'`. The path is a [URLPattern](https://developer.mozilla.org/docs/Web/API/URL_Pattern_API) pathname: `:id`, `:path*`, `:tab?`.
- **By folder:** in `routes/` inside the components folder, a bare `'use route'` takes its path from its place: `routes/index.zb` is `/`, `routes/about.zb` is `/about`, `routes/farms/[id].zb` is `/farms/:id`, `routes/docs/[...path].zb` is `/docs/:path*`. Both ways make one table, and an app can mix them.
- **Order:** segment by segment, text is tried before a parameter and a parameter before a wildcard, so `/farms/new` wins over `/farms/:id` whatever order the files are in.
- **Mistakes found when the server starts:** two routes for one path (both files named), a folder route's parameter nothing reads, a written path that disagrees with its folder, a bare `'use route'` outside `routes/`.

## Layouts

A layout is a component with a `<zb-slot></zb-slot>` where the page goes.

```html
<!-- components/app.zb: the shell around every page -->
<app-shell route={{}}>
  <header>
    <a href="/" aria-current={route.path === '/' ? 'page' : null}>Market</a>
    <a href="/about" aria-current={route.path === '/about' ? 'page' : null}>About</a>
  </header>
  <main><zb-slot></zb-slot></main>
</app-shell>
```

- **`app.zb`** is the shell, the layout around every page. It needs no directive.
- **`'use layout /farm'`** wraps `/farm` and every page under it, inside the shell. Prefixes are whole segments, so it is not around `/farmers`. In `routes/`, `routes/farm/layout.zb` with a bare `'use layout'` is the same thing. Layouts nest to any depth.
- **`'use layout /farm root'`** starts over at its prefix: its pages are not inside `app.zb` or any layout above. For a section with its own frame, such as a dashboard beside a public site.
- A layout or page that declares a **`route`** prop is given `{ path, pattern, params }`.
- The router writes the document around them: the doctype, `<html lang>`, the charset and viewport, the components' CSS and scripts. `createRouter({ lang: 'en-GB', head: '<link rel="stylesheet" href="/site.css">' })` sets the language and adds to `<head>`; `head` may be a function of `{ url, request, route }`. It is written as given, so it is for the app's own markup, never a visitor's text.

## `load`

`load({ params, url, request, route, context, result })`.

- **`context`** is what `createRouter({ context })` returns for the request: the signed-in person, a database handle. Pass the same function `createActions({ context })` has, so pages and actions see the same thing. It is called once per request.
- **`result`** is an action's answer after a post without JavaScript (`{ action, value }`, once, otherwise `null`). Pass `createRouter({ actions })` the app's `createActions()`.

It returns the page's props, and may also return or answer with:

| | |
|---|---|
| `title` | The document's `<title>`. A page's wins over its layout's |
| `notFound()` | The 404 page, with a 404 |
| `redirect('/cart')` | 303 to there; `redirect(to, 301)` for another status |
| `show('sign-in', { next })` | Another component at the same URL, in place of this one. `{ status: 403 }` as a third argument sets the response's |

`show()` is for a sign-in form or a "this page is for farmers" notice: the address stays what was asked for.

A layout's `load` covers its section. What it returns reaches every layout and page inside it that declares the prop. When it answers with `notFound()`, `redirect()` or `show()`, the loads inside it don't run, so one check guards every page under the prefix. Its `show()` takes the layout's place, inside the layouts over it: from a `root` layout, that is the shell.

Live data needs nothing more: return the current value as a prop and let the component follow its `@zubra/sync` document from there.

## Errors

An unknown path, `notFound()`, and a `load` that throws are rendered inside `app.zb`, with status 404 or 500. If the app has `error.zb`, it goes in the shell's slot with a `status` prop; otherwise a heading does. A shell that declares an `error` prop is given `{ status }`. The error's message never reaches the browser: `createRouter({ onError(error, request) })` is told. With no shell, or when the shell itself can't render, the response is plain text.

## What it doesn't do

- **Client-side navigation.** Links load pages. State that should outlive a page belongs in a `@zubra/sync` collection, where it survives a reload too.
- **Posts.** Writes are `@zubra/actions`; a form that posts to a plain URL is the app's own handler.
- **Static files, sessions, caching, prerendering.** The app's server has them, or doesn't need them.
- **Other elements on the server.** A Lit, Stencil or hand-written element in a page arrives as an empty tag and fills in when it upgrades.
