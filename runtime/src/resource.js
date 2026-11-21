// Async data as signals: `resource(fetcher)`.
//
//   const user = resource(({ signal }) => fetch(`/api/users/${p.id}`, { signal }).then((r) => r.json()))
//   <zb-if test={user.loading}><p>Loading…</p><zb-else><p>{user.value?.name}</p></zb-else></zb-if>
//
// The fetcher runs at once and again whenever a signal it read before its first `await`
// changes (a prop, a state), like an effect. A new run aborts the previous one through the
// `AbortSignal` it was given, and so does the element leaving the document while a run is still
// in flight (it starts again if the element comes back). A result that arrives after a newer
// run started, or after that abort, is dropped, so the value is always the latest request's.
// While a new run is pending the previous value stays (`loading` is true), so the UI doesn't
// flash empty.
// `dispose()` (or `using`, through `Symbol.dispose`) stops it early: the run in flight is
// aborted and nothing re-runs it. Otherwise it lives as long as the scope that created it.
import { State, untrack } from './signal.js';
import { DISPOSE, effect } from './effect.js';
import { current, onMount } from './element.js';


/** Marks a resource, so `<zb-await>` follows its state instead of awaiting it once. */
export const RESOURCE = Symbol.for('zubra.resource');

/**
 * A signal-backed view of async data. `value`, `error`, `loading` and `status` (`"pending"`,
 * `"ready"`, `"error"`) are reactive reads; `refresh()` runs the fetcher again; `then()` makes
 * it awaitable (resolving to the current run's value).
 */
export function resource(fetcher, { initial } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('zubra: resource() takes a function that returns a value or a promise');
  const value = new State(initial);
  const error = new State(undefined);
  const status = new State('pending');
  const version = new State(0);
  let currentRun = null; // the latest run's promise

  // The in-flight run, so disconnect can abort it. Null once the run has settled: moving an
  // element that already has its value doesn't refetch.
  let live = null;
  const stop = effect(() => {
    version.get();
    const controller = new AbortController();
    live = controller;
    let result;
    try {
      result = fetcher({ signal: controller.signal });
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    untrack(() => {
      if (status.get() !== 'pending') status.set('pending');
    });
    const run = Promise.resolve(result).then(
      (resolved) => {
        if (run !== currentRun || controller.signal.aborted) return resolved;
        live = null;
        value.set(resolved);
        error.set(undefined);
        status.set('ready');
        return resolved;
      },
      (thrown) => {
        if (run !== currentRun) throw thrown;
        // An aborted run was replaced or the element left: not an error to show.
        if (controller.signal.aborted) return untrack(() => value.get());
        live = null;
        error.set(thrown);
        status.set('error');
        throw thrown;
      },
    );
    run.catch(() => {}); // reported through `error`
    currentRun = run;
    return () => {
      live = null;
      controller.abort();
    };
  });
  // Pause doesn't run the effect's cleanup, so an in-flight fetch would keep the detached
  // element alive and could still write its result. Abort it here (onMount's cleanup runs on
  // disconnect, before pause) and bump `version` so coming back starts a fresh run.
  if (current) {
    onMount(() => () => {
      if (!live) return;
      live.abort();
      live = null;
      version.set(untrack(() => version.get()) + 1);
    });
  }

  return {
    [RESOURCE]: true,
    get value() { return value.get(); },
    get error() { return error.get(); },
    get status() { return status.get(); },
    get loading() { return status.get() === 'pending'; },
    refresh() { version.set(untrack(() => version.get()) + 1); },
    then(resolve, reject) { return currentRun.then(resolve, reject); },
    dispose: stop,
    [DISPOSE]: stop,
  };
}
