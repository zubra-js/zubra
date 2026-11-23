// @zubra/sync: a component's state as a document in a local store.
//
//   <script>
//     'use collection tasks';
//     import { ephemeral } from '@zubra/sync';
//     let completed = false;             // stored: a field of the document
//     let editing = ephemeral(false);    // not stored
//   </script>
//   <task-item doc="">…</task-item>      <!-- <task-item doc="t42"> is the document tasks/t42 -->
//
// The compiler turns the directive into one call, `collection("tasks", ["doc"], $p, { completed })`,
// at the end of the component's setup. This module does the rest, with the platform's pieces only:
//
// - a write is a signal assignment, so the UI never waits; the store catches up behind it;
// - the store is IndexedDB (in memory where there's none), so state survives reloads, offline;
// - other elements showing the same document, in this tab or another (BroadcastChannel), follow.
//
// Tier 0 of plan/sync-design.md: one device, no server. Merging is last-writer-wins per field.
import { effect, onUnmount, raw, Signal, state } from '@zubra/runtime';
import { refusedField } from './fields.js';

/** `let editing = ephemeral(false)`: state the collection doesn't store. */
export const ephemeral = (value) => value;
/**
 * `let cursor = presence({ x: 0, y: 0 })`: state shared live with the document's other viewers
 * (other tabs; other devices when connected), never stored. The compiler passes it on.
 */
export const presence = (value) => value;
/** `let others = peers()`: the document's other viewers' presence, `[{ peer, ...state }]`. */
export const peers = () => [];

let store = null;
/** Use another store (`{ get(collection, key), set(collection, key, fields) }`), before elements start. */
export function configure(options = {}) {
  if (options.store) store = options.store;
}
const theStore = () => (store ??= typeof indexedDB === 'undefined' ? memoryStore() : indexedDBStore());

// What a connection (connect.js) listens to: every local save, with the fields it changed.
const writers = new Set();
/** @internal Called with `(collection, key, fields)` on each local save. */
export const onWrite = (fn) => (writers.add(fn), () => writers.delete(fn));
/**
 * @internal A change from elsewhere: store it, and show it in this tab and the others. `keep(field)`
 * is asked again before showing it: a field edited here while it was being stored isn't shown.
 */
export async function receive(collection, key, fields, keep = () => true) {
  await theStore().set(collection, key, fields);
  const shown = Object.fromEntries(Object.entries(fields).filter(([field]) => keep(field)));
  deliver(collection, key, shown, null);
  channel?.postMessage({ collection, key, fields: shown });
}
/** @internal The store in use. */
export const currentStore = () => theStore();

// Fresh first: a page connected to a log reads it before a component applies what this device
// stored last time, so a returning visitor never sees last visit's state over the server's (or
// over a page the server just rendered). Offline, the pull fails at once and stored values show.
const FRESH_WAIT = 1500; // and never longer than this
let firstPull = null;
/** @internal connect() hands over its first pull, as it starts. */
export const startingPull = (pull) => {
  firstPull = Promise.resolve(pull).catch(() => {});
};
/**
 * Before reading a stored document: wait until the page's own scripts have run (they finish before
 * DOMContentLoaded, and connect() is one of them), then for the first pull if there is a connection.
 */
const fresh = () =>
  scriptsDone().then(() => (firstPull ? Promise.race([firstPull, new Promise((done) => setTimeout(done, FRESH_WAIT))]) : undefined));
let scripts = null;
const scriptsDone = () =>
  (scripts ??= (() => {
    if (typeof document === 'undefined' || document.readyState === 'complete') return Promise.resolve();
    // Navigation timing says whether DOMContentLoaded has already started (readyState is
    // 'interactive' both while module scripts run and after).
    const navigation = globalThis.performance?.getEntriesByType?.('navigation')?.[0];
    if (navigation && navigation.domContentLoadedEventStart > 0) return Promise.resolve();
    return new Promise((done) => {
      document.addEventListener('DOMContentLoaded', done, { once: true });
      setTimeout(done, FRESH_WAIT);
    });
  })());

