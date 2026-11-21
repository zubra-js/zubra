// Effects and ownership, built on the engine's reactions (signal.js).
//
// The engine leaves effects and scheduling to this file. It follows the pattern from the Signals
// proposal's README (one set of reactions, flushed in a microtask) and adds what components need:
//
//   effect(fn)        run fn now, re-run it (batched) when what it read changes; returns dispose
//   scope(fn)         an ownership root: effects created inside belong to it
//   flush() / tick()  apply pending re-runs now / await them
//
// Disposal: effect()'s dispose function and every scope are also disposables
// (`[Symbol.dispose]`), so `using` and `DisposableStack` can own them where the browser has
// Explicit Resource Management. Nothing here depends on it. Pausing is not disposal: a paused
// scope resumes; only dispose() (or Symbol.dispose) ends one.
//
// Ownership: an effect created while another effect (or a scope) is running belongs to it. When
// the owner re-runs or is disposed, everything it owns is disposed first, so nothing outlives
// the code that created it.
//
// Pausing: a scope can be paused (an element left the DOM) and resumed (it came back). Paused
// effects are unwatched, so long-lived signals hold no reference to them, but each keeps its
// cached result and the versions it last saw. On resume it is re-validated and re-runs only if
// something it depends on changed while it was away — the engine's re-validation does exactly
// that, so no extra bookkeeping is needed here.
import { untrack, reactions } from './signal.js';

const MAX_ROUNDS = 100;

let owner = null;          // the Effect or Scope currently running
let nextId = 0;
let scheduled = null;      // promise for the pending microtask flush
let flushing = false;

/**
 * `Symbol.dispose`, or, where the engine doesn't have it yet, the symbol TypeScript's downlevel
 * `using` and the polyfills look up (`Symbol.for('Symbol.dispose')`).
 */
export const DISPOSE = Symbol.dispose ?? Symbol.for('Symbol.dispose');

// @dev
/**
 * For the DevTools hook (devtools.js), in development only: `label` is what the effect being
 * created binds (element.js sets it around each binding), `flushed` hears which effects each
 * flush re-ran and how long it took (ms), and `live`, once devtools.js sets it (when the pane
 * connects, so a page that never opens it pays nothing), counts the owners (scopes and effects)
 * and the effects made since then and neither disposed nor garbage-collected. (A removed
 * element's are paused, not disposed, in case it comes back: they leave the count when they're
 * collected.)
 */
export const dev = { label: null, flushed: null, live: null };
let collected = null;
/** Count from now on (devtools.js, on connecting). */
export function countLive() {
  dev.live ??= { owners: 0, effects: 0 };
  collected ??= new FinalizationRegistry((kind) => { dev.live[kind]--; });
  return dev.live;
}

/** The effect a subscriber of a signal is (or whose reaction it is); null for a computed. */
export const effectOf = (sink) => (sink instanceof Effect ? sink : (watcher.owner(sink) ?? null));
// @dev-end

/** The effect or scope currently running, for binders that register work against its owner. */
export const activeOwner = () => owner;

/** True when `node` or an owner above it is paused or disposed. `parent` stays inside this file. */
export function pausedOwner(node) {
  for (let at = node; at; at = at.parent) if (at.paused || at.disposed) return true;
  return false;
}

/** The value `map` holds for the running owner or one above it. */
export function ownerData(map) {
  for (let at = owner; at; at = at.parent) if (map.has(at)) return map.get(at);
  return undefined;
}

const watcher = reactions(() => {
  scheduled ??= new Promise((resolve) => queueMicrotask(() => {
    try { flush(); } finally { scheduled = null; resolve(); }
  }));
});

// Unwatching is batched: disposing or pausing a subtree (removing a list of 1,000 rows), or
// anything inside `batch()`, unwatches everything in one pass over the watcher's signals,
// instead of one pass per effect. Outside a batch it happens at once.
const unwatching = new Set();
let batching = 0;

function unwatchLater(computed) {
  if (batching) unwatching.add(computed);
  else watcher.unwatch(computed);
}

/** Run `fn`, unwatching what it disposes or pauses in one pass at the end. */
export function batch(fn) {
  batching++;
  try {
    return fn();
  } finally {
    if (--batching === 0 && unwatching.size) {
      const all = [...unwatching];
      unwatching.clear();
      for (let i = 0; i < all.length; i += 10000) watcher.unwatch(...all.slice(i, i + 10000));
    }
  }
}

/** Watch again (a resumed effect): if its unwatch is still pending, just cancel that. */
function watchAgain(computed) {
  if (!unwatching.delete(computed)) watcher.watch(computed);
}

function report(error) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
  else console.error(error);
}

// An owner's children are a list through the children themselves (`first`/`last` on the owner,
// `previous`/`next` on each child), in the order they were made: no collection to allocate, for
// the rows and bindings that make up most owners, and O(1) to take one out.
/** `owner`'s children now, in order (a copy: they may change while it's walked). */
export function children(owner) {
  const out = [];
  for (let child = owner.first; child !== null; child = child.next) out.push(child);
  return out;
}

class Owner {
  constructor(parent) {
    this.parent = parent;
    this.first = null;
    this.last = null;
    this.previous = null;
    this.next = null;
    this.disposed = false;
    this.paused = false;
    // @dev
    this.counted = dev.live !== null;
    if (this.counted) {
      dev.live.owners++;
      collected.register(this, 'owners', this);
    }
    // @dev-end
    if (parent) {
      const last = parent.last;
      if (last === null) parent.first = this;
      else { last.next = this; this.previous = last; }
      parent.last = this;
    }
  }

