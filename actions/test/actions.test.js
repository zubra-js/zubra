import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createActions } from '../src/index.js';
import { createActionsCore, routesFrom } from '../src/core.js';

const components = fileURLToPath(new URL('./components', import.meta.url));
const actions = await createActions({ components, onError: () => {} });
const URL_LOGIN = 'http://localhost/_zb/action/login-form/login';

const post = (url, fields, headers = {}) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  return actions.fetch(new Request(url, { method: 'POST', body, headers }));
};

test('every component\'s server functions are routed, and only those', () => {
  assert.deepEqual(actions.routes().sort(), [
    '/_zb/action/login-form/away',
    '/_zb/action/login-form/crash',
    '/_zb/action/login-form/login',
  ]);
});

test("a route's load is not an action, and its module isn't imported", async () => {
  // createActions above would have thrown if boom.js (imported only by load) had been imported.
  assert.ok(!actions.routes().some((route) => route.includes('farm-page')));
  const response = await post('http://localhost/_zb/action/farm-page/load', {}, { accept: 'application/json' });
  assert.equal(response.status, 404);
});

test('the enhanced path gets the return value as JSON', async () => {
  const response = await post(URL_LOGIN, { email: 'a@example.com' }, { accept: 'application/json' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, email: 'a@example.com' });
  const refused = await post(URL_LOGIN, { email: 'b@example.com' }, { accept: 'application/json' });
  assert.deepEqual(await refused.json(), { error: 'Invalid login' });
});

test('the browser\'s own post goes back to the page, with the result in a one-use cookie', async () => {
  const response = await post(URL_LOGIN, { email: 'b@example.com' }, { referer: 'http://localhost/login?next=1' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/login?next=1');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__zb_result=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=60$/);
  const next = new Request('http://localhost/login', { headers: { cookie: cookie.split(';')[0] } });
  const cleared = [];
  assert.deepEqual(actions.result(next, (name, value) => cleared.push([name, value])), {
    action: '/_zb/action/login-form/login',
    value: { error: 'Invalid login' },
  });
  assert.match(cleared[0][1], /Max-Age=0/);
  assert.equal(actions.result(new Request('http://localhost/login')), null);
});

test('a referer on another site never becomes the redirect', async () => {
  const response = await post(URL_LOGIN, { email: 'a@example.com' }, { referer: 'https://evil.example/x' });
  assert.equal(response.headers.get('location'), '/');
});

test('cross-site posts are refused', async () => {
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { origin: 'http://localhost', accept: 'application/json' })).status, 200);
  assert.equal((await post(URL_LOGIN, { email: 'a@example.com' }, { 'sec-fetch-site': 'same-origin', accept: 'application/json' })).status, 200);
});

test('a site in `origins` may post from its own pages, as a browser sends it', async () => {
  const listed = await createActions({ components, onError: () => {}, origins: ['https://shop.example'] });
  const from = (origin) => ({ origin, 'sec-fetch-site': 'cross-site', accept: 'application/json' });
  const send = (headers) => {
    const body = new FormData();
    body.append('email', 'a@example.com');
    return listed.fetch(new Request(URL_LOGIN, { method: 'POST', body, headers }));
  };
  assert.equal((await send(from('https://shop.example'))).status, 200);
  assert.equal((await send(from('https://evil.example'))).status, 403);
  assert.equal((await send({ 'sec-fetch-site': 'cross-site', accept: 'application/json' })).status, 403);
});

test('unknown actions are 404, other methods 405, other paths not ours', async () => {
  assert.equal((await post('http://localhost/_zb/action/login-form/nope', {})).status, 404);
  assert.equal((await actions.fetch(new Request(URL_LOGIN))).status, 405);
  assert.equal(await actions.fetch(new Request('http://localhost/login', { method: 'POST', body: '' })), null);
});

test('a thrown error is a generic 500, never the message', async () => {
  const response = await post('http://localhost/_zb/action/login-form/crash', {}, { accept: 'application/json' });
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.doesNotMatch(body, /secret detail/);
});

test('a returned Response passes through', async () => {
  const response = await post('http://localhost/_zb/action/login-form/away', {});
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'http://localhost/elsewhere#done');
});