// Every bound element, by document, so a write reaches the others (this tab and, below, others).
const bound = new Map();
const docId = (collection, key) => `${collection}\u0000${key}`;
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('zubra-sync');
// Outside a browser (Node, a test), an open channel would keep the process from exiting.
channel?.unref?.();
channel?.addEventListener('message', ({ data }) =>
  data.kind === 'presence' ? receivePresence(data) : deliver(data.collection, data.key, data.fields, null));

// Presence: each tab is one peer per document ("room"). What it sends goes to the other tabs
// (BroadcastChannel) and, through a connection, to other devices; nothing is stored.
let tab = Math.random().toString(36).slice(2, 10);
const rooms = new Map(); // room → Set of (peer, state) handlers
const presenceSenders = new Set();
const joined = new Map(); // room → this tab's presence there, to leave on pagehide (or say again)
/** @internal Called with `{ room, peer, state }` for each presence this tab sends (state null: left). */
export const onPresence = (fn) => (presenceSenders.add(fn), () => presenceSenders.delete(fn));
/** @internal This tab's peer id. */
export const peerId = () => tab;
/**
 * @internal A new peer id for this tab, when the server says another viewer holds this one (the
 * tab was away longer than the server keeps an id for its key). Its presence is said again as the
 * new peer, so the others see it come back.
 */
export function newPeerId() {
  tab = Math.random().toString(36).slice(2, 10);
  for (const [room, state] of [...joined]) sendPresence(room, state);
  return tab;
}
/** @internal Presence from elsewhere. */
export function receivePresence({ room, peer, state }) {
  if (peer === tab) return;
  for (const handler of rooms.get(room) ?? []) handler(peer, state);
}
/** Stop handing `room`'s presence to `handler`; a room no one here is in is forgotten. */
function leaveRoom(room, handler) {
  const handlers = rooms.get(room);
  if (handlers?.delete(handler) && handlers.size === 0) rooms.delete(room);
}
function sendPresence(room, state) {
  const message = { room, peer: tab, state };
  if (state === null) joined.delete(room);
  else joined.set(room, state);
  channel?.postMessage({ kind: 'presence', ...message });
  for (const send of presenceSenders) send(message);
}
if (typeof addEventListener === 'function') {
  addEventListener('pagehide', () => {
    for (const room of [...joined.keys()]) sendPresence(room, null);
  });
}
// Every `documents()` list, by collection: told of each change to a document, whoever made it.
const lists = new Map();
function deliver(collection, key, fields, from) {
  for (const apply of bound.get(docId(collection, key)) ?? []) if (apply !== from) apply(fields);
  // A list is told after the document's own elements, and only what a document can be: a key or
  // fields of another type (a log that isn't Zubra's, another tab's message) stop here, and one
  // list failing never stops the next, or the change going on to the other tabs.
  if (typeof key !== 'string' || !fields || typeof fields !== 'object') return;
  for (const hear of lists.get(collection) ?? []) {
    try {
      hear(key, fields);
    } catch (error) {
      console.error(`@zubra/sync: a documents() list couldn't take ${collection}/${key}`, error);
    }
  }
}

/** Plain JSON of a state value; reading it all also subscribes to every nested change. */
const snapshot = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/**
 * Bind `fields` (the component's state signals, by name) to the document keyed by the `keys`
 * props in `collection`. Called by compiled components.
 */
