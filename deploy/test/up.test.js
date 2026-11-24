// deploy/up.mjs deploys only the demos a change touches, by their railway.json watch patterns.
//
//   node --test deploy/test/up.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affected, matcher, services } from '../up.mjs';

test('watch patterns match as Railway reads them, from the repository root', () => {
  assert.ok(matcher('/src/**').test('src/main.rs'));
  assert.ok(matcher('/src/**').test('src/a/b/c.rs'));
  assert.ok(!matcher('/src/**').test('examples/src/x.js'), 'a leading / anchors at the root');
  assert.ok(matcher('/Cargo.toml').test('Cargo.toml'));
  assert.ok(!matcher('/Cargo.toml').test('wasm/Cargo.toml'));
  assert.ok(matcher('*.md').test('docs/guide/a.md'), 'no leading /: any depth');
  assert.ok(!matcher('/runtime/src/**').test('runtime/test/a.js'));
});

test('every demo has its watch patterns, and a change rebuilds only the demos it touches', () => {
  const all = services();
  assert.deepEqual(Object.keys(all).sort(), ['flask-garden', 'hono-bikes', 'standup']);
  assert.deepEqual(affected(['examples/standup/server.js'], all), ['standup']);
  assert.deepEqual(affected(['examples/backends/flask-garden/app.py'], all), ['flask-garden']);
  assert.deepEqual(affected(['sync/src/server.js'], all), ['standup'], 'only standup uses @zubra/sync');
  assert.deepEqual(affected(['runtime/test/a.test.js'], all), ['hono-bikes', 'standup'], 'the garden ships runtime/src only');
  assert.deepEqual(affected(['src/main.rs'], all), ['flask-garden', 'hono-bikes', 'standup'], 'the compiler goes into every image');
  assert.deepEqual(affected(['docs/sync.md', 'examples/todo/main.js', 'demos/list.js'], all), [], 'nothing that goes into an image');
});
