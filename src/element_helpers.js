// The helpers `--emit element` writes into a component's module, each only when the component
// needs it. A section starts with `//@@ name: dependencies`; `class:` sections go inside the
// element's class. `@name` is a module-level name the compiler picks (the name itself, or a
// `$`-prefixed one when the component already uses it), and `@@styled`/`@@slots` are filled in.

//@@ bind:
/** Keeps one spot in the DOM up to date: `write` runs when `read` gives a value it hasn't had. */
function @bind(read, write) {
  let last = @bind; // nothing written yet
  return () => {
    const value = read();
    if (Object.is(value, last)) return;
    const previous = last === @bind ? undefined : last;
    write((last = value), previous);
  };
}

//@@ attribute:
/** An attribute from a value: null, undefined and false remove it. */
function @attribute(node, name, value) {
  if (value == null || value === false) {
    node.removeAttribute(name);
  } else if (typeof value === "object") {
    console.error(`zubra: cannot write an object to the "${name}" attribute`, value);
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, value);
  }
}

//@@ isSafeUrl:
/** The rule the compiler checks at build time: http(s), mailto and tel URLs, and relative ones. */
function @isSafeUrl(value) {
  // A browser reads `\` as `/` in an http(s) URL, so `/\evil.example` is `//evil.example`.
  const url = String(value).trim().replaceAll("\\", "/");
  if (!url || /[\u0000-\u001f\u007f-\u009f]/.test(url) || url.startsWith("//")) return false;
  const beforePath = url.split(/[/?#]/)[0];
  const colon = beforePath.indexOf(":");
  return colon < 0 || ["http", "https", "mailto", "tel"].includes(beforePath.slice(0, colon).toLowerCase());
}

//@@ isSafeSrcset: isSafeUrl
/** Every URL in a srcset is safe. */
function @isSafeSrcset(value) {
  const urls = String(value).split(",").map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 && urls.every(@isSafeUrl);
}

//@@ urlAttribute: attribute
/** A URL attribute (href, src…), written only when `safe` says the URL is safe. */
function @urlAttribute(node, name, value, safe) {
  if (value != null && value !== false && typeof value !== "object") {
    const text = String(value);
    if (text.trim() === "") return node.removeAttribute(name);
    if (!safe(text)) {
      console.error(`zubra: blocked an unsafe URL in "${name}":`, text);
      return node.removeAttribute(name);
    }
  }
  @attribute(node, name, value);
}

//@@ setValue:
/**
 * A form field's value: the property (what's shown and submitted), not the attribute (which is
 * only its starting value).
 */
function @setValue(node, value) {
  const text = String(value ?? "");
  if (node.value !== text) node.value = text;
  // A <select>'s options may come from a list inside it that renders after this: again once they're there.
  if (node.localName === "select" && node.value !== text) queueMicrotask(() => { if (node.value !== text) node.value = text; });
}

//@@ setStyle:
/** One CSS property from a value: null, false and "" remove it. */
function @setStyle(node, property, value) {
  if (value == null || value === false || value === "") node.style.removeProperty(property);
  else node.style.setProperty(property, String(value));
}

//@@ swapClasses:
/** A computed class next to class: toggles: its tokens come and go one by one, so the toggled classes stay. */
function @swapClasses(node, previous, next) {
  const tokens = (value) => String(value ?? "").split(/\s+/).filter(Boolean);
  const after = tokens(next);
  for (const token of tokens(previous)) if (!after.includes(token)) node.classList.remove(token);
  for (const token of after) node.classList.add(token);
}

//@@ setProperty: attribute
// Another library's custom element gets its property when it has one (React 19's rule). Until it's
// defined: an attribute (JSON for objects), and the property once it is. The latest value for each
// waits here, held weakly, so an element that's never defined keeps nothing alive.
const @waiting = new WeakMap(); // node → { prop: value }
const @waitingTags = new Map(); // tag → Set of WeakRef(node)
function @setProperty(node, prop, name, value) {
  if (prop in node) {
    node[prop] = value;
    return;
  }
  if (!customElements.get(node.localName)) {
    let props = @waiting.get(node);
    if (!props) {
      @waiting.set(node, (props = {}));
      let nodes = @waitingTags.get(node.localName);
      if (!nodes) {
        const tag = node.localName;
        @waitingTags.set(tag, (nodes = new Set()));
        customElements.whenDefined(tag).then(() => {
          @waitingTags.delete(tag);
          for (const ref of nodes) {
            const later = ref.deref();
            const given = later && @waiting.get(later);
            if (given) for (const key in given) if (key in later) later[key] = given[key];
          }
        });
      }
      nodes.add(new WeakRef(node));
    }
    props[prop] = value;
  }
  if (value != null && typeof value === "object") node.setAttribute(name, JSON.stringify(value));
  else @attribute(node, name, value);
}

//@@ insert:
/** Puts a node in place (the platform's insertBefore, not one an element overrides for its slots). */
function @insert(parent, node, before) {
  return Node.prototype.insertBefore.call(parent, node, before);
}

//@@ move: insert
/** Moves a node already on the page, keeping its focus and state where the browser can (moveBefore). */
function @move(parent, node, before) {
  try {
    // The platform's own, as with insert: a parent that is another element's host has one that routes.
    if (Element.prototype.moveBefore && node.isConnected && parent.isConnected) return Element.prototype.moveBefore.call(parent, node, before);
  } catch {
    // not movable in one step: insert it
  }
  return @insert(parent, node, before);
}

//@@ list: insert move
/**
 * <zb-each>: a row per item, between two markers. Rows are matched by key, so a row that stays
 * keeps its nodes (and its focus), and moves only when it's out of order. `create(item, index)`
 * makes a row: its nodes, and how to bring them up to date. With `animate`, `leave` and `glide`
 * come too: removed rows leave, and the rows that stay glide to their new places.
 */
function @list(start, end, read, key, create, leave, glide) {
  let rows = new Map();
  const nodesOf = (row) => {
    const nodes = [];
    for (let node = row.first; node; node = node.nextSibling) {
      nodes.push(node);
      if (node === row.last) break;
    }
    return nodes;
  };
  // The indexes of a longest increasing run of `sequence` (negative entries never count): the rows
  // already in order, which needn't move.
  const inOrder = (sequence) => {
    const tails = [];
    const previous = [];
    sequence.forEach((value, index) => {
      if (value < 0) return;
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sequence[tails[middle]] < value) low = middle + 1;
        else high = middle;
      }
      previous[index] = low > 0 ? tails[low - 1] : -1;
      tails[low] = index;
    });
    const kept = new Set();
    for (let index = tails.length ? tails[tails.length - 1] : -1; index >= 0; index = previous[index]) kept.add(index);
    return kept;
  };
  const update = () => {
    const parent = start.parentNode;
    const items = [...(read() ?? [])];
    const ids = items.map((item, index) => key(item, index));
    const seen = new Set();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        console.error("zubra: duplicate zb-each key", id, `(row ${index + 1}); that row is not keyed`);
        ids[index] = Symbol("duplicate");
      }
      seen.add(ids[index]);
    });
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      row.destroy?.();
      if (leave) leave(nodesOf(row), true);
      else for (const node of nodesOf(row)) node.remove();
    }
    const was = new Map([...rows.values()].map((row, index) => [row, index]));
    const next = new Map();
    const order = items.map((item, index) => {
      const id = ids[index];
      let row = rows.get(id);
      if (!row) {
        const { nodes, update, destroy } = create(item, index);
        // A row is everything from its first node to its last, with what a list inside it adds later.
        row = { first: nodes.firstChild, last: nodes.lastChild, update, destroy, nodes };
        update(item, index); // filled in before it's on the page
      }
      next.set(id, row);
      row.update(item, index);
      return row;
    });
    // The longest run of rows still in their old order stays put; every other row goes before the
    // row after it, from the end. A swap moves two rows, not the rows between them.
    const stay = inOrder(order.map((row) => was.get(row) ?? -1));
    let before = end;
    for (let index = order.length - 1; index >= 0; index--) {
      const row = order[index];
      if (row.nodes) {
        @insert(parent, row.nodes, before); // a new row, from its fragment
        delete row.nodes;
      } else if (!stay.has(index)) {
        for (const node of nodesOf(row)) @move(parent, node, before);
      }
      before = row.first;
    }
    rows = next;
  };
  if (!glide) return update;
  const elements = () => [...rows.values()].flatMap((row) => nodesOf(row).filter((node) => node.nodeType === 1));
  return () => glide(elements(), update);
}