export function collection(name, keys, props, fields, presenceFields = null, peersSignal = null) {
  const keyOf = () => {
    const parts = keys.map((key) => props[key]);
    return parts.every((part) => part !== undefined && part !== null && part !== '') ? parts.join('/') : null;
  };
  const loaded = new Signal.State(null);
  let current = null;
  let last = null; // each field's JSON as last loaded or saved, so a load isn't written back
  let applying = false;

  const apply = (doc) => {
    if (!doc) return;
    applying = true;
    try {
      for (const [field, signal] of Object.entries(fields)) if (field in doc) signal.set(doc[field]);
    } finally {
      applying = false;
    }
  };
  // Each field's value as JSON text, kept until the field changes: a save re-serialises only the
  // fields that changed, not the whole document (one small edit beside a 10 000-item list was
  // the list written out again, every time). Reading the text subscribes to every nested change.
  const names = Object.keys(fields);
  const texts = Object.fromEntries(names.map((field) => [field, new Signal.Computed(() => JSON.stringify(fields[field].get() ?? null))]));
  /** Each field's current value, as JSON text. */
  const values = () => Object.fromEntries(names.map((field) => [field, texts[field].get()]));
  /** The document's JSON, from its fields' texts. */
  const documentText = (now) => `{${names.map((field) => `${JSON.stringify(field)}:${now[field]}`).join(',')}}`;
  const onRemote = (doc) => {
    apply(doc);
    last = Signal.subtle.untrack(values);
  };

  const join = (key) => {
    const id = docId(name, key);
    if (!bound.has(id)) bound.set(id, new Set());
    bound.get(id).add(onRemote);
  };
  const leave = (key) => {
    const id = docId(name, key);
    bound.get(id)?.delete(onRemote);
    if (bound.get(id)?.size === 0) bound.delete(id);
  };

  // Load the document whenever the key changes.
  effect(() => {
    const key = keyOf();
    if (current !== null) leave(current);
    current = key;
    if (key === null) return;
    join(key);
    let cancelled = false;
    // What the fields hold as loading starts, to tell what someone changed while it loaded.
    const before = Signal.subtle.untrack(values);
    fresh()
      .then(() => theStore().get(name, key))
      .then((doc = {}) => {
        if (cancelled) return;
        // An edit made before the document arrived is newer than it: keep the edit (and save
        // it, below); take the document's values for the rest.
        const now = values();
        const edited = new Set(Object.keys(fields).filter((field) => now[field] !== before[field]));
        apply(Object.fromEntries(Object.entries(doc).filter(([field]) => !edited.has(field))));
        // `last` is what's stored, so the save effect writes exactly the edits.
        last = Object.fromEntries(names.map((field) => [field, field in doc ? JSON.stringify(doc[field] ?? null) : before[field]]));
        loaded.set(key);
      })
      .catch((error) => console.error(`@zubra/sync: couldn't load ${name}/${key}`, error));
    return () => (cancelled = true);
  });

  // Save on every change, once the document is loaded (so the defaults never overwrite it).
  effect(() => {
    const key = keyOf();
    const now = values();
    if (key === null || loaded.get() !== key || applying) return;
    const edited = names.filter((field) => last === null || now[field] !== last[field]);
    if (!edited.length) return;
    last = now;
    // (Parsed from the texts: a copy of the state, as every reader of the document gets.)
    const doc = JSON.parse(documentText(now));
    const changed = Object.fromEntries(edited.map((field) => [field, doc[field]]));
    for (const write of writers) write(name, key, changed);
    theStore()
      .set(name, key, doc)
      .catch((error) => console.error(`@zubra/sync: couldn't save ${name}/${key}`, error));
    deliver(name, key, doc, onRemote);
    channel?.postMessage({ collection: name, key, fields: doc });
  });

  onUnmount(() => current !== null && leave(current));
  if (presenceFields || peersSignal) live(name, keyOf, presenceFields ?? {}, peersSignal);
}

let warnedAll = false;
/**
 * `let orders = documents('orders', 'kitchen/')`: the collection's documents as a list, each
 * `{ key, ...fields }` (what the server's `documents().all()` gives), sorted by key, and kept
 * current: a document that appears is a new item, a field that changes is that item's. With a
 * prefix, only the documents whose key starts with it; a function (`() => \`${board}/\``) is
 * followed when what it reads changes, and while it gives `null` or `undefined` the list is empty. `start` is the list until the store has been read: what
 * the server rendered (the compiler renders it there). The list is for reading: an edit goes
 * through a `'use collection'` component, or the server.
 */
