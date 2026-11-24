// Signals mode (experimental): the reactive engine on the TC39 Signals API.
//
// Zubra's own engine (signal.js) is the default. This one is the opt-in: `zubra({ signals: true })`
// in a bundler, `createZubra({ signals: true })` on @zubra/server, `buildRuntime({ signals: true })`,
// each of which puts this file where signal.js would be. In this mode `state()` returns a real
// `Signal.State`, the runtime's `Signal` export is the proposal's whole API, and a browser's native
// `globalThis.Signal` is used when there is one (Zubra's implementation, signal-impl.js, otherwise).
// It implements the same contract as signal.js, which describes it, and every suite runs on both.
// (`plan/decisions/reactive-engine.md` in the project; docs/stability.md.)
import { Signal as Implementation } from './signal-impl.js';

// Only what is the API: a page's element with `id="Signal"` (or `<img name="Signal">`) is
// `globalThis.Signal` too, and a visitor's id would otherwise stop every component (audit 6).
const native = globalThis.Signal;
export const Signal =
  typeof native?.State === 'function' && typeof native.Computed === 'function' && typeof native.subtle?.untrack === 'function' ? native : Implementation;
export const isNative = Signal !== Implementation;
export const { State, Computed } = Signal;
export const { untrack } = Signal.subtle;
const { currentComputed, introspectSources, introspectSinks, Watcher } = Signal.subtle;

export const isState = (value) => value instanceof State;
export const isComputed = (value) => value instanceof Computed;
export const isSignal = (value) => value instanceof State || value instanceof Computed;
export const tracking = () => currentComputed() !== undefined;
export const sources = (value) => introspectSources(value);
export const sinks = (value) => introspectSinks(value);

// @dev
/** Which engine this is, for the DevTools. */
export const engine = 'tc39';
/** The proposal keeps no count of changes. */
export const changes = () => null;
// @dev-end

/**
 * Reactions, flushed by the caller (the proposal's pattern for effects), on a Watcher per root
 * owner: in effect.js an element's effects all hang from its own root scope, so that is a Watcher
 * per element. A Watcher holds what it watches, so one shared by every effect kept each connected
 * element's effects, and so each element, reachable from the page for as long as it was watched.
 * An element connected in a document that is then dropped (an iframe removed, an inert document)
 * is never disconnected, so it was never let go. With a Watcher each, an element's effects are
 * held only by what they read, as in the default engine, and what's left of a dropped document
 * goes with it. (A Watcher per effect would do the same, at half again the cost of adding rows.)
 * `notified` holds a Watcher only from its notify until the next flush reads it.
 */
const OWNER = Symbol('owner');
const WATCHER = Symbol('watcher');

export function reactions(notify) {
  const watchers = new WeakMap(); // root owner → its Watcher
  const notified = new Set();
  const watcherOf = (owner) => {
    let root = owner;
    while (root?.parent) root = root.parent; // effect.js's owner chain
    let watcher = watchers.get(root);
    if (!watcher) {
      watcher = new Watcher(() => {
        if (notified.size === 0) notify();
        notified.add(watcher);
      });
      watchers.set(root, watcher);
    }
    return watcher;
  };
  return {
    create(fn, owner) {
      const reaction = new Computed(() => fn.call(owner));
      reaction[OWNER] = owner;
      reaction[WATCHER] = watcherOf(owner);
      return reaction;
    },
    owner: (reaction) => reaction[OWNER],
    run: (reaction) => untrack(() => reaction.get()),
    watch: (reaction) => reaction[WATCHER].watch(reaction),
    unwatch(...list) {
      // One pass per Watcher, however many of its reactions go (effect.js batches them).
      const by = new Map();
      for (const reaction of list) {
        const watcher = reaction[WATCHER];
        if (!by.has(watcher)) by.set(watcher, []);
        by.get(watcher).push(reaction);
      }
      for (const [watcher, reactions] of by) watcher.unwatch(...reactions);
    },
    pending() {
      const pending = [];
      for (const watcher of notified) {
        pending.push(...watcher.getPending());
        watcher.watch(); // re-armed before they run, so writes made by effects schedule another round
      }
      notified.clear();
      return pending;
    },
  };
}
