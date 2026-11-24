// The help desk as a public demo (HOSTED_DEMO=1): the notice, the body, write and record limits,
// the same-site check behind the proxy, the bounded streams and the reset. No browser: raw HTTP
// (so the Host header can be the public one), with a clock the test moves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../src/app.js';
import { memoryStore } from '../src/store/memory.js';
import { demo, fromEnv, FULL, NOTICE } from '../src/hosted.js';

const DAY = 24 * 60 * 60_000;
const PUBLIC = 'helpdesk.example.app';
const servers = [];
after(() => servers.forEach((server) => (server.closeAllConnections(), server.close())));

async function desk(hosted = {}, { store = memoryStore() } = {}) {
  let time = Date.UTC(2026, 0, 1, 12);
  const app = createApp({ store, cache: false, now: () => time, hosted: hosted && { trustProxies: 1, origins: [`https://${PUBLIC}`], ...hosted } });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  /**
   * One request; `form` is sent urlencoded, with its length or, `chunked`, without one.
   * Resolves to { status, headers, body }.
   */
  const send = (method, path, { headers = {}, form, chunked = false } = {}) => new Promise((resolve, reject) => {
    const body = form && new URLSearchParams(form).toString();
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(body !== undefined && { 'content-type': 'application/x-www-form-urlencoded', ...(!chunked && { 'content-length': Buffer.byteLength(body) }) }), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (chunk) => (text += chunk)).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (chunked) req.write(body); // (given to end(), Node would set the length)
    req.end(chunked ? undefined : body);
  });
  /** Signs in as `user` from `from` (an X-Forwarded-For); the cookie to send. */
  const signIn = async (user, from = '192.0.2.1') => {
    const response = await send('POST', '/login', { form: { user, next: '/' }, headers: { 'x-forwarded-for': from } });
    assert.equal(response.status, 303);
    return response.headers['set-cookie'][0].split(';')[0];
  };
  return { store, send, signIn, later: (ms) => (time += ms) };
}

// What Railway's proxy sends: the public Host, https, the visitor's address appended.
const proxied = (from, extra = {}) => ({ host: PUBLIC, 'x-forwarded-proto': 'https', 'x-forwarded-for': from, ...extra });
const replyAction = (html) => html.match(/<form[^>]*action="(\/_zb\/action\/[^"]+)"/)[1];

test('fromEnv: off unless HOSTED_DEMO=1; the public origin from DEMO_ORIGIN or Railway', () => {
  assert.equal(fromEnv({}), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1, origins: [] });
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', RAILWAY_PUBLIC_DOMAIN: PUBLIC, DEMO_ORIGIN: 'https://other.test' }).origins, ['https://other.test', `https://${PUBLIC}`]);
});

test('every page says the data resets, and only when hosted', async () => {
  const { send, signIn } = await desk();
  const cookie = await signIn('u-ada');
  for (const path of ['/login', '/', '/tickets', '/tickets/1001', '/tickets/new', '/nowhere']) {
    assert.ok((await send('GET', path, { headers: { cookie } })).body.includes(`<p class="demo-notice">${NOTICE}</p>`), path);
  }
  const local = await desk(null);
  assert.ok(!(await local.send('GET', '/login')).body.includes('demo-notice'));
});

test('a body over 16 KiB is refused before it reaches a route or the server function', async () => {
  const { send, signIn, store } = await desk();
  const cookie = await signIn('u-lena');
  const before = (await store.listTickets({})).length;
  const replies = (await store.getTicket(1001)).messages.length;
  const big = await send('POST', '/tickets', { headers: { cookie }, form: { subject: 'A long story', body: 'x'.repeat(17_000) } });
  assert.equal(big.status, 413);
  assert.equal((await store.listTickets({})).length, before);
  const action = replyAction((await send('GET', '/tickets/1001', { headers: { cookie } })).body);
  assert.equal((await send('POST', action, { headers: { cookie }, form: { ticket: '1001', body: 'y'.repeat(17_000) } })).status, 413);
  // Without a length, each reader stops at the limit.
  assert.equal((await send('POST', '/tickets', { headers: { cookie }, chunked: true, form: { subject: 'A long story', body: 'x'.repeat(17_000) } })).status, 413);
  assert.equal((await send('POST', action, { headers: { cookie, accept: 'application/json' }, chunked: true, form: { ticket: '1001', body: 'y'.repeat(17_000) } })).status, 413);
  assert.equal((await store.getTicket(1001)).messages.length, replies);
  assert.equal((await send('POST', '/tickets', { headers: { cookie }, form: { subject: 'A short story', body: 'x'.repeat(15_000) } })).status, 303, 'under it is fine');
});

test('30 writes a minute from one visitor, counted per visitor behind the proxy', async () => {
  const { send, signIn, later } = await desk();
  const cookie = await signIn('u-ada', '203.0.113.9');
  const save = (from) => send('POST', '/tickets/1001', { headers: { cookie, 'x-forwarded-for': from }, form: { status: 'pending' } });
  for (let i = 0; i < 30; i++) assert.equal((await save('203.0.113.1')).status, 303);
  const refused = await save('203.0.113.1');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers['retry-after'], '60');
  // A visitor can't pass as someone else by sending the header: the proxy's entry is the last one.
  assert.equal((await save('198.51.100.7, 203.0.113.1')).status, 429);
  assert.equal((await save('203.0.113.2')).status, 303, 'another visitor still can');
  assert.equal((await send('GET', '/', { headers: { cookie, 'x-forwarded-for': '203.0.113.1' } })).status, 200, 'reading is not limited');
  later(60_000);
  assert.equal((await save('203.0.113.1')).status, 303, 'and the first can again a minute later');
});

