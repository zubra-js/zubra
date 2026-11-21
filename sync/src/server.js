import { refusedField } from './fields.js';

// The log that 'use collection' devices share (tier 1). A fetch handler, so it runs on Node
// (through `node(req, res)`), Bun, Deno and workers; the log itself is pluggable, and in memory
// by default. It keeps changes in order and hands them out after a cursor; it doesn't merge:
// every device applies the same last-writer-wins rule to the same changes, so they converge.
//
//   import { createSyncServer } from '@zubra/sync/server';
//   const sync = createSyncServer();
//   const response = await sync.fetch(request);   // a Response, or null if not ours
//
// `authorize({ request, collection, key, write, kind })` may refuse a change or hide one (return
// false). `kind` says what's asked: 'read' (a change being sent to this request), 'change' (one
// it pushed) or 'presence' (joining a document's room, or signaling in it: nothing is stored).
// `write` is true for the last two. A 'change' also has the `field` and `value` it sets, so an
// app can keep fields (or whole collections) for the server alone.
//
// Without `authorize`, pages may neither read nor write: pull and live are refused, as are pushes,
// presence and signals. Say who may see and change
// what; `authorize: allowReads(['notes'])` for collections anyone may read and nobody may write
// (`allowReads()` for every collection, or `({ write }) => !write`), or, for a page everyone may
// edit (a shared board on a trusted network), `authorize: allowAnyone`. The server's own
// `write()` is never asked.
//
// The server can take part too. `await sync.documents()` is every document as the devices see
// it (last writer wins, per field), kept current; `sync.write(collection, key, fields)` writes as
// the server, to the log and to every live page:
//
//   const docs = await sync.documents();
//   const left = docs.get('stock', 'eggs')?.qty ?? 0;   // read and write with no await between,
//   if (left > 0) sync.write('stock', 'eggs', { qty: left - 1 });   // and no request interleaves
//
// Scope: a page asks only for what it shows. `?scope=` on pull and live is JSON, per collection
// `true` or a key prefix (or a list of them): `{ "seats": "showing-12/", "brands": true }`.
// Changes and presence outside it aren't sent. `scope({ request })` imposes one from the server
// (tenancy: each business's keys under its own prefix), which the page's can only narrow; writes
// and joins outside it are refused.
//
// A cursor past the end of the log (the log was replaced, or compacted, or this device's cursor
// is from another log) starts over: pull and live answer from the beginning, with `reset: true`,
// and the device takes the new cursor. Logs that can say where they end have `head()`.
//
// Live: `GET <mount>/live?since=<cursor>&peer=<id>` is a server-sent event stream: `changes` as
// they're pushed, and `presence` from the other viewers (POST <mount>/presence). Subscribers are
// this process's; several server processes need a shared log and a pub/sub between them.
//
// A peer id belongs to the live stream holding it. The stream's first event, `hello`, carries a
// secret `key`; presence and signals sent as that peer must carry it, and a second stream asking
// for a peer id that's held gets it only with the key (`&key=`, a reconnect). So nobody can speak
// as another viewer, leave a room for them, or receive the WebRTC signals meant for them.
//
// On Node, `handle(req, res)` answers sync requests (streaming the live ones) and returns true.

// A Host header is a host and an optional port. Anything else (a path, a query, an empty one)
// would move the URL's path away from the request's: `Host: site/admin` with `GET /public` would
// read as `/admin/public`, past a proxy that allowed `/public`. That's refused (the callers answer
// 400); a request without one (HTTP/1.0) is for localhost.
const HOST = /^(?:[\w.-]+|\[[\da-fA-F:.]+\])(?::\d{1,5})?$/;
const hostOf = (req) => {
  const { host } = req.headers;
  if (host === undefined) return 'localhost';
  if (!HOST.test(host)) throw new TypeError(`not a host: ${JSON.stringify(host)}`);
  return host;
};
export const MOUNT = '/_zb/sync';

/** How long a peer whose stream ended keeps its id for a reconnect with its key (ms). */
const RECONNECT = 60_000;

/**
 * A log in memory: `append(changes)` and `after(cursor)`. `keep: 'latest'` keeps each field's
 * latest value only (a newer clock replaces it and takes the next cursor, an older one is dropped),
 * as `sqliteLog(path, { keep: 'latest' })` does.
 */
