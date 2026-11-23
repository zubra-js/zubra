// documents() in Node: what the list holds while the store is read and after, and the built-in
// memory store's all(). A component's use of it is the browser's (browser.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const shim = new URL('./runtime-without-elements.js', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === '@zubra/runtime' && context.parentURL?.endsWith('/sync/src/index.js')) return { url: ${JSON.stringify(shim)}, shortCircuit: true };
  return next(specifier, context);
}`)}`);
const { flush } = await import('@zubra/runtime/core');
const sync = await import('../src/index.js');
const settle = async (ms = 0) => {
  flush();
  await new Promise((done) => setTimeout(done, ms));
  flush();
};
const plain = (list) => JSON.parse(JSON.stringify(list));

test('memoryStore.all(): a collection\'s documents under a prefix, as [key, fields], by key, each a copy', async () => {
  const store = sync.memoryStore();
  await store.set('orders', 'b/2', { n: 2 });
  await store.set('orders', 'b/1', { n: 1, list: [1] });
  await store.set('orders', 'c/1', { n: 3 });
  await store.set('ordersx', 'b/9', { n: 9 });
  assert.deepEqual(await store.all('orders', 'b/'), [['b/1', { n: 1, list: [1] }], ['b/2', { n: 2 }]]);
  assert.deepEqual((await store.all('orders')).map(([key]) => key), ['b/1', 'b/2', 'c/1']);
  (await store.all('orders', 'b/'))[0][1].list.push(2);
  assert.deepEqual((await store.get('orders', 'b/1')).list, [1]);
});

test('documents(): what was given, then the store\'s, and a change heard while the store was read is not undone by it', async () => {
  const memory = sync.memoryStore();
  await memory.set('orders', 'k/1', { item: 'Soup', status: 'new', $clocks: { item: '1-0-a' } });
  await memory.set('orders', 'k/3', { item: 'Tea', status: 'new' });
  // all() answers late, with what it read before the change below.
  let answer;
  sync.configure({ store: { get: memory.get, set: memory.set, all: (collection, prefix) => memory.all(collection, prefix).then((found) => new Promise((done) => (answer = () => done(found)))) } });
  const list = sync.documents('orders', 'k/', [{ key: 'k/2', item: 'Given', status: 'new' }, { key: 'x/1', item: 'Not this board' }, { item: 'No key' }]);
  assert.deepEqual(plain(list), [{ key: 'k/2', item: 'Given', status: 'new' }]);
  await settle(10);
  await sync.receive('orders', 'k/1', { status: 'ready', $clocks: { status: '2-0-b' } });
  await sync.receive('orders', 'j/1', { item: 'Another prefix' });
  assert.deepEqual(plain(list), [{ key: 'k/1', status: 'ready' }, { key: 'k/2', item: 'Given', status: 'new' }]);
  answer();
  await settle(10);
  assert.deepEqual(plain(list), [
    { key: 'k/1', status: 'ready', item: 'Soup' },
    { key: 'k/2', item: 'Given', status: 'new' },
    { key: 'k/3', item: 'Tea', status: 'new' },
  ]);
  // After the read, a change is applied as it comes; clocks and reserved names never show.
  await sync.receive('orders', 'k/3', { status: 'served', key: 'spoofed', $clocks: {} });
  assert.deepEqual(plain(list)[2], { key: 'k/3', item: 'Tea', status: 'served' });
});

// ---- Security audit of #433 ----------------------------------------------------------------

