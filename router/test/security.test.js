// What the 2026-11-15 security audit found in the router, each pinned by a test that fails
// without its fix.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createRouter, redirect } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'zubra-router-security-'));
// Inside this package, so the fixtures' `import … from '@zubra/router'` resolves to it.
const cacheDir = fileURLToPath(new URL('./.cache-security', import.meta.url));
after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

const files = {
  // The shell turns away anyone `banned`, on every page.
  'app.zb': `<script>
  'use layout /'
  import { notFound } from '@zubra/router'
  export function load({ context }) { return context.who === 'banned' ? notFound() : {} }
</script>
<app-shell><main><zb-slot></zb-slot></main></app-shell>
`,
  // A tenant's section: only its members.
  'org-shell.zb': `<script>
  'use layout /org/:org'
  import { show } from '@zubra/router'
  export function load({ params, context }) { return context.org === params.org ? {} : show('denied-notice', {}, { status: 403 }) }
</script>
<org-shell><zb-slot></zb-slot></org-shell>
`,
  'denied-notice.zb': '<denied-notice><p>DENIED</p></denied-notice>\n',
  'org-billing.zb': `<script>
  'use route /org/:org/billing'
  export function load({ params }) { return { what: 'BILLING-' + params.org } }
</script>
<org-billing what=""><p>{what}</p></org-billing>
`,
  // The same section, its parameter spelled three other ways.
  'org-members.zb': `<script>
  'use route /org/:org([a-z]+)/members'
  export function load({ params }) { return { what: 'MEMBERS-' + params.org } }
</script>
<org-members what=""><p>{what}</p></org-members>
`,
  'org-invoices.zb': `<script>
  'use route /org/:orgId/invoices'
  export function load({ params }) { return { what: 'INVOICES-' + params.orgId } }
</script>
<org-invoices what=""><p>{what}</p></org-invoices>
`,
  'org-export.zb': `<script>
  'use route /org/acme/export'
  export function load() { return { what: 'EXPORT-acme' } }
</script>
<org-export what=""><p>{what}</p></org-export>
`,
  // A private part of the docs, and a catch-all page that also reaches it.
  'routes/docs/private/layout.zb': `<script>
  'use layout'
  import { notFound } from '@zubra/router'
  export function load({ context }) { return context.who === 'staff' ? {} : notFound() }
</script>
<private-docs><zb-slot></zb-slot></private-docs>
`,
  'routes/docs/[...path].zb': `<script>
  'use route'
  export function load({ params }) { return { file: 'DOC:' + params.path } }
</script>
<doc-page file=""><p>{file}</p></doc-page>
`,
  // An admin section with a root layout inside it.
  'admin-shell.zb': `<script>
  'use layout /admin'
  import { show } from '@zubra/router'
  export function load({ context }) { return context.who === 'admin' ? {} : show('denied-notice', {}, { status: 403 }) }
</script>
<admin-shell><zb-slot></zb-slot></admin-shell>
`,
  'print-frame.zb': `<script>'use layout /admin/print root'</script>
<print-frame><zb-slot></zb-slot></print-frame>
`,
  'print-invoices.zb': `<script>
  'use route /admin/print/invoices'
  export function load() { return { rows: 'ALL-INVOICES' } }
</script>
<print-invoices rows=""><p>{rows}</p></print-invoices>
`,
  'staff-report.zb': `<script>
  'use route /staff/report'
  export function load() { return { body: 'STAFF-REPORT' } }
</script>
<staff-report body=""><p>{body}</p></staff-report>
`,
  // Where a redirect goes, and whether a HEAD uses up an action's answer.
  'go-page.zb': `<script>
  'use route /go'
  import { redirect } from '@zubra/router'
  export function load({ url }) {
    const to = url.searchParams.get('to')
    return url.searchParams.has('external') ? redirect(to, { external: true }) : redirect(to)
  }
</script>
<go-page></go-page>
`,
  'me-page.zb': `<script>
  'use route /me'
  export function load({ result }) { return { said: result?.value ?? 'nothing' } }
</script>
<me-page said=""><p>{said}</p></me-page>
`,
};
for (const [path, source] of Object.entries(files)) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), source);
}

// An actions stand-in: one answer, cleared when read (as @zubra/actions' result() does).
let answer = null;
const actions = { result: (_request, setHeader) => { const value = answer; if (value) { answer = null; setHeader('set-cookie', '__zb_result=; Max-Age=0'); } return value; } };
const zubra = createZubra({ components: dir });
const errors = [];
const router = await createRouter({
  zubra,
  components: dir,
  cacheDir,
  actions,
  context: ({ request }) => ({ who: request.headers.get('x-who'), org: request.headers.get('x-org') }),
  onError: (error) => errors.push(error),
});
const get = (path, headers = {}, method = 'GET') => router.fetch(new Request(`http://localhost${path}`, { method, headers }));
const body = async (response) => (await response.text()).replace(/<script[\s\S]*?<\/script>/g, '');