//@@ when: insert
/**
 * <zb-if>: the branch whose condition holds, between two markers, rebuilt only when that changes.
 * With `animate`, `leave` comes too: the branch going away leaves, beside the one replacing it.
 */
function @when(start, end, read, branches, leaving, leave) {
  let shown = -1;
  let update = null;
  let branch = null;
  return () => {
    const index = read() ? 0 : 1;
    if (index !== shown) {
      shown = index;
      branch?.destroy?.(); // a window listener in the branch goes with it
      branch = null;
      leaving?.(start, end); // slotted content inside goes back to wait, not away
      if (leave && start.nextSibling !== end) {
        const nodes = [];
        for (let node = start.nextSibling; node !== end; node = node.nextSibling) nodes.push(node);
        nodes[nodes.length - 1].after(start); // the region starts after them now
        leave(nodes);
      }
      while (start.nextSibling !== end) start.nextSibling.remove();
      update = null;
      if (branches[index]) {
        branch = branches[index]();
        branch.update(); // filled in before it's on the page
        @insert(end.parentNode, branch.nodes, end);
        update = branch.update;
      }
    }
    update?.();
  };
}

//@@ leave:
/**
 * Lets nodes finish their exit before they go. Each element gets `data-leaving` (and `inert`), so
 * CSS can transition or animate it out, and is removed once those animations end; with nothing
 * animating, or under prefers-reduced-motion, it goes at once. `float` takes the elements out of
 * the flow first, held where they are, so what's around them can move into their space.
 */
