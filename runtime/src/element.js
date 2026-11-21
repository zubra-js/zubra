// define(): the custom element a compiled component becomes.
//
// The compiler hands over a template and a list of parts (see src/emit_js.rs). Each part has a
// path to a node and a function computing what goes there. On first connection the element
// either clones the template (fresh) or finds the same nodes in markup the server already
// rendered (hydration), then binds every part with an effect. Hydration never re-renders: a
// part only writes when its value differs from what is already in the DOM.
//
// Paths count element and comment children only. The browser merges and drops text nodes, so
// text is reached through its element (an only child) or through an empty-comment anchor.
import { State, Computed, untrack, isSignal } from './signal.js';
import { wrap, raw } from './deep.js';
import { activeOwner, effect, ownerData, root as rootScope, tick } from './effect.js';
// @dev (left out of the production build: scripts/build-production.js)
import { dev as devEffects } from './effect.js';
import { register as devRegister, listened as devListened } from './devhook.js';
// @dev-end

const TEXT = 3;
const COMMENT = 8;

// ---- values --------------------------------------------------------------------------------

/** Unwrap a signal, so templates can read `{count}` for `const count = state(0)`. */
/** Where a message's topic is documented. */
const see = (section) => ` (see https://github.com/zubra-js/zubra/blob/main/docs/reference.md#${section})`;

export const $r = (value) => (isSignal(value) ? value.get() : value);

/** Text for a `{…}` in content: null/undefined render nothing; objects are an error. */
export function $t(value) {
  value = $r(value);
  if (value == null) return '';
  if (typeof value === 'object') {
    // @dev
    console.error('zubra: cannot render an object as text; access a field or iterate it instead', value);
    // @dev-end
    return '';
  }
  return String(value);
}

