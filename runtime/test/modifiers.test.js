// `.self` / selfOnly: the original target, not the one a shadow root retargets to the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfOnly } from '../src/modifiers.js';

test('selfOnly ignores an inner click whose target was retargeted to the shadow host', () => {
  const host = {};
  const inner = {};
  let ran = false;
  const listener = selfOnly(() => { ran = true; });
  listener.call(host, { currentTarget: host, target: host, composedPath: () => [inner, host] });
  assert.equal(ran, false, 'the click came from inside the shadow tree');
  listener.call(host, { currentTarget: host, target: host, composedPath: () => [host] });
  assert.equal(ran, true, 'the click was on the host itself');
});

test('selfOnly falls back to event.target where composedPath is missing', () => {
  const host = {};
  let ran = false;
  selfOnly(() => { ran = true; }).call(host, { currentTarget: host, target: host });
  assert.equal(ran, true);
  ran = false;
  selfOnly(() => { ran = true; }).call(host, { currentTarget: host, target: {} });
  assert.equal(ran, false);
});
