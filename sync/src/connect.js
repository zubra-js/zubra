// Tier 1: share 'use collection' documents through a log on a server, so other devices (and
// other people) converge. The store stays the source of truth on the device: writes land there
// first, and go out when the network allows; changes from the log come in and are merged.
//
//   import { connect } from '@zubra/sync/connect';
//   connect({ url: '/_zb/sync' });
//
// The protocol (plan/sync-design.md), plain HTTP so any server can keep the log:
//   POST <url>/push  { changes: [Change] }            → { ok: true }
//   GET  <url>/pull?since=<cursor>[&scope=<json>]      → { changes: [Change], cursor }
//   Change = { collection, key, field, value, clock }  (clock: a hybrid logical clock, a string
//   that sorts by time, then counter, then client id)
//
// Merging is last-writer-wins per field, by clock. A device that was offline pushes what it
// wrote when it's back; whichever write has the later clock wins, on every device alike.
import { onWrite, receive, currentStore, onPresence, receivePresence, peerId, newPeerId, startingPull } from './index.js';

const CLOCKS = '$clocks';
const pad = (number, width) => String(number).padStart(width, '0');

/** How far ahead of this device a clock it hears can be before it stops following it. */
const MAX_SKEW = 60_000;

/** A device's hybrid logical clock (exported for tests). */
export function deviceClock(client) {
  let last = 0;
  let counter = 0;
  const tick = (seen = 0) => {
    let now = Math.max(Date.now(), last, seen);
    counter = now === last ? counter + 1 : 0;
    // Five digits of counter; past them, the next millisecond (a clock must compare as a string).
    if (counter > 99_999) {
      now += 1;
      counter = 0;
    }
    last = now;
    return `${pad(now, 15)}-${pad(counter, 5)}-${client}`;
  };
  // A stamp far in the future (a device with a wrong clock, or one sent to poison the log) isn't
  // followed: this device's writes keep its own time, and the server refuses such stamps anyway.
  const see = (stamp) => {
    const time = Number(stamp.slice(0, 15));
    return tick(time > Date.now() + MAX_SKEW ? 0 : time);
  };
  return { tick, see };
}

const remember = (name, fallback) => {
  try { return localStorage.getItem(name) ?? fallback(); } catch { return fallback(); }
};
const keep = (name, value) => { try { localStorage.setItem(name, value); } catch {} };

/**
 * Start sharing. `url`: where the log is (`/_zb/sync`). `interval`: how often to pull, in ms
 * (default 2000). `scope`: only what this page shows, per collection `true` or a key prefix (or a
 * list of them), e.g. `{ seats: 'showing-12/', brands: true }`; leave it out for everything.
 * Returns `{ flush, pull, stop }`.
 */
