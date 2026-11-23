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
