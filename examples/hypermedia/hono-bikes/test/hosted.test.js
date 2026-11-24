// The shop as a public demo (HOSTED_DEMO=1): the notice, the body and write limits, and the reset.
// No browser: these call the app's fetch directly, with a clock the test moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store.js';
import { fromEnv, NOTICE } from '../src/hosted.js';

const DAY = 24 * 60 * 60_000;
const form = (fields, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });

function shop(options = {}) {
  let time = Date.UTC(2026, 0, 1, 12);
  const store = createStore();
  const app = createApp({ store, cache: false, hosted: { now: () => time, ...options } });
  return { app, store, later: (ms) => (time += ms), get: (path, init) => app.fetch(new Request(`http://shop.test${path}`, init)) };
}

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
});

test('every page says the data resets, and only when hosted', async () => {
  const { get } = shop();
  assert.ok((await (await get('/')).text()).includes(NOTICE));
  const local = createApp({ store: createStore(), cache: false });
  assert.ok(!(await (await local.fetch(new Request('http://shop.test/'))).text()).includes(NOTICE));
});

test('a body over 16 KiB is refused before it reaches a route', async () => {
  const { get, store } = shop();
  const response = await get('/items/1', form({ name: 'x'.repeat(20_000), price: '1', count: '1' }));
  assert.equal(response.status, 413);
  assert.equal(store.get(1).name, 'Trail 29 hardtail');
});

test('30 writes a minute from one visitor, counted per visitor behind the proxy', async () => {
  const { get, later } = shop({ trustProxies: 1 });
  const sell = (from) => get('/items/8/sell', form({}, { 'x-forwarded-for': from }));
  for (let i = 0; i < 30; i++) assert.equal((await sell('203.0.113.1')).status, 303);
  assert.equal((await sell('203.0.113.1')).status, 429);
  // A visitor can't pass as someone else by sending the header: the proxy's entry is the last one.
  assert.equal((await sell('198.51.100.7, 203.0.113.1')).status, 429);
  assert.equal((await sell('203.0.113.2')).status, 303, 'another visitor still can');
  later(60_000);
  assert.equal((await sell('203.0.113.1')).status, 303, 'and the first can again a minute later');
});

test('the inventory goes back to its seed at midnight UTC', async () => {
  const { get, store, later } = shop();
  await get('/items/1/sell', form({}));
  assert.equal(store.get(1).count, 3);
  later(DAY / 4);
  await get('/');
  assert.equal(store.get(1).count, 3, 'not before');
  later(DAY / 2);
  await get('/');
  assert.equal(store.get(1).count, 4);
});
