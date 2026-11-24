export interface Change {
  collection: string;
  key: string;
  field: string;
  value: unknown;
  /** A hybrid logical clock: `<15-digit ms>-<5-digit counter>-<client id>`. */
  clock: string;
}

export interface Log {
  append(changes: Change[]): Promise<unknown>;
  after(cursor: string, limit?: number): Promise<{ changes: Change[]; cursor: number | string }>;
  /**
   * The cursor after the last change. Optional: with it, a device whose cursor is past the end
   * (the log was replaced) is answered from the start, with `reset: true`.
   */
  head?(): Promise<number>;
}

/** A log in memory. `keep: 'latest'` keeps each field's latest value only. */
export function memoryLog(options?: { keep?: 'all' | 'latest' }): Log;

export interface Documents {
  /** A document's fields (a copy), or undefined when nothing has been written to it. */
  get(collection: string, key: string): Record<string, unknown> | undefined;
  /**
   * Every document in a collection whose key starts with `prefix` (all of them by default), each
   * with its key, in the order they were first written to.
   */
  all(collection: string, prefix?: string): Array<{ key: string } & Record<string, unknown>>;
  /** The collections that have documents, in the order they were first written to. */
  collections(): string[];
}

/** Per collection, `true` (every document) or a key prefix, or a list of them. */
export type Scope = Record<string, true | string | string[]>;

/** A scope from a request's `?scope=` (JSON), or null for everything. Throws on anything else. */
export function parseScope(text: string | null | undefined): Scope | null;
/** Whether a document is in a scope (null is everything). */
export function inScope(scope: Scope | null, collection: string, key: string): boolean;

/** For `createSyncServer({ authorize: allowAnyone })`: every page may read and write everything. */
export const allowAnyone: () => true;

/**
 * For `createSyncServer({ authorize: allowReads(['notes', 'board']) })`: pages may read those
 * collections and write nothing. With no list, every collection.
 */
export function allowReads(collections?: string[]): (asked: { collection: string; write: boolean }) => boolean;

export function createSyncServer(options?: {
  log?: Log;
  /** Default `/_zb/sync`. */
  mount?: string;
  /**
   * Refuse a write, or hide a change from a reader, by returning false. `kind` is what's asked:
   * 'change' (a push), 'presence' (joining or signaling in a document's room; nothing is stored)
   * or 'read' (a change about to be sent to this request). `write` is true for the first two. A
   * 'change' has the `field` and `value` it sets.
   *
   * Without it, pages may neither read nor write: pull and live send them nothing, and every
   * write from a page is refused (403, saying why). `allowReads(['notes'])` opens those
   * collections to reading; `({ write }) => !write` also allows public reads, and `allowAnyone`
   * allows everything to reading and writing. The server's own `write()` is never asked.
   */
  /**
   * How far ahead of the server's clock a pushed change's clock may be, in ms (default 60 000).
   * Further ahead is refused (400): a clock far in the future would win every merge for ever.
   */
  maxSkew?: number;
  authorize?: (from: { request: Request; collection: string; key: string; field?: string; value?: unknown; write: boolean; kind: 'change' | 'presence' | 'read' }) => boolean | Promise<boolean>;
  /** Other origins allowed to push. */
  /**
   * The scope a request may see and write (tenancy: a business's keys under its own prefix), or
   * null for everything. A page's own `scope` can only narrow it; pushes and joins outside it are
   * refused.
   */
  scope?: (from: { request: Request }) => Scope | null | Promise<Scope | null>;
  origins?: string[];
  /**
   * The `Host` names this server answers to, against DNS rebinding (a site whose name is pointed
   * at this machine). An IP address, `localhost`, `*.localhost` and the hosts of `origins` are
   * always answered; `'.app.example'` is that name and every name under it; `true` is any name.
   * Checked when given, and by default with `authorize: allowAnyone` or `allowReads()`, where
   * anyone who reaches the server may read; then another name is refused (403).
   */
  allowedHosts?: string[] | true;
  /**
   * Told, once per collection, when a page read the whole log and was sent none of a collection
   * that has documents (`authorize` refused every read, or `scope` left them all out): to the
   * page that is an empty collection. By default `console.warn` where `process.env.NODE_ENV` is
   * `development`, and nothing elsewhere; `false` turns it off.
   */
  warn?: ((message: string) => void) | false;
  /** How often the live stream sends a keep-alive comment (ms, default 15000). */
  heartbeat?: number;
  /** The server's name in the clocks of its own writes (default `server`). */
  device?: string;
}): {
  fetch(request: Request): Promise<Response | null>;
  /**
   * Every document as the devices merge it (last writer wins, per field), read from the log the
   * first time and kept current after. Its reads are synchronous.
   */
  documents(): Promise<Documents>;
  /**
   * Write fields to a document as the server, with a clock later than any it has seen: to the
   * documents view at once, then to the log and every live page. Resolves to the changes.
   */
  write(collection: string, key: string, fields: Record<string, unknown>): Promise<Change[]>;
  /** Node's http: answers sync requests (streaming the live ones) and resolves true, else false. */
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean>;
};
