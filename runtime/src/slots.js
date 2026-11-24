// Light-DOM slots: a part with `binder: $slot` (interface 4), and the router a component with
// slots imports (`slotting: $slotted`), which places the page's and a framework's children in
// them. A light-DOM component without slots keeps those out of sight with element.js's own
// parkChildren.

import { clearBetween, mountBlock, move } from './blocks.js';
import { scope, effect } from './effect.js';
import { COMMENT, FORWARD, TEXT, isContent, mark, marker, matchingClose, routeTo, see, setMarker, slotName, slotRecord, standIns, standsFor, unmark } from './element.js';

/**
 * zb-slot in light DOM: the host's own children for this slot, moved in once at startup, or the
 * fallback block. The provided nodes are kept, so a slot inside an zb-if branch gets them back
 * when the branch comes back.
 */
export function bindSlot(part, open, hydrating, context) {
  const close = matchingClose(open);
  const slot = slotRecord(context, part.slot);
  if (hydrating && marker(open) === '[!' && !slot.nodes.length) {
    // The server already put supplied content here.
    for (let node = open.nextSibling; node !== close; node = node.nextSibling) slot.nodes.push(node);
  }
  // A slot right inside a light-DOM child's tag (`forward`: the child's slot it sits in): what it
  // shows is passed on to that slot, and the child routes it there, not by its own `slot`.
  // `passing` is what this slot passed on, so what has left it stops being.
  let passing = [];
  let label = null; // `{ to: the child, slot }`, one for every node passed on
  const pass = (nodes) => {
    if (!part.forward) return;
    label ??= { to: open.parentNode, slot: part.forward };
    for (const node of passing) if (!nodes.includes(node) && node[FORWARD] === label) delete node[FORWARD];
    for (const node of nodes) node[FORWARD] = label;
    passing = [...nodes];
  };
  const holder = scope(); // owns the fallback while it shows
  let fallback = null;
  let first = hydrating;
  const region = {
    open,
    close,
    provided: false,
    update() {
      const hydrate = first;
      first = false;
      region.provided = slot.nodes.some(isContent);
      if (region.provided) {
        if (fallback) { fallback.dispose(); fallback = null; clearBetween(open, close); }
        setMarker(open, '[!');
        place(slot.nodes, open, context.slotted);
        pass(slot.nodes);
        return;
      }
      // Only markers and whitespace (a framework's bookkeeping): they wait in the park, where
      // the framework can still add content next to them, while the fallback shows.
      if (slot.nodes.length) slot.park.append(...slot.nodes);
      pass([]);
      if (part.fallback) {
        if (fallback) return;
        if (!hydrate || marker(open) !== '[') clearBetween(open, close);
        setMarker(open, '[');
        fallback = holder.run(() => scope(() => mountBlock(part.fallback, [], open, close, hydrate, context)));
      } else {
        clearBetween(open, close);
        setMarker(open, '[');
      }
    },
  };
  // The region exists while this effect does (an zb-if branch switching away disposes it):
  // then the slotted nodes are parked, to come back when the branch does.
  effect(() => {
    slot.region = region;
    return () => {
      if (slot.region !== region) return;
      slot.region = null;
      slot.park.append(...slot.nodes);
      pass([]);
      holder.dispose();
    };
  });
  region.update();
}

 // a stand-in → its element
function standIn(node) {
  let comment = standIns.get(node);
  if (!comment) {
    comment = document.createComment('zb-slot');
    standIns.set(node, comment);
    standsFor.set(comment, node);
  }
  return comment;
}

function forget(node) {
  standsFor.delete(standIns.get(node));
  standIns.delete(node);
}

/**
 * Put `nodes` right after `open`, in order, moving only what's out of place. (Anything that left
 * the slot was removed from the region as it left, so nothing else is there.)
 */
function place(nodes, open, tag) {
  const parent = open.parentNode;
  let cursor = open.nextSibling;
  for (const node of nodes) {
    mark(node, tag);
    if (node === cursor) cursor = cursor.nextSibling;
    else move(parent, node, cursor);
  }
}

/**
 * The slot for each of `nodes` (an element's children, in order). Comments and whitespace are
 * frameworks' markers (Lit's parts, Svelte's anchors): a comment goes with the content after it
 * and whitespace with the content before it, so a framework's range stays together in one slot.
 * Empty text nodes come in pairs (Vue brackets each fragment, a v-for, with two): both go with
 * the content between them, since Vue moves that content through the start anchor's parent.
 */
function assignSlots(nodes, host) {
  const named = nodes.map((node) => (isContent(node) ? slotName(node, host) : null));
  // The slot of the nearest content after (step 1) or before (step -1) node i.
  const near = (i, step) => { for (let j = i + step; nodes[j]; j += step) if (named[j]) return named[j]; return null; };
  // An empty text node right before content opens a range; otherwise it closes the last one,
  // and both take the slot of the first content between them.
  const open = [];
  nodes.forEach((node, i) => {
    if (node.nodeType !== TEXT || node.data) return;
    if (!open.length || named[i + 1] && nodes[i + 1].data == null) return open.push(i);
    const start = open.pop();
    named[start] = named[i] = named.slice(start + 1, i).find(Boolean);
  });
  return nodes.map((node, i) => named[i]
    ?? (node.nodeType === COMMENT ? near(i, 1) ?? near(i, -1) : near(i, -1) ?? near(i, 1))
    ?? 'default');
}