export function documents(name, prefix = '', start = []) {
  // A prefix function that has nothing to give yet (`null`, `undefined`) lists nothing: only
  // `documents('orders')`, written out, is the whole collection.
  const read = () => {
    const now = typeof prefix === 'function' ? prefix() : prefix ?? '';
    return now === null || now === undefined ? null : String(now);
  };
  const entry = (key, fields) => {
    const doc = { key };
    for (const [field, value] of Object.entries(fields)) if (!refusedField(field)) doc[field] = snapshot(value);
    return doc;
  };
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const given = (Array.isArray(start) ? start : []).filter((doc) => doc && typeof doc === 'object' && typeof doc.key === 'string');
  // The reactive array a `let` holds: the component's state wraps the same one.
  const list = state(given.map((doc) => entry(doc.key, doc)).sort(byKey)).get();
  // Where `key` is, or belongs: a binary search of the array itself (not its proxy, which would
  // track every item looked at), since the list is always in key order.
  const find = (key) => {
    const items = raw(list);
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (items[middle].key < key) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const update = (at, fields, skip) => {
    for (const [field, value] of Object.entries(fields)) {
      if (!refusedField(field) && !skip?.has(field)) list[at][field] = snapshot(value);
    }
  };
  const put = (key, fields) => {
    const at = find(key);
    if (raw(list)[at]?.key === key) update(at, fields);
    else list.splice(at, 0, entry(key, fields));
  };
  // The store's documents, which come in key order: fields into the items already here, and the
  // new ones merged in one pass (an insert each would move the rest of the list every time).
  const merge = (stored, changed) => {
    const added = [];
    for (const [key, doc] of stored) {
      if (typeof key !== 'string' || !doc || typeof doc !== 'object' || !key.startsWith(current)) continue;
      const at = find(key);
      if (raw(list)[at]?.key === key) update(at, doc, changed.get(key));
      else added.push(entry(key, doc));
    }
    if (!added.length) return;
    added.sort(byKey);
    const items = raw(list);
    const merged = [];
    let next = 0;
    for (const item of items) {
      while (next < added.length && added[next].key < item.key) merged.push(added[next++]);
      merged.push(item);
    }
    while (next < added.length) merged.push(added[next++]);
    list.splice(0);
    for (let at = 0; at < merged.length; at += 5000) list.push(...merged.slice(at, at + 5000));
  };

  let current = null;
  let heard = null; // while the store is being read: the fields that changed, which are newer than it
  const hear = (key, fields) =>
    Signal.subtle.untrack(() => {
      if (current === null || !key.startsWith(current)) return;
      if (heard) {
        if (!heard.has(key)) heard.set(key, new Set());
        for (const field of Object.keys(fields)) heard.get(key).add(field);
      }
      put(key, fields);
    });
  if (!lists.has(name)) lists.set(name, new Set());
  lists.get(name).add(hear);
  onUnmount(() => {
    lists.get(name)?.delete(hear);
    if (lists.get(name)?.size === 0) lists.delete(name);
  });

  let started = false;
  effect(() => {
    const now = read();
    Signal.subtle.untrack(() => {
      // Another prefix is another list; the first keeps what the page was given under it.
      if (started && current !== now) list.splice(0);
      else if (!started) for (let at = list.length - 1; at >= 0; at--) if (now === null || !list[at].key.startsWith(now)) list.splice(at, 1);
      started = true;
      current = now;
    });
    heard = null;
    if (now === null) return;
    const store = theStore();
    if (typeof store.all !== 'function') {
      if (!warnedAll) console.error(`@zubra/sync: this store has no all(collection, prefix), so documents(${JSON.stringify(name)}) starts with what it was given and only hears changes from now on`);
      warnedAll = true;
      return;
    }
    const changed = (heard = new Map());
    let cancelled = false;
    fresh()
      .then(() => store.all(name, now))
      .then((stored) => {
        if (!cancelled) Signal.subtle.untrack(() => merge(stored ?? [], changed));
      })
      .catch((error) => console.error(`@zubra/sync: couldn't list ${name}/${now}`, error))
      .finally(() => {
        if (heard === changed) heard = null;
      });
    return () => (cancelled = true);
  });
  return list;
}

const PRUNE = 30_000; // a peer not heard from for this long has gone (a crash, a closed laptop)
const HEARTBEAT = 10_000;

/** Send this element's presence to its document's room, and keep `peers` up to date. */
function live(name, keyOf, fields, peersSignal) {
  const others = new Map(); // peer → { state, seen }
  const publish = () =>
    peersSignal?.set([...others.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([peer, { state }]) => ({ ...state, peer })));
  const sending = Object.keys(fields).length > 0;
  const mine = () => Object.fromEntries(Object.entries(fields).map(([field, signal]) => [field, snapshot(signal.get())]));
  let room = null;
  let latest = null;
  let queued = false;
  const flush = () => {
    queued = false;
    if (room !== null && latest !== null) sendPresence(room, latest);
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    // At most once a frame: a pointer moves far more often than anyone can see.
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(flush);
  };
  const onPeer = (peer, state) => {
    const known = others.has(peer);
    if (state === null) others.delete(peer);
    else others.set(peer, { state, seen: Date.now() });
    publish();
    // Someone new: tell them where we are, so they don't wait for our next move.
    if (!known && state !== null && sending) queue();
  };

  effect(() => {
    const key = keyOf();
    const next = key === null ? null : `${name}/${key}`;
    const state = sending ? mine() : null;
    if (next !== room) {
      if (room !== null) {
        leaveRoom(room, onPeer);
        if (sending) sendPresence(room, null);
        others.clear();
        publish();
      }
      room = next;
      if (room !== null) {
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(onPeer);
      }
    }
    if (room !== null && sending) {
      latest = state;
      queue();
    }
  });

  const timer = setInterval(() => {
    if (sending && room !== null && latest !== null) sendPresence(room, latest);
    const now = Date.now();
    let pruned = false;
    for (const [peer, { seen }] of others) if (now - seen > PRUNE) pruned = others.delete(peer) || pruned;
    if (pruned) publish();
  }, HEARTBEAT);

  onUnmount(() => {
    clearInterval(timer);
    if (room !== null) {
      leaveRoom(room, onPeer);
      if (sending) sendPresence(room, null);
    }
  });
}

/** A store in memory: for servers, tests, and browsers without IndexedDB. */
export function memoryStore() {
  const docs = new Map();
  return {
    async get(collection, key) {
      const doc = docs.get(docId(collection, key));
      return doc ? structuredClone(doc) : undefined;
    },
    async set(collection, key, fields) {
      const id = docId(collection, key);
      docs.set(id, { ...docs.get(id), ...structuredClone(fields) });
    },
    async all(collection, prefix = '') {
      const from = docId(collection, prefix);
      return [...docs]
        .filter(([id]) => id.startsWith(from))
        .map(([id, doc]) => [id.slice(collection.length + 1), structuredClone(doc)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
}

/** The default store: one IndexedDB database, one record per document, fields merged on write. */
export function indexedDBStore(database = 'zubra-sync') {
  let opening = null;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('docs');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const run = async (mode, work) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('docs', mode);
      const docs = transaction.objectStore('docs');
      let result;
      work(docs, (value) => (result = value));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      // A handler that throws aborts the transaction with neither of those: say so, not nothing.
      transaction.onabort = () => reject(transaction.error ?? new Error('@zubra/sync: the store\'s transaction was aborted'));
    });
  };
  return {
    get: (collection, key) =>
      run('readonly', (docs, done) => {
        const request = docs.get([collection, key]);
        request.onsuccess = () => done(request.result);
      }),
    set: (collection, key, fields) =>
      run('readwrite', (docs) => {
        const request = docs.get([collection, key]);
        request.onsuccess = () => docs.put({ ...request.result, ...fields }, [collection, key]);
      }),
    all: (collection, prefix = '') =>
      run('readonly', (docs, done) => {
        const found = [];
        done(found);
        // Keys are [collection, key], in order: from the prefix on, until a key without it.
        const request = docs.openCursor(IDBKeyRange.bound([collection, prefix], [`${collection}\u0000`], false, true));
        request.onsuccess = () => {
          const cursor = request.result;
          // (A key that isn't a string, which only a log that isn't Zubra's could have sent, sorts
          // after every string: nothing of this prefix follows it.)
          if (!cursor || typeof cursor.key[1] !== 'string' || !cursor.key[1].startsWith(prefix)) return;
          found.push([cursor.key[1], cursor.value]);
          cursor.continue();
        };
      }),
  };
}
