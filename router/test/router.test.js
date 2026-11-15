import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createRouter } from '../src/index.js';

const components = fileURLToPath(new URL('./components', import.meta.url));
const zubra = createZubra({ components });
const errors = [];
// The cache is inside this package, so the fixtures' `import … from '@zubra/router'` resolves
// to it (in an app it resolves from node_modules).
const cacheDir = fileURLToPath(new URL('./.cache', import.meta.url));
const person = ({ request }) => ({ person: request.headers.get('x-person') });
const router = await createRouter({ zubra, components, cacheDir, context: person, onError: (error) => errors.push(error) });

const get = async (path, method = 'GET', headers = {}) => router.fetch(new Request(`http://localhost${path}`, { method, headers }));

test('the table has every route, by directive and by folder, most specific first', () => {
  // Segment by segment, text before a parameter before a wildcard; then the longer pattern.
  assert.deepEqual(router.routes().map((route) => [route.pattern, route.name]), [
    ['/farm/stock', 'farm-stock'],
    ['/farms/new', 'routes/farms/new'],
    ['/farms/:id', 'farm-page'],
    ['/docs/:path*', 'routes/docs/[...path]'],
    ['/', 'home-page'],
    ['/about', 'routes/about'],
    ['/broken', 'broken-page'],
    ['/door', 'door-page'],
    ['/farm', 'farm-today'],
    ['/farmers', 'farmers-page'],
    ['/old', 'old-page'],
  ]);
  assert.equal(router.match('/farms/new').name, 'routes/farms/new', 'a static segment beats a parameter');
  assert.deepEqual(router.match('/farms/hilltop'), { name: 'farm-page', pattern: '/farms/:id', params: { id: 'hilltop' } });
  assert.equal(router.match('/nowhere'), null);
});

test('a route renders as a whole page on the server', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<home-page[^>]*>[\s\S]*<h1>Home<\/h1>/);
  assert.match((await (await get('/about')).text()), /<h1>About<\/h1>/);
  assert.match((await (await get('/farms/new')).text()), /<h1>New farm<\/h1>/);
});

test('app.zb is around every page, with the page in its slot and the current link marked', async () => {
  assert.deepEqual(router.layouts(), [
    { name: 'app', pattern: '/', root: false },
    { name: 'farm-shell', pattern: '/farm', root: true },
    { name: 'routes/docs/layout', pattern: '/docs', root: false },
  ]);
  const home = await (await get('/')).text();
  assert.match(home, /^<!doctype html>\n<html lang="en"><head><meta charset="utf-8">/);
  assert.match(home, /<body><app-shell[\s\S]*<header class="public">[\s\S]*<main>[\s\S]*<home-page[\s\S]*<h1>Home<\/h1>[\s\S]*<\/main>\s*<\/app-shell>/);
  assert.match(home, /<a href="\/" aria-current="page">Home<\/a>/);
  assert.match(home, /<a href="\/about">About<\/a>/);
  const about = await (await get('/about')).text();
  assert.match(about, /<a href="\/about" aria-current="page">About<\/a>/);
  assert.match(about, /<a href="\/">Home<\/a>/);
  // The shell hydrates too: its module is on the page.
  assert.match(home, /_zubra\/components\/app\.js/);
});

test('a layout wraps the pages under its prefix, inside the shell', async () => {
  assert.deepEqual(router.routes().find((route) => route.name === 'routes/docs/[...path]').layouts, ['app', 'routes/docs/layout']);
  const docs = await (await get('/docs/guide/routing')).text();
  assert.match(docs, /<app-shell[\s\S]*<main>[\s\S]*<docs-shell[\s\S]*<aside class="docs">Docs<\/aside>[\s\S]*<docs-page[\s\S]*guide\/routing[\s\S]*<\/docs-shell>[\s\S]*<\/main>/);
});

test("a root layout replaces the shell for its prefix; its load is its own props", async () => {
  const stock = await (await get('/farm/stock?as=Grace')).text();
  assert.match(stock, /<body><farm-shell[\s\S]*<section>[\s\S]*<farm-stock[\s\S]*<h1>Stock<\/h1>[\s\S]*<\/section>\s*<\/farm-shell>/);
  assert.doesNotMatch(stock, /app-shell|class="public"/, 'no public header');
  assert.match(stock, /<a href="\/farm\/stock" aria-current="page">Stock<\/a>/);
  assert.match(stock, /<a href="\/farm">Today<\/a>/);
  assert.match(stock, /<p class="farmer">Grace<\/p>/);
  assert.doesNotMatch(stock, /stays on the server/);
  const today = await (await get('/farm')).text();
  assert.match(today, /<a href="\/farm" aria-current="page">Today<\/a>/);
  assert.match(today, /<p class="farmer">Ada<\/p>/);
  // A prefix is whole segments: /farmers isn't under /farm.
  const farmers = await (await get('/farmers')).text();
  assert.match(farmers, /<app-shell/);
  assert.doesNotMatch(farmers, /farm-shell/);
});

