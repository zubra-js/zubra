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

/** Reactions on one Watcher, flushed by the caller (the proposal's own pattern for effects). */
const OWNER = Symbol('owner');

export function reactions(notify) {
  const watcher = new Watcher(notify);
  return {
    create(fn, owner) {
      const reaction = new Computed(() => fn.call(owner));
      reaction[OWNER] = owner;
      return reaction;
    },
    owner: (reaction) => reaction[OWNER],
    run: (reaction) => untrack(() => reaction.get()),
    watch: (reaction) => watcher.watch(reaction),
    unwatch: (...list) => watcher.unwatch(...list),
    pending() {
      const pending = watcher.getPending();
      watcher.watch(); // re-arm before running, so writes made by effects schedule another round
      return pending;
    },
  };
}