  disposeChildren() {
    let child = this.first;
    if (child === null) return;
    this.first = this.last = null;
    // Taken out of this owner before any is disposed, so whatever their cleanups do to their
    // siblings (dispose one, make another here) doesn't reach this list.
    for (let at = child; at !== null; at = at.next) at.parent = null;
    batch(() => {
      while (child !== null) {
        const next = child.next;
        child.previous = child.next = null;
        child.dispose();
        child = next;
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // @dev
    if (this.counted) {
      dev.live.owners--;
      collected.unregister(this); // (an effect's two registrations: Effect.dispose counted its own)
    }
    // @dev-end
    this.disposeChildren();
    const parent = this.parent;
    if (parent !== null) {
      this.parent = null;
      const { previous, next } = this;
      if (previous === null) parent.first = next;
      else previous.next = next;
      if (next === null) parent.last = previous;
      else next.previous = previous;
      this.previous = this.next = null;
    }
  }

  [DISPOSE]() {
    this.dispose();
  }

  pause() {
    if (this.paused || this.disposed) return;
    this.paused = true;
    if (this.first !== null) batch(() => {
      for (const child of children(this)) child.pause();
    });
  }

  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    // Children may be replaced while their parent resumes, so iterate a snapshot and skip
    // anything that was disposed along the way.
    if (this.first !== null) for (const child of children(this)) if (!child.disposed) child.resume();
  }
}

/** An effect's run, as its reaction calls it (`this` is the effect). */
function compute() {
  this.disposeChildren();
  this.runCleanup();
  const previous = owner;
  owner = this;
  try {
    const result = this.fn();
    this.cleanup = typeof result === 'function' ? result : undefined;
  } finally {
    owner = previous;
  }
}

class Effect extends Owner {
  constructor(fn, parent) {
    super(parent);
    this.id = ++nextId;
    this.cleanup = undefined;
    // @dev
    this.label = dev.label;
    if (this.counted) {
      dev.live.effects++;
      collected.register(this, 'effects', this);
    }
    // @dev-end
    this.fn = fn;
    // The reaction calls `compute` on this effect: one method for every effect, not a closure each.
    this.computed = watcher.create(compute, this);
    watcher.watch(this.computed);
  }

  /** Re-validate: re-runs fn only if a dependency changed since the last run. */
  run() {
    // untrack: if this effect was created inside another effect, the parent must not end up
    // depending on whatever the child reads.
    watcher.run(this.computed);
  }

  runCleanup() {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup) untrack(cleanup);
  }

  dispose() {
    if (this.disposed) return;
    // @dev
    if (this.counted) dev.live.effects--;
    // @dev-end
    super.dispose();
    unwatchLater(this.computed);
    try { this.runCleanup(); } catch (error) { report(error); }
  }

  pause() {
    if (this.paused || this.disposed) return;
    super.pause();
    unwatchLater(this.computed);
  }

  resume() {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    watchAgain(this.computed);
    try { this.run(); } catch (error) { report(error); }
    if (this.first !== null) for (const child of children(this)) if (!child.disposed) child.resume();
  }
}

class Scope extends Owner {
  run(fn) {
    const previous = owner;
    owner = this;
    try { return fn(); } finally { owner = previous; }
  }
}

/**
 * Run `fn` now and again whenever a signal it read changes. Re-runs are batched: any number of
 * writes in one task cause one re-run, in a microtask. `fn` may return a cleanup function, which
 * runs before the next run and on dispose. Errors thrown by re-runs are reported, not thrown, so
 * one failing effect doesn't stop the others; an error in the first run is thrown to the caller.
 */
export function effect(fn) {
  const e = new Effect(fn, owner);
  e.run(); // if this throws, the effect stays registered and re-runs when its dependencies change
  const dispose = () => e.dispose();
  dispose[DISPOSE] = dispose;
  return dispose;
}

/**
 * Create an ownership root and run `fn` inside it. Returns the scope, whose `dispose()`,
 * `pause()` and `resume()` apply to every effect created within (now or by later `run()` calls).
 */
export function scope(fn) {
  const s = new Scope(owner);
  if (fn) s.run(fn);
  return s;
}

/**
 * Like `scope`, but owned by nothing and untracked: for something whose life isn't the running
 * effect's (an element, which lives as long as it's in the document, even when an effect's run
 * inserted it).
 */
export function root(fn) {
  const s = new Scope(null);
  if (fn) untrack(() => s.run(fn));
  return s;
}

/** Apply all pending re-runs synchronously, parents before children. */
export function flush() {
  if (flushing) return;
  flushing = true;
  // @dev
  const ran = [];
  const started = performance.now();
  // @dev-end
  try {
    for (let round = 0; ; round++) {
      const pending = watcher.pending();
      if (pending.length === 0) {
        // @dev
        if (ran.length) dev.flushed?.(ran, performance.now() - started);
        // @dev-end
        return;
      }
      if (round >= MAX_ROUNDS) {
        report(new Error('zubra: effects keep re-triggering each other; stopped after 100 rounds'));
        return;
      }
      const effects = pending.map((computed) => watcher.owner(computed)).sort((a, b) => a.id - b.id);
      for (const e of effects) {
        if (e.disposed || e.paused) continue;
        try { e.run(); } catch (error) { report(error); }
        // @dev
        ran.push(e);
        // @dev-end
      }
    }
  } finally {
    flushing = false;
  }
}

/** Resolves once pending re-runs have been applied. */
export const tick = () => scheduled ?? Promise.resolve();