function @leave(nodes, float) {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const elements = [];
  for (const node of nodes) {
    if (node.nodeType === 1 && !reduced && node.isConnected) elements.push(node);
    else node.remove();
  }
  // Every position first: floating one element moves the next.
  const places = elements.map((element) => float && {
    position: "absolute",
    top: `${element.offsetTop}px`,
    left: `${element.offsetLeft}px`,
    width: `${element.getBoundingClientRect().width}px`,
    height: `${element.getBoundingClientRect().height}px`,
    margin: "0",
  });
  elements.forEach((element, index) => {
    if (float) Object.assign(element.style, places[index]);
    element.inert = true;
    element.setAttribute("data-leaving", "");
  });
  for (const element of elements) {
    // getAnimations() brings styles up to date, so it sees what data-leaving started. An infinite
    // animation (a spinner inside) never ends, so it isn't waited for.
    const running = (element.getAnimations?.({ subtree: true }) ?? [])
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity && animation.playState !== "finished");
    if (!running.length) element.remove();
    else Promise.allSettled(running.map((animation) => animation.finished)).then(() => element.remove());
  }
}

//@@ glide:
/**
 * Runs `change`, then animates each element from where it was to where it is now (First, Last,
 * Invert, Play). Each element's `--zb-move-duration` (250ms) and `--zb-move-easing` say how;
 * a duration of 0, or prefers-reduced-motion, moves them without animating.
 */
function @glide(elements, change) {
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return change();
  const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
  change();
  // Every read first, then every write: a read after a write lays the page out again.
  const moves = [];
  for (const [element, was] of before) {
    if (!element.isConnected) continue;
    const now = element.getBoundingClientRect();
    const x = was.left - now.left;
    const y = was.top - now.top;
    if (!x && !y) continue;
    if (element.hasAttribute("data-leaving")) {
      moves.push({ element, x, y, leaving: true });
      continue;
    }
    const style = getComputedStyle(element);
    const time = /^\s*([\d.]+)(ms|s)\s*$/.exec(style.getPropertyValue("--zb-move-duration"));
    const duration = time ? Number(time[1]) * (time[2] === "s" ? 1000 : 1) : 250;
    if (!duration) continue;
    moves.push({ element, x, y, duration, easing: style.getPropertyValue("--zb-move-easing").trim() || "cubic-bezier(0.2, 0, 0, 1)" });
  }
  for (const { element, x, y, leaving, duration, easing } of moves) {
    if (leaving) {
      // Held where it was on screen as it leaves, even if its container moved.
      element.style.top = `${parseFloat(element.style.top) + y}px`;
      element.style.left = `${parseFloat(element.style.left) + x}px`;
      continue;
    }
    // "add": on top of the element's own transform.
    element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], { duration, easing, composite: "add" });
  }
}