test('lang and head go on every page', async () => {
  const styled = await createRouter({
    zubra,
    components,
    cacheDir,
    lang: 'en-GB',
    head: ({ route }) => `<link rel="stylesheet" href="/site.css"><meta name="at" content="${route.pattern}">`,
  });
  const html = await (await styled.fetch(new Request('http://localhost/farms/hilltop'))).text();
  assert.match(html, /<html lang="en-GB">/);
  assert.match(html, /<head>[\s\S]*<link rel="stylesheet" href="\/site\.css"><meta name="at" content="\/farms\/:id">[\s\S]*<\/head>/);
});

test("load's result becomes the page's props; a parameter the page declares is passed too", async () => {
  const html = await (await get('/farms/hilltop?q=apples')).text();
  assert.match(html, /<h1>Hilltop Farm<\/h1>/);
  assert.match(html, /<p class="query">apples<\/p>/);
  // Only what the page declares reaches it.
  assert.doesNotMatch(html, /sk_live_router|dropped/);
  const docs = await (await get('/docs/guide/routing')).text();
  assert.match(docs, /<p class="path">guide\/routing<\/p>/);
});

test("load and what only it imports never reach the browser", async () => {
  const module = await (await zubra.fetch(new Request('http://localhost/_zubra/components/farm-page.js'))).text();
  assert.doesNotMatch(module, /farms\.js|sk_live_router|function load|Hilltop/);
  const served = await zubra.fetch(new Request('http://localhost/_zubra/components/farms.js'));
  assert.equal(served?.status ?? 404, 404);
});

test('notFound() is a 404, redirect() sends the browser on', async () => {
  const missing = await get('/farms/nowhere');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /<app-shell[\s\S]*<h1 class="oops">Nothing here<\/h1>/);
  const moved = await get('/old');
  assert.equal(moved.status, 303);
  assert.equal(moved.headers.get('location'), '/farms/new');
  assert.equal(await moved.text(), '');
  const forGood = await get('/old?moved');
  assert.equal(forGood.status, 301);
  assert.equal(forGood.headers.get('location'), '/about');
});

test("a title from load is the document's, escaped", async () => {
  const html = await (await get('/farms/hilltop')).text();
  assert.match(html, /<head>[\s\S]*<title>Hilltop Farm &lt;Tailgate><\/title>[\s\S]*<\/head>/);
  assert.doesNotMatch(await (await get('/')).text(), /<title>/);
});

test("context reaches load, and show() renders another component at the same URL", async () => {
  const in_ = await get('/door', 'GET', { 'x-person': 'Grace' });
  assert.equal(in_.status, 200);
  assert.match(await in_.text(), /<h1>Door: Grace<\/h1>/);
  const out = await get('/door');
  assert.equal(out.status, 200);
  const form = await out.text();
  assert.match(form, /<app-shell[\s\S]*<sign-in[\s\S]*<form method="post" action="\/staff\/sign-in">[\s\S]*name="next" value="\/door"/);
  assert.doesNotMatch(form, /door-page/);
});

test("a layout's load reaches the pages under it, and answers for its section", async () => {
  const stock = await (await get('/farm/stock', 'GET', { 'x-person': 'Lin' })).text();
  assert.match(stock, /<p class="farmer">Lin<\/p>/);
  assert.match(stock, /<p class="for">Stock for Lin<\/p>/, "the layout's result is the page's prop");
  assert.match(stock, /<title>Stock<\/title>/);
  // Turned away by the layout: its notice takes the layout's place, in the app's shell, and
  // the page's load never runs.
  const away = await get('/farm/stock?as=nobody');
  assert.equal(away.status, 403);
  const notice = await away.text();
  assert.match(notice, /<app-shell[\s\S]*<main>[\s\S]*<farmers-only[\s\S]*\/farm\/stock is for farmers/);
  assert.doesNotMatch(notice, /farm-shell|farm-stock|<title>/);
});

test("an action's answer reaches load as result, and its cookie is cleared", async () => {
  const asked = [];
  const actions = {
    result(request, setHeader) {
      asked.push(request);
      setHeader('set-cookie', '__zb_result=; Max-Age=0; Path=/');
      return { action: '/_zb/action/sign-in/enter', value: { error: 'Wrong code' } };
    },
  };
  const withActions = await createRouter({ zubra, components, cacheDir, context: person, actions });
  const response = await withActions.fetch(new Request('http://localhost/door'));
  assert.match(await response.text(), /<p class="problem">Wrong code<\/p>/);
  assert.deepEqual(response.headers.getSetCookie(), ['__zb_result=; Max-Age=0; Path=/']);
  assert.equal(asked.length, 1, 'read once');
  // A page with no load leaves the answer for the page that wants it.
  await withActions.fetch(new Request('http://localhost/'));
  assert.equal(asked.length, 1);
});

