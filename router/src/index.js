// @zubra/router: serve components that say 'use route <path>' as pages.
//
//   import { createZubra } from '@zubra/server';
//   import { createRouter } from '@zubra/router';
//   const zubra = createZubra({ components: 'components' });
//   const router = await createRouter({ zubra, components: 'components' });
//
//   router.handle(req, res)   // Node's http: true if it answered (a GET or HEAD to a route)
//   router.fetch(request)     // fetch-style servers: a Response, or null if not ours
//   router.listener           // (req, res) for http.createServer: a route, or 404
//
// It is one more handler in the app's own server, like `zubra.handle` and `actions.handle`:
// the app keeps its order, its static files and its other routes (plan/app-design.md).
//
// A route's `load({ params, url, request })` runs on the server before the page renders; what
// it returns becomes the page's props. A parameter the page declares as a prop is passed too.
//
// Layouts wrap the page, outermost first: `app.zb`, then each 'use layout <prefix>' the path is
// under, the page in the innermost one's default slot. A layout has its own `load`, and one
// that declares a `route` prop is given `{ path, pattern, params }` (to mark where you are).
//
// `load` is given `{ params, url, request, route, context, result }`: `context` is the app's
// (`createRouter({ context })`, the same function `createActions` takes), `result` an action's
// answer after a post without JavaScript (`createRouter({ actions })`). Besides props it can
// return a `title`, `notFound()`, `redirect(to)` or `show(component, props)`.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findCompiler } from '@zubra/server';
import { ANSWER } from './answers.js';
import { APP, buildTable, fromRoot, matcher, RouteError } from './table.js';

export { notFound, redirect, show } from './answers.js';

export { RouteError };

const SOURCE = /\.zb(?:\.[jt]sx)?$/;

let compiler;
async function compilerModule() {
  if (!compiler) {
    findCompiler();
    compiler = await import('@zubra/compiler');
  }
  return compiler;
}

async function urlPattern() {
  if (globalThis.URLPattern) return globalThis.URLPattern;
  return (await import('urlpattern-polyfill/urlpattern')).URLPattern;
}

/**
 * `zubra`: the app's `createZubra()`, which renders the pages. `components`: the same folder
 * (default `components`). `cacheDir`: where the routes' server halves are written (bare imports
 * resolve from there, so keep it inside the project). `onError(error, request)`: called when a
 * `load` throws; the browser gets a plain 500, never the message. `lang`: the document's
 * language (default `en`). `head`: HTML for every page's `<head>` (fonts, a stylesheet), or a
 * function of `{ url, request, route }` returning it; written as given, so it is the app's own
 * markup, never a visitor's text. `context({ request, req })`: what each `load` gets as
 * `context` (the signed-in person, a database handle), made once per request; give it the
 * function `createActions` has. `actions`: the app's `createActions()`, so `load` gets an
 * action's answer as `result`.
 */