test("a layout's check guards every page under its prefix, however the page spells it", async () => {
  const mine = { 'x-org': 'mine' };
  for (const path of ['/org/acme/billing', '/org/acme/members', '/org/acme/invoices', '/org/acme/export']) {
    const response = await get(path, mine);
    assert.equal(response.status, 403, path);
    assert.match(await body(response), /DENIED/, path);
  }
  // The org's own people get each page, with the layout's own parameter.
  assert.match(await body(await get('/org/acme/members', { 'x-org': 'acme' })), /MEMBERS-acme/);
  assert.match(await body(await get('/org/acme/invoices', { 'x-org': 'acme' })), /INVOICES-acme/);
  // A catch-all page under a guarded folder: guarded there, open elsewhere.
  assert.equal((await get('/docs/private/salaries')).status, 404);
  assert.match(await body(await get('/docs/private/salaries', { 'x-who': 'staff' })), /DOC:private\/salaries/);
  assert.match(await body(await get('/docs/guide')), /DOC:guide/);
});

test("a root layout's pages still pass the checks of the layouts over them", async () => {
  const denied = await get('/admin/print/invoices', { 'x-who': 'mallory' });
  assert.equal(denied.status, 403);
  const text = await body(denied);
  assert.match(text, /DENIED/);
  assert.doesNotMatch(text, /ALL-INVOICES/);
  // The shell's check too.
  assert.equal((await get('/admin/print/invoices', { 'x-who': 'banned' })).status, 404);
  // An admin gets the page, inside the root layout only: not the shell, not admin-shell.
  const page = await body(await get('/admin/print/invoices', { 'x-who': 'admin' }));
  assert.match(page, /<body><print-frame[\s\S]*ALL-INVOICES/);
  assert.doesNotMatch(page, /<app-shell|<admin-shell/);
});

test('a path starting // is no route: the polyfill would read //host as an authority', async () => {
  assert.equal(router.match('//evil/staff/report'), null);
  assert.equal(router.match('/staff/report').name, 'staff-report');
  assert.equal(await router.fetch(new Request('http://localhost//evil/staff/report')), null);
});

test("Node's handle(): the path routed is req.url's, whatever the Host says", { timeout: 15_000 }, async () => {
  // The app keeps its own guard on req.url, as apps do, in front of the router.
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/staff') && req.headers['x-who'] !== 'staff') return res.writeHead(403).end('app guard');
    if (await router.handle(req, res)) return;
    res.writeHead(404).end('app 404');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  server.unref();
  const { port } = server.address();
  const raw = (target, host) =>
    new Promise((done) => {
      let out = '';
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      socket.setTimeout(3000, () => socket.destroy());
      socket.on('data', (chunk) => (out += chunk));
      socket.on('close', () => done(out));
    });
  try {
    for (const [target, host] of [['/report', 'localhost/staff'], ['/', 'localhost/staff/report#'], ['/x', 'x\\staff\\report?'], ['http://evil/staff/report', 'x'], ['//evil/staff/report', 'localhost']]) {
      const answer = await raw(target, host);
      assert.doesNotMatch(answer, /STAFF-REPORT/, `${target} with Host ${host}`);
      assert.match(answer, /^HTTP\/1\.1 (400|404)/, `${target} with Host ${host}`);
    }
    // Targets Node passes on that aren't a path (absolute-form, `*`): the router answers them, 400.
    for (const target of ['http://localhost/staff/report', '*']) assert.match(await raw(target, 'localhost'), /^HTTP\/1\.1 400/, target);
    assert.match(await raw('/org/acme/export', `localhost:${port}`), /^HTTP\/1\.1 403/, 'an ordinary Host still routes');
  } finally {
    server.close();
  }
});

