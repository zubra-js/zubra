// A page that only reads: the documents its 'use collection' components show, from the server's
// log, kept current over the live stream. No outbox, no pushes, no presence, no peers: for a page
// whose server lets it read and never write (a menu with live stock, say).
//
//   import { follow } from '@zubra/sync/follow';
//   follow();                     // instead of connect()
//
// An edit made on such a page stays on this device (its store and its other tabs), as it would
// with connect() and a server that refuses it, but it isn't queued or sent: the first one is
// reported in the console, since a page that writes wants connect().
//
// What it reads, and how (the cursor, a scope, last-writer-wins by clock, the live stream and its
// reconnecting), is connect()'s, line for line: sync/test/browser.test.js runs the same reading
// tests against both. A change to one belongs in the other.
import { onWrite, receive, currentStore, peerId, newPeerId, startingPull } from './index.js';

const CLOCKS = '$clocks';
const remember = (name, fallback) => {
  try { return localStorage.getItem(name) ?? fallback(); } catch { return fallback(); }
};
const keep = (name, value) => { try { localStorage.setItem(name, value); } catch {} };

/** Start following. The same options as connect(): `url`, `interval`, `live`, `scope`. Returns `{ pull, stop }`. */
export function follow({ url = '/_zb/sync', interval = 2000, live = true, scope = null } = {}) {
  const base = url.replace(/\/$/, '');
  const scoped = scope ? `&scope=${encodeURIComponent(JSON.stringify(scope))}` : '';
  const cursorName = scope ? `zubra-sync:cursor:${JSON.stringify(scope)}` : 'zubra-sync:cursor';
  let cursor = remember(cursorName, () => '0');

  async function pull() {
    let body;
    try {
      const response = await fetch(`${base}/pull?since=${encodeURIComponent(cursor)}${scoped}`);
      if (!response.ok) return;
      body = await response.json();
    } catch {
      return;
    }
    await apply(body);
  }

  let applying = Promise.resolve();
  const apply = (body) => (applying = applying.then(() => merge(body)).catch(() => {}));

  // Last-writer-wins per field, by clock, as connect() merges (this page writes nothing of its own).
  async function merge(body) {
    const byDoc = new Map();
    for (const change of body.changes) {
      const id = JSON.stringify([change.collection, change.key]);
      if (!byDoc.has(id)) byDoc.set(id, []);
      byDoc.get(id).push(change);
    }
    for (const changes of byDoc.values()) {
      const { collection, key } = changes[0];
      const doc = (await currentStore().get(collection, key)) ?? {};
      const known = { ...doc[CLOCKS] };
      const fields = {};
      for (const change of changes) {
        if (known[change.field] && known[change.field] >= change.clock) continue;
        known[change.field] = change.clock;
        fields[change.field] = change.value;
      }
      if (Object.keys(fields).length) await receive(collection, key, { ...fields, [CLOCKS]: known });
    }
    const next = String(body.cursor);
    if (body.reset || !(/^\d+$/.test(next) && /^\d+$/.test(cursor) && Number(next) < Number(cursor))) cursor = next;
    keep(cursorName, cursor);
  }

  let source = null;
  let open = false;
  let retry = null;
  let key = '';
  let stopped = false;
  const listen = () => {
    if (!live || typeof EventSource === 'undefined' || stopped) return;
    const at = `${base}/live?since=${encodeURIComponent(cursor)}&peer=${encodeURIComponent(peerId())}${key ? `&key=${key}` : ''}${scoped}`;
    source = new EventSource(at);
    source.addEventListener('open', () => (open = true));
    source.addEventListener('hello', (event) => (key = JSON.parse(event.data).key ?? ''));
    source.addEventListener('changes', (event) => apply(JSON.parse(event.data)));
    source.addEventListener('error', () => {
      const opened = open;
      open = false;
      source?.close();
      source = null;
      clearTimeout(retry);
      if (opened) return void (retry = setTimeout(listen, 1000));
      const asking = new AbortController();
      fetch(at, { signal: asking.signal })
        .then((answer) => {
          asking.abort();
          if (answer.status === 409) {
            key = '';
            newPeerId();
          }
        })
        .catch(() => {})
        .finally(() => (retry = setTimeout(listen, 1000)));
    });
  };

  let told = false;
  const off = onWrite((collection) => {
    if (told) return;
    told = true;
    console.warn(`@zubra/sync: this page follows the log (follow()), so its change to "${collection}" stays on this device; connect() sends changes`);
  });
  const loop = setInterval(() => (open ? undefined : pull()), interval);
  addEventListener('online', pull);
  const first = pull();
  startingPull(first);
  first.then(listen);
  return {
    pull,
    stop() {
      stopped = true;
      off();
      source?.close();
      clearTimeout(retry);
      clearInterval(loop);
      removeEventListener('online', pull);
    },
  };
}