export function memoryLog({ keep = 'all' } = {}) {
  if (keep === 'latest') return latestInMemory();
  if (keep !== 'all') throw new TypeError("memoryLog: `keep` is 'all' or 'latest'");
  const changes = [];
  return {
    async append(more) {
      for (const change of more) changes.push(change);
      return changes.length;
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      return { changes: changes.slice(from, from + limit), cursor: Math.min(changes.length, from + limit) };
    },
    head: async () => changes.length,
  };
}

function latestInMemory() {
  const rows = new Map(); // collection, key, field → { change, seq }
  // Sequence order permits a binary search by cursor. Rewrites leave tombstones until compaction.
  let ordered = [];
  let obsolete = 0;
  let seq = 0;
  return {
    async append(more) {
      for (const change of more) {
        const id = JSON.stringify([change.collection, change.key, change.field]);
        const had = rows.get(id);
        if (had && had.change.clock >= change.clock) continue;
        const row = { change: structuredClone(change), seq: ++seq, live: true };
        if (had) {
          had.live = false;
          obsolete++;
        }
        rows.set(id, row);
        ordered.push(row);
      }
      if (obsolete > rows.size) {
        ordered = ordered.filter((row) => row.live);
        obsolete = 0;
      }
      return seq;
    },
    async after(cursor, limit = 1000) {
      const from = Number(cursor) || 0;
      let low = 0;
      let high = ordered.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (ordered[mid].seq <= from) low = mid + 1;
        else high = mid;
      }
      const count = Number(limit);
      const max = Number.isNaN(count) ? 0 : Math.trunc(count);
      let page = [];
      for (let i = low; i < ordered.length; i++) {
        if (max === 0) break;
        if (ordered[i].live) page.push(ordered[i]);
        if (max > 0 && page.length >= max) break;
      }
      if (max < 0) page = page.slice(0, max);
      return { changes: page.map((row) => structuredClone(row.change)), cursor: page.length ? page[page.length - 1].seq : from };
    },
    head: async () => seq,
  };
}

/**
 * A scope from a request's `?scope=`: `{ collection: true | prefix | [prefixes] }`, or null for
 * everything. Throws on anything else.
 */
export function parseScope(text) {
  if (text === null || text === undefined || text === '') return null;
  let scope;
  try {
    scope = JSON.parse(text);
  } catch {
    throw new TypeError('scope is JSON');
  }
  if (scope === null) return null;
  checkScope(scope);
  return scope;
}

function checkScope(scope) {
  const prefix = (each) => typeof each === 'string' && each.length <= 200;
  const ok =
    scope !== null && typeof scope === 'object' && !Array.isArray(scope) && Object.keys(scope).length <= 100 &&
    Object.values(scope).every((each) => each === true || prefix(each) || (Array.isArray(each) && each.length <= 50 && each.every(prefix)));
  if (!ok) throw new TypeError('scope is { collection: true | "key prefix" | ["prefixes"] }');
}

/** Whether a document is in a scope (null is everything). */
export function inScope(scope, collection, key) {
  if (!scope) return true;
  const rule = scope[collection]; // inherited properties (constructor…) are none of these
  if (rule === true) return true;
  if (typeof rule === 'string') return key.startsWith(rule);
  if (Array.isArray(rule)) return rule.some((prefix) => key.startsWith(prefix));
  return false;
}

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// A clock is `<15-digit ms>-<5-digit counter>-<device>`, so clocks compare as strings.
const CLOCK = /^(\d{15})-(\d{5})-[\w-]+$/;
const clock = {
  format: (time, counter, device) => `${String(time).padStart(15, '0')}-${String(counter).padStart(5, '0')}-${device}`,
  /** `{ time, counter }`, or null when it isn't a clock. */
  parse(text) {
    const match = typeof text === 'string' && CLOCK.exec(text);
    return match ? { time: Number(match[1]), counter: Number(match[2]) } : null;
  },
};

// Field names a change can't have: see fields.js (`key`, `$clocks`, `__proto__`, `constructor`, …).
const valid = (change) =>
  change && typeof change.collection === 'string' && typeof change.key === 'string' &&
  !refusedField(change.field) && clock.parse(change.clock) !== null;

/** The largest counter a clock can carry; past it, the clock moves on a millisecond. */
const MAX_COUNTER = 99_999;

/**
 * How documents are read, wherever they're kept: `find(collection, key)` → fields or undefined,
 * `list(collection)` → `[{ key, fields }]`, `names()` → the collections. What a reader gets is a
 * copy, so changing it changes nothing.
 */