export function connect({ url = '/_zb/sync', interval = 2000, live = true, webrtc = false, scope = null, write = true } = {}) {
  const base = url.replace(/\/$/, '');
  // The scope goes with every pull and live request. Each scope keeps its own cursor: a page that
  // moves to another showing reads that showing from the start, not from where the last one was.
  const scoped = scope ? `&scope=${encodeURIComponent(JSON.stringify(scope))}` : '';
  const cursorName = scope ? `zubra-sync:cursor:${JSON.stringify(scope)}` : 'zubra-sync:cursor';
  const client = remember('zubra-sync:client', () => {
    const id = Math.random().toString(36).slice(2, 10);
    keep('zubra-sync:client', id);
    return id;
  });
  const clocks = deviceClock(client);
  let cursor = remember(cursorName, () => '0');
  // This device's stamps, kept here the moment a field is edited. Storing them beside the document
  // takes an await, and a change from elsewhere merged in that time must still lose to them.
  const mine = new Map(); // JSON [collection, key] → { field: clock }
  const newest = (a, b) => (a && (!b || a > b) ? a : b);
  const own = ({ collection, key, field, clock: stamp }) => {
    const id = JSON.stringify([collection, key]);
    if (!mine.has(id)) mine.set(id, {});
    mine.get(id)[field] = newest(stamp, mine.get(id)[field]);
  };

  // Local writes: stamped here, as they're made (their clocks are the write's own); queued and
  // pushed by push.js, which a page that writes loads as it connects. `write: false` (a page whose
  // server lets it read only): it isn't loaded, and edits stay on this device unsent.
  let pusher = null;
  const waiting = []; // stamped before push.js was here
  const off = write
    ? onWrite((collection, key, fields) => {
        const changes = Object.entries(fields).map(([field, value]) => {
          const change = { collection, key, field, value, clock: clocks.tick() };
          own(change);
          return change;
        });
        if (pusher) pusher.add(changes);
        else waiting.push(...changes);
      })
    : () => {};
  const pushing = write
    ? import('./push.js').then(({ pushes }) => {
        pusher = pushes(base);
        if (waiting.length) pusher.add(waiting.splice(0));
        return pusher;
      })
    : null;
  const flush = () => (pusher ? pusher.flush() : Promise.resolve());

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

  // Changes are applied one batch at a time, in the order they arrived.
  let applying = Promise.resolve();
  const apply = (body) => (applying = applying.then(() => merge(body)).catch(() => {}));

  async function merge(body) {
    // By document: apply the fields whose clock beats the one stored here.
    const byDoc = new Map();
    for (const change of body.changes) {
      if (change.clock.endsWith(`-${client}`)) continue;
      clocks.see(change.clock);
      const id = JSON.stringify([change.collection, change.key]);
      if (!byDoc.has(id)) byDoc.set(id, []);
      byDoc.get(id).push(change);
    }
    for (const [id, changes] of byDoc) {
      const { collection, key } = changes[0];
      const doc = (await currentStore().get(collection, key)) ?? {};
      // What's stored, and what this device has stamped since that may not be stored yet.
      const known = { ...doc[CLOCKS] };
      for (const [field, stamp] of Object.entries(mine.get(id) ?? {})) known[field] = newest(stamp, known[field]);
      const fields = {};
      for (const change of changes) {
        if (known[change.field] && known[change.field] >= change.clock) continue;
        known[change.field] = change.clock;
        fields[change.field] = change.value;
      }
      // An edit made here while the change was being stored still wins on screen.
      const stillNewer = (field) => field === CLOCKS || !(mine.get(id)?.[field] > known[field]);
      if (Object.keys(fields).length) await receive(collection, key, { ...fields, [CLOCKS]: known }, stillNewer);
    }
    // Never move the cursor back (a live backlog can arrive after a newer push), unless the server
    // says this device's cursor was past the end of its log: then it starts over from what it sent.
    const next = String(body.cursor);
    if (body.reset || !(/^\d+$/.test(next) && /^\d+$/.test(cursor) && Number(next) < Number(cursor))) cursor = next;
    keep(cursorName, cursor);
  }

  // Live: a server-sent event stream brings changes as they're pushed, and other viewers'
  // presence. While it's open there's nothing to poll; while it isn't, polling carries on.
  let source = null;
  let open = false;
  let retry = null;
  // The live stream's secret for this tab's peer id (its `hello`): presence and signals sent as
  // this peer carry it, and a reconnect presents it to keep the peer id.
  let key = '';
  const listen = () => {
    if (!live || typeof EventSource === 'undefined' || stopped) return;
    const at = `${base}/live?since=${encodeURIComponent(cursor)}&peer=${encodeURIComponent(peerId())}${key ? `&key=${key}` : ''}${scoped}`;
    source = new EventSource(at);
    source.addEventListener('open', () => (open = true));
    source.addEventListener('hello', (event) => (key = JSON.parse(event.data).key ?? ''));
    source.addEventListener('changes', (event) => apply(JSON.parse(event.data)));
    source.addEventListener('presence', (event) => {
      const message = JSON.parse(event.data);
      rtc?.sawPeer(message.room, message.peer, message.state);
      receivePresence(message);
    });
    source.addEventListener('signal', (event) => rtc?.receiveSignal(JSON.parse(event.data)));
    source.addEventListener('error', () => {
      // Reconnect from the current cursor (EventSource would reuse the first one).
      const opened = open;
      open = false;
      source?.close();
      source = null;
      clearTimeout(retry);
      if (opened) return void (retry = setTimeout(listen, 1000));
      // It never opened: the server may be down, or (EventSource can't say which) answered 409
      // because another viewer holds this peer id now. Asked once to tell: a 409 means a new id.
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

  // Presence goes straight out, unqueued: an old cursor position is worth nothing later.
  // With webrtc, presence goes over data channels to the peers that have one; the server carries
  // it only while someone in the room doesn't (and always carries goodbyes). webrtc.js is loaded
  // only for a page that asks for it, while the first pull runs; the live stream, which brings the
  // peers and their signals, opens once it's here (below), so none arrives before the mesh. Until
  // then presence goes through the server, as it does to any peer without a channel.
  let rtc = null;
  const meshing =
    webrtc && typeof RTCPeerConnection !== 'undefined'
      ? import('./webrtc.js').then(({ mesh }) => {
          if (stopped) return;
          rtc = mesh({
            self: peerId, // read each time: a tab can be given a new one
            iceServers: webrtc.iceServers ?? [],
            deliver: receivePresence,
            signal: (room, to, data) =>
              fetch(`${base}/signal`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ room, from: peerId(), to, data, key }),
              }).catch(() => {}),
          });
        }, (error) => console.error('@zubra/sync: couldn\'t load webrtc.js; presence goes through the server', error))
      : null;

  const offPresence = onPresence((message) => {
    if (rtc?.send(message) && message.state !== null) return;
    fetch(`${base}/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...message, key }),
      keepalive: message.state === null, // a leave on pagehide still gets there
    }).catch(() => {});
  });
  let stopped = false;

  const loop = setInterval(() => flush().then(() => (open ? undefined : pull())), interval);
  const online = () => flush().then(pull);
  addEventListener('online', online);
  // Components wait for this first pull before applying what's stored (index.js: fresh first).
  // What's still waiting to be sent (push.js) is put back first: a tab that closed with writes
  // queued can leave the stored value behind them.
  const first = (pushing ? pushing.then((started) => (applying = applying.then(started.replay).catch(() => {}))) : Promise.resolve()).then(flush).then(pull);
  startingPull(first);
  first.then(() => meshing).then(listen);
  return {
    flush,
    pull,
    /** The peers presence goes to directly (webrtc), by peer id. */
    direct: () => rtc?.direct() ?? [],
    stop() {
      stopped = true;
      off();
      offPresence();
      rtc?.close();
      source?.close();
      clearTimeout(retry);
      clearInterval(loop);
      pusher?.stop();
      removeEventListener('online', online);
    },
  };
}
