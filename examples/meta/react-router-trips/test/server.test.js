// `npm start` (server.js) without HOSTED_DEMO: the app as react-router-serve serves it, with none of
// a hosted demo's notice or limits. No browser: the built app over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

delete process.env.HOSTED_DEMO;
const build = await import('../build/server/index.js');
let server, url;

before(async () => {
  server = createApp({ build }).listen(0);
  await new Promise((done) => server.once('listening', done));
  url = `http://localhost:${server.address().port}`;
});
after(() => new Promise((done) => {
  server.closeAllConnections();
  server.close(done);
}));

const add = (what) => fetch(`${url}/?index`, { method: 'POST', headers: { origin: url }, body: new URLSearchParams({ what, amount: '12', category: 'food', paidBy: 'Ana', split: 'Ben' }) });

test('the page and its assets, without the notice', async () => {
  const text = await (await fetch(url)).text();
  assert.match(text, /<h1>Trip budget<\/h1>/);
  assert.ok(!text.includes('demo-notice'));
  const script = /<script type="module"[^>]*>[^<]*import\("(\/assets\/[^"]+\.js)"\)/.exec(text)?.[1] ?? /href="(\/assets\/[^"]+\.js)"/.exec(text)[1];
  const asset = await fetch(url + script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
});

test('no limits: long text, a 20 KB body, more than 30 writes', async () => {
  assert.equal((await add('z'.repeat(20_000))).status, 200);
  for (let i = 0; i < 31; i++) assert.equal((await add(`Snack ${i}`)).status, 200);
  assert.equal((await fetch(`${url}/reset`, { method: 'POST' })).status, 204);
  assert.ok(!(await (await fetch(url)).text()).includes('Snack'));
});

test('a cross-site post is refused', async () => {
  const forged = await fetch(`${url}/?index`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: new URLSearchParams({ what: 'Forged' }) });
  assert.equal(forged.status, 400);
});
