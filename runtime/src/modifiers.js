// A listener with modifiers: a part with `binder: $modified` (interface 4), for `onclick.prevent`,
// `onkeydown.shift.enter`, `.self`, `.once` and the rest, on an element or on `<zb-window>` /
// `<zb-document>`. A component whose listeners have none doesn't load this.
import { effect } from './effect.js';
import { $r, APPLE, formOf, whileConnected } from './element.js';

/** The node the event came from, before a shadow root retargets `event.target` to its host. */
const originalTarget = (event) => {
  const path = event.composedPath?.();
  return path?.length ? path[0] : event.target;
};

/**
 * The listener and its options: the handler, read when the event fires, behind the modifiers'
 * checks (`.self`, key filters) and effects (`.prevent`, `.stop`, `.submit`).
 */
function listen(part, node) {
  const m = part.modifiers ?? {};
  // `.mod` is ⌘ on Apple platforms and Ctrl elsewhere.
  const ctrl = m.ctrl || (m.mod && !APPLE());
  const meta = m.meta || (m.mod && APPLE());
  const listener = (event) => {
    // `.self` is the original target, not the retargeted one: a listener on a shadow host
    // otherwise sees every inner click as targeting the host (WebKit and Firefox included).
    if (m.self && originalTarget(event) !== node) return;
    if (m.keys) {
      const key = event.key ?? '';
      if (!m.keys.some((wanted) => (wanted.length === 1 ? key.toLowerCase() === wanted : key === wanted))) return;
      // With a key, the named modifier keys must be held and the others not.
      if (!!m.shift !== event.shiftKey || !!ctrl !== event.ctrlKey || !!m.alt !== event.altKey || !!meta !== event.metaKey) return;
    } else if ((m.shift && !event.shiftKey) || (ctrl && !event.ctrlKey) || (m.alt && !event.altKey) || (meta && !event.metaKey)) {
      return;
    }
    if (m.prevent) event.preventDefault();
    if (m.stop) event.stopPropagation();
    const handler = $r(part.handler());
    if (typeof handler === 'function') handler.call(node, event);
    // `.submit`: the form the element belongs to (or, in a shadow root, the host's form).
    if (m.submit) formOf(node)?.requestSubmit();
  };
  const options = m.once || m.capture || m.passive ? { once: !!m.once, capture: !!m.capture, passive: !!m.passive } : undefined;
  return [listener, options];
}

function bindModified(part, node) {
  if (part.global) {
    // <zb-window>/<zb-document>: listening while this part of the template is rendered.
    const target = part.global === 'window' ? window : document;
    effect(() => whileConnected(() => {
      const [listener, options] = listen(part, target);
      target.addEventListener(part.on, listener, options);
      return () => target.removeEventListener(part.on, listener, options);
    }));
  } else {
    const [listener, options] = listen(part, node);
    node.addEventListener(part.on, listener, options);
  }
}

/** @internal The binder an interface 4 part with modifiers names (`binder: $modified`). */
export { bindModified as $modified };

// ---- the modifiers as functions (for JSX, and for handlers built in scripts) ----------------

/** `prevent(fn)`: a handler that calls `event.preventDefault()` first. */
export const prevent = (fn) => function (event) { event.preventDefault(); return fn?.call(this, event); };
/** `stop(fn)`: a handler that calls `event.stopPropagation()` first. */
export const stop = (fn) => function (event) { event.stopPropagation(); return fn?.call(this, event); };
/** `selfOnly(fn)`: a handler that ignores events from inside the element (`.self`). */
export const selfOnly = (fn) => function (event) {
  if (originalTarget(event) !== event.currentTarget) return;
  return fn?.call(this, event);
};
/** `submit(fn)`: after the handler, submit the element's form, with validation (`.submit`). */
export const submit = (fn) => function (event) {
  const result = fn?.call(this, event);
  formOf(event.currentTarget)?.requestSubmit();
  return result;
};

const KEY_NAMES = {
  enter: 'Enter', tab: 'Tab', space: ' ', esc: 'Escape', escape: 'Escape', up: 'ArrowUp', down: 'ArrowDown',
  left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight', delete: 'Delete', backspace: 'Backspace', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};
/**
 * `keys('shift+enter', fn)`: a keyboard handler for one key, with exactly the modifier keys named
 * (the same rule as `onkeydown.shift.enter` in a template). Several combinations: `'enter, space'`.
 */
export function keys(combinations, fn) {
  const wanted = String(combinations).split(',').map((combination) => {
    const pieces = combination.trim().toLowerCase().split('+');
    const key = pieces.pop();
    // `mod` is ⌘ on Apple platforms and Ctrl elsewhere.
    const mod = pieces.includes('mod');
    return { key: KEY_NAMES[key] ?? key, shift: pieces.includes('shift'), ctrl: pieces.includes('ctrl') || (mod && !APPLE()), alt: pieces.includes('alt'), meta: pieces.includes('meta') || (mod && APPLE()) };
  });
  return function (event) {
    const key = event.key ?? '';
    const match = wanted.some((w) => (w.key.length === 1 ? key.toLowerCase() === w.key : key === w.key)
      && w.shift === event.shiftKey && w.ctrl === event.ctrlKey && w.alt === event.altKey && w.meta === event.metaKey);
    if (match) return fn?.call(this, event);
  };
}