test('a returned redirect tells the enhanced path where to go, #fragment and all', async () => {
  const response = await post('http://localhost/_zb/action/login-form/away', {}, { accept: 'application/json' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('zb-location'), 'http://localhost/elsewhere#done');
});

// Found by the pre-6.0 audit: an action redirecting to a visitor's `next` handed the script a
// `javascript:` URL to navigate to.
test('only an http(s) redirect becomes zb-location', async () => {
  const to = (location) =>
    createActionsCore({ routes: routesFrom({ '/_zb/action/x/go': () => new Response(null, { status: 303, headers: { location } }) }) })
      .fetch(new Request('http://localhost/_zb/action/x/go', { method: 'POST', headers: { origin: 'http://localhost', accept: 'application/json' }, body: new URLSearchParams() }));
  for (const location of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'http://[bad']) {
    const response = await to(location);
    assert.equal(response.headers.get('zb-location'), null, location);
    assert.equal(response.status, 303, `${location}: the plain redirect, which nothing follows`);
  }
  for (const location of ['/done#top', 'https://pay.example/checkout', 'http://localhost/x']) {
    const response = await to(location);
    assert.equal(response.status, 204, location);
    assert.equal(response.headers.get('zb-location'), location);
  }
});

test('the client script is served, and the page gets a tag for it', async () => {
  const response = await actions.fetch(new Request('http://localhost/_zb/actions.js'));
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /beforeaction/);
  assert.equal(actions.script(), '<script type="module" src="/_zb/actions.js"></script>');
});

test('the form script (enhance-forms) is served too, with a tag of its own', async () => {
  const response = await actions.fetch(new Request('http://localhost/_zb/enhance-forms.js'));
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /data-zb-updates/);
  assert.equal(actions.formsScript(), '<script type="module" src="/_zb/enhance-forms.js"></script>');
});

test('Node\'s http: answers ours, leaves the rest (and their bodies) alone', async () => {
  const server = createServer(async (req, res) => {
    if (await actions.handle(req, res)) return;
    res.end(`page ${JSON.stringify(actions.result(req))}`);
  });
  await new Promise((done) => server.listen(0, done));
  const base = `http://localhost:${server.address().port}`;
  try {
    const body = new URLSearchParams({ email: 'a@example.com' });
    const json = await fetch(`${base}/_zb/action/login-form/login`, { method: 'POST', body, headers: { accept: 'application/json' } });
    assert.deepEqual(await json.json(), { ok: true, email: 'a@example.com' });
    const plain = await fetch(`${base}/_zb/action/login-form/login`, { method: 'POST', body, redirect: 'manual' });
    assert.equal(plain.status, 303);
    assert.equal(plain.headers.get('location'), '/', 'no Referer goes to the root');
    const page = await fetch(`${base}/`, { headers: { cookie: plain.headers.getSetCookie()[0].split(';')[0] } });
    assert.match(await page.text(), /"email":"a@example.com"/);
  } finally {
    server.close();
  }
});

test('the server halves are not in the browser modules', async () => {
  const compiler = await import('@zubra/compiler');
  const path = `${components}/login-form.zb`;
  const js = compiler.request({ emit: 'js', path, files: compiler.sources(path), runtime: '@zubra/runtime' });
  assert.ok(js.ok, js.error);
  assert.doesNotMatch(js.output, /users\.js|secret detail|Invalid login/);
});