test('at most maxTickets tickets and maxMessages messages', async () => {
  const { send, signIn, store } = await desk({ maxTickets: 13, maxMessages: 26 });
  const cookie = await signIn('u-lena');
  const seeded = await store.listTickets({});
  assert.equal(seeded.length, 12);
  const file = () => send('POST', '/tickets', { headers: { cookie }, form: { subject: 'Another problem', body: 'Details.' } });
  assert.equal((await file()).status, 303);
  const full = await file();
  assert.equal(full.status, 503);
  assert.ok(full.body.includes(FULL));
  assert.equal((await store.listTickets({})).length, 13);

  const messages = async () => (await store.listTickets({})).reduce((sum, ticket) => sum + ticket.messages.length, 0);
  const action = replyAction((await send('GET', '/tickets/1001', { headers: { cookie } })).body);
  const reply = () => send('POST', action, { headers: { cookie, accept: 'application/json' }, form: { ticket: '1001', body: 'More.' } });
  while ((await messages()) < 26) assert.equal((await reply()).status, 204, 'sent: told where to go');
  const refused = await reply();
  assert.ok(refused.body.includes(FULL), refused.body);
  assert.equal(await messages(), 26);
});

test('behind the proxy: same-site posts pass, with or without Sec-Fetch-Site; cross-site ones are refused', async () => {
  const { send, signIn, store } = await desk();
  const cookie = await signIn('u-ada');
  const action = replyAction((await send('GET', '/tickets/1002', { headers: { cookie } })).body);
  const origin = `https://${PUBLIC}`;
  const cases = [
    [{ origin, 'sec-fetch-site': 'same-origin' }, 'same site'],
    [{ origin }, 'same site, no Sec-Fetch-Site (the origin is named in origins)'],
    [{ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, 'cross site'],
    [{ origin: 'https://evil.example' }, 'cross site, no Sec-Fetch-Site'],
    [{ 'sec-fetch-site': 'same-site', origin: `https://other.${PUBLIC}` }, 'a sibling subdomain'],
  ];
  let n = 0;
  for (const [headers, label] of cases) {
    const same = label.startsWith('same');
    const update = await send('POST', '/tickets/1002', { headers: { cookie, ...proxied(`198.51.100.${n++}`, headers) }, form: { priority: 'urgent' } });
    assert.equal(update.status, same ? 303 : 403, `the app's own form: ${label}`);
    const before = (await store.getTicket(1002)).messages.length;
    const reply = await send('POST', action, { headers: { cookie, ...proxied(`198.51.100.${n++}`, headers) }, form: { ticket: '1002', body: `From ${label}` } });
    assert.equal(reply.status, same ? 303 : 403, `the reply box's server function: ${label}`);
    assert.equal((await store.getTicket(1002)).messages.length, before + (same ? 1 : 0));
    if (same) assert.equal(reply.headers.location, '/tickets/1002#latest', "a path: the browser keeps https");
  }
});

test('without the public origin, a same-site post that has no Sec-Fetch-Site is refused (why origins is set)', async () => {
  const { send, signIn } = await desk({ origins: [] });
  const cookie = await signIn('u-ada');
  const action = replyAction((await send('GET', '/tickets/1002', { headers: { cookie } })).body);
  const headers = { cookie, ...proxied('198.51.100.1', { origin: `https://${PUBLIC}` }) };
  assert.equal((await send('POST', action, { headers, form: { ticket: '1002', body: 'Hi' } })).status, 403);
  assert.equal((await send('POST', action, { headers: { ...headers, 'sec-fetch-site': 'same-origin' }, form: { ticket: '1002', body: 'Hi' } })).status, 303);
});

test('the dashboard streams its activity, and past maxStreams at once sends it in the page', async () => {
  const streamed = await desk();
  const cookie = await streamed.signIn('u-ada');
  const page = (await streamed.send('GET', '/', { headers: { cookie } })).body;
  assert.match(page, /Loading recent activity/, 'pending at first, then streamed');
  assert.match(page, /<template for=/);
  const full = await desk({ maxStreams: 0 });
  const whole = (await full.send('GET', '/', { headers: { cookie: await full.signIn('u-ada') } })).body;
  assert.doesNotMatch(whole, /Loading recent activity|<template for=/);
  assert.match(whole, /<ol aria-label="Recent activity">/);
});

test('a stream slot is given back when its response closes', () => {
  const { streams } = demo({ store: memoryStore(), maxStreams: 2 });
  const [a, b, c] = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
  assert.equal(streams.take(a), true);
  assert.equal(streams.take(b), true);
  assert.equal(streams.take(c), false);
  a.emit('close');
  assert.equal(streams.open, 1);
  assert.equal(streams.take(c), true);
});

test('the tickets go back to their seed at midnight UTC', async () => {
  const { send, signIn, store, later } = await desk();
  const cookie = await signIn('u-lena');
  assert.equal((await send('POST', '/tickets', { headers: { cookie }, form: { subject: 'Before midnight', body: 'Hi' } })).status, 303);
  assert.equal((await store.listTickets({})).length, 13);
  later(DAY / 4);
  await send('GET', '/login');
  assert.equal((await store.listTickets({})).length, 13, 'not before');
  later(DAY / 2);
  await send('GET', '/login');
  assert.equal((await store.listTickets({})).length, 12);
  assert.equal((await send('GET', '/', { headers: { cookie } })).status, 200, 'still signed in: the people are the same');
});