test("on Node's http, context gets req and the cleared cookie is sent", async () => {
  const actions = { result: (req, setHeader) => { setHeader('set-cookie', 'a=1'); setHeader('set-cookie', 'b=2'); return null; } };
  const node = await createRouter({ zubra, components, cacheDir, actions, context: ({ req }) => ({ person: req?.headers['x-person'] }) });
  const server = createServer(node.listener);
  await new Promise((done) => server.listen(0, done));
  after(() => server.close());
  const response = await fetch(`http://localhost:${server.address().port}/door`, { headers: { 'x-person': 'Ada' } });
  assert.match(await response.text(), /<h1>Door: Ada<\/h1>/);
  assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2']);
});

test('an unknown path, a post and a thrown load', async () => {
  assert.equal(await get('/nowhere'), null, "not the router's: the app's next handler decides");
  assert.equal(await router.fetch(new Request('http://localhost/', { method: 'POST', body: 'x' })), null);
  const head = await get('/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const broken = await get('/broken');
  assert.equal(broken.status, 500);
  const page = await broken.text();
  assert.match(page, /<header class="public">[\s\S]*<main data-error="500">[\s\S]*<h1 class="oops">That broke<\/h1>/, 'inside the shell');
  assert.match(page, /<title>Something went wrong<\/title>/);
  assert.doesNotMatch(page, /database/, 'never the message');
  assert.equal(errors.at(-1).message, 'the database is down');
});

test("Node's http: handle answers routes, the listener answers everything else with 404", async () => {
  const server = createServer(router.listener);
  await new Promise((done) => server.listen(0, done));
  after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const page = await fetch(`${base}/farms/ridge`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Ridge Orchard<\/h1>/);
  const missing = await fetch(`${base}/nowhere`);
  assert.equal(missing.status, 404);
  const notFound = await missing.text();
  assert.match(notFound, /<header class="public">[\s\S]*<main data-error="404">[\s\S]*<error-page[\s\S]*<h1 class="oops">Nothing here<\/h1>/);
  assert.match(notFound, /<title>Page not found<\/title>/);
  assert.equal((await fetch(`${base}/nowhere`, { method: 'POST', body: 'x' })).status, 404);
  // handle() leaves what isn't a route to the app.
  const chained = createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    res.writeHead(418).end('the app');
  });
  await new Promise((done) => chained.listen(0, done));
  after(() => chained.close());
  const other = `http://localhost:${chained.address().port}`;
  assert.equal((await fetch(`${other}/`)).status, 200);
  assert.equal((await fetch(`${other}/static/site.css`)).status, 418);
  assert.equal((await fetch(`${other}/`, { method: 'POST', body: 'x' })).status, 418);
});

/** A components folder of its own, for one mistake. */
async function tableError(files) {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-router-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    await createRouter({ zubra: createZubra({ components: dir }), components: dir, cacheDir: join(dir, '.cache') });
  } catch (error) {
    return error.message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return null;
}

test('two routes with one pattern are an error naming both', async () => {
  const message = await tableError({
    'a-page.zb': "<script>'use route /same'</script>\n<a-page></a-page>\n",
    'routes/same.zb': "<script>'use route'</script>\n<b-page></b-page>\n",
  });
  assert.match(message, /a-page\.zb and .*routes[\\/]same\.zb are both routes for \/same/);
});

test("a folder route's parameters are checked like a written one's", async () => {
  assert.match(
    await tableError({ 'routes/farms/[id].zb': "<script>'use route'</script>\n<farm-page></farm-page>\n" }),
    /is \/farms\/:id, whose parameter `id` neither `load` nor a prop reads/,
  );
  assert.equal(await tableError({ 'routes/farms/[id].zb': '<script>\'use route\'</script>\n<farm-page id=""></farm-page>\n' }), null, 'a prop reads it');
  assert.equal(
    await tableError({ 'routes/farms/[id].zb': "<script>'use route'\nexport function load({ params }) { return { name: params.id } }</script>\n<farm-page name=\"\"></farm-page>\n" }),
    null,
    'load reads it',
  );
  assert.match(
    await tableError({ 'routes/farms/[id].zb': "<script>'use route'\nexport function load({ params }) { return { name: params.slug } }</script>\n<farm-page name=\"\"></farm-page>\n" }),
    /parameter `id` neither/,
  );
});

