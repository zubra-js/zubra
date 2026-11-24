// The potluck as a public demo (HOSTED_DEMO=1). No browser: the guard (src/lib/hosted.js) with a
// clock the test moves, then the built app (.output, as `npm test` builds it) with raw requests,
// as Railway's proxy sends them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientAddress, createGuard, fromEnv, MAX_SIGNUPS, NOTICE, signupErrors } from '../src/lib/hosted.js';

const DAY = 24 * 60 * 60_000;

function guarded(options = {}) {
  let time = Date.UTC(2026, 0, 1, 12);
  let resets = 0;
  const guard = createGuard({ reset: () => resets++, now: () => time, ...options });
  const post = (headers = {}, body = 'name=Theo') => guard(new Request('http://potluck.test/_server?id=x', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body }), '10.0.0.9');
  return { guard, post, later: (ms) => (time += ms), resets: () => resets };
}

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ HOSTED_DEMO: '0' }), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', DEMO_RESET_MINUTES: '5' }), { resetMinutes: 5, trustProxies: 0 });
});

test('the visitor is the last X-Forwarded-For entry behind one proxy, else the socket', () => {
  const from = (header) => new Request('http://potluck.test/', { headers: header ? { 'x-forwarded-for': header } : {} });
  assert.equal(clientAddress(from('198.51.100.7, 203.0.113.1'), '10.0.0.9', 1), '203.0.113.1');
  assert.equal(clientAddress(from('198.51.100.7, 203.0.113.1'), '10.0.0.9', 0), '10.0.0.9');
  assert.equal(clientAddress(from(null), '10.0.0.9', 1), '10.0.0.9');
});

test('30 writes a minute from one visitor; reads are not counted', async () => {
  const { guard, post, later } = guarded({ trustProxies: 1 });
  for (let i = 0; i < 40; i++) assert.equal(await guard(new Request('http://potluck.test/'), '10.0.0.9'), undefined);
  for (let i = 0; i < 30; i++) assert.equal(await post({ 'x-forwarded-for': '203.0.113.1' }), undefined);
  const refused = await post({ 'x-forwarded-for': '203.0.113.1' });
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '60');
  // A visitor can't pass as someone else by sending the header: the proxy's entry is the last one.
  assert.equal((await post({ 'x-forwarded-for': '198.51.100.7, 203.0.113.1' })).status, 429);
  assert.equal(await post({ 'x-forwarded-for': '203.0.113.2' }), undefined, 'another visitor still can');
  later(60_000);
  assert.equal(await post({ 'x-forwarded-for': '203.0.113.1' }), undefined, 'and the first can again a minute later');
});

test('a body over 16 KiB is refused, with a Content-Length or without one', async () => {
  const { post } = guarded();
  assert.equal(await post({}, 'x'.repeat(16 * 1024)), undefined);
  assert.equal((await post({}, 'x'.repeat(16 * 1024 + 1))).status, 413);
  const chunks = (size) => new ReadableStream({ start(controller) { for (let sent = 0; sent < size; sent += 4096) controller.enqueue(new Uint8Array(Math.min(4096, size - sent))); controller.close(); } });
  const { guard } = guarded();
  const streamed = (size) => guard(new Request('http://potluck.test/_server', { method: 'POST', body: chunks(size), duplex: 'half' }), '10.0.0.9');
  assert.equal((await streamed(20_000)).status, 413);
  const small = new Request('http://potluck.test/_server', { method: 'POST', body: chunks(1000), duplex: 'half' });
  assert.equal(await guard(small, '10.0.0.9'), undefined);
  assert.equal((await small.text()).length, 1000, 'and a body it lets through can still be read');
});

test('the sign-ups go back to the seed at midnight UTC', async () => {
  const { guard, later, resets } = guarded();
  const look = () => guard(new Request('http://potluck.test/'), '10.0.0.9');
  later(DAY / 4);
  await look();
  assert.equal(resets(), 0, 'not before');
  later(DAY / 2);
  await look();
  assert.equal(resets(), 1);
  await look();
  assert.equal(resets(), 1, 'once a day');
});