//@@ clone:
/** Markup, parsed once into a <template>; each call returns a fresh copy of its nodes. */
const @templates = new Map();
function @clone(markup) {
  let template = @templates.get(markup);
  if (!template) {
    template = document.createElement("template");
    template.innerHTML = markup;
    @templates.set(markup, template);
  }
  return template.content.cloneNode(true);
}

//@@ cloneSvg:
/** Markup that goes inside an <svg>: parsed there, so its elements are SVG elements. */
const @svgTemplates = new Map();
function @cloneSvg(markup) {
  let template = @svgTemplates.get(markup);
  if (!template) {
    template = document.createElement("template");
    template.innerHTML = `<svg>${markup}</svg>`;
    template.content.replaceChildren(...template.content.firstChild.childNodes);
    @svgTemplates.set(markup, template);
  }
  return template.content.cloneNode(true);
}

//@@ fromJson:
/** An attribute that holds JSON (how arrays and objects are written as attributes), or `fallback`. */
function @fromJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

//@@ fromEnum:
/**
 * An attribute for an enum prop: the member whose value it is (`"4"`, `"large"`), or the member
 * it names (`"Large"`). Anything else keeps `fallback`, with a warning listing the members.
 */
function @fromEnum(raw, members, fallback, attribute) {
  const values = Object.values(members);
  const found = values.find((value) => String(value) === raw);
  if (found !== undefined) return found;
  if (Object.hasOwn(members, raw)) return members[raw];
  console.warn(`zubra: attribute "${attribute}" is "${raw}", not one of ${Object.keys(members).join(", ")}`);
  return fallback;
}

//@@ reads:
// While a computed() or an effect runs: what it reads. Each entry reads the same value again, so
// it can tell later whether anything it depends on has changed.
let @reads = null;

//@@ createState: reads
/**
 * State: a value that updates the element when it's set, or (an array or plain object) changed
 * in place: push, splice and nested writes count. `.value` reads and sets it; so do `.get()` and
 * `.set()`.
 */
