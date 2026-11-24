// The shop as a public demo (HOSTED_DEMO=1): server/hosted.js on its own, with a clock the test
// moves and no server. test/app.test.js checks the same caps through the built Nitro server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { clientAddress, createGuard, fromEnv, readCapped, sameSite } from '../server/hosted.js';

const DAY = 24 * 60 * 60_000;
const HOST = 'nuxt-bookshop-production.up.railway.app';
// A request as it arrives behind Railway's proxy, from a page of the shop.
const put = (headers = {}) => ({ method: 'PUT', remoteAddress: '10.0.0.2', headers: { host: HOST, origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.1', 'content-length': '80', ...headers } });

function guard(options = {}) {
  let time = Date.UTC(2026, 0, 1, 12);
  let resets = 0;
  const check = createGuard({ reset: () => resets++, now: () => time, ...options });
  return { check, later: (ms) => (time += ms), resets: () => resets };
}

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ HOSTED_DEMO: '0' }), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', DEMO_RESET_MINUTES: '5' }), { resetMinutes: 5, trustProxies: 0 });
});

test('the visitor is the entry TRUST_PROXIES from the end of X-Forwarded-For, else the socket', () => {
  assert.equal(clientAddress({ 'x-forwarded-for': '198.51.100.7, 203.0.113.1' }, '10.0.0.2', 1), '203.0.113.1');
  assert.equal(clientAddress({ 'x-forwarded-for': '198.51.100.7, 203.0.113.1, 10.0.0.9' }, '10.0.0.2', 2), '203.0.113.1');
  assert.equal(clientAddress({ 'x-forwarded-for': '198.51.100.7' }, '10.0.0.2', 0), '10.0.0.2', 'no proxy trusted');
  assert.equal(clientAddress({}, '10.0.0.2', 1), '10.0.0.2');
});

test('30 writes a minute from one visitor, counted per visitor behind the proxy', () => {
  const { check, later } = guard({ trustProxies: 1 });
  const from = (address) => check(put({ 'x-forwarded-for': address }));
  for (let i = 0; i < 30; i++) assert.equal(from('203.0.113.1'), null);
  assert.equal(from('203.0.113.1')?.status, 429);
  assert.equal(from('203.0.113.1').headers['retry-after'], '60');
  // A visitor can't pass as someone else by sending the header: the proxy's entry is the last one.
  assert.equal(from('198.51.100.7, 203.0.113.1')?.status, 429);
  assert.equal(from('203.0.113.2'), null, 'another visitor still can');
  for (let i = 0; i < 40; i++) assert.equal(check({ ...put(), method: 'GET' }), null, 'reads are not counted');
  later(60_000);
  assert.equal(from('203.0.113.1'), null, 'and the first can again a minute later');
});

test('a body over 16 KiB is refused by its Content-Length', () => {
  const { check } = guard();
  assert.equal(check(put({ 'content-length': String(16 * 1024) })), null);
  assert.equal(check(put({ 'content-length': String(16 * 1024 + 1) }))?.status, 413);
});

test('a body with no Content-Length is read only up to the limit', async () => {
  assert.equal((await readCapped(Readable.from([Buffer.alloc(10_000), Buffer.alloc(6_000)]), 16 * 1024)).length, 16_000);
  assert.equal(await readCapped(Readable.from([Buffer.alloc(10_000), Buffer.alloc(10_000)]), 16 * 1024), null);
});

test('writes from the shop’s pages pass behind the https proxy; cross-site ones are refused', () => {
  const { check } = guard();
  assert.equal(check(put()), null, 'same origin, with Sec-Fetch-Site');
  assert.equal(check(put({ 'sec-fetch-site': undefined })), null, 'same origin, Origin only (https page, http server)');
  assert.equal(check(put({ 'sec-fetch-site': undefined, origin: undefined })), null, 'not a browser');
  assert.equal(check(put({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))?.status, 403);
  assert.equal(check(put({ 'sec-fetch-site': 'same-site', origin: 'https://other.up.railway.app' }))?.status, 403, 'another Railway app');
  assert.equal(check(put({ 'sec-fetch-site': undefined, origin: 'https://evil.example' }))?.status, 403, 'cross-site, Origin only');
  assert.equal(check(put({ 'sec-fetch-site': undefined, origin: 'null' }))?.status, 403);
  assert.equal(sameSite({ host: 'localhost:3000', origin: 'http://localhost:3000' }), true);
});

test('the books go back to their seed at midnight UTC', () => {
  const { check, later, resets } = guard();
  check({ ...put(), method: 'GET' });
  assert.equal(resets(), 0);
  later(DAY / 4);
  check({ ...put(), method: 'GET' });
  assert.equal(resets(), 0, 'not before');
  later(DAY / 2); // 06:00 the next day
  check({ ...put(), method: 'GET' });
  assert.equal(resets(), 1);
  check({ ...put(), method: 'GET' });
  assert.equal(resets(), 1, 'once');
});

test('DEMO_RESET_MINUTES shortens the period', () => {
  const { check, later, resets } = guard({ resetMinutes: 5 });
  later(5 * 60_000);
  check(put());
  assert.equal(resets(), 1);
});