export function documentsView({ find, list, names }) {
  return {
    /** A document's fields (a copy), or undefined when nothing has been written to it. */
    get(collection, key) {
      const fields = find(collection, key);
      return fields && structuredClone(fields);
    },
    /**
     * Every document in a collection whose key starts with `prefix` (all of them by default):
     * `[{ key, ...fields }]`, in the order they were first written to.
     */
    all: (collection, prefix = '') =>
      list(collection)
        .filter(({ key }) => key.startsWith(prefix))
        // The key last: nothing in the fields can stand in for it.
        .map(({ key, fields }) => ({ ...structuredClone(fields), key })),
    /** The collections that have documents, in the order they were first written to. */
    collections: () => names(),
  };
}

/** The documents a log describes, merged by each field's latest clock, as every device merges them. */
function documentsOf() {
  const docs = new Map();
  const id = (collection, key) => `${collection}\u0000${key}`;
  return {
    /** Applies a change if its clock is the field's latest; returns what undoes it, if it did. */
    apply(change) {
      // A log written before this check, or past the push handler, must not set a prototype.
      if (refusedField(change?.field)) return null;
      let doc = docs.get(id(change.collection, change.key));
      if (!doc) docs.set(id(change.collection, change.key), (doc = { collection: change.collection, key: change.key, fields: {}, clocks: {} }));
      const known = doc.clocks[change.field];
      if (known && known >= change.clock) return null;
      const had = change.field in doc.fields;
      const before = doc.fields[change.field];
      doc.clocks[change.field] = change.clock;
      doc.fields[change.field] = change.value;
      return () => {
        if (doc.clocks[change.field] !== change.clock) return; // something newer came since: it stands
        if (had) [doc.clocks[change.field], doc.fields[change.field]] = [known, before];
        else delete doc.clocks[change.field], delete doc.fields[change.field];
        if (!Object.keys(doc.fields).length) docs.delete(id(change.collection, change.key));
      };
    },
    view: documentsView({
      find: (collection, key) => docs.get(id(collection, key))?.fields,
      list: (collection) => [...docs.values()].filter((doc) => doc.collection === collection),
      names: () => [...new Set([...docs.values()].map((doc) => doc.collection))],
    }),
  };
}

/** For `createSyncServer({ authorize: allowAnyone })`: every page may read and write everything. */
export const allowAnyone = () => true;

const READS_ONLY = Symbol('allowReads');
/**
 * For `createSyncServer({ authorize: allowReads(['notes', 'board']) })`: pages may read those
 * collections (every collection, with no list), and write nothing.
 */
export function allowReads(collections) {
  if (collections !== undefined && (!Array.isArray(collections) || !collections.every((name) => typeof name === 'string'))) throw new TypeError("allowReads: a list of collection names (['notes', 'board']), or nothing for every collection");
  const readable = collections && new Set(collections);
  const reads = ({ write, collection }) => !write && (!readable || readable.has(collection));
  // (A write it refuses is told why, as with no authorize: nothing here takes writes.)
  reads[READS_ONLY] = true;
  return reads;
}

/** The default, since 6.0: pages read nothing and write nothing until `authorize` says who may. */
const closed = () => false;
const NO_AUTHORIZE = 'This sync server takes no reads or writes from pages until it is told who may access them: pass createSyncServer({ authorize }) (or authorize: allowAnyone, for a page anyone may edit). See docs/sync.md, "Who may read and write".';
const NO_WRITES = 'This sync server takes no writes from pages until it is told who may make them: pass createSyncServer({ authorize }) (or authorize: allowAnyone, for a page anyone may edit). See docs/sync.md, "Who may read and write".';

/** How many of a collection's documents `notice` counts, at most. */
const NOTICE_KEYS = 1000;

// Where there is a `process.env` that says development (Node, Bun, Deno), as @zubra/server
// decides: an unset NODE_ENV is production. A Worker has none: nothing is logged there unless
// `warn` is given.
const development = () => typeof globalThis.process?.env === 'object' && globalThis.process.env.NODE_ENV === 'development';