test('a bare route outside routes/, and a written path that disagrees with its folder', async () => {
  assert.match(
    await tableError({ 'lost-page.zb': "<script>'use route'</script>\n<lost-page></lost-page>\n" }),
    /says 'use route' with no path, and isn't in a routes\/ folder/,
  );
  assert.match(
    await tableError({ 'routes/about.zb': "<script>'use route /info'</script>\n<about-page></about-page>\n" }),
    /says 'use route \/info', but its place in routes\/ makes it \/about/,
  );
  assert.match(
    await tableError({ 'routes/[id.zb': "<script>'use route'</script>\n<odd-page></odd-page>\n" }),
    /plain text or one \[param\]/,
  );
});

test('layout mistakes are named', async () => {
  const page = "<script>'use route /'</script>\n<home-page></home-page>\n";
  assert.match(
    await tableError({ 'home-page.zb': page, 'app.zb': '<app-shell><header>Site</header></app-shell>\n' }),
    /app\.zb is a layout with nowhere for its page: put `<zb-slot><\/zb-slot>`/,
  );
  assert.match(
    await tableError({ 'home-page.zb': page, 'app.zb': '<app-shell><zb-slot></zb-slot></app-shell>\n', 'other-shell.zb': "<script>'use layout /'</script>\n<other-shell><zb-slot></zb-slot></other-shell>\n" }),
    /app\.zb and .*other-shell\.zb are both layouts for \//,
  );
  assert.match(
    await tableError({ 'app.zb': "<script>'use route /'</script>\n<app-shell><zb-slot></zb-slot></app-shell>\n" }),
    /app\.zb is the app's shell, the layout around every page: it can say 'use layout \/' \(to export `load`\), not 'use route \/'/,
  );
  assert.match(
    await tableError({ 'side-shell.zb': "<script>'use layout'</script>\n<side-shell><zb-slot></zb-slot></side-shell>\n" }),
    /says 'use layout' with no prefix, and isn't a layout\.zb in a routes\/ folder/,
  );
  assert.match(
    await tableError({ 'routes/farm/layout.zb': "<script>'use layout /field'</script>\n<side-shell><zb-slot></zb-slot></side-shell>\n" }),
    /says 'use layout \/field', but its place in routes\/ makes it \/farm/,
  );
  // The shell may say what it is, to have a load.
  assert.equal(
    await tableError({ 'home-page.zb': page, 'app.zb': "<script>'use layout /'\nexport function load() { return { year: 2026 } }</script>\n<app-shell year={0}><zb-slot></zb-slot></app-shell>\n" }),
    null,
  );
});

test('errors without error.zb get a heading in the shell; without a shell, or when the shell breaks, plain text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-router-errors-'));
  const told = [];
  const build = async (files) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [path, source] of Object.entries(files)) writeFileSync(join(dir, path), source);
    told.length = 0;
    return createRouter({ zubra: createZubra({ components: dir }), components: dir, cacheDir: join(dir, '.cache'), onError: (error) => told.push(error.message) });
  };
  const home = "<script>'use route /'</script>\n<home-page></home-page>\n";
  const boom = "<script>'use route /boom'\nexport function load() { throw new Error('secret detail') }</script>\n<boom-page></boom-page>\n";
  try {
    const shelled = await build({ 'home-page.zb': home, 'boom-page.zb': boom, 'app.zb': '<app-shell><header>Site</header><zb-slot></zb-slot></app-shell>\n' });
    const missing = await shelled.notFoundResponse(new Request('http://localhost/nowhere'));
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /<header>Site<\/header>[\s\S]*<h1>Page not found<\/h1>/);
    const broke = await shelled.fetch(new Request('http://localhost/boom'));
    assert.equal(broke.status, 500);
    const html = await broke.text();
    assert.match(html, /<header>Site<\/header>[\s\S]*<h1>Something went wrong<\/h1>/);
    assert.doesNotMatch(html, /secret detail/);
    // notFoundResponse is always the 404, even for a path that is a route.
    assert.equal((await shelled.notFoundResponse(new Request('http://localhost/'))).status, 404);
    assert.equal(await shelled.fetch(new Request('http://localhost/nowhere')), null, "fetch still leaves an unknown path to the app");

    const bare = await build({ 'home-page.zb': home, 'boom-page.zb': boom });
    assert.equal(await (await bare.notFoundResponse(new Request('http://localhost/nowhere'))).text(), 'Not found');
    assert.equal(await (await bare.fetch(new Request('http://localhost/boom'))).text(), 'Internal error');

    const badShell = await build({ 'home-page.zb': home, 'app.zb': "<script>'use layout /'\nexport function load() { throw new Error('shell down') }</script>\n<app-shell><zb-slot></zb-slot></app-shell>\n" });
    const down = await badShell.fetch(new Request('http://localhost/'));
    assert.equal(down.status, 500);
    assert.equal(await down.text(), 'Internal error');
    assert.deepEqual(told, ['shell down'], 'told once, and the shell is not tried again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createRouter needs the app\'s createZubra()', async () => {
  await assert.rejects(createRouter({ components }), /needs the app's createZubra\(\)/);
});
