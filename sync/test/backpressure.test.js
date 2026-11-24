// Security audit 6: a live stream is paced by its reader. A page that opens /live?since=0 and
// reads nothing used to make the server load the whole log into that stream, and keep every
// change after it: ten such pages held 400 MB for a 200,000-change log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createSyncServer, allowReads, allowAnyone } from '../src/server.js';

const PAGES = 50;
/** A log read from storage page by page, counting the pages read. */
function countedLog() {
  const log = {
    pages: 0,
    async append() { return PAGES * 1000; },
    async after(cursor, limit = 1000) {
      const from = Number(cursor);
      if (from >= PAGES * 1000) return { changes: [], cursor: from };
      log.pages++;
      const changes = Array.from({ length: Math.min(limit, PAGES * 1000 - from) }, (_, i) => ({ collection: 'menu', key: `k${from + i}`, field: 'name', value: 'x'.repeat(50), clock: `${String(from + i + 1).padStart(15, '0')}-00000-dev1` }));
      return { changes, cursor: from + changes.length };
    },
    head: async () => PAGES * 1000,
  };
  return log;
}

test('a stream nobody reads holds a page or two, not the whole log', async () => {
  const log = countedLog();
  const sync = createSyncServer({ log, authorize: allowReads(['menu']), warn: false });
  const unread = [];
  for (let i = 0; i < 5; i++) unread.push(await sync.fetch(new Request(`http://localhost/_zb/sync/live?since=0&peer=p${i}`)));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(log.pages <= 5 * 3, `${log.pages} pages read for five streams that read nothing (of ${5 * PAGES})`);
  for (const response of unread) await response.body.cancel();
});

test('a stream that is read gets the whole backlog', async () => {
  const log = countedLog();
  const sync = createSyncServer({ log, authorize: allowReads(['menu']), warn: false });
  const response = await sync.fetch(new Request('http://localhost/_zb/sync/live?since=0&peer=reader'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let text = '';
  while (seen < PAGES * 1000) {
    text += decoder.decode((await reader.read()).value, { stream: true });
    let end;
    while ((end = text.indexOf('\n\n')) >= 0) {
      const event = text.slice(0, end);
      text = text.slice(end + 2);
      if (event.startsWith('event: changes')) seen += JSON.parse(event.slice(event.indexOf('data: ') + 6)).changes.length;
    }
  }
  assert.equal(seen, PAGES * 1000);
  await reader.cancel();
});

test('a live stream that falls far behind is closed, to reconnect from its cursor', async () => {
  const sync = createSyncServer({ authorize: allowAnyone, warn: false });
  const response = await sync.fetch(new Request('http://localhost/_zb/sync/live?since=0&peer=slow'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Two hundred writes while the page reads nothing.
  for (let i = 0; i < 200; i++) await sync.write('menu', `k${i}`, { name: `n${i}` });
  const reader = response.body.getReader();
  let events = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    events += (new TextDecoder().decode(value).match(/event: changes/g) ?? []).length;
  }
  assert.ok(events < 200, `the stream ended after ${events} change events, not holding all 200`);
});

test("Node's handle() writes the stream only as fast as the connection takes it", { timeout: 20_000 }, async () => {
  const log = countedLog();
  const sync = createSyncServer({ log, authorize: allowReads(['menu']), warn: false });
  const server = createServer((req, res) => sync.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A client that opens the stream and then stops reading from its socket.
  const req = request({ host: '127.0.0.1', port: server.address().port, path: '/_zb/sync/live?since=0&peer=stalled' });
  const opened = new Promise((resolve) => req.on('response', resolve));
  req.end();
  const res = await opened;
  res.pause();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(log.pages < PAGES / 2, `${log.pages} of ${PAGES} pages read for a connection that stopped reading`);
  req.destroy();
  server.close();
});