/** The same rule the compiler applies at build time (src/validate.rs `is_safe_url`). */
export function isSafeUrl(value) {
  // A browser reads `\` as `/` in an http(s) URL, so `/\evil.example` is `//evil.example`.
  const url = String(value).trim().replaceAll('\\', '/');
  if (!url || /[\u0000-\u001f\u007f-\u009f]/.test(url) || url.startsWith('//')) return false;
  const beforePath = url.split(/[/?#]/)[0];
  const colon = beforePath.indexOf(':');
  if (colon < 0) return true;
  return ['http', 'https', 'mailto', 'tel'].includes(beforePath.slice(0, colon).toLowerCase());
}

/** A srcset whose every candidate's URL is safe (src/validate.rs `is_safe_srcset`). */
export function isSafeSrcset(value) {
  const urls = String(value).split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 && urls.every(isSafeUrl);
}
/** @internal The URL checks as interface 5 output names them (`url: $url`, `srcset: $srcset`). */
export { isSafeUrl as $url, isSafeSrcset as $srcset };

const clone = (value) => (value && typeof value === 'object' ? structuredClone(value) : value);

/** Attribute text → prop value, typed by the prop's default (JSON for arrays and objects). */
function parseAttribute(spec, raw) {
  const fallback = spec.default;
  // An enum prop (`<script lang="ts">`): the member whose value the text is, or the member it names.
  if (spec.enum) {
    if (raw === null) return clone(fallback);
    const found = Object.values(spec.enum).find((value) => String(value) === raw);
    if (found !== undefined) return found;
    if (Object.hasOwn(spec.enum, raw)) return spec.enum[raw];
    // @dev
    console.warn(`zubra: attribute "${spec.attribute}" is "${raw}", not one of ${Object.keys(spec.enum).join(', ')}`);
    // @dev-end
    return clone(fallback);
  }
  if (typeof fallback === 'boolean') return fallback ? raw !== 'false' : raw !== null;
  if (raw === null) return clone(fallback);
  if (typeof fallback === 'number') return Number(raw);
  if (typeof fallback === 'string') return raw;
  if (fallback === undefined || fallback === null) {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  // A framework's server rendering stringified an object it sets as a property once it runs
  // (Svelte does this): not given yet, rather than invalid.
  if (raw === '[object Object]') return clone(fallback);
  try {
    return JSON.parse(raw);
  } catch {
    // @dev
    console.warn(`zubra: attribute "${spec.attribute}" is not valid JSON:`, raw);
    // @dev-end
    return clone(fallback);
  }
}

// ---- hooks ---------------------------------------------------------------------------------

let current = null; // lifecycle hooks of the component whose setup is running

function hooks(name) {
  if (!current) throw new Error(`zubra: ${name}() must be called while a component is setting up${see('script-state-and-hooks')}`);
  return current;
}

/**
 * The signal itself, where a script passes a signal `const` along (`watch(signal(count), …)`).
 * It returns what it's given: since 3.0 a signal `const` in a script means its value, and the
 * compiler leaves `signal(name)`'s argument alone, so it's the signal. (`plan/decisions/3.0-scope.md`.)
 */
export const signal = (value) => value;

/** The original object behind reactive state (`let items = []` holds a proxy of the array). */
export { raw };

export const state = (value, options) => {
  // @hot (left out of the production build: scripts/build-production.js)
  // During a hot reload, a component's state keeps its value: by position, like hooks, unless
  // the edit changed what kind of value it holds.
  const kept = current?.kept;
  const at = current?.states?.length ?? 0;
  if (kept && at < kept.length && kind(kept[at]) === kind(value)) value = kept[at];
  // @hot-end
  const signal = new State(wrap(value), options);
  // An array or plain object assigned later is wrapped the same way, so `items = [...]` followed
  // by `items.push(x)` keeps updating.
  signal.set = (next) => State.prototype.set.call(signal, wrap(next));
  current?.states?.push(signal);
  return signal;
};
/**
 * State that follows a prop until it's assigned, and starts over when the prop changes:
 *
 *   let left = from(seconds)          // a timer's time left: counts down, resets on a new length
 *   let running = from(seconds, false) // false, and false again whenever `seconds` changes
 *
 * With a second argument, the state starts as that value instead, each time the first changes.
 * In a `.zb` script the compiler passes both as functions (`from(() => seconds)`), so the state
 * can follow them. Outside one, pass a function or a signal.
 */
export function from(source, start) {
  const read = (value) => (typeof value === 'function' ? value() : isSignal(value) ? value.get() : value);
  // A fresh box each time the source changes, so an assignment made against one value of the
  // source is dropped once it moves on (even back to the same value).
  const latest = new Computed(() => {
    const value = read(source);
    return { value: start === undefined ? value : read(start) };
  });
  const assigned = new State(null);
  const linked = new Computed(() => {
    const base = latest.get();
    const own = assigned.get();
    return wrap(own && own.base === base ? own.value : base.value);
  });
  linked.set = (value) => assigned.set({ base: untrack(() => latest.get()), value });
  // @hot (left out of the production build: scripts/build-production.js)
  // A hot reload keeps an assigned value, by position, like state().
  const kept = current?.kept;
  const at = current?.states?.length ?? 0;
  if (kept && at < kept.length && kind(kept[at]) === kind(untrack(() => linked.get()))) linked.set(kept[at]);
  // @hot-end
  current?.states?.push(linked);
  return linked;
}
// @hot
const kind = (value) => (value === null || value === undefined ? 'empty' : Array.isArray(value) ? 'array' : typeof value);
// @hot-end
export const computed = (fn, options) => new Computed(fn, options);

/**
 * Whether the element has started: false while its markup is the server's (and on the server),
 * true from when it hydrates (or renders) in the browser. A signal, read like a value in the
 * template, for what only works with JavaScript:
 *
 *   const live = hydrated()
 *   <zb-if test={!live}><button>Apply</button></zb-if>
 *
 * The host also gets the custom state `hydrated`, for CSS: `:host(:state(hydrated))`, or
 * `my-filters:state(hydrated)` from the page.
 */
export function hydrated() {
  return hooks('hydrated').hydrated;
}

/** Run when the element is connected; may return a cleanup for when it is disconnected. */
export function onMount(fn) {
  hooks('onMount').mount.push(fn);
}

/** Run when the element is disconnected. */
export function onUnmount(fn) {
  hooks('onUnmount').unmount.push(fn);
}

// Element scope → its hooks, so a binder can register connection-scoped work after setup
// (when `current` is no longer set) and from a branch that renders later.
const scopeHooks = new WeakMap();

/**
 * Run `start` while the component is connected. The cleanup `start` returns runs on
 * disconnect, and `start` runs again if the element comes back — a window listener or any
 * other external subscription, which pause() alone would leave in place (pause keeps the
 * effect and skips its cleanup, so a move doesn't rebuild the DOM). Dispose the returned
 * function when the part leaves the template (a branch switching away).
 * @internal
 */
export function whileConnected(start) {
  const component = ownerData(scopeHooks);
  if (!component) throw new Error(`zubra: whileConnected() must run inside a component${see('script-state-and-hooks')}`);
  const host = component.host;
  let remove = null;
  let on = false;
  const up = () => {
    if (on || !host.isConnected) return;
    on = true;
    const cleanup = start();
    remove = typeof cleanup === 'function' ? cleanup : null;
  };
  const down = () => {
    if (!on) return;
    on = false;
    remove?.();
    remove = null;
  };
  const entry = { up, down };
  component.links.push(entry);
  up();
  return () => {
    down();
    const at = component.links.indexOf(entry);
    if (at >= 0) component.links.splice(at, 1);
  };
}

/**
 * The component's props: reading one tracks it (in `computed`, `effect`, the template), and
 * writing one updates the element as if it had been set from outside.
 */
export function props() {
  return hooks('props').props;
}

/**
 * The element whose setup is running, for custom hooks that need it (to read an attribute,
 * dispatch an event, observe its size, …).
 */
export function host() {
  return hooks('host').host;
}

/**
 * Fire a DOM event from the component: `emit('valuechange', value)`. The compiler binds `emit`
 * to each element, so handlers and timers can call it long after setup, and declares every
 * event it sees. Outside a compiled component, use the `emit` that `setup` receives.
 */
export function emit(name) {
  throw new Error(`zubra: emit("${name}") is bound to each element by the compiler; outside a compiled component, use the emit that setup() receives`);
}

/**
 * An id unique to this element and call, for `id`/`for`/`aria-*` attributes. Stable for the
 * element's life. Based on the host's own `id` when it has one, else on the base the server
 * rendered it with (`data-zb-id`), so the ids in server-rendered markup stay as they are.
 */
export function id() {
  const component = hooks('id');
  const host = component.host;
  const base = host.id || host.getAttribute('data-zb-id') || `${host.localName}-${component.instance}`;
  return `${base}-${++component.ids}`;
}

/** Call `callback(next, previous)` when `source()` changes (not on the first run). */
export function watch(source, callback) {
  let first = true;
  let previous;
  effect(() => {
    const next = $r(typeof source === 'function' ? source() : source);
    if (!first && !Object.is(next, previous)) {
      const old = previous;
      untrack(() => callback(next, old));
    }
    first = false;
    previous = next;
  });
}

// ---- finding parts -------------------------------------------------------------------------
//
// A range is a run of sibling nodes: an element's children, or the nodes between a region's
// `<?zb [?>` and its matching `<?zb ]?>`. Within a range, positions count elements and comments
// only, and a whole region counts as one position (its start marker), so a list's length never
// shifts the paths of what comes after it.

// `[!` opens a slot region holding supplied content (static, left alone on hydration).
// `[?` opens a region the server left for the element to render (partial rendering).
//
// The server writes markers as processing instructions (`<?zb [?>`, `<?zb ]?>`, `<?zb ?>`), which
// HTML minifiers and sanitizers keep. A browser that doesn't parse them yet makes each a comment
// (`?zb [?`), and client templates and 4.x servers use plain comments (`[`): `marker` reads all three.
const PI = 7;
/** A marker's text (`[`, `[!`, `[?`, `]`, or '' for a text anchor), or null for any other node. */
function marker(node) {
  if (node.nodeType === PI) return node.target === 'zb' ? node.data : null;
  if (node.nodeType !== COMMENT) return null;
  const data = node.data;
  return data.startsWith('?zb ') ? data.slice(4, data.endsWith('?') ? -1 : undefined) : data;
}
const opens = (m) => m === '[' || m === '[!' || m === '[?';
const isOpen = (node) => opens(marker(node));

const isClose = (node) => marker(node) === ']';
/** Change a region's opening marker: a PI keeps its target, a comment takes the plain form. */
const setMarker = (node, text) => { if (marker(node) !== text) node.data = text; };

function matchingClose(open) {
  let depth = 0;
  for (let node = open.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType === 1) continue;
    // (Each node's marker read once: reading one parses a comment's text, and hydration reads
    // every node between a region's markers, and again for each region it is inside.)
    const m = marker(node);
    if (opens(m)) depth++;
    else if (m === ']') {
      if (depth === 0) return node;
      depth--;
    }
  }
  return null;
}

const MARKERS = ['[', '[!', '[?', ']', ''];
/** The nodes that hold a position: elements and markers (not text, nor a stream's `<?start>`). */
function* positions(first, stop) {
  for (let node = first; node && node !== stop; node = node.nextSibling) {
    const m = node.nodeType === 1 ? null : marker(node);
    if (m !== null ? !MARKERS.includes(m) : node.nodeType !== 1) continue;
    yield node;
    if (opens(m)) {
      node = matchingClose(node);
      if (!node) return;
    }
  }
}

function walk(range, path) {
  let first = range.first;
  let stop = range.stop;
  let node = null;
  for (const index of path) {
    node = null;
    let seen = -1;
    for (const candidate of positions(first, stop)) {
      if (++seen === index) { node = candidate; break; }
    }
    if (!node) return null;
    // The next step goes into this node: an element's children, or a region's contents (a
    // part inside a child component's slot, in server markup, is reached that way).
    if (isOpen(node)) {
      first = node.nextSibling;
      stop = matchingClose(node);
    } else {
      // (The native getter: a light-DOM host answers `firstChild` with the page's first child.)
      first = (nativeFirst ??= Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild').get).call(node);
      stop = null;
    }
  }
  return node;
}
let nativeFirst; // looked up on first use, so the module loads without a DOM

const childRange = (parent) => ({ first: parent.firstChild, stop: null });

/**
 * Where a part given to a child component sits in server markup: its one place, or, where that's
 * in doubt (the child has the slot in more than one branch of a `zb-if`, or another slot where
 * this one is), the first place (`[{ path, kinds }]`) whose steps lead to what the compiler
 * expects there: `kinds[i]` for step `i`, a tag name, `[` for a region, `[!` for a filled slot's
 * (a hole for a step it doesn't check). That's the branch the server rendered; none (or no
 * places): `[]`, which leads nowhere, so the element renders fresh.
 */
const placed = (range, hydrate) =>
  hydrate[0]?.path
    ? hydrate.find(({ path, kinds }) => kinds.every((kind, step) => {
      const node = walk(range, path.slice(0, step + 1));
      return (node && (marker(node) ?? node.localName)) === kind;
    }))?.path ?? []
    : hydrate;

/** The node for every part, or null if the markup doesn't have the template's shape. */
function locate(range, parts, hydrating = false) {
  const nodes = [];
  for (const part of parts) {
    // In server markup, content given to a child component sits where the child projected it.
    const node = walk(range, hydrating && part.hydrate ? placed(range, part.hydrate) : part.path);
    const fits = !node ? false
      : part.when || part.each || part.slot || part.await ? isOpen(node) && matchingClose(node) !== null
      : part.anchor || part.global ? marker(node) === ''
      : node.nodeType === 1;
    if (!fits) return null;
    nodes.push(node);
  }
  return nodes;
}

// ---- blocks: the contents of an zb-if branch or an zb-each row ----------------------------

const blueprints = new WeakMap();
const SVG = 'http://www.w3.org/2000/svg';
const MATHML = 'http://www.w3.org/1998/Math/MathML';

function blueprint(source, parent = null) {
  const ns = parent?.namespaceURI;
  const context = ns === SVG && parent.localName !== 'foreignObject' ? 'svg' : ns === MATHML ? 'math' : '';
  let byContext = blueprints.get(source);
  if (!byContext) blueprints.set(source, (byContext = {}));
  let content = byContext[context];
  if (!content) {
    const element = document.createElement('template');
    element.innerHTML = context ? `<${context}>${source.template}</${context}>` : source.template;
    content = element.content;
    if (context) content.replaceChildren(...content.firstChild.childNodes);
    byContext[context] = content;
  }
  return content;
}

// ---- binding parts -------------------------------------------------------------------------

// (The event helpers, `prevent`, `keys` and the rest, are modifiers.js's; the form helpers form.js's;
// context is provide.js's. A page whose components use none of them doesn't load that code.)

/**
 * `function X({ value = model(0) })` in a JSX component marks `value` as two-way (like
 * `value:model={0}` in `.zb`). The compiler reads it; at runtime it's just the default.
 */
export const model = (value) => value;

const formOf = (node) => node.form ?? node.closest('form') ?? node.getRootNode().host?.form;

let apple;
const APPLE = () => (apple ??= /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? ''));

/**
 * An event part's listener: the handler, read when the event fires, so swapping it never
 * re-subscribes. A listener with modifiers (`.prevent`, `.self`, a key) names a binder of its
 * own (`binder: $modified`, modifiers.js), so a component without them doesn't load that code.
 */
const listen = (part, node) => (event) => {
  const handler = $r(part.handler());
  if (typeof handler === 'function') handler.call(node, event);
};

// Interface 2 and 3 parts name no binder: $define fills one in from their keys (`legacyBinder`),
// and is the only code that names every binder, so an app of interface 4 components drops it.
let legacy = null;
/** @internal Turned on by $define (legacy.js) the first time an interface 2 or 3 module loads. */
export const useLegacy = (fill) => { legacy = fill; };

function bind(part, node, hydrating, context) {
  if (legacy !== null && part.binder === undefined) legacy(part);
  // @dev
  // The effects created here are this part's (for the DevTools hook, devtools.js).
  const outerLabel = devEffects.label;
  devEffects.label = { part, node };
  if (part.on && !part.global) devListened(part, node);
  // @dev-end
  if (part.binder) {
    // A block (`zb-if`, `zb-await`, `zb-each`), a slot, a listener with modifiers or a window
    // listener, a class list or toggle, a style property: interface 5 output imports the binder
    // for each kind it has, so a bundler leaves out the ones an app doesn't use.
    part.binder(part, node, hydrating, context);
  } else if (part.text) {
    effect(() => {
      const text = part.text();
      // A lone Text child is compared and written in place (`.data`): reading `textContent`
      // walks the subtree, and setting it replaces the Text node.
      const child = node.firstChild;
      if (child !== null && child === node.lastChild && child.nodeType === TEXT) {
        if (child.data !== text) child.data = text;
      } else if (node.textContent !== text) node.textContent = text;
    });
  } else if (part.anchor) {
    effect(() => {
      const text = part.anchor();
      let target = node.nextSibling;
      if (!target || target.nodeType !== TEXT) {
        target = document.createTextNode('');
        node.after(target);
      }
      if (target.data !== text) target.data = text;
    });
  } else if (part.on) {
    node.addEventListener(part.on, listen(part, node));
  } else if (part.bind) {
    // A part whose code lives in its own entry (`{...spread}`: @zubra/runtime/spread), so
    // components that don't use it don't load it.
    part.bind(part, node);
  } else if (part.ref) {
    effect(() => {
      const assign = $r(part.ref());
      if (typeof assign !== 'function') return;
      untrack(() => assign(node));
      return () => untrack(() => assign(null));
    });
  } else if (part.property) {
    // A child component's prop: always a property, so objects and arrays arrive as they are.
    effect(() => {
      node[part.property] = $r(part.value());
    });
  } else if (part.attribute) {
    bindAttribute(part, node, hydrating);
  }
  // @dev
  devEffects.label = outerLabel;
  // @dev-end
}

/** The signal saying whether slot `name` has content (shared by hasSlot() and the slot). */
function filledSignal(filled, name) {
  let signal = filled.get(name);
  if (!signal) filled.set(name, (signal = new State(false)));
  return signal;
}

/**
 * Whether content was given for slot `name` (`'default'` for the default slot), as a signal that
 * follows the content: for wrapping a slot in markup only when it's used.
 *
 *   const hasFooter = hasSlot('footer')
 *   <zb-if test={hasFooter}><footer><zb-slot name="footer"></zb-slot></footer></zb-if>
 */
export function hasSlot(name = 'default') {
  const component = hooks('hasSlot');
  const filled = filledSignal(component.filled, name);
  // The server rendered with this slot filled (`data-zb-filled`): start from that, so hydrating
  // keeps the markup it wrapped around the slot. The slot's own content takes over once bound.
  if (component.host?.getAttribute('data-zb-filled')?.split(' ').includes(name)) filled.set(true);
  return filled;
}

// ---- slotted content (light DOM) -------------------------------------------------------------
//
// In light DOM the host's children are the template, so content given to the element lives in
// its slot regions instead. Frameworks keep managing that content through the host — React
// calls host.insertBefore(node, sibling) and host.removeChild(node), Preact 11 reorders with
// host.moveBefore(node, sibling), Vue sets textContent — so
// the host's child methods are routed to the slots, and a MutationObserver notices content
// removed through its real parent. Each slot keeps its nodes in order; while its region isn't
// rendered (inside an zb-if branch that's off) they're parked in a fragment. A slot's own text
// nodes are watched too: Angular creates `{{ }}` text empty and fills it afterwards, and empty
// text is a marker until it has words.
//
// The default slot's nodes are also the page's children in order: an element for another slot
// leaves a stand-in there, a comment where the page put it. A framework that removes a run of
// siblings (Vue a fragment, Svelte and Lit a block, from one node to another) walks from sibling
// to sibling, which can't reach an element that was moved to another slot; it does reach the
// stand-in, and the element goes when its stand-in does. `host.firstChild` answers from the
// same list (Solid writes a lone text child through it).

const standIns = new WeakMap(); // an element in a named slot → its stand-in
const standsFor = new WeakMap();

function slotRecord(context, name) {
  let slot = context.slots.get(name);
  if (!slot) {
    slot = { name, nodes: [], region: null, park: document.createDocumentFragment(), filled: filledSignal(context.filled, name) };
    context.slots.set(name, slot);
    context.observer?.observe(slot.park, { childList: true });
  }
  return slot;
}

/**
 * Content a component passes on to a light-DOM child's slot (`<frame-box><zb-slot name="y">`)
 * keeps its own `slot` attribute (`slot="y"`, its name in the outer component). That slot part
 * names the child's slot it sits in (`forward`), and puts `{ to: the child, slot }` on each node
 * here: the child routes it by that, and every other host, the outer one included, by the
 * attribute. A symbol shared by name, so `--emit element` output reads it too.
 */
const FORWARD = Symbol.for('zubra.forward');
const slotName = (node, host) => (node[FORWARD]?.to === host ? node[FORWARD].slot : (node.nodeType === 1 && node.getAttribute('slot')) || 'default');
/** An element or non-blank text: what fills a slot (comments and whitespace don't). */
const isContent = (node) => node.nodeType === 1 || (node.nodeType === TEXT && node.data.trim() !== '');

let nativeText, nativeHTML; // looked up on first use, so the module loads without a DOM

const ROUTED = ['insertBefore', 'moveBefore', 'appendChild', 'append', 'removeChild', 'replaceChild', 'replaceChildren', 'textContent', 'innerHTML', 'firstChild'];

/** Route the host's child methods to its slots (see above). */
/**
 * A light-DOM host without slots: what a framework adds to it is the page's and isn't shown, so
 * its child methods keep that content in a fragment of its own (`context.park`), where the
 * framework still finds it (`firstChild`, `parentNode`). A component with slots imports
 * `$slotted` instead, which places content in them (routeChildren below).
 */
function parkChildren(host, context, tag) {
  const park = (context.park = document.createDocumentFragment());
  const holds = (node) => node?.parentNode === park;
  routeTo(host, {
    insert(node, before) {
      // @dev
      if ((node.nodeType === 11 ? [...node.childNodes] : [node]).some(isContent)) console.warn(`zubra: <${tag}> has no slot named "default"; that content is not shown${see('slots')}`);
      // @dev-end
      park.insertBefore(node, holds(before) ? before : null);
    },
    remove: (node) => holds(node) && !!park.removeChild(node),
    holds,
    clear: () => park.replaceChildren(),
    first: () => park.firstChild,
  });
}

/**
 * A light-DOM host's child methods, routed: what a framework adds, removes or replaces goes
 * through `insert`, `remove` and `clear`, and `firstChild` is the page's first child (`first`).
 * Reading `textContent` and `innerHTML` still shows the element's own markup.
 */
function routeTo(host, { insert, remove, holds, clear, first }) {
  const asNodes = (items) => items.map((item) => (item instanceof Node ? item : document.createTextNode(String(item))));
  Object.defineProperties(host, {
    insertBefore: { value(node, before) { insert(node, before ?? null); return node; }, configurable: true },
    // Preact 11 reorders a keyed child with moveBefore() where the browser has it. The node goes
    // where an insert would put it; one already in its slot is moved there with its state kept
    // (`move` in blocks.js). Only where the browser has the method: frameworks ask for it by name.
    ...(typeof Element.prototype.moveBefore === 'function' && {
      moveBefore: { value(node, before) { insert(node, before ?? null); }, configurable: true },
    }),
    appendChild: { value(node) { insert(node, null); return node; }, configurable: true },
    append: { value(...items) { for (const node of asNodes(items)) insert(node, null); }, configurable: true },
    removeChild: {
      value(node) {
        if (!remove(node)) Node.prototype.removeChild.call(host, node); // throws as natively
        return node;
      },
      configurable: true,
    },
    replaceChild: {
      value(node, old) {
        if (!holds(old)) return Node.prototype.replaceChild.call(host, node, old);
        insert(node, old);
        remove(old);
        return old;
      },
      configurable: true,
    },
    replaceChildren: { value(...items) { clear(); for (const node of asNodes(items)) insert(node, null); }, configurable: true },
    textContent: {
      get() { return (nativeText ??= Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')).get.call(host); },
      set(value) { clear(); if (value != null && value !== '') insert(document.createTextNode(String(value)), null); },
      configurable: true,
    },
    // The page's first child, wherever its slot is: what a framework that reads it means.
    firstChild: { get: first, configurable: true },
    innerHTML: {
      get() { return (nativeHTML ??= Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')).get.call(host); },
      set(value) {
        clear();
        const template = document.createElement('template');
        template.innerHTML = value;
        insert(document.importNode(template.content, true), null);
      },
      configurable: true,
    },
  });
}

const LIVE = new Set(['input.value', 'textarea.value', 'select.value', 'input.checked', 'option.selected']);

// Changed by someone before the element started: no longer the server's default.
const touched = (n, k) => (n.options ? [...n.options].some((o) => o.selected !== o.defaultSelected) : n[k] !== n[`default${k[0].toUpperCase()}${k.slice(1)}`]);

function bindAttribute(part, node, hydrating = false) {
  const name = part.attribute;
  // For live state: the last value written, so the property is written only when the bound
  // value changes (what the user typed stays until then).
  let written;
  // Server HTML someone already used keeps what they did until the bound value changes.
  const live = LIVE.has(`${node.localName}.${name}`);
  let keep = hydrating && live && touched(node, name);
  effect(() => {
    const value = $r(part.value());
    if (keep) {
      keep = false;
      written = value;
      return;
    }
    // Another library's custom element: a property when it has one (React 19's rule).
    if (part.prop && part.prop in node) {
      node[part.prop] = value;
      return;
    }
    if (part.boolean) {
      if (typeof value !== 'boolean') {
        // @dev
        console.error(`zubra: "${name}" is a boolean attribute; got`, value);
        // @dev-end
        return;
      }
      // A control's live state is its property (the attribute is only the default once the
      // user has touched it).
      if (live) {
        if (value !== written) node[name] = written = value;
        return;
      }
      node.toggleAttribute(name, value);
      return;
    }
    if (live) {
      const text = value == null ? '' : String(value);
      if (text !== written) {
        // Unchanged text isn't written: that would move the caret and lose a selection.
        if (node[name] !== text) node[name] = text;
        written = text;
        // A <select>'s options may come from a list inside it that renders after this part:
        // until the option exists the value doesn't take, so set it again once they're there.
        if (node.options && node.value !== text) {
          queueMicrotask(() => {
            // The element may have been removed before the options rendered.
            if (written === text && node.isConnected && node.value !== text) node.value = text;
          });
        }
      }
      return;
    }
    if (value == null) return node.removeAttribute(name);
    if (typeof value === 'object' && !part.prop) {
      // @dev
      console.error(`zubra: cannot write an object to the "${name}" attribute`, value);
      // @dev-end
      return node.removeAttribute(name);
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // A URL attribute's check (`url: $url`, `srcset: $srcset`: isSafeUrl and isSafeSrcset, which
    // interface 5 output imports where it has one, and legacy.js fills in for older output). No
    // URL yet (a prop's "" default, before the app sets it): no attribute, and nothing to report.
    const safe = part.url ?? part.srcset;
    if (safe && text.trim() === '') return node.removeAttribute(name);
    if (safe && !safe(text)) {
      // @dev
      console.error(`zubra: blocked an unsafe URL in "${name}"${see('safety')}:`, text);
      // @dev-end
      return node.removeAttribute(name);
    }
    if (node.getAttribute(name) !== text) node.setAttribute(name, text);
  });
}

const hasContent = (root) =>
  [...root.childNodes].some((node) => node.nodeType !== TEXT || node.data.trim() !== '');

// ---- define --------------------------------------------------------------------------------

const fired = new WeakMap(); // event → the component that dispatched it

// ---- styles --------------------------------------------------------------------------------
//
// A component's stylesheet is one constructed CSSStyleSheet shared by every instance: adopted
// by each shadow root of a shadow component, and, for a light-DOM component, by the document (or
// the shadow root it lives in). `adoptStyles()` (shadow.js) adds app-wide sheets — Tailwind's
// output, a design system — to every zubra shadow root, since page CSS doesn't reach inside them.

const adopted = new WeakMap(); // Document | ShadowRoot → Set<CSSStyleSheet>

function toSheet(css) {
  if (css instanceof CSSStyleSheet) return css;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(String(css));
  return sheet;
}

/**
 * A sheet whose CSS is at `href`, fetched now: empty until it arrives (and for good if it
 * doesn't). For a light-DOM component whose page carries its CSS, where only an element inside
 * a shadow root needs the sheet at all (`stylesHref`).
 */
function fetchedSheet(href) {
  const sheet = new CSSStyleSheet();
  fetch(href).then((response) => (response.ok ? response.text() : '')).then((css) => sheet.replaceSync(css), () => {});
  return sheet;
}

function adopt(root, sheets) {
  let has = adopted.get(root);
  if (!has) adopted.set(root, (has = new Set()));
  const added = sheets.filter((sheet) => !has.has(sheet));
  for (const sheet of added) has.add(sheet);
  if (added.length) root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...added];
}

/** The attribute that marks content slotted into a styled light-DOM component (value: its tag). */
const SLOTTED = 'data-zb-slotted';
const unmark = (node, tag) => {
  if (tag && node.nodeType === 1 && node.getAttribute(SLOTTED) === tag) node.removeAttribute(SLOTTED);
};
const mark = (node, tag) => {
  if (tag && node.nodeType === 1 && node.getAttribute(SLOTTED) !== tag) node.setAttribute(SLOTTED, tag);
};

/** What adapters and tools need: the tag, each prop's attribute and default, the events. */
function describe(tag, { props, shadow, form, slots, events, styled }) {
  return Object.freeze({
    tag,
    props: Object.freeze(Object.fromEntries(Object.entries(props).map(([name, spec]) =>
      [name, Object.freeze({ attribute: spec.attribute, default: spec.default, required: !!spec.required, model: !!spec.model })]))),
    events: Object.freeze([...events]),
    slots: Object.freeze([...slots]),
    shadow,
    form,
    styled,
  });
}

const serverElements = new Map();
function serverElement(tag, options) {
  if (!serverElements.has(tag)) {
    serverElements.set(tag, class ZubraServerElement {
      static zubra = describe(tag, options);
      constructor() { throw new TypeError(`zubra: <${tag}> can't be created without a DOM`); }
    });
  }
  return serverElements.get(tag);
}

/**
 * Register a compiled component. `props` maps prop names to `{ attribute, default, required }`;
 * `template` is the element's inner HTML with dynamic parts left empty; `setup($p)` runs the
 * component's script once per element and returns its parts.
 */
/**
 * The version of the compiled-code interface: what `$define()`'s arguments and parts mean, and the
 * server markup they hydrate. 3 (5.0) is 2 with processing-instruction markers; this runtime reads
 * 2's comment markers too, so modules compiled by 3.x and 4.x still run. 4 (5.17) is parts that
 * name their binders, as 5.17 and 5.18 wrote them; 5 (5.19.1) also names event modifiers'
 * binder, form controls and hydration, which 4 left to the runtime.
 *
 * Bump it whenever compiled output starts naming something the runtime used to do unasked:
 * output from before the change still says the old number, and only `legacy.js` fills in what it
 * doesn't name. (5.19.0 didn't, and ran 5.18's interface 4 output without its modifiers, form
 * association or hydration: `test/browser/since-4.test.js`.)
 */
export const ABI = 5;
const READS = [2, 3, 4, 5]; // what $define and $element (legacy.js) read; interface 5 output calls $component

/**
 * What modules compiled for runtime 1.x call. Their compiled shape differs, so they're refused
 * with a clear message instead of misbehaving.
 */
export function define(tag) {
  throw new Error(`zubra: <${tag}> was compiled for @zubra/runtime 1.x; recompile it with zubra 2 (the CLI, @zubra/compiler or @zubra/unplugin)`);
}

/**
 * @internal Register a component compiled for interface 5: its parts and definition name what
 * they need (binders, slots, form controls, hydration). Older output calls `$define` or `$element`.
 */
export function $component(tag, definition) {
  if (definition?.abi !== ABI) refuse(tag, definition);
  return defineElement(tag, definition);
}

/** @internal A module compiled for an interface this runtime doesn't read: say what to do. */
export function refuse(tag, definition) {
  throw new Error(`zubra: <${tag}> was compiled for a different @zubra/runtime (interface ${definition?.abi ?? 1}, this runtime is ${ABI}); recompile it with the matching zubra`);
}

// @hot (left out of the production build: scripts/build-production.js)
/** What a hot reload can't change without a full page reload: the element's interface. */
const shape = ({ props = {}, shadow = false, form = false, events = [], styled = false, inPage = false }) => JSON.stringify([props, shadow, form, events, styled, inPage]);
const HOT = Symbol('zubra.hot');
// @hot-end

// @dev
const warnedTwice = new Set(); // tags already warned about being defined twice
// What each tag's definition compiled to: two copies of one component (an app's and a package's,
// both carrying a shared part) compile the same, comments aside, and needn't be warned about.
const definedAs = new Map();
const compiledAs = ({ template = '', styles = null, props = {}, shadow = false, form = false, events = [], slots = [], styled = false, setup }) =>
  JSON.stringify([template, styles, props, shadow, form, events, slots, styled, String(setup ?? '')]);
// @dev-end

function defineElement(tag, definition) {
  const { props = {}, shadow = false, form = false, events = [], styled = false, inPage = false, stylesHref = null, stylesFromPage = null } = definition;
  // Light-DOM slots, when the component has some: imported by its module (`$slotted`), filled in by $define.
  const slottingOf = (next) => (!shadow && next.slots?.length ? next.slotting ?? null : null);
  let slotting = slottingOf(definition);
  // A form-associated component's API and callbacks: imported by its module (`$form`), filled in by $define.
  const forming = form ? definition.forming ?? null : null;
  // A shadow component's root, sheets and slot following (shadow.js): what its output names.
  const shadowing = shadow ? definition.shadowing ?? null : null;
  // Taking over server markup (hydrate.js): what compiled output imports, unless built for an app
  // that never renders on a server.
  const hydrating = definition.hydrating ?? null;
  let { roots, template = '', slots = [], styles = null, setup } = definition;
  // On a server (no DOM), a stand-in with the same `zubra` description, so a module that imports a
  // component loads there: adapters render the host tag, and `@zubra/runtime/server` renders it.
  if (typeof HTMLElement === 'undefined') return serverElement(tag, { props, shadow, form, slots, events, styled });
  let sheet; // created on first use, so define() needs no document
  // A module with only the address takes the page's word for the CSS being there: the server
  // names the components its `<style>` (or stylesheet links) carry, `data-zb-components="a-tag
  // b-tag"`. On a page that doesn't name this one (a fragment swapped into another page, a
  // page built without the server's head), the document gets the fetched sheet like any root.
  let carried;
  const pageHasStyles = () => styles != null || stylesFromPage != null || (carried ??= document.querySelector(`[data-zb-components~="${tag}"]`) !== null);
  // (`stylesHref`: the page has the CSS and the module only its address; see `fetchedSheet`.)
  // (`stylesFromPage`: the bundler put the CSS in the page, and the module has neither; see page-styles.js.)
  const ownSheets = () => (styles != null ? [(sheet ??= toSheet(styles))] : stylesHref ? [(sheet ??= fetchedSheet(stylesHref))] : stylesFromPage && (sheet ??= stylesFromPage(tag)) ? [sheet] : []);
  const existing = customElements.get(tag);
  if (existing) {
    // @hot (left out of the production build: scripts/build-production.js)
    // The same tag again: in development (with hot module replacement), a new version of the
    // component, swapped into the live elements; otherwise the first definition stands.
    if (globalThis.__ZUBRA_HOT__ && existing[HOT]) {
      existing.hotReloaded = existing[HOT](definition);
      return existing;
    }
    // @hot-end
    // @dev (left out of the production build)
    // Two different components with one tag on a page: the browser keeps the first, and the
    // other never runs. The compiler refuses two of the app's (or two packages') within what one
    // component imports, and the bundler plugin and @zubra/server give a package's components the
    // app's copy of a part; what's left shows here. A second copy of the same component is quiet.
    if (definedAs.get(tag) !== compiledAs(definition) && !warnedTwice.has(tag)) {
      warnedTwice.add(tag);
      console.warn(`zubra: <${tag}> is already defined, so another, different definition of it is ignored: a page defines a tag once, and whichever loads first wins. Two components share the tag (an app's own and a package's, say): rename one, or import the same file everywhere${see('writing-a-component')}`);
    }
    // @dev-end
    return existing;
  }
  const componentTemplate = { content: blueprint({ template }) };
  // Whether children that have the template's shape but no markers can be the server's markup
  // with its markers stripped. In light DOM they can just as well be the page's own content for
  // a slot (`<status-badge><span>3</span></status-badge>`, where the badge's root is a <span>),
  // so there the server says it rendered the host: it writes `data-zb-filled` on every light-DOM
  // host that has slots, naming the ones it filled. Without it, such children are the page's.
  const claimed = (host) => shadow || !slots.length || host.hasAttribute('data-zb-filled');
  let instances = 0;
  // @hot (left out of the production build: scripts/build-production.js)
  const live = new Set(); // WeakRefs to the elements, kept only for hot reloads
  // @hot-end
  const byAttribute = Object.fromEntries(Object.entries(props).map(([name, spec]) => [spec.attribute, name]));
  // HTML lowercases attribute names, so `maxValue` in a page arrives as `maxvalue`, which isn't
  // the prop's attribute (`max-value`): the element would ignore it without a word.
  // @dev
  const lowercased = Object.entries(props)
    .filter(([name, spec]) => name !== name.toLowerCase() && spec.attribute !== name.toLowerCase())
    .map(([name, spec]) => [name.toLowerCase(), name, spec.attribute]);
  const checkAttributeCase = (element) => {
    for (const [lower, name, attribute] of lowercased) {
      if (element.hasAttribute(lower) && !element.hasAttribute(attribute)) {
        console.warn(`zubra: <${tag}> ignores the attribute "${lower}": HTML lowercases attribute names, and the prop ${name} is the attribute "${attribute}"${see('writing-a-component')}`);
      }
    }
  };
  // @dev-end

  let internals; // (element) => its ElementInternals; set in the static block below
  let hooksOf; // (element) => its hooks, for form.js; likewise
  class ZubraElement extends HTMLElement {
    static observedAttributes = Object.keys(byAttribute);
    static zubra = describe(tag, { props, shadow, form, slots, events, styled });
    static formAssociated = form;
    static {
      internals = (element) => element.#internals;
      hooksOf = (element) => element.#hooks;
    }
    // @hot
    /** Swap in a new version of the component (see above); false if its interface changed. */
    static [HOT](next) {
      if (shape(next) !== shape(definition)) return false;
      ({ roots, template = '', slots = [], setup } = next);
      slotting = slottingOf(next);
      componentTemplate.content = blueprint({ template });
      const nextStyles = next.styles ?? null;
      if (nextStyles !== styles) {
        styles = nextStyles;
        sheet?.replaceSync(styles ?? '');
      }
      for (const ref of [...live]) {
        const element = ref.deref();
        if (element) element.#reload();
        else live.delete(ref);
      }
      return true;
    }
    // @hot-end
    #context = null;
    #signals = {};
    #given = new Set(); // props set from outside (property, attribute, or before upgrade)
    #early = null; // attributes whose upgrade replay a property set before the upgrade outranks
    #scope = null;
    #starting = null; // the wait for remark.js, while the element hasn't rendered yet
    #hooks = null;
    #cleanups = [];
    #internals = null; // form-associated only
    #states = null; // the custom states (CustomStateSet), for :state(hydrated)

    static {
      for (const name of Object.keys(props)) {
        Object.defineProperty(this.prototype, name, {
          get() { return this.#signals[name].get(); },
          set(value) { this.#given.add(name); this.#signals[name].set(value); },
          configurable: true,
          enumerable: true,
        });
      }
    }

    constructor() {
      super();
      const internals = this.attachInternals();
      if (form) this.#internals = internals;
      this.#states = internals.states ?? null;
      // An event the component fires is its own: an inner element's event of the same name
      // (a native `change` bubbling out of light DOM, a nested component's `valuechange`) stops
      // here, so listeners outside see only the component's, as with a built-in element.
      for (const name of events) {
        this.addEventListener(name, (event) => {
          if (fired.get(event) !== this) event.stopImmediatePropagation();
        });
      }
      for (const [name, spec] of Object.entries(props)) {
        this.#signals[name] = new State(clone(spec.default));
        // A framework may have set the property before the element was defined; that landed
        // as an own property shadowing the accessor. Take it over.
        if (Object.hasOwn(this, name)) {
          const value = this[name];
          delete this[name];
          this.#given.add(name);
          this.#signals[name].set(value);
          // The upgrade replays the attributes already on the element after this, and the
          // server writes a prop's attribute when it isn't the default: that replay is older
          // than the property, so it's skipped (once). A later setAttribute still applies.
          if (this.hasAttribute(spec.attribute)) (this.#early ??= new Set()).add(spec.attribute);
        }
      }
    }

    attributeChangedCallback(attribute, _old, value) {
      if (this.#early?.delete(attribute)) return;
      const name = byAttribute[attribute];
      this[name] = parseAttribute(props[name], value);
    }

    connectedCallback() {
      // A light-DOM component's styles go where it is: the document, or a shadow root.
      if (!shadow && (styles != null || stylesHref || stylesFromPage)) {
        // A light-DOM component's sheet goes to the root it's in, unless the bundler already put
        // it in the page (`inPage`) and that root is the document.
        // (A callback can run after the element was moved out again: then the root is a detached
        // tree, which has no stylesheets of its own.)
        const root = this.getRootNode();
        if (root.adoptedStyleSheets && !(inPage && root === document && pageHasStyles())) adopt(root, ownSheets());
      }
      let waits;
      if (this.#scope) {
        this.#scope.resume();
        // Slot observation and external listeners (window, document) were dropped on disconnect.
        this.#context?.observe?.();
        for (const link of this.#hooks.links) link.up();
      } else if ((waits = hydrating?.waits(shadow ? this.shadowRoot : this, componentTemplate.content, roots, claimed(this)))) {
        // Server markup without its comments: start once the code that puts them back is here.
        this.#starting ??= waits.then(() => {
          this.#starting = null;
          if (this.isConnected && !this.#scope) this.connectedCallback();
        });
        return;
      } else {
        // @dev
        if (lowercased.length) checkAttributeCase(this);
        // @dev-end
        this.#boot();
      }
      this.#cleanups = this.#hooks.mount.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function');
      this.#started();
    }

    /** The element is live: hydrated() turns true, and the host gets :state(hydrated). */
    #started() {
      this.#hooks.hydrated.set(true);
      this.#states?.add('hydrated');
    }

    disconnectedCallback() {
      if (!this.#scope) return; // (not started: waiting for remark.js)
      for (const cleanup of this.#cleanups.splice(0)) cleanup();
      for (const fn of this.#hooks.unmount) fn();
      // Drop external observers and listeners before pausing. Pause keeps effects (a move
      // re-runs only what changed) and does not run their cleanups, so a window listener or a
      // MutationObserver would otherwise retain the element for as long as it stayed detached.
      this.#context?.observer?.disconnect();
      for (const link of this.#hooks.links) link.down();
      // Paused, not disposed: long-lived signals stop holding this element, and if it comes
      // back only the parts whose inputs changed meanwhile are re-run.
      this.#scope.pause();
    }

    /**
     * Dispatch the component's event. It bubbles (and leaves a shadow root); `before…` events
     * are cancelable, like the platform's. Returns false if a listener called preventDefault().
     */
    #emit(name, detail) {
      const event = new CustomEvent(name, {
        detail, bubbles: true, composed: shadow, cancelable: name.startsWith('before'),
      });
      fired.set(event, this);
      return this.dispatchEvent(event);
    }

    /**
     * Resolves once pending prop changes have reached the DOM: after the first render too, when
     * that's waiting for remark.js (content that might be stripped server markup).
     */
    get updateComplete() {
      return this.#starting ? this.#starting.then(tick) : tick();
    }

    // @hot
    /** Re-run the (new) script and template, keeping props, state and slotted content. */
    #reload() {
      if (!this.#scope) return;
      const connected = this.isConnected;
      if (connected) {
        for (const cleanup of this.#cleanups.splice(0)) cleanup();
        for (const fn of this.#hooks.unmount) fn();
      }
      const kept = this.#hooks.states.map((signal) => untrack(() => signal.get()));
      const slotted = shadow ? [] : [...this.#context.slots.values()].flatMap((slot) => slot.nodes).filter((node) => !standsFor.has(node)).concat([...(this.#context.park?.childNodes ?? [])]);
      this.#context.observer?.disconnect();
      // The host's child methods are routed to the old slots (see routeChildren); back to native.
      for (const key of ROUTED) delete this[key];
      this.#scope.dispose();
      this.#scope = null;
      if (shadow) this.shadowRoot.replaceChildren();
      else Element.prototype.replaceChildren.call(this, ...slotted);
      this.#boot(kept, true);
      if (connected) {
        this.#cleanups = this.#hooks.mount.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function');
        this.#started();
      }
    }
    // @hot-end

    #boot(kept = null, reloading = false) {
      const element = this;
      // Props a framework's server rendering wrote as JSON (the adapters' `zb-props`), for
      // starting with them before the framework sets them as properties.
      let given;
      if (!reloading) try { given = JSON.parse(this.getAttribute('zb-props')); } catch {}
      for (const name in given) if (Object.hasOwn(props, name) && !this.#given.has(name)) this[name] = given[name];
      forming?.begin(this);
      // @hot (left out of the production build: scripts/build-production.js)
      if (globalThis.__ZUBRA_HOT__ && !reloading) live.add(new WeakRef(this));
      // @hot-end
      const root = shadowing ? shadowing.attach(this, ownSheets()) : this;
      const $p = {};
      for (const name of Object.keys(props)) {
        // A two-way prop (`value:model`) fires `<prop>change` when the component assigns it.
        const change = props[name].model ? `${name.toLowerCase()}change` : null;
        Object.defineProperty($p, name, {
          get: () => element.#signals[name].get(),
          set: (value) => {
            const signal = element.#signals[name];
            if (change && Object.is(untrack(() => signal.get()), value)) return;
            signal.set(value);
            if (change) element.#emit(change, value);
          },
          enumerable: true,
        });
      }
      this.#hooks = {
        mount: [], unmount: [], links: [], host: this, props: $p, instance: ++instances, ids: 0, filled: new Map(), states: [], kept, hydrated: new State(false),
        internals: this.#internals, formReset: [], formRestore: [], formDisabled: [],
      };
      // @dev
      let named = null; // the script's signals by name (a --devtools build)
      // @dev-end
      // The element's own root: an effect that inserted it (a list row) doesn't own it, so
      // re-running that effect can't dispose the element's effects.
      this.#scope = rootScope(() => {
        scopeHooks.set(activeOwner(), this.#hooks);
        const previous = current;
        current = this.#hooks;
        let parts;
        // A default computed from the script (`count={start}` where `const start = Date.now()`),
        // unless the prop was given.
        const initial = (name, compute) => {
          if (!this.#given.has(name)) this.#signals[name].set(compute());
        };
        // @dev
        // A --devtools build hands over its script's signals by name, for the DevTools hook.
        const dev = (names) => { named = names; };
        // @dev-end
        try {
          parts = setup ? setup($p, (name, detail) => this.#emit(name, detail), initial
            // @dev
            , dev
            // @dev-end
          ) : [];
        } finally { current = previous; }
        forming?.model(this.#hooks, $p, props, this.#internals);

        const context = { slots: new Map(), slotted: styled && !shadow ? tag : null, filled: this.#hooks.filled, states: this.#states };
        this.#context = context;
        const server = hasContent(root);
        // Server markup has the template's shape (its stripped comments put back first); anything
        // else is the page's own children. (Without `hydrating`, it's all the page's.)
        const [nodes, lost] = server && !reloading && hydrating
          ? hydrating.adopt(root, componentTemplate.content, parts, claimed(this), shadow ? [] : (this.getAttribute('data-zb-filled') ?? '').split(' '))
          : [];
        if (nodes) {
          parts.forEach((part, index) => bind(part, nodes[index], true, context));
        } else {
          // An empty text node is a framework's (the parser makes none): Angular's `{{ }}` before
          // its first write, which is content once written, so it's kept though nothing shows yet.
          // (Without `server`, every child is text.)
          if ((server || [...root.childNodes].some((node) => node.data === '')) && slotting) {
            // Not server markup: the page's own children for this element, to be slotted.
            slotting.assign(context, [...root.childNodes], slots, tag);
          } else if (server) {
            // No comments at all where the template has markers: something stripped them, and
            // they couldn't be put back for sure.
            // @dev
            console.warn(lost
              ? `zubra: <${tag}>'s hydration markers (<?zb [?>, <?zb ]?>, …) are missing, so it's rendered fresh. A sanitizer or a fragment parser removed them; keep processing instructions (and comments, for markup from a 4.x server)${see('hydration-markers')}`
              : `zubra: <${tag}>'s markup doesn't match its template; rendering it fresh${see('server-rendering-and-hydration')}`);
            // Where they part ways, in a second warning, from a module loaded only now. The markup
            // is moved out to be read then (it is about to be replaced).
            if (!lost) {
              const was = document.createDocumentFragment();
              was.append(...root.childNodes);
              import('./mismatch.js').then((module) => module.report(tag, was, componentTemplate.content, parts, [positions, walk, placed, isOpen, isClose, marker, matchingClose]), () => {});
            }
            // @dev-end
          }
          // Find and bind the parts before inserting (see mountBlock).
          const fragment = document.importNode(componentTemplate.content, true);
          const fresh = locate(childRange(fragment), parts);
          parts.forEach((part, index) => bind(part, fresh[index], false, context));
          root.replaceChildren(fragment);
        }
        if (!shadow) {
          // Content for slots that aren't rendered now waits in their park.
          for (const slot of context.slots.values()) {
            if (!slot.region) slot.park.append(...slot.nodes);
            slot.filled.set(slot.nodes.some(isContent));
          }
          if (slotting) slotting.route(this, context, slots, tag);
          else parkChildren(this, context, tag);
        } else if (this.#hooks.filled.size) {
          // Shadow DOM: the host's children are assigned by the browser; follow them.
          shadowing?.follow(this, this.#hooks);
        }
      });
      // @dev
      devRegister(this, { tag, definition, props: this.#signals, named, scope: this.#scope });
      // @dev-end
      forming?.end(this, this.#hooks);
    }
  }

  forming?.define(ZubraElement, { internals, hooksOf, props });


  // @dev
  definedAs.set(tag, compiledAs(definition));
  // @dev-end
  customElements.define(tag, ZubraElement);
  return ZubraElement;
}

/** @internal What the runtime's feature modules (blocks, when, each, await, slots) take from here. */
export { adopt, APPLE, FORWARD, hooks, bind, blueprint, childRange, COMMENT, current, defineElement, formOf, hasContent, isClose, isContent, isOpen, listen, locate, mark, marker, matchingClose, PI, positions, READS, routeTo, see, setMarker, slotName, slotRecord, standIns, standsFor, TEXT, toSheet, unmark };
