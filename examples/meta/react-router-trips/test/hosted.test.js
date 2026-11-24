// The trip as a public demo (HOSTED_DEMO=1): the notice, the body and write limits, the cap on
// expenses, the reset, and React Router's Origin check behind Railway's proxy. No browser: the
// built app over HTTP (server.js), with a clock the test moves; the reset on the store itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

// The server build reads HOSTED_DEMO when it loads.
process.env.HOSTED_DEMO = '1';
const { createApp } = await import('../server.js');
const { fromEnv, MAX_EXPENSES, NOTICE } = await import('../app/lib/hosted.server.js');
const build = await import('../build/server/index.js');

const DAY = 24 * 60 * 60_000;
const PUBLIC = 'react-router-trips-production.up.railway.app';
let time = Date.UTC(2026, 0, 1, 12);
let server, port;

before(async () => {
  server = createApp({ build, hosted: { trustProxies: 1, now: () => time } }).listen(0);
  await new Promise((done) => server.once('listening', done));
  port = server.address().port;
});
after(() => new Promise((done) => {
  server.closeAllConnections();
  server.close(done);
}));

/** A request as Railway's proxy passes it on: the public host, https, the visitor appended. */
function send(method, path, { from = '203.0.113.1', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ port, method, path, headers: { host: PUBLIC, 'x-forwarded-proto': 'https', 'x-forwarded-for': from, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const sameSite = { origin: `https://${PUBLIC}`, 'sec-fetch-site': 'same-origin' };
const form = (fields, { headers = sameSite, ...options } = {}) => {
  const body = new URLSearchParams(fields).toString();
  return { ...options, body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), ...headers } };
};
const expense = (what, extra = {}) => ({ what, amount: '12', category: 'food', paidBy: 'Ana', split: 'Ben', ...extra });
const add = (what, options = {}, extra = {}) => send('POST', '/?index', form(expense(what, extra), options));
const page = async () => (await send('GET', '/')).text;

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', DEMO_RESET_MINUTES: '5' }), { resetMinutes: 5, trustProxies: 0 });
});

test('every page says the data resets', async () => {
  const { status, text } = await send('GET', '/');
  assert.equal(status, 200);
  assert.ok(text.includes(`<p class="demo-notice">${NOTICE}</p>`));
});

test('a same-site post behind the proxy is an https one, so the Origin check passes, with or without Sec-Fetch-Site', async () => {
  assert.equal((await add('Ferry tickets')).status, 200);
  assert.equal((await add('Ice cream', { headers: { origin: `https://${PUBLIC}` } })).status, 200);
  const text = await page();
  assert.ok(text.includes('Ferry tickets') && text.includes('Ice cream'));
});

test('a cross-site post is refused, with or without Sec-Fetch-Site', async () => {
  assert.equal((await add('Forged', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status, 400);
  assert.equal((await add('Forged too', { headers: { origin: 'https://evil.example' } })).status, 400);
  // The same host over http isn't the page's origin either.
  assert.equal((await add('Forged three', { headers: { origin: `http://${PUBLIC}` } })).status, 400);
  assert.ok(!(await page()).includes('Forged'));
});

test('a body over 16 KiB is refused before React Router reads it, and so is one without a length', async () => {
  const big = await add('Huge', {}, { note: 'x'.repeat(20_000) });
  assert.equal(big.status, 413);
  const chunked = await send('POST', '/?index', { from: '203.0.113.9', headers: { ...sameSite, 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' }, body: new URLSearchParams(expense('Chunked')).toString() });
  assert.equal(chunked.status, 411);
  assert.ok(!(await page()).includes('Huge'));
});

test('long text and huge sums are refused by the action', async () => {
  const long = await add('y'.repeat(101), { from: '203.0.113.10' });
  assert.equal(long.status, 400);
  assert.match(long.text, /At most 100 characters/);
  const huge = await add('Yacht', { from: '203.0.113.10' }, { amount: '100000.01' });
  assert.equal(huge.status, 400);
  assert.match(huge.text, /At most \$100,000/);
});

test('the reset route the tests use is not there', async () => {
  assert.equal((await send('POST', '/reset', form({}))).status, 404);
  assert.ok((await page()).includes('Ferry tickets'));
});

test('30 writes a minute from one visitor, counted per visitor behind the proxy', async () => {
  time += 60_000;
  const write = (from) => send('POST', '/?index', form({ intent: 'delete', id: '9999' }, { from }));
  for (let i = 0; i < 30; i++) assert.equal((await write('198.51.100.1')).status, 200);
  const refused = await write('198.51.100.1');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers['retry-after'], '60');
  // A visitor can't pass as someone else by sending the header: the proxy's entry is the last one.
  assert.equal((await write('192.0.2.50, 198.51.100.1')).status, 429);
  assert.equal((await write('198.51.100.2')).status, 200, 'another visitor still can');
  assert.equal((await send('GET', '/', { from: '198.51.100.1' })).status, 200, 'and reading is not a write');
  time += 60_000;
  assert.equal((await write('198.51.100.1')).status, 200, 'and the first can again a minute later');
});

test(`the trip holds at most ${MAX_EXPENSES} expenses`, async () => {
  const count = async () => (await page()).match(/aria-label="Delete /g).length;
  let n = 0;
  while (await count() < MAX_EXPENSES) assert.equal((await add(`Snack ${n}`, { from: `10.0.${n >> 8}.${n++ & 255}` })).status, 200);
  const full = await add('One too many', { from: '10.1.0.1' });
  assert.equal(full.status, 400);
  assert.match(full.text, /The demo holds 100 expenses: delete one first\./);
  assert.equal(await count(), MAX_EXPENSES);
  assert.equal((await send('POST', '/?index', form({ intent: 'delete', id: '1' }, { from: '10.1.0.1' }))).status, 200);
  assert.equal((await add('Room again', { from: '10.1.0.1' })).status, 200);
});

test('the expenses go back to the seed at midnight UTC', async () => {
  // The store itself (the server build has its own copy, on the real clock).
  const trip = await import('../app/lib/trip.server.js');
  let now = Date.UTC(2026, 0, 1, 12);
  trip.hostDemo({ now: () => now });
  trip.add({ what: 'Kayaks', category: 'fun', cents: 9000, paidBy: 'Ben', split: ['Ben'] });
  assert.equal(trip.list().length, 4);
  now += DAY / 4;
  assert.equal(trip.list().length, 4, 'not before');
  now += DAY / 2;
  assert.equal(trip.list().length, 3);
  assert.ok(!trip.list().some(({ what }) => what === 'Kayaks'));
  // DEMO_RESET_MINUTES shortens the period.
  trip.hostDemo({ now: () => now, resetMinutes: 5 });
  trip.remove(1);
  now += 5 * 60_000;
  assert.equal(trip.list().length, 3);
});