function routeChildren(host, context, slots, tag) {
  const home = slotRecord(context, 'default');
  const holding = (node) => {
    for (const slot of context.slots.values()) if (slot.nodes.includes(node)) return slot;
    return null;
  };
  // `node` left its slot. A stand-in takes its element with it, and an element its stand-in.
  const lose = (node) => {
    unmark(node, context.slotted);
    const other = standsFor.get(node) ?? standIns.get(node);
    if (!other) return;
    forget(standsFor.has(node) ? other : node);
    const slot = take(other);
    unmark(other, context.slotted);
    other.remove();
    if (slot) show(slot);
  };
  // Drop content that left through its real parent (or was moved elsewhere), except `keep`,
  // which is arriving now.
  const prune = (slot, keep) => {
    const parent = slot.region?.provided ? slot.region.open.parentNode : slot.park;
    const left = slot.nodes.filter((node) => node !== keep && node.parentNode !== parent);
    if (!left.length) return;
    slot.nodes = slot.nodes.filter((node) => !left.includes(node));
    left.forEach(lose);
  };
  const show = (slot, keep) => {
    prune(slot, keep);
    slot.filled.set(slot.nodes.some(isContent));
    if (slot.region) slot.region.update();
    else slot.park.append(...slot.nodes);
  };
  const take = (node) => {
    const slot = holding(node);
    if (slot) slot.nodes.splice(slot.nodes.indexOf(node), 1);
    return slot;
  };
  const put = (slot, node, before) => {
    const at = before ? slot.nodes.indexOf(before) : -1;
    if (at >= 0) slot.nodes.splice(at, 0, node);
    else slot.nodes.push(node);
  };
  const named = (node) => {
    const name = slotName(node, host);
    // @dev
    if (!slots.includes(name) && isContent(node)) console.warn(`zubra: <${tag}> has no slot named "${name}"; that content is not shown${see('slots')}`);
    // @dev-end
    return slotRecord(context, name);
  };
  // A slot's text node counts as content only while it has words: hear when that changes.
  const watch = (node) => { if (node.nodeType === TEXT) context.observer.observe(node, { characterData: true }); };
  const insert = (node, before) => {
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) insert(child, before);
      return;
    }
    watch(node);
    const content = isContent(node);
    // A marker or whitespace goes in the slot of what it's inserted before.
    const slot = content ? named(node) : slotRecord(context, (before && holding(before)?.name) || 'default');
    const from = take(node);
    // Among the page's children it goes before `before`, or last: so does its stand-in.
    let comment = standIns.get(node);
    if (comment) take(comment);
    const seat = before && (standIns.get(before) ?? before);
    if (slot === home) {
      if (comment) { forget(node); comment.remove(); }
      put(home, node, seat);
    } else {
      put(slot, node, before);
      if (content) put(home, (comment = standIn(node)), seat);
    }
    // (The stand-in is placed before anything else looks at the default slot: one that isn't
    // where it belongs reads as removed.)
    show(slot, node);
    const seated = slot !== home && content;
    if (seated) show(home, comment);
    if (from && from !== slot && !(seated && from === home)) show(from);
  };
  // Content that is in the wrong slot (its `slot` attribute changed, or a framework put it next
  // to its own marker in another slot's region, or its text was a marker while it was empty)
  // goes to its own, and keeps its place among the page's children.
  const reslot = (node) => {
    const at = home.nodes.indexOf(standIns.get(node) ?? node);
    insert(node, (at >= 0 && home.nodes[at + 1]) || null);
  };
  const remove = (node) => {
    const slot = take(node);
    if (!slot) return false;
    node.remove();
    lose(node);
    show(slot);
    return true;
  };
  const clear = () => {
    for (const slot of context.slots.values()) {
      for (const node of slot.nodes.splice(0)) {
        unmark(node, context.slotted);
        node.remove();
      }
      show(slot);
    }
  };
  routeTo(host, { insert, remove, holds: holding, clear, first: () => { const [first] = home.nodes; return first ? standsFor.get(first) ?? first : null; } });

  // Content removed or moved away through its real parent (Vue removes via child.parentNode),
  // and content whose `slot` attribute changed (it moves to that slot, as with native slots).
  context.observer = new MutationObserver((records) => {
    const written = []; // text nodes that were written
    for (const record of records) {
      if (record.type === 'characterData') written.push(record.target);
      const slot = record.type === 'attributes' && holding(record.target);
      if (slot && slotName(record.target, host) !== slot.name) reslot(record.target);
      // Solid clears a run of nodes one by one, skipping those that aren't where the first is
      // (an element moved to its slot), and puts an empty text node in the first one's place:
      // the stand-ins right after that node are the rest of the run.
      const [added] = record.addedNodes;
      if (record.removedNodes.length === 1 && record.addedNodes.length === 1 && added.nodeType === TEXT && !added.data) {
        while (standsFor.has(added.nextSibling)) added.nextSibling.remove();
      }
    }
    // Svelte removes a block from its first node to its last, sibling by sibling. When the last
    // is an element that was moved to another slot, the walk never meets it and carries on to
    // the end of the parent, taking the block's own anchor, this slot's closing marker and the
    // template's nodes after it. Those go back: everything from the first comment after a
    // stand-in (the anchor), or else from the closing marker.
    for (const { region } of context.slots.values()) {
      const parent = region?.open.parentNode;
      if (!parent || region.close.parentNode === parent) continue;
      const gone = records.filter((record) => record.target === parent).flatMap((record) => [...record.removedNodes]);
      let cut = gone.indexOf(region.close);
      for (let i = 0, seen = false; i < cut; i++) {
        if (standsFor.has(gone[i])) seen = true;
        else if (seen && gone[i].nodeType === COMMENT) cut = i;
      }
      if (cut >= 0) for (const node of gone.slice(cut)) if (!node.parentNode) Node.prototype.insertBefore.call(parent, node, null);
    }
    // Each slot's nodes are what's actually in it: frameworks also insert and remove content
    // next to their own markers there, without going through the host.
    for (const slot of context.slots.values()) {
      let actual;
      if (slot.region?.provided) {
        actual = [];
        for (let node = slot.region.open.nextSibling; node && node !== slot.region.close; node = node.nextSibling) actual.push(node);
      } else {
        actual = [...slot.park.childNodes];
      }
      if (actual.length === slot.nodes.length && actual.every((node, i) => node === slot.nodes[i])) {
        // The same nodes, but one's text was written: it may have become content, or stopped being.
        if (!written.some((node) => slot.nodes.includes(node))) continue;
      } else {
        const left = slot.nodes.filter((node) => !actual.includes(node));
        slot.nodes = actual;
        left.forEach(lose);
        actual.forEach(watch);
      }
      // Content that belongs to another slot goes there: an element added next to a marker here,
      // or text that was a marker while it was empty. (A copy: moving one takes it out of the list.)
      for (const node of [...slot.nodes]) if (isContent(node) && slotName(node, host) !== slot.name) reslot(node);
      show(slot);
    }
    // Content a parent adds inside a slot itself (its zb-if or zb-each there) is slotted too;
    // a fallback showing there is the component's own, so it stays unmarked.
    if (context.slotted) {
      for (const slot of context.slots.values()) {
        if (!slot.region?.provided) continue;
        for (let node = slot.region.open.nextSibling; node && node !== slot.region.close; node = node.nextSibling) {
          mark(node, context.slotted);
        }
      }
    }
  });
  const observe = () => {
    context.observer.disconnect();
    context.observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['slot'] });
    for (const slot of context.slots.values()) context.observer.observe(slot.park, { childList: true });
    // disconnect() also drops the observation of each text node (a slot hears that one got words
    // through it), so a label written after the element was moved would never reach the slot.
    for (const slot of context.slots.values()) slot.nodes.forEach(watch);
  };
  // Connected again (element.js drops the observer on disconnect, so it can't retain the element).
  // What left a slot while the element was detached went unseen: drop it first, so the element
  // neither watches a node that is now someone else's (which, if the element is then never
  // disconnected, as in a document that's dropped, would keep it alive through that node) nor puts
  // it back where it was.
  context.observe = () => {
    for (const slot of context.slots.values()) show(slot);
    // A slot attribute changed meanwhile went unseen too: what's still here goes where it says.
    for (const slot of [...context.slots.values()]) {
      for (const node of [...slot.nodes]) if (isContent(node) && slotName(node, host) !== slot.name) reslot(node);
    }
    observe();
  };
  if (host.isConnected) observe();
  for (const slot of context.slots.values()) slot.nodes.forEach(watch);
}

// Form controls' live state: bound as properties, so `value={draft}` keeps up with typing and
// `checked={done}` with clicks.
/**
 * @internal A light-DOM component's slots (interface 4: `slotting: $slotted`, imported by
 * components that have slots): the page's children go to theirs, and the host's child methods
 * route what a framework adds later (routeChildren).
 */
export const $slotted = {
  assign(context, children, slots, tag) {
    // (The host's own children: their parent is the host.)
    assignSlots(children, children[0]?.parentNode).forEach((name, i) => {
      slotRecord(context, name).nodes.push(children[i]);
      // An element for a named slot keeps its place among the page's children (see routeChildren).
      if (name !== 'default' && isContent(children[i])) slotRecord(context, 'default').nodes.push(standIn(children[i]));
    });
    for (const [name, slot] of context.slots) {
      // @dev
      if (!slots.includes(name) && slot.nodes.some(isContent)) console.warn(`zubra: <${tag}> has no slot named "${name}"; that content is not shown${see('slots')}`);
      // @dev-end
    }
  },
  route: routeChildren,
};

/** @internal The binder an interface 4 part names (`binder: $slot`). */
export { bindSlot as $slot };