test('a hosted sign-up: a bounded number, with short names and dishes', () => {
  const signup = { name: 'Theo', dish: 'Lemonade' };
  assert.deepEqual(signupErrors(signup, MAX_SIGNUPS - 1), []);
  assert.deepEqual(signupErrors(signup, MAX_SIGNUPS), ['The sign-up sheet is full until the demo resets (daily).']);
  assert.equal(signupErrors({ ...signup, name: 'x'.repeat(41) }, 0).length, 1);
  assert.equal(signupErrors({ ...signup, dish: 'x'.repeat(61) }, 0).length, 1);
});

// The built app, as Railway runs it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = 'solidstart-potluck-production.up.railway.app';
const servers = [];
const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
async function start(env) {
  const port = await freePort();
  servers.push(spawn(process.execPath, ['.output/server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'inherit'] }));
  for (let tries = 0; tries < 100; tries++) {
    if (await fetch(`http://localhost:${port}/`).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return port;
}
let hosted, local, action;
before(async () => {
  [hosted, local] = await Promise.all([start({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), start({ HOSTED_DEMO: '' })]);
  action = (await (await fetch(`http://localhost:${hosted}/`)).text()).match(/<form action="([^"]+)"/)[1];
});
after(() => servers.forEach((server) => server.kill()));

/** A raw request (Host included, which fetch won't send as given), as through Railway's proxy. */
function send(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: 'localhost', port, method, path, headers: { host: PUBLIC, 'x-forwarded-proto': 'https', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
let visitor = 0;
const signUp = (fields, headers = {}) => {
  const body = new URLSearchParams({ dish: 'Soup', course: 'side', guests: '1', ...fields }).toString();
  return send(hosted, { method: 'POST', path: action, body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), origin: `https://${PUBLIC}`, referer: `https://${PUBLIC}/`, 'x-forwarded-for': `203.0.113.${++visitor % 250}`, ...headers } });
};
const flash = (response) => decodeURIComponent(String(response.headers['set-cookie'] ?? ''));

test('every page says the data resets, and only when hosted', async () => {
  assert.ok((await send(hosted)).text.includes(`<p class="demo-notice">${NOTICE}</p>`));
  assert.ok((await send(hosted, { path: '/no-such-page' })).text.includes(NOTICE));
  assert.ok(!(await send(local)).text.includes(NOTICE));
});

test('POST /reset is the tests\', not the public\'s', async () => {
  assert.equal((await send(hosted, { method: 'POST', path: '/reset' })).status, 404);
  assert.equal((await send(local, { method: 'POST', path: '/reset' })).status, 204);
});

test('behind the proxy, a same-site sign-up goes through and a cross-site one does not', async () => {
  // As browsers send it (Sec-Fetch-Site), and as older ones do (Origin alone): both pass.
  const same = await signUp({ name: 'Ada' }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(same.status, 302);
  assert.equal(same.headers.location, `https://${PUBLIC}/`);
  assert.match(flash(same), /"ok":"Ada"/);
  assert.match(flash(await signUp({ name: 'Bea' })), /"ok":"Bea"/);
  // From another site: refused before the action runs, with the header or without it.
  for (const headers of [{ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await signUp({ name: 'Mallory' }, headers)).status, 403, JSON.stringify(headers));
  }
  assert.ok(!(await send(hosted)).text.includes('Mallory'));
});

test('the built app refuses a big body and a 31st write a minute', async () => {
  assert.equal((await signUp({ name: 'Big', dish: 'x'.repeat(20_000) })).status, 413);
  const from = { 'x-forwarded-for': '198.51.100.99' };
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await signUp({ name: `Rate ${i}` }, from)).status);
  assert.deepEqual(statuses.slice(0, 30), Array(30).fill(302));
  assert.equal(statuses[30], 429);
});

test('the sheet holds 100 sign-ups', async () => {
  const lede = async () => (await send(hosted)).text.match(/class="lede">(?:<!--\$-->)?(\d+)/)[1];
  for (let i = Number(await lede()); i < MAX_SIGNUPS; i++) assert.match(flash(await signUp({ name: `Guest ${i}` })), /"ok"/);
  assert.equal(await lede(), String(MAX_SIGNUPS));
  assert.match(flash(await signUp({ name: 'One too many' })), /The sign-up sheet is full/);
  assert.equal(await lede(), String(MAX_SIGNUPS));
});
