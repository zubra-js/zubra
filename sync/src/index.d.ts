/** `let editing = ephemeral(false)`: state a `'use collection'` component doesn't store. */
export function ephemeral<T>(value: T): T;

/** `let cursor = presence({ x: 0, y: 0 })`: state shared live with the document's other viewers, never stored. */
export function presence<T>(value: T): T;

/** `let others = peers()`: the document's other viewers, each `{ peer, ...presence }`. */
export function peers<T extends object = Record<string, unknown>>(): Array<T & { peer: string }>;

/**
 * `let orders = documents('orders', 'kitchen/')`: a collection's documents as a list, each
 * `{ key, ...fields }`, sorted by key and kept current. `prefix` keeps the documents whose key
 * starts with it (a function is followed), and `start` is the list until the store is read: what
 * the server rendered. Read-only: edits go through a `'use collection'` component or the server.
 */
export function documents<T extends object = Record<string, unknown>>(
  collection: string,
  prefix?: string | (() => string),
  start?: ReadonlyArray<T & { key: string }>,
): Array<T & { key: string }>;

/** Where documents live. `set` merges `fields` into the stored document. */
export interface Store {
  get(collection: string, key: string): Promise<Record<string, unknown> | undefined>;
  set(collection: string, key: string, fields: Record<string, unknown>): Promise<void>;
  /** For `documents()`: each stored document of `collection` whose key starts with `prefix`, as `[key, fields]`, by key. */
  all?(collection: string, prefix?: string): Promise<Array<[string, Record<string, unknown>]>>;
}

/** Use another store, before any `'use collection'` element starts. */
export function configure(options: { store?: Store }): void;

/** The default in browsers: one IndexedDB database (`zubra-sync`), one record per document. */
export function indexedDBStore(database?: string): Store;

/** A store in memory, for tests and places without IndexedDB. */
export function memoryStore(): Store;

/** Called by compiled components; not for direct use. */
export function collection(
  name: string,
  keys: string[],
  props: Record<string, unknown>,
  fields: Record<string, { get(): unknown; set(value: unknown): void }>,
  presence?: Record<string, { get(): unknown; set(value: unknown): void }> | null,
  peers?: { get(): unknown; set(value: unknown): void } | null,
): void;
