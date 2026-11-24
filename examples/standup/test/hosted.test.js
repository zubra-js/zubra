// The board as a public demo (HOSTED_DEMO=1): the notice, what the log takes, the request and
// write limits, and the reset. No browser: the sync API over HTTP, with a clock the test moves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { fromEnv, MAX_TEXT, NOTICE } from '../hosted.js';

const DAY = 24 * 60 * 60_000;
const dir = mkdtempSync(join(tmpdir(), 'standup-hosted-'));
const db = join(dir, 'demo.db');
let time = Date.UTC(2026, 0, 1, 12);
let server;
let base;
let n = 0;

const change = (key, field, value) => ({ collection: 'cards', key, field, value, clock: `${String(Date.now()).padStart(15, '0')}-${String(n++).padStart(5, '0')}-test` });
const push = (changes, headers = {}) => fetch(`${base}/_zb/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify({ changes }) });
const pull = async (since = '0') => (await fetch(`${base}/_zb/sync/pull?since=${since}`)).json();

before(async () => {
  writeFileSync(db, 'left over from a run before'); // the demo starts from nothing, whatever is there
  server = await createApp({ db, cache: false, hosted: { now: () => time, trustProxies: 1 } });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
});

test('the page says the data resets', async () => {
  assert.ok((await (await fetch(base)).text()).includes(NOTICE));
});

test('the log takes the team\'s cards and their two fields, and nothing else', async () => {
  assert.equal((await push([change('ada', 'today', 'Reviews'), change('ada', 'blocked', true)])).status, 200);
  for (const refused of [
    change('mallory', 'today', 'a card nobody shows'),
    change('ada', 'notes', 'a field the card has not got'),
    change('ada', 'today', 'x'.repeat(MAX_TEXT + 1)),
    change('ada', 'blocked', 'yes'),
    { ...change('ada', 'today', 'x'), collection: 'other' },
  ]) assert.equal((await push([refused])).status, 403, JSON.stringify(refused).slice(0, 80));
  const { changes } = await pull();
  assert.deepEqual(changes.map((one) => [one.key, one.field, one.value]).sort(), [['ada', 'blocked', true], ['ada', 'today', 'Reviews']]);
});

test('the latest value of a field is all that is kept', async () => {
  for (let i = 0; i < 5; i++) await push([change('grace', 'today', `draft ${i}`)], { 'x-forwarded-for': '198.51.100.9' });
  const kept = (await pull()).changes.filter((one) => one.key === 'grace');
  assert.deepEqual(kept.map((one) => one.value), ['draft 4']);
});

test('a request over 64 KiB is refused', async () => {
  const many = Array.from({ length: 40 }, () => change('linus', 'today', 'y'.repeat(MAX_TEXT)));
  assert.equal((await push(many)).status, 413);
});

test('a burst of writes from one visitor is slowed, others are not', async () => {
  const from = { 'x-forwarded-for': '203.0.113.5' };
  const statuses = [];
  for (let i = 0; i < 101; i++) statuses.push((await push([change('linus', 'today', `${i}`)], from)).status);
  assert.deepEqual(statuses.slice(0, 100), Array(100).fill(200));
  assert.equal(statuses[100], 429);
  assert.equal((await push([change('linus', 'today', 'spoofed')], { 'x-forwarded-for': '192.0.2.1, 203.0.113.5' })).status, 429, 'the header a visitor sends doesn\'t make them someone else');
  assert.equal((await push([change('linus', 'today', 'other')], { 'x-forwarded-for': '203.0.113.6' })).status, 200);
  time += 1000;
  assert.equal((await push([change('linus', 'today', 'later')], from)).status, 200, 'and a second later it can write again');
});

test('at midnight UTC the log starts over, and a page that read the old one is told to start over', async () => {
  const before = await pull();
  assert.ok(before.changes.length > 0);
  time += DAY / 4;
  assert.ok((await pull()).changes.length > 0, 'not before');
  time += DAY / 2;
  const after = await pull(String(before.cursor));
  assert.equal(after.reset, true);
  assert.deepEqual(after.changes, []);
  assert.ok(existsSync(db));
});