test('a key or fields that are not a document\'s stop before the lists, and one list failing does not stop the next', async () => {
  sync.configure({ store: sync.memoryStore() });
  const first = sync.documents('guarded', '');
  const second = sync.documents('guarded', '');
  await settle(10);
  const errors = [];
  const error = console.error;
  console.error = (...said) => errors.push(said.join(' '));
  try {
    // Before lists existed these resolved; they still do, and nothing is listed.
    await sync.receive('guarded', 7, { item: 'a number key' });
    await sync.receive('guarded', null, { item: 'no key' });
    assert.deepEqual(plain(first), []);
    assert.deepEqual(errors, []);
    // A list that fails says so, and the next is still told.
    Object.defineProperty(first, 'splice', { value: () => { throw new Error('this list is broken'); } });
    await sync.receive('guarded', 'a', { item: 'Soup' });
    assert.deepEqual(plain(second), [{ key: 'a', item: 'Soup' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /a documents\(\) list couldn't take guarded\/a/);
  } finally {
    console.error = error;
  }
});

test('a prefix function with nothing to give lists nothing, not the whole collection', async () => {
  const store = sync.memoryStore();
  await store.set('private', 'alice/1', { item: 'Hers' });
  await store.set('private', 'bob/1', { item: 'His' });
  sync.configure({ store });
  const { Signal } = await import('@zubra/runtime/core');
  const who = new Signal.State(undefined);
  const list = sync.documents('private', () => (who.get() ? `${who.get()}/` : who.get()), [{ key: 'alice/1', item: 'Given' }]);
  await settle(10);
  assert.deepEqual(plain(list), []);
  await sync.receive('private', 'alice/2', { item: 'Heard' });
  assert.deepEqual(plain(list), []);
  who.set('bob');
  await settle(10);
  assert.deepEqual(plain(list), [{ key: 'bob/1', item: 'His' }]);
  who.set(null);
  await settle(10);
  assert.deepEqual(plain(list), []);
  // Written out, with no prefix, it is the whole collection.
  const all = sync.documents('private');
  await settle(10);
  assert.deepEqual(plain(all).map((doc) => doc.key), ['alice/1', 'alice/2', 'bob/1']);
});

test('a long list stays quick: finding a key reads a handful of items, and the store is merged in one pass', async () => {
  const N = 20_000;
  const key = (n) => `big/${String(n).padStart(8, '0')}`;
  const store = sync.memoryStore();
  for (let n = 0; n < N; n += 2) await store.set('long', key(n), { n });
  sync.configure({ store });
  // Count the reads of items' keys: a linear search reads them all, for every change.
  let reads = 0;
  const counted = (doc) => new Proxy(doc, { get: (target, name) => (name === 'key' && reads++, target[name]) });
  const loading = performance.now();
  const list = sync.documents('long', 'big/', [{ key: key(1), n: 1 }]);
  await settle(50);
  assert.equal(list.length, N / 2 + 1);
  // One pass over 10 000 documents: tens of milliseconds. An insert each took seconds.
  assert.ok(performance.now() - loading < 1500, `the store's documents joined the list in ${Math.round(performance.now() - loading)} ms`);
  assert.deepEqual(plain(list.slice(0, 3)), [{ key: key(0), n: 0 }, { key: key(1), n: 1 }, { key: key(2), n: 2 }]);
  const { raw } = await import('@zubra/runtime/core');
  const items = raw(list);
  for (let at = 0; at < items.length; at++) items[at] = counted(items[at]);
  const started = performance.now();
  for (let n = 3; n < 2003; n += 2) await sync.receive('long', key(n), { n });   // 1000 new, in the middle
  await sync.receive('long', key(N), { n: N });                                   // one at the end
  await sync.receive('long', key(4), { n: 'changed' });                           // one already there
  assert.equal(list.length, N / 2 + 1 + 1001);
  assert.equal(raw(list).find((doc) => doc.n === 'changed').key, key(4));
  for (let at = 1; at < 2100; at++) assert.ok(raw(list)[at - 1].key < raw(list)[at].key, `in key order at ${at}`);
  // About 2 × log2(11 000) ≈ 28 reads a change; a linear search would be millions.
  assert.ok(reads < 1002 * 60, `${reads} reads of a key for 1002 changes`);
  assert.ok(performance.now() - started < 5000, 'and in well under a second on any machine');
});