test("redirect() stays on the site unless it says it's leaving", async () => {
  const to = async (where, extra = '') => {
    const response = await get(`/go?to=${encodeURIComponent(where)}${extra}`);
    return [response.status, response.headers.get('location')];
  };
  assert.deepEqual(await to('/cart?x=1'), [303, '/cart?x=1']);
  assert.deepEqual(await to('//evil.example/login'), [303, '/evil.example/login']);
  assert.deepEqual(await to('/\\evil.example/'), [303, '/evil.example/']);
  assert.deepEqual(await to('http://localhost/cart'), [303, '/cart'], 'this site, written whole');
  // This site's own address with a path that begins `//`, or a relative path that resolves to
  // one: the origin is this site's, but a Location of `//evil.example/x` is another site
  // (security audit 6). However it's spelled, the browser lands here.
  for (const where of ['http://localhost//evil.example/x', 'http://localhost/\\evil.example/x', 'HTTP://LOCALHOST//evil.example', './/evil.example/x', '..//evil.example/x', './/evil.example/../evil', 'x/..//evil.example', '/./\\evil.example']) {
    const [status, location] = await to(where);
    assert.equal(status, 303, where);
    assert.equal(new URL(location, 'http://localhost/go').host, 'localhost', `${where} -> ${location}`);
    assert.ok(!/^[/\\]{2}/.test(location), `${where} -> ${location}`);
  }
  errors.length = 0;
  assert.equal((await to('https://evil.example/login'))[0], 500);
  assert.equal((await to('javascript:alert(1)'))[0], 500);
  assert.equal((await to('javascript:alert(1)', '&external'))[0], 500, 'no script URL, even leaving');
  for (const where of ['/\t/evil.example/login', '/\n\\evil.example/login', '/cart\r']) {
    assert.equal((await to(where))[0], 500, `control characters are refused: ${JSON.stringify(where)}`);
    assert.equal((await to(where, '&external'))[0], 500, 'control characters are refused even when leaving');
  }
  assert.match(String(errors[0]?.message), /another site/);
  assert.deepEqual(await to('https://pay.example/checkout', '&external'), [303, 'https://pay.example/checkout']);
  assert.deepEqual(redirect('/a', 302, { external: true }), redirect('/a', { status: 302, external: true }));
});

// Found by the pre-6.0 audit: browsers drop tab, LF and CR from a URL, so a Location of
// `/\t/evil.example/login` arrives as `//evil.example/login`, another site.
test('redirect() refuses a control character, over real HTTP', { timeout: 15_000 }, async () => {
  const server = createServer(router.listener);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  server.unref();
  const { port } = server.address();
  const raw = (target) =>
    new Promise((done) => {
      let out = '';
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      socket.setTimeout(3000, () => socket.destroy());
      socket.on('data', (chunk) => (out += chunk));
      socket.on('close', () => done(out));
    });
  const go = async (where) => {
    const answer = await raw(`/go?to=${encodeURIComponent(where)}`);
    return [Number(answer.match(/^HTTP\/1\.1 (\d+)/)?.[1]), answer.match(/\r\nlocation: ([^\r\n]*)/i)?.[1] ?? null];
  };
  try {
    assert.deepEqual(await go('//evil.example/login'), [303, '/evil.example/login'], 'the slash form still works');
    errors.length = 0;
    for (const where of ['/\t/evil.example/login', '/\n/evil.example/login', '/\r/evil.example/login', '/\t\\evil.example/login', '\\\t\\evil.example', '/x\x00', '/x\x7f', 'http://localhost/\t/x']) {
      const [status, location] = await go(where);
      assert.equal(status, 500, JSON.stringify(where));
      assert.equal(location, null, JSON.stringify(where));
    }
    assert.match(String(errors[0]?.message), /control character/);
  } finally {
    server.close();
  }
});

test("a HEAD doesn't use up an action's one-use answer", async () => {
  answer = { value: 'SAVED' };
  const head = await get('/me', {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('set-cookie'), null);
  assert.match(await body(await get('/me')), /SAVED/, 'the GET after it still shows it');
});

test('a page whose loads read the request is never kept by a shared cache', async () => {
  assert.equal((await get('/org/acme/billing', { 'x-org': 'acme' })).headers.get('cache-control'), 'private, no-store');
});

test('two components whose names flatten alike get their own server halves', async () => {
  const other = mkdtempSync(join(tmpdir(), 'zubra-router-names-'));
  try {
    for (const [path, word] of [['routes/a/b.zb', 'NESTED'], ['routes/a__b.zb', 'FLAT']]) {
      mkdirSync(join(other, path, '..'), { recursive: true });
      writeFileSync(join(other, path), `<script>\n  'use route'\n  export function load() { return { word: '${word}' } }\n</script>\n<x-page word=""><p>{word}</p></x-page>\n`);
    }
    const own = join(cacheDir, 'names');
    const both = await createRouter({ zubra: createZubra({ components: other }), components: other, cacheDir: own });
    // Each import follows its write, so in one process the second only overwrites the first on
    // disk; a second process sharing the cache would import the wrong half.
    assert.equal(readdirSync(own).filter((file) => file.endsWith('.route.mjs')).length, 2);
    assert.match(await (await both.fetch(new Request('http://localhost/a/b'))).text(), /NESTED/);
    assert.match(await (await both.fetch(new Request('http://localhost/a__b'))).text(), /FLAT/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
