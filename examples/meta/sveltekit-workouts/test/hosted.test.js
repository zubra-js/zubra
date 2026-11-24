// The log as a public demo (HOSTED_DEMO=1): the notice, the body and write limits, the bound on
// workouts and the reset. No browser and no build: these call the guard and the server hook
// directly, with a clock the test moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORKOUTS, NOTICE, fromEnv, guard, withNotice } from '../src/lib/server/hosted.js';
import { add, cap, reset, workouts } from '../src/lib/server/log.js';
import * as devalue from 'devalue';

const DAY = 24 * 60 * 60_000;
const event = (method = 'GET', headers = {}, address = '10.0.0.9') => ({
  request: new Request('http://reps.test/?/log', { method, headers }),
  getClientAddress: () => address,
});

function demo(options = {}) {
  let time = Date.UTC(2026, 0, 1, 12);
  let resets = 0;
  const check = guard({ reset: () => resets++, now: () => time, ...options });
  return { check, later: (ms) => (time += ms), resets: () => resets };
}

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', DEMO_RESET_MINUTES: '60' }), { resetMinutes: 60, trustProxies: 0 });
});

test('the notice goes at the top of the body', () => {
  const html = withNotice('<html><head></head><body data-sveltekit-preload-data="hover">\n<div>app</div></body></html>');
  assert.match(html, /<body data-sveltekit-preload-data="hover">\s*<p class="demo-notice">Demo: data resets daily\.<\/p>\s*<div>app<\/div>/);
  assert.equal(NOTICE, 'Demo: data resets daily.');
});

test('a body over 16 KiB is refused, a smaller one and a read are not', () => {
  const { check } = demo();
  assert.equal(check(event('POST', { 'content-length': String(16 * 1024 + 1) }))?.status, 413);
  assert.equal(check(event('POST', { 'content-length': String(16 * 1024) })), undefined);
  assert.equal(check(event('GET')), undefined);
});

test('30 writes a minute from one visitor, counted per visitor behind the proxy', () => {
  const { check, later } = demo({ trustProxies: 1 });
  const post = (from) => check(event('POST', { 'x-forwarded-for': from }))?.status ?? 200;
  for (let i = 0; i < 30; i++) assert.equal(post('203.0.113.1'), 200);
  assert.equal(post('203.0.113.1'), 429);
  // A visitor can't pass as someone else by sending the header: the proxy's entry is the last one.
  assert.equal(post('198.51.100.7, 203.0.113.1'), 429);
  assert.equal(post('203.0.113.2'), 200, 'another visitor still can');
  // To use:enhance, the refusal is the action's failure, which the form shows as its error.
  const enhanced = check(event('POST', { 'x-forwarded-for': '203.0.113.1', 'x-sveltekit-action': 'true' }));
  assert.equal(enhanced.status, 429);
  assert.equal(enhanced.headers.get('retry-after'), '60');
  return enhanced.json().then((result) => {
    assert.equal(result.type, 'failure');
    assert.deepEqual(devalue.parse(result.data), { errors: { limit: 'Too many changes from here: try again in a minute.' } });
    later(60_000);
    assert.equal(post('203.0.113.1'), 200, 'and the first can again a minute later');
  });
});

test('reads are not counted as writes', () => {
  const { check } = demo({ trustProxies: 1 });
  const post = (from) => check(event('POST', { 'x-forwarded-for': from }))?.status ?? 200;
  for (let i = 0; i < 29; i++) assert.equal(post('203.0.113.2'), 200);
  for (let i = 0; i < 40; i++) assert.equal(check(event('GET', { 'x-forwarded-for': '203.0.113.2' })), undefined);
  assert.equal(post('203.0.113.2'), 200, 'the 30th write');
  assert.equal(post('203.0.113.2'), 429);
});

test('without a trusted proxy, the visitor is the socket address and X-Forwarded-For is ignored', () => {
  const { check } = demo();
  for (let i = 0; i < 30; i++) check(event('POST', { 'x-forwarded-for': `198.51.100.${i}` }, '10.0.0.1'));
  assert.equal(check(event('POST', { 'x-forwarded-for': '198.51.100.99' }, '10.0.0.1'))?.status, 429);
  assert.equal(check(event('POST', {}, '10.0.0.2')), undefined);
});

test('the log goes back to its seed at midnight UTC', () => {
  const { check, later, resets } = demo();
  later(DAY / 4);
  check(event());
  assert.equal(resets(), 0, 'not before');
  later(DAY / 2);
  check(event());
  assert.equal(resets(), 1);
  check(event());
  assert.equal(resets(), 1, 'once a period');
  const hourly = demo({ resetMinutes: 60 });
  hourly.later(60 * 60_000);
  hourly.check(event());
  assert.equal(hourly.resets(), 1, 'DEMO_RESET_MINUTES sets the period');
});

test('a hosted log keeps at most MAX_WORKOUTS workouts, dropping the oldest', () => {
  reset();
  const seeded = workouts().length;
  for (let i = 0; i < MAX_WORKOUTS + 20; i++) add({ exercise: 'row', sets: 1, reps: 1, effort: 1 });
  assert.equal(workouts().length, MAX_WORKOUTS + 20 + seeded, 'unbounded unless hosted');
  reset();
  cap(MAX_WORKOUTS);
  for (let i = 0; i < MAX_WORKOUTS + 20; i++) add({ exercise: i === MAX_WORKOUTS + 19 ? 'squat' : 'row', sets: 1, reps: 1, effort: 1 });
  assert.equal(workouts().length, MAX_WORKOUTS);
  assert.equal(workouts()[0].exercise, 'squat', 'the newest stays');
  reset();
  assert.equal(workouts().length, seeded);
  cap(Infinity);
});

test('the server hook: the notice on pages and the write limit, only when hosted', async () => {
  const page = '<!doctype html><html><head></head><body data-sveltekit-preload-data="hover"><div>app</div></body></html>';
  const resolve = (_, { transformPageChunk }) => new Response(transformPageChunk({ html: page, done: true }), { headers: { 'content-type': 'text/html' } });
  const local = await import('../src/hooks.server.js?local');
  assert.ok(!(await (await local.handle({ event: event(), resolve })).text()).includes(NOTICE));
  process.env.HOSTED_DEMO = '1';
  process.env.TRUST_PROXIES = '1';
  try {
    const { handle } = await import('../src/hooks.server.js?hosted');
    assert.ok((await (await handle({ event: event(), resolve })).text()).includes(`<p class="demo-notice">${NOTICE}</p>`));
    const post = () => handle({ event: event('POST', { 'x-forwarded-for': '203.0.113.5' }), resolve });
    for (let i = 0; i < 30; i++) assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429);
    for (let i = 0; i < MAX_WORKOUTS + 5; i++) add({ exercise: 'row', sets: 1, reps: 1, effort: 1 });
    assert.equal(workouts().length, MAX_WORKOUTS, 'and the log is bounded');
    // The tests' reset route isn't there for strangers.
    const route = await import('../src/routes/reset/+server.js');
    assert.throws(() => route.POST(), (thrown) => thrown.status === 404);
    assert.equal(workouts().length, MAX_WORKOUTS);
  } finally {
    delete process.env.HOSTED_DEMO;
    delete process.env.TRUST_PROXIES;
    cap(Infinity);
  }
});