function @createState(initial, changed) {
  let version = 0;
  const proxies = new WeakMap(); // this state's own, so the same object in two states tells each
  const bump = () => {
    version++;
    changed();
  };
  const deep = (value) => {
    if (!value || typeof value !== "object" || !(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) return value;
    let proxy = proxies.get(value);
    if (!proxy) {
      proxy = new Proxy(value, {
        get: (target, key, receiver) => deep(Reflect.get(target, key, receiver)),
        set: (target, key, next, receiver) => {
          const same = Object.is(target[key], next);
          const done = Reflect.set(target, key, next, receiver);
          if (!same) bump();
          return done;
        },
        deleteProperty: (target, key) => {
          const done = Reflect.deleteProperty(target, key);
          bump();
          return done;
        },
      });
      proxies.set(value, proxy);
    }
    return proxy;
  };
  let value = deep(initial);
  const read = () => version;
  return {
    get value() {
      @reads?.push(read);
      return value;
    },
    set value(next) {
      if (Object.is(next, value)) return;
      value = deep(next);
      bump();
    },
    get() {
      return this.value;
    },
    set(next) {
      this.value = next;
    },
  };
}

//@@ createComputed: reads
/** A value derived from props and state, cached until something it read changes. */
function @createComputed(compute) {
  let seen = null; // [read again, the value it gave]
  let value;
  return {
    get value() {
      if (!seen || !seen.every(([read, last]) => Object.is(read(), last))) {
        const outer = @reads;
        const collected = (@reads = []);
        try {
          value = compute();
        } finally {
          @reads = outer;
          seen = collected.map((read) => [read, read()]);
        }
      }
      if (@reads) for (const [read] of seen) @reads.push(read); // what reads this depends on what it read
      return value;
    },
    get() {
      return this.value;
    },
  };
}

//@@ live:
/** A value that's read fresh each time (what hasSlot() and hydrated() give). */
function @live(read) {
  return {
    get value() {
      return read();
    },
    get() {
      return read();
    },
  };
}

//@@ ids:
let @ids = 0; // for id(): unique on the page

//@@ apple:
// .mod is ⌘ on Apple platforms and Ctrl elsewhere.
const @apple = /mac|iphone|ipad|ipod/i.test(globalThis.navigator?.platform ?? "");

//@@ slotted: insert
// Light-DOM slots: the page's children for this element, sorted by their slot attribute.
const @isContent = (node) => node.nodeType === 1 || (node.nodeType === 3 && node.data.trim() !== "");
// Content an outer component passed on to one of this element's slots (`<frame-box><zb-slot
// name="y">` in its template) keeps its own `slot` ("y"); the outer one puts `{ to, slot }` under
// this shared symbol, and `to`, this element, routes it by that. Every other host reads the attribute.
const @forward = Symbol.for("zubra.forward");
const @slotName = (node, host) => (node[@forward]?.to === host ? node[@forward].slot : (node.nodeType === 1 && node.getAttribute("slot")) || "default");

/**
 * The slot for each child: by its slot attribute. A framework's markers (comments, whitespace, a
 * pair of empty text nodes) go with the content they belong to.
 */
function @assignSlots(nodes, host) {
  const named = nodes.map((node) => (@isContent(node) ? @slotName(node, host) : null));
  const near = (i, step) => {
    for (let j = i + step; nodes[j]; j += step) if (named[j]) return named[j];
    return null;
  };
  const open = [];
  nodes.forEach((node, i) => {
    if (node.nodeType !== 3 || node.data) return;
    if (!open.length || (named[i + 1] && nodes[i + 1].data == null)) return open.push(i);
    const start = open.pop();
    named[start] = named[i] = named.slice(start + 1, i).find(Boolean);
  });
  return nodes.map((node, i) => named[i] ?? (node.nodeType === 8 ? near(i, 1) ?? near(i, -1) : near(i, -1) ?? near(i, 1)) ?? "default");
}

// The default slot's nodes are also the page's children in order: an element for another slot
// leaves a stand-in there, a comment where the page put it. A framework that removes a run of
// siblings (Vue a fragment, Svelte and Lit a block) walks from sibling to sibling, which can't
// reach an element that was moved to another slot; it does reach the stand-in, and the element
// goes when its stand-in does.
const @standIns = new WeakMap(); // an element in a named slot → its stand-in
const @standsFor = new WeakMap(); // a stand-in → its element
function @standIn(node) {
  let comment = @standIns.get(node);
  if (!comment) {
    comment = document.createComment("zb-slot");
    @standIns.set(node, comment);
    @standsFor.set(comment, node);
  }
  return comment;
}
function @dropStandIn(node) {
  @standsFor.delete(@standIns.get(node));
  @standIns.delete(node);
}

//@@ class:slots: slotted move
  // ---- slots
  // Light DOM has no <slot>, so this element places the page's children itself: each slot's
  // nodes, in order, between its two markers, or the fallback while it has none. Until a slot is
  // shown (or while it's in a zb-if branch that's off), its nodes wait in a fragment, its park.

  #slots = new Map(); // name → { name, nodes, region, park }
  #observer = null;

  #slot(name) {
    let record = this.#slots.get(name);
    if (!record) {
      record = { name, nodes: [], region: null, park: document.createDocumentFragment() };
      this.#slots.set(name, record);
      this.#observer?.observe(record.park, { childList: true });
    }
    return record;
  }
  #collectSlots() {
    const children = [...this.childNodes];
    @assignSlots(children, this).forEach((name, i) => {
      this.#warnSlot(name, children[i]);
      const record = this.#slot(name);
      record.nodes.push(children[i]);
      record.park.append(children[i]);
      // An element for a named slot keeps its place among the page's children.
      if (name !== "default" && @isContent(children[i])) {
        const home = this.#slot("default");
        home.nodes.push(@standIn(children[i]));
        home.park.append(@standIn(children[i]));
      }
    });
  }
  /**
   * A slot between `start` and `end`, showing its nodes or `fallback()`. `into`: the slot sits
   * right inside a light-DOM child's tag, in that child's slot of this name; what it shows is
   * passed on there (see @slotName).
   */
  #slotRegion(start, end, name, fallback, into = null) {
    const record = this.#slot(name);
    let passing = [];
    let label = null; // `{ to: the child, slot }`, on every node passed on
    const pass = (nodes) => {
      if (!into) return;
      label ??= { to: start.parentNode, slot: into };
      for (const node of passing) if (!nodes.includes(node) && node[@forward] === label) delete node[@forward];
      for (const node of nodes) node[@forward] = label;
      passing = [...nodes];
    };
    const region = {
      start,
      end,
      provided: false,
      fallback: null,
      update: (keep = null) => {
        // Content a framework removed through its real parent (Vue does) has left, even before the
        // MutationObserver says so: it mustn't be put back.
        const left = record.nodes.filter((node) => node !== keep && node.parentNode !== start.parentNode && node.parentNode !== record.park);
        if (left.length) {
          record.nodes = record.nodes.filter((node) => !left.includes(node));
          for (const node of left) this.#lose(node);
        }
        region.provided = record.nodes.some(@isContent);
        if (region.provided) {
          if (region.fallback) {
            while (start.nextSibling !== end) start.nextSibling.remove();
            region.fallback = null;
          }
          let cursor = start.nextSibling;
          for (const node of record.nodes) {
            this.#mark(node);
            if (node === cursor) cursor = cursor.nextSibling;
            else @move(start.parentNode, node, cursor);
          }
          pass(record.nodes);
          return;
        }
        // Only markers and whitespace (a framework's bookkeeping): they wait in the park, where the
        // framework can still add content next to them, while the fallback shows.
        if (record.nodes.length) record.park.append(...record.nodes);
        pass([]);
        if (fallback && !region.fallback) {
          while (start.nextSibling !== end) start.nextSibling.remove();
          const block = fallback();
          block.update();
          @insert(end.parentNode, block.nodes, end);
          region.fallback = block.update;
        }
        region.fallback?.();
      },
    };
    record.region = region;
    return () => {
      record.region = region;
      region.update();
    };
  }
  #mark(node) {
    if (@@styled && node.nodeType === 1) node.setAttribute("data-zb-slotted", this.localName);
  }
  #unmark(node) {
    if (@@styled && node.nodeType === 1 && node.getAttribute("data-zb-slotted") === this.localName) node.removeAttribute("data-zb-slotted");
  }
  #warnSlot(name, node) {
    if (@isContent(node) && !@@slots.includes(name)) console.warn(`zubra: <${this.localName}> has no slot named "${name}"; that content is not shown`);
  }
  #holding(node) {
    for (const record of this.#slots.values()) if (record.nodes.includes(node)) return record;
    return null;
  }
  // `node` left its slot. A stand-in takes its element with it, and an element its stand-in.
  #lose(node) {
    this.#unmark(node);
    const other = @standsFor.get(node) ?? @standIns.get(node);
    if (!other) return;
    @dropStandIn(@standsFor.has(node) ? other : node);
    const record = this.#take(other);
    this.#unmark(other);
    other.remove();
    if (record) this.#show(record);
  }
  // Drops content that left through its real parent (or was moved elsewhere), except `keep`.
  #show(record, keep) {
    const parent = record.region?.provided ? record.region.start.parentNode : record.park;
    const left = record.nodes.filter((node) => node !== keep && node.parentNode !== parent);
    if (left.length) {
      record.nodes = record.nodes.filter((node) => !left.includes(node));
      for (const node of left) this.#lose(node);
    }
    if (record.region) record.region.update(keep);
    else record.park.append(...record.nodes);
    this.#requestUpdate(); // hasSlot() and the rest may have changed
  }
  #take(node) {
    const record = this.#holding(node);
    if (record) record.nodes.splice(record.nodes.indexOf(node), 1);
    return record;
  }
  #route(node, before) {
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.#route(child, before);
      return;
    }
    this.#watch(node);
    const content = @isContent(node);
    // A marker or whitespace goes in the slot of what it's inserted before.
    const name = content ? @slotName(node, this) : (before && this.#holding(before)?.name) || "default";
    this.#warnSlot(name, node);
    const record = this.#slot(name);
    const home = this.#slot("default");
    const from = this.#take(node);
    // Among the page's children it goes before `before`, or last: so does its stand-in.
    let comment = @standIns.get(node);
    if (comment) this.#take(comment);
    const put = (slot, item, ref) => {
      const at = ref ? slot.nodes.indexOf(ref) : -1;
      slot.nodes.splice(at < 0 ? slot.nodes.length : at, 0, item);
    };
    const seat = before && (@standIns.get(before) ?? before);
    if (record === home) {
      if (comment) {
        @dropStandIn(node);
        comment.remove();
      }
      put(home, node, seat);
    } else {
      put(record, node, before);
      if (content) put(home, (comment = @standIn(node)), seat);
    }
    // (The stand-in is placed before anything else looks at the default slot: one that isn't
    // where it belongs reads as removed.)
    this.#show(record, node);
    const seated = record !== home && content;
    if (seated) this.#show(home, comment);
    if (from && from !== record && !(seated && from === home)) this.#show(from);
  }
  // Content that is in the wrong slot goes to its own, and keeps its place among the page's children.
  #reslot(node) {
    const home = this.#slot("default");
    const at = home.nodes.indexOf(@standIns.get(node) ?? node);
    this.#route(node, (at >= 0 && home.nodes[at + 1]) || null);
  }
  #remove(node) {
    const record = this.#take(node);
    if (!record) return false;
    node.remove();
    this.#lose(node);
    this.#show(record);
    return true;
  }
  #clearSlots() {
    for (const record of this.#slots.values()) {
      for (const node of record.nodes.splice(0)) {
        this.#unmark(node);
        node.remove();
      }
      this.#show(record);
    }
  }
  /** A zb-if branch is going away: the slotted content inside it waits in the parks. */
  #parkSlotsIn(start, end) {
    for (const record of this.#slots.values()) {
      const region = record.region;
      if (!region) continue;
      let inside = false;
      for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
        if (node === region.start || node.contains?.(region.start)) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      record.region = null;
      record.park.append(...record.nodes);
    }
  }
  // A slot's text node is content only while it has words (Angular creates {{ }} text empty and
  // fills it afterwards): hear when that changes.
  #watch(node) {
    if (node.nodeType === 3) this.#observer?.observe(node, { characterData: true });
  }
  // Content removed or moved through its real parent (Vue removes via parentNode; Lit and Svelte
  // change content next to their markers), content whose slot attribute changed, and text that
  // was written.
  #observe() {
    this.#observer = new MutationObserver((records) => {
      const written = new Set();
      for (const record of records) {
        if (record.type === "characterData") written.add(record.target);
        const slot = record.type === "attributes" && this.#holding(record.target);
        if (slot && @slotName(record.target, this) !== slot.name) this.#reslot(record.target);
        // Solid clears a run of nodes one by one, skipping those that aren't where the first is
        // (an element moved to its slot), and puts an empty text node in the first one's place:
        // the stand-ins right after that node are the rest of the run.
        const [added] = record.addedNodes;
        if (record.removedNodes.length === 1 && record.addedNodes.length === 1 && added.nodeType === 3 && !added.data) {
          while (@standsFor.has(added.nextSibling)) added.nextSibling.remove();
        }
      }
      // Svelte removes a block from its first node to its last, sibling by sibling. When the last
      // is an element that was moved to another slot, the walk never meets it and carries on to
      // the end of the parent, taking the block's own anchor, this slot's closing marker and what
      // this element rendered after it. Those go back: everything from the first comment after a
      // stand-in (the anchor), or else from the closing marker.
      for (const { region } of this.#slots.values()) {
        const parent = region?.start.parentNode;
        if (!parent || region.end.parentNode === parent) continue;
        const gone = records.filter((record) => record.target === parent).flatMap((record) => [...record.removedNodes]);
        let cut = gone.indexOf(region.end);
        for (let i = 0, seen = false; i < cut; i++) {
          if (@standsFor.has(gone[i])) seen = true;
          else if (seen && gone[i].nodeType === 8) cut = i;
        }
        if (cut >= 0) for (const node of gone.slice(cut)) if (!node.parentNode) @insert(parent, node, null);
      }
      for (const slot of this.#slots.values()) {
        let actual;
        if (slot.region?.provided) {
          actual = [];
          for (let node = slot.region.start.nextSibling; node && node !== slot.region.end; node = node.nextSibling) actual.push(node);
        } else {
          actual = [...slot.park.childNodes];
        }
        if (actual.length === slot.nodes.length && actual.every((node, i) => node === slot.nodes[i])) {
          if (!slot.nodes.some((node) => written.has(node))) continue;
        } else {
          const left = slot.nodes.filter((node) => !actual.includes(node));
          slot.nodes = actual;
          for (const node of left) this.#lose(node);
          for (const node of actual) this.#watch(node);
        }
        // Content that belongs to another slot goes there: an element added next to a marker
        // here, or text that was a marker while it was empty. (A copy: moving one takes it out.)
        for (const node of [...slot.nodes]) if (@isContent(node) && @slotName(node, this) !== slot.name) this.#reslot(node);
        this.#show(slot);
      }
    });
    this.#observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["slot"] });
    for (const record of this.#slots.values()) {
      this.#observer.observe(record.park, { childList: true });
      for (const node of record.nodes) this.#watch(node);
    }
  }

  // Frameworks keep managing what they gave the element through the element itself (React calls
  // insertBefore and removeChild on it, Preact 11 moveBefore, Vue sets textContent): once it has
  // started, those go to the slots.
  insertBefore(node, before) {
    if (!this.#started) return super.insertBefore(node, before);
    this.#route(node, before ?? null);
    return node;
  }
  // Preact 11 reorders a keyed child with moveBefore() where the browser has it: the node goes
  // where an insert would put it, and one already in its slot is moved there with its state kept.
  // Defined only where the browser has the method, since frameworks ask for it by name.
  static {
    const native = Element.prototype.moveBefore;
    if (typeof native === "function") {
      this.prototype.moveBefore = function (node, before) {
        if (!this.#started) return native.call(this, node, before);
        this.#route(node, before ?? null);
      };
    }
  }
  appendChild(node) {
    if (!this.#started) return super.appendChild(node);
    this.#route(node, null);
    return node;
  }
  append(...items) {
    if (!this.#started) return super.append(...items);
    for (const item of items) this.#route(item instanceof Node ? item : document.createTextNode(String(item)), null);
  }
  removeChild(node) {
    if (this.#started && this.#remove(node)) return node;
    return super.removeChild(node);
  }
  replaceChild(node, old) {
    if (!this.#started || !this.#holding(old)) return super.replaceChild(node, old);
    this.#route(node, old);
    this.#remove(old);
    return old;
  }
  replaceChildren(...items) {
    if (!this.#started) return super.replaceChildren(...items);
    this.#clearSlots();
    this.append(...items);
  }
  // The page's first child, wherever its slot is: what a framework that reads it means (Solid
  // writes a lone text child through it).
  get firstChild() {
    if (!this.#started) return super.firstChild;
    const [first] = this.#slot("default").nodes;
    return first ? @standsFor.get(first) ?? first : null;
  }
  get textContent() {
    return super.textContent;
  }
  set textContent(value) {
    if (!this.#started) {
      super.textContent = value;
      return;
    }
    this.#clearSlots();
    if (value != null && value !== "") this.#route(document.createTextNode(String(value)), null);
  }
  get innerHTML() {
    return super.innerHTML;
  }
  set innerHTML(value) {
    if (!this.#started) {
      super.innerHTML = value;
      return;
    }
    this.#clearSlots();
    const template = document.createElement("template");
    template.innerHTML = value;
    this.#route(document.importNode(template.content, true), null);
  }
