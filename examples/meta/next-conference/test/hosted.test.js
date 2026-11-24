// The schedule as a public demo (HOSTED_DEMO=1), without Next: what the proxy refuses, the write
// limit, the bound on ratings and the reset, with a clock the test moves. test/hosted-app.test.js
// runs the built app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress, fromEnv, guard, MAX_RATINGS, writeLimit } from '../lib/hosted.js';
import { createFeedback } from '../lib/feedback.js';

const DAY = 24 * 60 * 60_000;
const clock = () => {
  let time = Date.UTC(2026, 0, 1, 12);
  return { now: () => time, later: (ms) => (time += ms) };
};
const request = (method, headers = {}) => ({ method, headers: new Headers(headers) });

test('fromEnv: off unless HOSTED_DEMO=1', () => {
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ HOSTED_DEMO: '0' }), null);
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', TRUST_PROXIES: '1' }), { resetMinutes: 1440, trustProxies: 1 });
  assert.deepEqual(fromEnv({ HOSTED_DEMO: '1', DEMO_RESET_MINUTES: '5' }), { resetMinutes: 5, trustProxies: 0 });
});

test('the visitor is the entry the proxy in front appended, never one they wrote', () => {
  const headers = new Headers({ 'x-forwarded-for': '192.0.2.1, 203.0.113.5' });
  assert.equal(clientAddress(headers, 1), '203.0.113.5');
  assert.equal(clientAddress(headers, 2), '192.0.2.1');
  assert.equal(clientAddress(new Headers({ 'x-forwarded-for': '203.0.113.5' }), 2), '203.0.113.5', 'fewer entries than proxies: the last');
  assert.equal(clientAddress(new Headers(), 1), 'unknown');
});

test('reads go through; a body over 16 KiB is refused', () => {
  const allow = writeLimit();
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(guard(request(method, { 'content-length': '999999' }), { allow }), null);
  assert.equal(guard(request('POST', { 'content-length': String(16 * 1024) }), { allow }), null);
  assert.equal(guard(request('POST', { 'content-length': String(16 * 1024 + 1) }), { allow }).status, 413);
});

test('30 writes a minute from one visitor, counted per visitor behind the proxy', () => {
  const { now, later } = clock();
  const allow = writeLimit({ now });
  const write = (from) => guard(request('POST', { 'x-forwarded-for': from }), { trustProxies: 1, allow })?.status ?? 200;
  for (let i = 0; i < 30; i++) assert.equal(write('203.0.113.1'), 200);
  assert.equal(write('203.0.113.1'), 429);
  assert.equal(write('198.51.100.7, 203.0.113.1'), 429, 'the header a visitor sends doesn\'t make them someone else');
  assert.equal(write('203.0.113.2'), 200, 'another visitor still can');
  later(60_000);
  assert.equal(write('203.0.113.1'), 200, 'and the first can again a minute later');
});

test('each talk keeps its latest ratings, and only as a hosted demo', () => {
  const { now } = clock();
  const hosted = createFeedback({ now, maxRatings: 3 });
  for (const rating of [1, 1, 5, 5, 5]) hosted.addFeedback('s1', { rating, followup: false });
  assert.deepEqual(hosted.summary('s1'), { count: 3, average: 5, followups: 0 });
  assert.equal(MAX_RATINGS, 200);
  const local = createFeedback();
  for (let i = 0; i < MAX_RATINGS + 5; i++) local.addFeedback('s1', { rating: 4, followup: true });
  assert.equal(local.summary('s1').count, MAX_RATINGS + 5);
});

test('the ratings start over at midnight UTC', () => {
  const { now, later } = clock();
  const feedback = createFeedback({ now });
  feedback.addFeedback('s6', { rating: 5, followup: true });
  later(DAY / 4);
  assert.equal(feedback.summary('s6').count, 1, 'not before');
  later(DAY / 2);
  assert.deepEqual(feedback.summary('s6'), { count: 0, average: 0, followups: 0 });
  feedback.addFeedback('s6', { rating: 3, followup: false });
  assert.equal(feedback.summary('s6').count, 1);
});

test('DEMO_RESET_MINUTES shortens the period', () => {
  const { now, later } = clock();
  const feedback = createFeedback({ now, resetMinutes: 5 });
  feedback.addFeedback('s2', { rating: 4, followup: false });
  later(5 * 60_000);
  assert.equal(feedback.summary('s2').count, 0);
});
