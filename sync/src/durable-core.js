// What a SyncObject is, without Workers' modules: a sync server on the object's storage, its
// `authorize` asked of the object, and a snapshot of the documents for the Worker to render from.
// durable.js wraps this in a DurableObject; tests run it on Node against a stand-in storage.
import { createSyncServer, MOUNT } from './server.js';
import { durableObjectLog } from './durable-log.js';

export { MOUNT };

/**
 * `owner` is the object: its `authorize(…)`, if it has one, decides as `createSyncServer`'s does;
 * without one, pages may neither read nor write.
 * `heartbeat` is shorter than on Node (2 s, not 15): a Durable Object isn't told when a page's
 * connection is cut, only that a keep-alive couldn't be written, which on workerd is the third
 * after the cut. So a crashed page's presence lingers about three keep-alives (6 s). A page that
 * closes normally says it's leaving and is gone at once.
 */
const OPTIONS = new Set(['mount', 'heartbeat', 'device', 'table', 'origins', 'scope', 'maxSkew', 'maxBytes', 'maxChanges', 'authorize', 'allowedHosts']);

export function syncObject(ctx, owner, options = {}) {
  // Every option reaches the server: one dropped here would be a `scope` silently not kept, so
  // each tenant reading every other's documents. A name it doesn't know is a mistake, said now.
  for (const name of Object.keys(options)) {
    if (!OPTIONS.has(name)) throw new Error(`SyncObject: \`${name}\` is not an option (${[...OPTIONS].join(', ')})`);
  }
  // Any Host by default: Cloudflare routes a request to the Worker by its Host, so a rebinding
  // page (a name of its own pointed at Cloudflare's address) never reaches this object.
  const { heartbeat = 2_000, table = 'changes', authorize, allowedHosts = true, ...rest } = options;
  const sync = createSyncServer({
    ...rest,
    allowedHosts,
    log: durableObjectLog(ctx.storage, { table }),
    heartbeat,
    // The object's own authorize, then the options'; without either, no reads and no writes
    // from pages, as createSyncServer does.
    authorize: typeof owner.authorize === 'function' ? (asked) => owner.authorize(asked) : authorize,
  });
  return {
    async fetch(request) {
      return (await sync.fetch(request)) ?? new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    },
    documents: sync.documents,
    write: sync.write,
    /** `{ collection: [{ key, ...fields }] }` for the collections named, or every one: plain data, for RPC. */
    async snapshot(collections = []) {
      const docs = await sync.documents();
      const names = collections.length ? collections : docs.collections();
      return Object.fromEntries(names.map((name) => [name, docs.all(name)]));
    },
  };
}