export function createSyncServer({ log = memoryLog(), mount = MOUNT, authorize: given, scope: serverScope = () => null, origins = [], heartbeat = 15_000, device = 'server', maxSkew = 60_000, maxBytes = 1 << 20, maxChanges = 1000, warn = development() ? (message) => console.warn(message) : false } = {}) {
  if (!/^[\w-]{1,40}$/.test(device)) throw new Error('createSyncServer: `device` names the server in its clocks: letters, digits, - and _');
  if (given !== undefined && typeof given !== 'function') throw new TypeError('createSyncServer: `authorize` is a function ({ request, collection, key, field, value, write, kind }) => boolean');
  const authorize = given ?? closed;
  /** Explain the closed-by-default policy, or preserve the app's own refusal. */
  const refused = (fallback) => json(403, { error: !given ? NO_AUTHORIZE : given[READS_ONLY] ? NO_WRITES : fallback });
  const base = mount.replace(/\/$/, '');
  // Appends, one after another, so the log's order is the order they were made in.
  let appending = Promise.resolve();
  // The server's clock: later than any clock it has seen, so its writes win over what came
  // before them (and lose to what devices write after, as any device's would).
  let lastTime = 0;
  let counter = 0;
  const tick = () => {
    let now = Math.max(Date.now(), lastTime);
    counter = now === lastTime ? counter + 1 : 0;
    // A counter can't outgrow its five digits (the clock would stop comparing as a string).
    if (counter > MAX_COUNTER) {
      now += 1;
      counter = 0;
    }
    lastTime = now;
    return clock.format(now, counter, device);
  };
  /** Whether a clock is further ahead of this server's than `maxSkew`: a device can't push one. */
  const ahead = (stamp) => clock.parse(stamp).time > Date.now() + maxSkew;
  const see = (change) => {
    const { time, counter: seen } = clock.parse(change.clock);
    // One already in the log from before this check (or a log written elsewhere) doesn't drag
    // this server's clock into the future with it.
    if (time > Date.now() + maxSkew) return;
    if (time > lastTime) {
      lastTime = time;
      counter = seen;
    } else if (time === lastTime) {
      counter = Math.max(counter, seen);
    }
  };
  // The documents, built from the log the first time they're asked for, then kept current.
  // While they're being built, what's recorded goes into the view being built too (applying a
  // change twice changes nothing), so nothing that arrives during the read is missed.
  let docs = null;
  let built = null;
  let building = null;
  /** Puts changes in the documents; returns what takes them back out (for a write the log refused). */
  const record = (changes) => {
    const undo = [];
    for (const change of changes) {
      see(change);
      const taken = (docs ?? built)?.apply(change);
      if (taken) undo.push(taken);
    }
    return () => undo.reverse().forEach((take) => take());
  };
  async function documents() {
    if (docs) return docs.view;
    building ??= (async () => {
      built = documentsOf();
      for (let cursor = 0; ; ) {
        const page = await log.after(cursor, 5000);
        for (const change of page.changes) {
          see(change);
          built.apply(change);
        }
        if (!page.changes.length || String(page.cursor) === String(cursor)) break;
        cursor = page.cursor;
      }
      docs = built;
      return built.view;
    })();
    return building;
  }
  // One that fails rejects for its own caller only; the next still runs.
  const append = (changes) => (appending = appending.catch(() => {}).then(() => log.append(changes)));
  // Live subscribers: { peer, request, send(event, data), rooms }.
  const listeners = new Set();
  const encoder = new TextEncoder();
  const roomOf = (room) => {
    const at = room.indexOf('/');
    return at > 0 ? { collection: room.slice(0, at), key: room.slice(at + 1) } : null;
  };
  /**
   * What a request may see: inside the server's scope for it and the page's own, and allowed by
   * authorize. `where` is `{ request, scopes: [server, page] }`.
   */
  const sees = async ({ request, scopes }, collection, key) =>
    scopes.every((scope) => inScope(scope, collection, key)) && (await authorize({ request, collection, key, write: false, kind: 'read' }));
  async function visible(where, changes) {
    // A read is asked once per document in a batch, not once per change: a push of many changes
    // to one document would otherwise cost every live page that many calls to authorize.
    const asked = new Map();
    const shown = [];
    for (const change of changes) {
      const doc = `${change.collection}\u0000${change.key}`;
      if (!asked.has(doc)) asked.set(doc, await sees(where, change.collection, change.key));
      if (asked.get(doc)) shown.push(change);
    }
    return shown;
  }
  /**
   * `warn` (development): a page that read the log from its start and was shown nothing of a
   * collection that has documents. The page can't tell that from an empty collection (and isn't
   * told: whether a document exists may be what `authorize` hides), so its components show their
   * defaults for good, with nothing in its console, no failed request and nothing here. Said once
   * per collection, to whoever runs the server, with which of the two refused: the server's
   * `scope`, or `authorize`. Only for a read from the start (later batches hold other people's
   * changes as a matter of course) and a collection the page's own scope doesn't leave out.
   */
  const noticed = new Set();
  /**
   * What `notice` needs of a read from the start, page by page as it is sent: for each collection,
   * how many documents it has (counted up to NOTICE_KEYS), whether the page's scope and the
   * server's leave any of them in, and which collections the request was shown something of. Not
   * the changes themselves: a stream reading a large log from the start would otherwise hold all
   * of it until the last page, where it holds one page at a time without `warn`.
   */
  const tally = () => ({ collections: new Map(), shown: new Set() });
  function count(seen, [server, page], changes, shown) {
    for (const change of shown) seen.shown.add(change.collection);
    for (const { collection, key } of changes) {
      if (seen.shown.has(collection) || noticed.has(collection)) continue;
      let one = seen.collections.get(collection);
      if (!one) seen.collections.set(collection, (one = { keys: new Set(), page: false, server: false }));
      if (one.keys.size < NOTICE_KEYS) one.keys.add(key);
      one.page ||= inScope(page, collection, key);
      one.server ||= inScope(server, collection, key);
    }
  }
  function notice(request, seen) {
    if (!warn) return;
    for (const [collection, { keys, page, server }] of seen.collections) {
      if (seen.shown.has(collection) || noticed.has(collection) || !page) continue;
      noticed.add(collection);
      const documents = keys.size >= NOTICE_KEYS ? `${NOTICE_KEYS} or more documents` : `${keys.size} document${keys.size === 1 ? '' : 's'}`;
      const path = new URL(request.url).pathname;
      const why = !server ? "the server's `scope` for that request leaves them all out" : given ? '`authorize` refused every read' : `this server was given no \`authorize\`, so pages may read nothing: name what they may read, createSyncServer({ authorize: allowReads(['${collection}']) }), or pass an authorize that decides (docs/sync.md, "Who may read and write")`;
      warn(`@zubra/sync: a page read "${collection}" (GET ${path}) and was sent none of its ${documents}: ${why}. To the page that is an empty collection, so its components show their defaults and nothing says why. If this request shouldn't see them, there is nothing to do (said once per collection; \`warn: false\` turns it off).`);
    }
  }
  /** The server's scope for a request and the page's (`?scope=`), or a Response refusing it. */
  async function scopesOf(request, url) {
    let page;
    try {
      page = parseScope(url.searchParams.get('scope'));
    } catch (error) {
      return json(400, { error: error.message });
    }
    const server = (await serverScope({ request })) ?? null;
    if (server) checkScope(server);
    return [server, page];
  }
  /** Where to read from for a device at `since`: from the start if it's past the end of the log. */
  async function startFrom(since) {
    const head = await log.head?.();
    const at = Number(since);
    if (head === undefined || !/^\d+$/.test(String(since)) || at <= Number(head)) return { since, reset: false };
    return { since: '0', reset: true };
  }
  async function broadcastChanges(changes, cursor) {
    for (const listener of listeners) {
      const mine = await visible(listener, changes);
      // Nothing it may see is nothing to say: an empty event (and its cursor) would tell a page
      // that another business on the log just wrote. Its next real event carries the cursor on.
      if (mine.length) listener.send('changes', { changes: mine, cursor });
    }
  }
  /** The live stream holding a peer id, if any. */
  const holder = (peer) => [...listeners].find((listener) => listener.peer === peer);
  // A peer whose stream ended keeps its id for a while, for its page to reconnect with the key:
  // otherwise whoever asked first in the gap would take the id, and be sent its signals.
  const released = new Map();
  /** The key `peer` speaks with: its stream's, or its stream's that ended within the grace. */
  const keyOf = (peer) => {
    const held = holder(peer);
    if (held) return held.key;
    const kept = released.get(peer);
    if (kept && kept.until > Date.now()) return kept.key;
    released.delete(peer);
    return null;
  };
  /** Whether `key` is the key `peer` speaks with; a peer nobody holds is anyone's. */
  const speaksAs = (peer, key) => {
    const held = keyOf(peer);
    return held === null || (typeof key === 'string' && key === held);
  };
  const newKey = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  async function broadcastPresence(message) {
    const { collection, key } = roomOf(message.room);
    for (const listener of listeners) {
      if (listener.peer === message.peer) continue;
      if (await sees(listener, collection, key)) listener.send('presence', message);
    }
  }
  /** Whether the server's scope lets this request write to (or join) a document. */
  const mayWrite = async (request, collection, key) => inScope((await serverScope({ request })) ?? null, collection, key);
  /** The page's origin, when it's one of `origins`: another site the app lets in. */
  const listed = (request) => {
    const origin = request.headers.get('origin');
    return origin && origins.includes(origin) ? origin : null;
  };
  // A browser's write: from this origin, or from one of `origins`. A browser says where it was
  // sent from in Sec-Fetch-Site and Origin both, and another site is let in only by its Origin.
  const sameOrigin = (request) => {
    const site = request.headers.get('sec-fetch-site');
    if (site === 'same-origin' || site === 'none' || listed(request)) return true;
    if (site) return false;
    const origin = request.headers.get('origin');
    return !origin || origin === new URL(request.url).origin;
  };
  // What lets a page on one of `origins` read the answer (its pulls, its live stream), and send
  // JSON at all: CORS, as the zubra-sync binary gives its --origins. Any other site's page gets
  // none, so its browser keeps every answer from it.
  const cors = (origin) => ({ 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' });

  /**
   * A request's JSON body, read no further than `maxBytes` (1 MiB by default, as the binary): a
   * page's push is small, and a body of any size used to be held in memory before anyone was asked
   * whether it could write at all. Returns `{ value }`, or `{ refused: Response }`.
   */
  async function readJson(request) {
    const tooLarge = () => ({ refused: json(413, { error: `A request body is at most ${maxBytes} bytes; send changes in smaller batches` }) });
    if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge();
    const parts = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          return tooLarge();
        }
        parts.push(value);
      }
    }
    try {
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of parts) bytes.set(part, (at += part.byteLength) - part.byteLength);
      return { value: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      return { refused: json(400, { error: 'Expected JSON' }) };
    }
  }

  async function fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${base}/`)) return null;
    const origin = listed(request);
    // A browser asks before it sends JSON from another site (a preflight): only `origins` are told yes.
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: origin ? cors(origin) : {} });
    const response = await answer(request, url);
    if (!origin) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors(origin))) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  async function answer(request, url) {
    if (!given && ((request.method === 'GET' && (url.pathname === `${base}/pull` || url.pathname === `${base}/live`)) ||
      (request.method === 'POST' && (url.pathname === `${base}/push` || url.pathname === `${base}/presence` || url.pathname === `${base}/signal`)))) return refused('Not yours');
    if (url.pathname === `${base}/push` && request.method === 'POST') {
      if (!sameOrigin(request)) return json(403, { error: 'Cross-site writes are refused' });
      const read = await readJson(request);
      if (read.refused) return read.refused;
      const body = read.value;
      const changes = Array.isArray(body?.changes) ? body.changes : null;
      if (changes && changes.length > maxChanges) return json(413, { error: `A push carries at most ${maxChanges} changes; send them in smaller batches` });
      if (!changes || !changes.every(valid)) return json(400, { error: 'Expected { changes: [{ collection, key, field, value, clock }] }; a field can\'t be named key, $clocks, or a name every object has (__proto__, constructor, toString…)' });
      if (changes.some((change) => ahead(change.clock))) return json(400, { error: "A change's clock is ahead of the server's by more than maxSkew; check the device's time" });
      for (const change of changes) {
        if (!(await mayWrite(request, change.collection, change.key))) return json(403, { error: 'Not yours to change' });
        if (!(await authorize({ request, collection: change.collection, key: change.key, field: change.field, value: change.value, write: true, kind: 'change' }))) return refused('Not yours to change');
      }
      const appended = changes.map(({ collection, key, field, value, clock }) => ({ collection, key, field, value, clock }));
      const cursor = await append(appended);
      record(appended); // once it's logged: the documents never hold what the log doesn't
      await broadcastChanges(appended, cursor);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/presence` && request.method === 'POST') {
      if (!sameOrigin(request)) return json(403, { error: 'Cross-site writes are refused' });
      const read = await readJson(request);
      if (read.refused) return read.refused;
      const message = read.value;
      const room = typeof message?.room === 'string' ? roomOf(message.room) : null;
      const okPeer = typeof message?.peer === 'string' && /^[\w-]{1,40}$/.test(message.peer);
      const okState = message?.state === null || (typeof message?.state === 'object' && !Array.isArray(message.state));
      if (!room || !okPeer || !okState || JSON.stringify(message.state).length > 4096) {
        return json(400, { error: 'Expected { room: "<collection>/<key>", peer, state: {…} | null }' });
      }
      if (!(await mayWrite(request, room.collection, room.key))) return json(403, { error: 'Not yours to join' });
      if (!(await authorize({ request, ...room, write: true, kind: 'presence' }))) return refused('Not yours to join');
      if (!speaksAs(message.peer, message.key)) return json(403, { error: "That peer id is another viewer's" });
      const clean = { room: message.room, peer: message.peer, state: message.state };
      for (const listener of listeners) if (listener.peer === clean.peer) {
        if (clean.state === null) listener.rooms.delete(clean.room);
        else listener.rooms.add(clean.room);
      }
      await broadcastPresence(clean);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/signal` && request.method === 'POST') {
      // WebRTC signaling: an offer, answer or ICE candidate for one peer in a room, delivered on
      // that peer's live stream. The server only passes it on.
      if (!sameOrigin(request)) return json(403, { error: 'Cross-site writes are refused' });
      const read = await readJson(request);
      if (read.refused) return read.refused;
      const message = read.value;
      const room = typeof message?.room === 'string' ? roomOf(message.room) : null;
      const peerOk = (peer) => typeof peer === 'string' && /^[\w-]{1,40}$/.test(peer);
      const dataOk = message?.data && typeof message.data === 'object' && !Array.isArray(message.data) && JSON.stringify(message.data).length <= 16384;
      if (!room || !peerOk(message.from) || !peerOk(message.to) || !dataOk) {
        return json(400, { error: 'Expected { room, from, to, data: {…} }' });
      }
      if (!(await mayWrite(request, room.collection, room.key))) return json(403, { error: 'Not yours to join' });
      if (!(await authorize({ request, ...room, write: true, kind: 'presence' }))) return refused('Not yours to join');
      // Only from a peer with a live stream (it must hear the answer), and only by that stream.
      if (!holder(message.from) || !speaksAs(message.from, message.key)) return json(403, { error: "That peer id is another viewer's" });
      const clean = { room: message.room, from: message.from, to: message.to, data: message.data };
      // To the recipient only if its own scope lets it into the room: a peer id from another
      // business's room gets nothing.
      const to = holder(clean.to);
      if (to && (await sees(to, room.collection, room.key))) to.send('signal', clean);
      return json(200, { ok: true });
    }
    if (url.pathname === `${base}/live` && request.method === 'GET') {
      const peer = url.searchParams.get('peer') ?? '';
      if (!/^[\w-]{0,40}$/.test(peer)) return json(400, { error: 'Bad peer id' });
      // A held peer id goes to a new stream only with the old stream's key (a reconnect, which
      // then replaces it); the key carries over, so what the page sends keeps working.
      const previous = peer ? holder(peer) : null;
      const held = peer ? keyOf(peer) : null;
      if (held !== null && url.searchParams.get('key') !== held) return json(409, { error: "That peer id is another viewer's; pick another" });
      const key = held ?? newKey();
      const scopes = await scopesOf(request, url);
      if (scopes instanceof Response) return scopes;
      const { since, reset } = await startFrom(url.searchParams.get('since') ?? '0');
      let listener;
      let timer;
      const stream = new ReadableStream({
        start: async (controller) => {
          const write = (text) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              close();
            }
          };
          const close = () => {
            if (!listeners.delete(listener)) return;
            clearInterval(timer);
            if (peer) {
              const now = Date.now();
              for (const [id, kept] of released) if (kept.until <= now) released.delete(id);
              released.set(peer, { key, until: now + RECONNECT });
            }
            // A viewer who disconnects leaves every room they were in.
            for (const room of listener.rooms) broadcastPresence({ room, peer, state: null });
            try { controller.close(); } catch {}
          };
          listener = { peer, key, request, scopes, rooms: previous ? new Set(previous.rooms) : new Set(), send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), close, closeQuietly: () => { clearInterval(timer); try { controller.close(); } catch {} } };
          // A reconnect takes over quietly: no goodbye from the stream it replaces.
          if (previous && listeners.delete(previous)) previous.closeQuietly();
          released.delete(peer);
          listeners.add(listener);
          request.signal?.addEventListener('abort', close);
          write('retry: 1000\n\n');
          listener.send('hello', { key });
          // Read the backlog after subscribing, so nothing pushed in between is missed (a change
          // may come twice; applying one twice changes nothing).
          // Page by page: a log longer than one page is sent whole before anything live.
          // (One event even when there's nothing, so the client learns the cursor; no empty event
          // after the last full page.)
          let from = since;
          // From the start of the log, the whole backlog and what of it this stream was shown,
          // for `notice`.
          const whole = warn && String(since) === '0' ? tally() : null;
          for (let first = true; ; first = false) {
            const backlog = await log.after(from);
            if (!backlog.changes.length && !first) break;
            const shown = await visible(listener, backlog.changes);
            if (whole) count(whole, listener.scopes, backlog.changes, shown);
            listener.send('changes', { changes: shown, cursor: backlog.cursor, ...(reset && first ? { reset: true } : {}) });
            if (!backlog.changes.length || String(backlog.cursor) === String(from)) break;
            from = backlog.cursor;
          }
          if (whole) notice(listener.request, whole);
          // Closed, or taken over by a reconnect, while the backlog was read: no keep-alive.
          if (!listeners.has(listener)) return;
          timer = setInterval(() => write(': keep-alive\n\n'), heartbeat);
          timer.unref?.();
        },
        cancel: () => listener?.close(),
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
      });
    }
    if (url.pathname === `${base}/pull` && request.method === 'GET') {
      const scopes = await scopesOf(request, url);
      if (scopes instanceof Response) return scopes;
      const { since, reset } = await startFrom(url.searchParams.get('since') ?? '0');
      const { changes, cursor } = await log.after(since);
      const shown = await visible({ request, scopes }, changes);
      // (Only when this page is the whole log: a longer one comes in several pulls, and the
      // documents this request may see can be in a later one.)
      if (warn && String(since) === '0' && !(await log.after(cursor)).changes.length) {
        const seen = tally();
        count(seen, scopes, changes, shown);
        notice(request, seen);
      }
      return json(200, { changes: shown, cursor, ...(reset ? { reset: true } : {}) });
    }
    return json(404, { error: 'Not found' });
  }

  /** Node's http: answers sync requests (streaming the live ones) and returns true, else false. */
  async function handle(req, res) {
    if (!req.url.startsWith(`${base}/`)) return false;
    let url;
    // A Host header that isn't a host can't make a URL: a 400 before the body is read, not an
    // unhandled rejection that ends the process.
    try { url = new URL(`http://${hostOf(req)}${req.url}`); } catch { res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request'); return true; }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const chunks = [];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Held only up to maxBytes. A body that says it's longer is refused before it's read; one
      // that only turns out longer is read to its end and dropped. Either way the answer is 413.
      const tooLarge = () => {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: `A request body is at most ${maxBytes} bytes; send changes in smaller batches` }));
        req.resume();
        return true;
      };
      if (Number(req.headers['content-length']) > maxBytes) return tooLarge();
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
      }
      if (size > maxBytes) return tooLarge();
    }
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((each) => [name, each]) : [[name, value]])),
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: controller.signal,
    });
    const response = await fetch(request);
    if (!response) return false;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.flushHeaders?.();
    if (!response.body) return res.end(), true;
    const reader = response.body.getReader();
    controller.signal.addEventListener('abort', () => reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {}
    res.end();
    return true;
  }

  /**
   * Write `fields` to a document as the server: to the documents view at once (so a check
   * before it, with no await between, can't be interleaved), then to the log and every live
   * page. Resolves to the changes written.
   */
  async function write(collection, key, fields) {
    if (typeof collection !== 'string' || typeof key !== 'string' || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('sync.write(collection, key, { field: value, … })');
    }
    for (const name of Object.keys(fields)) if (refusedField(name)) throw new TypeError(`sync.write: \`${name}\` can't be a field name`);
    // A server that hasn't read its log yet (it just started, or a Durable Object was evicted)
    // hasn't seen the clocks in it: read it first, so this write comes after all of them. Once
    // the documents exist this doesn't wait, so a check and a write with no await between stay
    // one step.
    if (!docs) await documents();
    const changes = Object.entries(fields).map(([field, value]) => ({ collection, key, field, value, clock: tick() }));
    if (!changes.length) return [];
    // In the documents at once, so a check before this call and the write are one step; taken
    // back out if the log refuses it.
    const undo = record(changes);
    let cursor;
    try {
      cursor = await append(changes);
    } catch (error) {
      undo();
      throw error;
    }
    await broadcastChanges(changes, cursor);
    return changes;
  }

  return { fetch, handle, documents, write };
}
