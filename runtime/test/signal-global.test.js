// signals mode reads a native `globalThis.Signal` when the browser has one. On a page, an element
// with `id="Signal"` is `globalThis.Signal` too: a visitor's id must not become the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fresh = (tag) => import(`../src/signal-tc39.js?${tag}`);

test("a page's element named Signal is not taken for the engine", async () => {
  // What `window.Signal` is when the page has <form id="Signal"><input name="State"></form>.
  const element = { nodeType: 1, State: { nodeType: 1 }, subtle: undefined };
  globalThis.Signal = element;
  try {
    const { Signal, isNative, State } = await fresh('element');
    assert.equal(isNative, false);
    assert.notEqual(Signal, element);
    assert.equal(new State(2).get(), 2, 'the engine works');
  } finally {
    delete globalThis.Signal;
  }
});

test('a native Signal API is still used', async () => {
  const { Signal: implementation } = await fresh('implementation');
  globalThis.Signal = implementation;
  try {
    const { isNative, Signal } = await fresh('native');
    assert.equal(Signal, implementation);
    assert.equal(isNative, false, 'the same object as ours here, so not "native", but it was taken');
  } finally {
    delete globalThis.Signal;
  }
});