test("a Host header that isn't a host is a 400 from handle(), and the server keeps answering", { timeout: 10_000 }, async () => {
  const server = createServer(async (req, res) => {
    if (await actions.handle(req, res)) return;
    res.end('page');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  server.unref(); // a crash mustn't leave the test run waiting on this server
  const { port } = server.address();
  try {
    const answer = await new Promise((done) => {
      let out = '';
      const socket = connect(port, '127.0.0.1', () => socket.write('POST /_zb/action/login-form/login HTTP/1.1\r\nHost: [::1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
      socket.setTimeout(3000, () => socket.destroy());
      socket.on('data', (chunk) => (out += chunk));
      socket.on('close', () => done(out));
    });
    assert.match(answer, /^HTTP\/1\.1 400/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'page');
    // A Host carrying a path would choose the action past the app's own check on req.url.
    for (const host of ['localhost/_zb/action/login-form/crash?', 'localhost/_zb/action/login-form/crash#', 'x\\y']) {
      const raw = await new Promise((done) => {
        let out = '';
        const socket = connect(port, '127.0.0.1', () => socket.write(`POST /_zb/action/login-form/login HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
        socket.setTimeout(3000, () => socket.destroy());
        socket.on('data', (chunk) => (out += chunk));
        socket.on('close', () => done(out));
      });
      assert.match(raw, /^HTTP\/1\.1 400/, host);
    }
  } finally {
    server.close();
  }
});

test('going back never leaves the site, even from a path that starts with //', async () => {
  for (const [referer, location] of [
    ['http://localhost//evil.example/login', '/evil.example/login'],
    ['http://localhost/\\evil.example/', '/evil.example/'],
    ['http://localhost///evil.example?x=1', '/evil.example?x=1'],
    ['http://localhost/orders?page=2', '/orders?page=2'],
  ]) {
    const response = await post(URL_LOGIN, { email: 'a@example.com' }, { referer });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), location, referer);
  }
});

test('the result cookie is __Host- and Secure on HTTPS, and only the page the form came from reads it', async () => {
  const secure = await post('https://shop.example/_zb/action/login-form/login', { email: 'b@example.com' }, { referer: 'https://shop.example/account?tab=1', origin: 'https://shop.example' });
  const cookie = secure.headers.get('set-cookie');
  assert.match(cookie, /^__Host-zb_result=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=60$/);
  const value = cookie.split(';')[0];
  const cleared = [];
  assert.equal(actions.result(new Request('https://shop.example/other', { headers: { cookie: value } }), (n, v) => cleared.push(v)), null, 'another page leaves it');
  assert.deepEqual(cleared, [], 'and does not clear it');
  assert.deepEqual(actions.result(new Request('https://shop.example/account', { headers: { cookie: value } }), (n, v) => cleared.push(v)), { action: '/_zb/action/login-form/login', value: { error: 'Invalid login' } });
  assert.match(cleared[0], /^__Host-zb_result=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
  // Over HTTPS a plain __zb_result (planted by a sibling subdomain, or over plain HTTP) is not ours.
  const planted = `__zb_result=${encodeURIComponent(JSON.stringify({ action: '/_zb/action/login-form/login', value: { error: 'Your account is locked: call +1-555-0100' }, page: '/account' }))}`;
  assert.equal(actions.result(new Request('https://shop.example/account', { headers: { cookie: planted } })), null);
  assert.ok(actions.result(new Request('http://localhost/account', { headers: { cookie: planted } })), 'over plain HTTP it is the only one there is');
  const unpaged = `__zb_result=${encodeURIComponent(JSON.stringify({ action: '/_zb/action/login-form/login', value: { role: 'admin' } }))}`;
  assert.equal(actions.result(new Request('http://localhost/other', { headers: { cookie: unpaged } })), null, 'a cookie with no page matches no path');
  // Behind a proxy that ends TLS, requests arrive as http: `secure: true` says the site is HTTPS.
  const proxied = createActionsCore({ routes: routesFrom({ '/_zb/action/login-form/login': () => ({ ok: true }) }), secure: true });
  const behind = await proxied.fetch(new Request('http://shop.example/_zb/action/login-form/login', { method: 'POST', headers: { origin: 'http://shop.example', referer: 'http://shop.example/account' }, body: new URLSearchParams({ email: 'a@b.c' }) }));
  assert.match(behind.headers.get('set-cookie'), /^__Host-zb_result=.*; Secure/);
  assert.equal(proxied.result(new Request('http://shop.example/account', { headers: { cookie: planted } })), null, 'and a planted plain cookie is not read');
  // Plain HTTP (local development) keeps the plain name: browsers refuse __Host- without Secure.
  const plain = await post(URL_LOGIN, { email: 'b@example.com' }, { referer: 'http://localhost/account' });
  assert.match(plain.headers.get('set-cookie'), /^__zb_result=/);
});
