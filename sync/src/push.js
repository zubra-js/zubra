// What a page that writes adds to connect(): its outbox (kept in localStorage, so writes made
// offline outlive the tab), pushes in batches the server takes, and putting back what was waiting
// when the page opens. connect() loads it unless told `write: false`; it stamps the writes itself.
import { receive, currentStore } from './index.js';

const CLOCKS = '$clocks';
const remember = (name, fallback) => {
  try { return localStorage.getItem(name) ?? fallback(); } catch { return fallback(); }
};
const keep = (name, value) => { try { localStorage.setItem(name, value); } catch {} };

/**
 * @internal Changes split into pushes of at most `count` changes and about `bytes` bytes of JSON,
 * under the server's default limits (1000 changes, 1 MiB), keeping their order.
 */
export function batches(changes, { count = 500, bytes = 512 * 1024 } = {}) {
  const out = [];
  let batch = [];
  let size = 0;
  for (const change of changes) {
    const length = JSON.stringify(change).length + 1;
    if (batch.length && (batch.length >= count || size + length > bytes)) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(change);
    size += length;
  }
  if (batch.length) out.push(batch);
  return out;
}

/**
 * @internal The changes waiting to be pushed. A push takes a snapshot (`take`), and when the
 * server has it, exactly those changes leave (`done`): by identity, not by count, so a change
 * added while an earlier push was out is never dropped by it. Two pushes can overlap (the debounce
 * and the poll loop); this is why that's safe.
 *
 * It keeps one change per field: a newer one replaces what's waiting for the same field (this
 * device's later write wins anyway), so hours of typing offline wait as one change per field,
 * not one per keystroke, and still fit in localStorage.
 */
export function outboxOf(changes = [], persist = () => {}) {
  const same = (a, b) => a.collection === b.collection && a.key === b.key && a.field === b.field;
  let pending = [];
  for (const change of changes) pending = [...pending.filter((other) => !same(other, change)), change];
  return {
    get size() {
      return pending.length;
    },
    pending: () => pending.slice(),
    add(change) {
      pending = pending.filter((other) => !same(other, change));
      pending.push(change);
      persist(pending);
    },
    take: () => pending.slice(),
    done(sent) {
      const gone = new Set(sent);
      pending = pending.filter((change) => !gone.has(change));
      persist(pending);
    },
  };
}

/** @internal The pushing half of a connection to the log at `base`. */
export function pushes(base) {
  const outbox = outboxOf(JSON.parse(remember('zubra-sync:outbox', () => '[]')), (pending) =>
    keep('zubra-sync:outbox', JSON.stringify(pending)));
  let timer = null;
  let warned = false;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 30);
  };

  /** Stamped changes from this device: queued, their clocks kept beside the document, sent soon. */
  async function add(changes) {
    const stamped = {};
    for (const change of changes) {
      stamped[change.field] = change.clock;
      outbox.add(change);
    }
    const { collection, key } = changes[0];
    const doc = (await currentStore().get(collection, key)) ?? {};
    await currentStore().set(collection, key, { [CLOCKS]: { ...doc[CLOCKS], ...stamped } });
    schedule();
  }

  async function flush() {
    if (!outbox.size) return;
    // In batches the server takes (at most 1000 changes or 1 MiB a push by default), so a device
    // back from hours offline with a long outbox still gets it all through.
    for (const sending of batches(outbox.take())) if (!(await send(sending))) return;
  }

  /** Push one batch. True when the server has it. */
  async function send(sending) {
    try {
      const response = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: sending }),
      });
      if (!response.ok) {
        // A refused write is kept (it may be allowed later), but say why once: a server with no
        // `authorize` refuses every write from pages, and a silent outbox looks like a bug.
        if (response.status === 403 && !warned) {
          warned = true;
          const why = await response.json().then((body) => body?.error, () => '');
          console.warn(`@zubra/sync: the server refused this page's changes${why ? `: ${why}` : ''}`);
        }
        return false;
      }
      outbox.done(sending);
      return true;
    } catch {
      // Offline: the outbox stays (in localStorage too), and goes with the next flush.
      return false;
    }
  }

  // What's still waiting to be sent is newer than what's stored wherever the store says otherwise:
  // a tab that closed with writes queued can leave the stored value behind the outbox.
  async function replay() {
    const byDoc = new Map();
    for (const change of outbox.pending()) {
      const id = JSON.stringify([change.collection, change.key]);
      byDoc.set(id, [...(byDoc.get(id) ?? []), change]);
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
  }

  return { add, flush, replay, stop: () => clearTimeout(timer) };
}
