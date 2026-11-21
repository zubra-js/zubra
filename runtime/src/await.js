// zb-await: a part with `binder: $await` (interface 4).

import { clearBetween, hydratable, mountBlock } from './blocks.js';
import { effect, pausedOwner, scope } from './effect.js';
import { $r, matchingClose } from './element.js';
import { RESOURCE } from './resource.js';
import { State, Computed, untrack } from './signal.js';

/**
 * zb-await: the pending block while the value is a promise (anything with `then`), then the
 * `zb-then` block with the resolved value, or the `zb-catch` block with the error. A value
 * that isn't a promise shows `zb-then` at once. Only the latest value's outcome is shown. A
 * `resource()` is followed through its states, so reloading it shows the pending content again.
 *
 * - An array value waits for every promise and resource in it, as `Promise.all` does, and
 *   resolves to the array of their values (4.2).
 * - `zb-catch` gets `retry()`: it refreshes the resources and evaluates the value again, so a
 *   `load()` call is made again (4.2).
 * - `delay`: the pending block shows only once the value has been pending that long; until
 *   then the previous content stays (4.2).
 * - `keep`: once settled, a reload keeps the settled content, and the host has
 *   `:state(loading)` while it runs (4.2).
 */
const loadingCounts = new WeakMap();

function markLoading(states, step) {
  if (!states) return;
  const count = (loadingCounts.get(states) ?? 0) + step;
  loadingCounts.set(states, count);
  states[count > 0 ? 'add' : 'delete']('loading');
}

export function bindAwait(part, open, hydrating, context) {
  hydrating = hydratable(open, hydrating);
  const close = matchingClose(open);
  let first = hydrating;
  let latest = null;
  let settled = false; // a zb-then or zb-catch block is showing
  const attempt = new State(0);
  // Bumped when a promise settles while the element is paused, so resume re-runs this effect
  // and shows the outcome. Pause does not run the effect's cleanup, and the promise is not one
  // of its dependencies, so without this the result would mount into a detached tree — and the
  // effects that mount creates would stay subscribed, retaining the element.
  const wake = new State(0);
  // The value, evaluated again only when what it reads changes or retry() asks: a resource
  // settling re-runs the effect below, and mustn't call `load()` again.
  const current = new Computed(() => (attempt.get(), $r(part.await())));
  const retry = () => {
    for (const value of [].concat(untrack(() => current.get()))) $r(value)?.[RESOURCE] && $r(value).refresh();
    attempt.set(untrack(() => attempt.get()) + 1);
  };
  effect(() => {
    wake.get();
    const value = current.get();
    const many = Array.isArray(value);
    const token = (latest = {});
    // Blocks mounted later (when the promise settles) still belong to this run.
    const owner = scope();
    let timer;
    let loading = 0;
    const defer = () => wake.set(untrack(() => wake.get()) + 1);
    const show = (index, payload) => {
      if (latest !== token || owner.disposed) return;
      if (pausedOwner(owner)) return defer();
      untrack(() => owner.run(() => {
        clearTimeout(timer);
        const block = part.blocks[index];
        const hydrate = first; // the server rendered this branch, unless it left the region to us
        first = false;
        settled = index > 0;
        if (block) mountBlock(block, index ? [new State(payload), new State(retry)] : [], open, close, hydrate, context);
        else clearBetween(open, close);
      }));
    };
    const done = (index, payload) => {
      if (latest !== token || owner.disposed) return;
      if (pausedOwner(owner)) return defer();
      if (loading) markLoading(context?.states, (loading = 0) - 1);
      show(index, payload);
    };
    // Each value: a resource's state, a promise, or a plain value.
    let pending = false;
    let failed;
    const promises = (many ? value : [value]).map((item) => {
      item = $r(item);
      if (item?.[RESOURCE]) {
        const status = item.status;
        if (status === 'error') failed ??= [item.error];
        pending ||= status === 'pending';
        return item.value;
      }
      if (item !== null && (typeof item === 'object' || typeof item === 'function') && typeof item.then === 'function') {
        pending = true;
        return item;
      }
      return item;
    });
    if (failed) done(2, failed[0]);
    else if (pending) {
      const delay = part.delay ? Number(untrack(part.delay)) : 0;
      if (part.keep && settled) markLoading(context?.states, (loading = 1));
      else if (delay > 0 && !first) timer = setTimeout(() => show(0), delay);
      else show(0);
      // A pending resource re-runs this effect when it settles; promises are waited for here.
      if (!(many ? value : [value]).some((item) => $r(item)?.[RESOURCE] && $r(item).status === 'pending')) {
        Promise.all(promises).then((resolved) => done(1, many ? resolved : resolved[0]), (error) => done(2, error));
      }
    } else done(1, many ? promises : promises[0]);
    return () => {
      clearTimeout(timer);
      if (loading) markLoading(context?.states, -1);
    };
  });
}

/** @internal The binder an interface 4 part names (`binder: $await`). */
export { bindAwait as $await };