export async function createRouter({
  zubra,
  components = 'components',
  cacheDir = join(process.cwd(), 'node_modules', '.cache', 'zubra-router'),
  onError = (error) => console.error(error),
  lang = 'en',
  head = '',
  context,
  actions,
} = {}) {
  if (!zubra?.page) throw new RouteError('createRouter({ zubra }) needs the app\'s createZubra() to render pages');
  const root = resolve(components);
  if (!existsSync(root)) throw new RouteError(`no components folder at ${root}`);
  const { request: compile, sources: read } = await compilerModule();
  mkdirSync(cacheDir, { recursive: true });

  // Every component that is a route or a layout: what its interface says, and its server half.
  const entries = [];
  const halves = new Map();
  for (const path of sourcesUnder(root)) {
    const described = compile({ emit: 'interface', path, files: read(path) });
    if (!described.ok) throw new Error(described.error);
    const info = JSON.parse(described.output);
    const name = relative(root, path).split(sep).join('/').replace(SOURCE, '');
    if (!info.route && name !== APP) continue;
    const file = relative(process.cwd(), path);
    entries.push({ name, file, props: info.props.map((prop) => prop.name), slots: info.slots, route: info.route });
    if (info.route?.load) halves.set(name, path);
  }
  const { pages, layouts } = buildTable(entries);
  // The props a component declares: only those are taken from what the loads return.
  const declaredBy = new Map(entries.map((entry) => [entry.name, new Set(entry.props)]));
  const propsOf = (name) => {
    if (!declaredBy.has(name)) declaredBy.set(name, new Set(zubra.describe(name).props.map((prop) => prop.name)));
    return declaredBy.get(name);
  };
  const isRoot = new Map(layouts.map((layout) => [layout.name, layout.root]));

  // The server halves of those with a `load`, written to the cache and imported. Their relative
  // imports point back at the source; each is written beside its place and renamed in, so a
  // second process starting at the same moment never imports half a file.
  const loads = new Map();
  for (const [name, path] of halves) {
    const response = compile({ emit: 'server', path, files: read(path) });
    if (!response.ok) throw new Error(response.error);
    const module = join(cacheDir, `${name.split('/').join('__')}.route.mjs`);
    const writing = `${module}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(writing, rewriteImports(response.output, (specifier) => pathToFileURL(resolve(dirname(path), specifier)).href));
    renameSync(writing, module);
    loads.set(name, (await import(`${pathToFileURL(module).href}?t=${Date.now()}`)).load);
  }

  const match = matcher(pages, await urlPattern());

  /** A Response for a GET or HEAD to a route, or null. `extra` (`{ req }`, `{ c }`) goes to `context`. */
  async function respond(request, extra = {}) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const url = new URL(request.url);
    const found = match(url.pathname);
    if (!found) return null;
    const { page, params } = found;
    const route = { path: url.pathname, pattern: page.pattern, params };
    const headers = new Headers();
    const fail = (error) => {
      onError(error, request);
      return text(500, 'Internal error', headers);
    };

    // What every `load` of this request is given. The app's context is made once, and so is the
    // read of an action's answer (reading it clears its cookie), and only if a `load` runs.
    let given;
    const loadArguments = async () => {
      if (!given) {
        const result = actions ? actions.result(extra.req ?? request, (name, value) => headers.append(name, value)) : null;
        given = { params, url, request, route, context: (context ? await context({ request, ...extra }) : null) ?? {}, result };
      }
      return given;
    };
    const loaded = new Map();
    const run = async (name) => {
      if (!loaded.has(name)) loaded.set(name, (await loads.get(name)(await loadArguments())) ?? {});
      return loaded.get(name);
    };

    // The layouts, outermost first, then the page. Each `load` runs in that order, and what the
    // ones outside returned reaches the ones inside as props they declare. A `show()` puts
    // another component in the place of the one that answered, and the walk starts again with
    // it (the loads that already ran aren't run twice).
    let chain = page.layouts;
    let leaf = { name: page.name };
    let status = 200;
    let parts;
    let title;
    try {
      walk: for (let walks = 0; ; walks++) {
        // Each show() from a layout leaves fewer layouts, so this can't go round for long.
        if (walks > page.around.length + 2) throw new RouteError(`${route.pattern}: show() kept being answered with another show()`);
        parts = [];
        title = undefined;
        const data = {};
        const names = [...chain, leaf.name];
        for (let index = 0; index < names.length; index++) {
          const name = names[index];
          const last = index === names.length - 1;
          const answer = last && leaf.props ? leaf.props : loads.has(name) ? await run(name) : {};
          switch (answer[ANSWER]) {
            case 'notFound':
              return text(404, 'Not found', headers);
            case 'redirect':
              headers.set('location', answer.location);
              return new Response(null, { status: answer.status, headers });
            case 'show':
              // In place of a layout: inside the layouts over it, as if it weren't there (so a
              // `root` layout that turns someone away shows its notice in the app's shell).
              if (!last) chain = fromRoot(page.around.slice(0, page.around.indexOf(name)).map((each) => ({ name: each, root: isRoot.get(each) }))).map((each) => each.name);
              leaf = { name: answer.name, props: { ...answer.props } };
              status = answer.status;
              continue walk;
          }
          Object.assign(data, answer);
          if (answer.title != null) title = String(answer.title);
          const declared = propsOf(name);
          const props = {};
          if (declared.has('route')) props.route = route;
          for (const [key, value] of Object.entries(params)) if (declared.has(key)) props[key] = value;
          // Props the component declares; anything else the loads return doesn't reach it.
          for (const [key, value] of Object.entries(data)) if (declared.has(key)) props[key] = value;
          parts.push({ name, props, last });
        }
        break;
      }
    } catch (error) {
      return fail(error);
    }

    let html;
    try {
      const rendering = zubra.page();
      // Inside out: the page, then each layout with what's inside it in its default slot.
      let body = '';
      for (const { name, props, last } of parts.reverse()) {
        body = last ? rendering.render(name, props) : rendering.render(name, props, { default: body });
      }
      const extraHead = typeof head === 'function' ? await head({ url, request, route }) : head;
      const titled = title === undefined ? '' : `<title>${escapeText(title)}</title>`;
      html = rendering.finish(`<!doctype html>\n<html lang="${escapeAttribute(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${titled}${extraHead ?? ''}</head><body>${body}</body></html>`);
    } catch (error) {
      return fail(error);
    }
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : html, { status, headers });
  }

  /** Node's http: answers a route and returns true, or returns false. */
  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let request;
    try { request = toRequest(req); } catch { res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request'); return true; }
    const response = await respond(request, { req });
    if (!response) return false;
    await send(response, res);
    return true;
  }

  /** For `http.createServer(router.listener)`: a route, or a plain 404. */
  async function listener(req, res) {
    if (!(await handle(req, res))) res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }

  return {
    handle,
    listener,
    fetch: respond,
    /** The pages, most specific first: `[{ name, pattern, params, load }]`. */
    routes: () => pages.map(({ name, pattern, params, load, layouts }) => ({ name, pattern, params, load, layouts })),
    /** The layouts, outermost first: `[{ name, pattern, root }]` (`app.zb` is `/`). */
    layouts: () => layouts.map(({ name, pattern, root }) => ({ name, pattern, root })),
    /** Which page a path goes to: `{ name, pattern, params }`, or null. */
    match: (pathname) => {
      const found = match(pathname);
      return found && { name: found.page.name, pattern: found.page.pattern, params: found.params };
    },
  };
}

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function text(status, body, headers = new Headers()) {
  headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(body, { status, headers });
}

function sourcesUnder(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && !entry.startsWith('.')) sourcesUnder(path, out);
    } else if (SOURCE.test(entry)) out.push(path);
  }
  return out;
}

/** Rewrite each relative import (`'./x'`, `'../x'`) with `to(specifier)`. */
function rewriteImports(code, to) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, keyword, quote, specifier) => `${keyword}${quote}${to(specifier)}${quote}`);
}

/** A Node GET or HEAD request as a fetch Request. */
function toRequest(req) {
  const host = req.headers.host ?? 'localhost';
  const protocol = req.socket?.encrypted ? 'https' : 'http';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((each) => headers.append(name, each));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`${protocol}://${host}${req.url}`, { method: req.method, headers });
}

async function send(response, res) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}
