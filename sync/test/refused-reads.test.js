// A collection whose every read is refused looks, to a page, exactly like an empty one. In
// development the server says so once, to whoever runs it; the page is told nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncServer, allowAnyone, allowReads } from '../src/server.js';

let n = 0;
const at = () => `${String(++n).padStart(15, '0')}-00000-dev1`;
const change = (collection, key, value) => ({ collection, key, field: 'v', value, clock: at() });
const url = (path, scope) => `http://localhost/_zb/sync${path}${scope === undefined ? '' : `&scope=${encodeURIComponent(JSON.stringify(scope))}`}`;
const pull = async (sync, { since = '0', scope, headers = {} } = {}) => (await sync.fetch(new Request(url(`/pull?since=${since}`, scope), { headers }))).json();

async function server(options) {
  const warned = [];
  const sync = createSyncServer({ warn: (message) => warned.push(message), ...options });
  await sync.write('secrets', 'a', { left: 2 });
  await sync.write('secrets', 'b', { left: 3 });
  await sync.write('items', 'bun', { left: 5 });
  return { sync, warned };
}

test('authorize refusing every read of a collection is said once, with the collection, the request and the cause', async () => {
  const { sync, warned } = await server({ authorize: ({ collection, write }) => !write && collection !== 'secrets' });
  const body = await pull(sync);
  assert.deepEqual([...new Set(body.changes.map((each) => each.collection))], ['items'], 'the page gets what it may see, and no word of the rest');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^@zubra\/sync: a page read "secrets" \(GET \/_zb\/sync\/pull\) and was sent none of its 2 documents: `authorize` refused every read\./);
  assert.match(warned[0], /`warn: false` turns it off/);
  await pull(sync);
  assert.equal(warned.length, 1, 'once per collection');
});

test('without authorize reads are refused; allowReads reports collections it leaves out', async () => {
  const { sync, warned } = await server({});
  const refused = await sync.fetch(new Request(url('/pull?since=0')));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /takes no reads or writes from pages/);
  assert.deepEqual(warned, [], 'the refusal is returned to the page');
  // A collection allowReads leaves out is `authorize` refusing it, as an app's own would.
  const listed = await server({ authorize: allowReads(['items']) });
  await pull(listed.sync);
  assert.equal(listed.warned.length, 1);
  assert.match(listed.warned[0], /"secrets" .*`authorize` refused every read/);
});

test("the server's scope leaving a collection out is said as that", async () => {
  const { sync, warned } = await server({ authorize: allowReads(), scope: () => ({ items: true, secrets: 'mine/' }) });
  await pull(sync);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /a page read "secrets" .* none of its 2 documents: the server's `scope` for that request leaves them all out/);
});

test('nothing is said when the page sees some of a collection, left it out of its own scope, or only read what is new', async () => {
  // Some of it: one document of two.
  const some = await server({ authorize: ({ key, write }) => !write && key !== 'a' });
  await pull(some.sync);
  assert.deepEqual(some.warned, []);
  // The page's own scope doesn't ask for the collection.
  const narrow = await server({ authorize: ({ collection, write }) => !write && collection !== 'secrets' });
  await pull(narrow.sync, { scope: { items: true } });
  assert.deepEqual(narrow.warned, []);
  // A later batch: other people's changes are refused as a matter of course.
  const later = await server({ authorize: ({ request, write }) => !write && request.headers.get('x-user') === 'ada' });
  const first = await pull(later.sync, { headers: { 'x-user': 'ada' } });
  await later.sync.write('secrets', 'c', { left: 1 });
  const grace = await pull(later.sync, { since: first.cursor });
  assert.deepEqual([grace.changes.length, later.warned], [0, []]);
  // Everything allowed.
  const open = await server({ authorize: allowAnyone });
  await pull(open.sync);
  assert.deepEqual(open.warned, []);
});

test('the live stream read from the start says the same, once', async () => {
  const { sync, warned } = await server({ authorize: ({ collection, write }) => !write && collection !== 'secrets' });
  const response = await sync.fetch(new Request(url('/live?since=0&peer=p1')));
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('event: changes')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /a page read "secrets" \(GET \/_zb\/sync\/live\)/);
});

test('`warn: false`, and production (NODE_ENV unset included), say nothing', async () => {
  const off = createSyncServer({ warn: false, authorize: ({ write }) => !write && false });
  await off.write('secrets', 'a', { left: 2 });
  assert.deepEqual((await pull(off)).changes, []);
  const said = [];
  const { warn } = console;
  const env = process.env.NODE_ENV;
  console.warn = (message) => said.push(message);
  try {
    for (const value of ['production', undefined, 'test']) {
      if (value === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = value;
      const production = createSyncServer({ authorize: () => false });
      await production.write('secrets', 'a', { left: 2 });
      await pull(production);
      assert.deepEqual(said, [], `NODE_ENV ${value}`);
    }
    // And in development, with no `warn` given, it goes to the console.
    process.env.NODE_ENV = 'development';
    const development = createSyncServer({ authorize: () => false });
    await development.write('secrets', 'a', { left: 2 });
    await pull(development);
    assert.equal(said.length, 1);
  } finally {
    console.warn = warn;
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
  }
});

test('a stream read from the start holds one page at a time, and still says it right across pages', async () => {
  // A log read from storage page by page (as the SQL logs are): each page's changes are made
  // when it is read. Five pages of 1000. While the stream reads them, the earlier pages are
  // the stream's to let go: what `warn` needs is a count per collection, not the changes
  // themselves (security audit 4: a large log read from the start by a few streams at once
  // was held whole by each).
  const { queryObjects } = await import('node:v8');
  class Change {
    constructor(at) {
      // `secrets` in the first four pages, refused; `later` there too, refused but for one
      // document in the last page; `items` only in the last page, and shown.
      this.collection = at === 4999 ? 'later' : at >= 4000 ? 'items' : at % 2 ? 'secrets' : 'later';
      this.key = `k${at}`;
      this.field = 'v';
      this.value = at;
      this.clock = `${String(at + 1).padStart(15, '0')}-00000-dev1`;
    }
  }
  const PAGES = 5;
  let alive = null;
  const log = {
    async append() {},
    async after(cursor, limit = 1000) {
      const from = Number(cursor);
      if (from >= PAGES * 1000) return { changes: [], cursor: from };
      // While the last page is read: how many changes of the earlier pages are still held.
      if (from === (PAGES - 1) * 1000) alive = queryObjects(Change, { format: 'count' });
      return { changes: Array.from({ length: Math.min(limit, PAGES * 1000 - from) }, (_, i) => new Change(from + i)), cursor: from + Math.min(limit, PAGES * 1000 - from) };
    },
    head: async () => PAGES * 1000,
  };
  const warned = [];
  const sync = createSyncServer({ log, warn: (message) => warned.push(message), authorize: ({ collection, key, write }) => !write && (collection === 'items' || key === 'k4999') });
  const response = await sync.fetch(new Request(url('/live?since=0&peer=p1')));
  const reader = response.body.getReader();
  let text = '';
  while ((text.match(/event: changes/g) ?? []).length < PAGES) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(alive !== null && alive <= 2000, `while reading the last page, ${alive} changes of the earlier ones were still held`);
  assert.equal(warned.length, 1, 'secrets, refused across four pages, is said once');
  assert.match(warned[0], /a page read "secrets" \(GET \/_zb\/sync\/live\) and was sent none of its 1000 or more documents: `authorize` refused every read/);
  assert.doesNotMatch(warned.join('\n'), /"items"|"later"/, 'a collection shown in some page, the last included, is not said');
});
