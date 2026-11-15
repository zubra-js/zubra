// The route table: which component answers which path. Pure (no files, no compiler), so the
// rules are tested on their own and an edge entry can build the same table later.
//
// A page says where it lives with 'use route /farms/:id', or, in a `routes/` folder, with a
// bare 'use route' and its place in the folder (`routes/farms/[id].zb` is `/farms/:id`).
// Both make the same table. Matching is URLPattern's pathname syntax.
//
// A layout wraps the pages under its prefix, the page in its default <zb-slot>: `app.zb` wraps
// every page, 'use layout /farm' (or `routes/farm/layout.zb` with a bare 'use layout') wraps
// /farm and everything below it, and they nest. 'use layout /farm root' starts over there:
// its pages aren't inside `app.zb` or any layout above it.

/** The component that is the app's shell, the outermost layout, when there is one. */
export const APP = 'app';

/** The folder `routes/` pages live in, relative to the components folder. */
export const ROUTES = 'routes';

/**
 * The path a component's place in `routes/` gives it, or null outside the folder:
 * `routes/index` → `/`, `routes/farms/[id]` → `/farms/:id`, `routes/docs/[...path]` → `/docs/:path*`.
 */
export function folderPattern(name, kind = 'page') {
  const parts = name.split('/');
  if (parts[0] !== ROUTES || parts.length < 2) return null;
  const segments = parts.slice(1);
  // A layout's prefix is its folder (`routes/farm/layout` → `/farm`); any other name isn't one.
  if (kind === 'layout') {
    if (segments.at(-1) !== 'layout') return null;
    segments.pop();
  } else if (segments.at(-1) === 'index') segments.pop();
  const pattern = segments.map((segment) => {
    const rest = /^\[\.\.\.([A-Za-z_$][\w$]*)\]$/.exec(segment);
    if (rest) return `:${rest[1]}*`;
    const param = /^\[([A-Za-z_$][\w$]*)\]$/.exec(segment);
    if (param) return `:${param[1]}`;
    if (/[[\]:*?(){}]/.test(segment)) throw new RouteError(`${name}: a folder or file name in ${ROUTES}/ is plain text or one [param] (\`[id]\`, \`[...path]\`), not \`${segment}\``);
    return segment;
  });
  return `/${pattern.join('/')}`;
}

/** The named parameters of a pathname pattern, in order (`:id`, `:path*`). */
export function patternParams(pattern) {
  return [...pattern.replace(/\\./g, '').matchAll(/:([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
}

export class RouteError extends Error {
  constructor(message) {
    super(`@zubra/router: ${message}`);
    this.name = 'RouteError';
  }
}

/**
 * The table from what each component's interface says.
 *
 * `entries`: `[{ name, file, props: ['id', …], route: { kind, pattern, params, root, load, reads } }]`
 * for every component that is a route or a layout (`file` is for messages).
 * Returns `{ pages: [{ name, pattern, params, load }], layouts: [...] }`, pages ordered so the
 * most specific pattern is tried first.
 */
export function buildTable(entries) {
  const pages = [];
  const layouts = [];
  for (const entry of entries) {
    const { name, file = name, props = [], slots } = entry;
    // `app.zb` is the shell whether or not it says so; it can say 'use layout /' to have a `load`.
    const route = entry.route ?? (name === APP ? { kind: 'layout', pattern: '/' } : null);
    if (!route) continue;
    if (name === APP && (route.kind !== 'layout' || (route.pattern ?? '/') !== '/')) {
      throw new RouteError(`${file} is the app's shell, the layout around every page: it can say 'use layout /' (to export \`load\`), not 'use ${[route.kind === 'layout' ? 'layout' : 'route', route.pattern].filter(Boolean).join(' ')}'`);
    }
    const layout = route.kind === 'layout';
    const word = layout ? 'layout' : 'route';
    const fromFolder = folderPattern(name, route.kind);
    let pattern = route.pattern ?? (name === APP ? '/' : null);
    if (layout && slots && !slots.includes('default')) {
      throw new RouteError(`${file} is a layout with nowhere for its page: put \`<zb-slot></zb-slot>\` where the page goes`);
    }
    if (pattern == null) {
      if (fromFolder == null) {
        throw new RouteError(layout
          ? `${file} says 'use layout' with no prefix, and isn't a layout.zb in a ${ROUTES}/ folder: name its prefix ('use layout /farm'), or make it ${ROUTES}/farm/layout.zb`
          : `${file} says 'use route' with no path, and isn't in a ${ROUTES}/ folder: name its path ('use route /farms/:id'), or move it to ${ROUTES}/`);
      }
      pattern = fromFolder;
      // The compiler checked a written path's parameters; a folder's are checked here.
      for (const param of patternParams(pattern)) {
        const read = props.includes(param) || (route.load && (route.reads == null || route.reads.includes(param)));
        if (!read) throw new RouteError(`${file} is ${pattern}, whose parameter \`${param}\` neither \`load\` nor a prop reads`);
      }
    } else if (fromFolder != null && fromFolder !== pattern) {
      throw new RouteError(`${file} says 'use ${word} ${pattern}', but its place in ${ROUTES}/ makes it ${fromFolder}: drop the path from the directive, or move the file`);
    }
    (layout ? layouts : pages).push({ name, file, pattern, params: patternParams(pattern), load: Boolean(route.load), root: Boolean(route.root) });
  }
  for (const list of [pages, layouts]) {
    const seen = new Map();
    for (const entry of list) {
      const other = seen.get(entry.pattern);
      if (other) throw new RouteError(`${other.file} and ${entry.file} are both ${list === pages ? 'routes' : 'layouts'} for ${entry.pattern}`);
      seen.set(entry.pattern, entry);
    }
  }
  pages.sort((a, b) => compareSpecificity(a.pattern, b.pattern));
  layouts.sort((a, b) => segmentsOf(a.pattern).length - segmentsOf(b.pattern).length);
  for (const page of pages) {
    // `around`: every layout over the page's path; `layouts`: those it is rendered inside.
    page.around = layoutsAround(page.pattern, layouts).map((layout) => layout.name);
    page.layouts = layoutsFor(page.pattern, layouts).map((layout) => layout.name);
  }
  return { pages, layouts };
}

const segmentsOf = (pattern) => pattern.split('/').filter(Boolean);

/**
 * The layouts around a page, outermost first: every layout whose prefix is the start of the
 * page's path, segment for segment (`/farm` is around `/farm` and `/farm/stock`, not
 * `/farmers`), from the innermost `root` one inwards.
 */
export function layoutsFor(pattern, layouts) {
  return fromRoot(layoutsAround(pattern, layouts));
}

/** Every layout whose prefix is the start of the path, outermost first, `root` ones or not. */
export function layoutsAround(pattern, layouts) {
  const path = segmentsOf(pattern);
  return layouts
    .filter((layout) => segmentsOf(layout.pattern).every((segment, index) => path[index] === segment))
    .sort((a, b) => segmentsOf(a.pattern).length - segmentsOf(b.pattern).length);
}

/** A list of layouts, outermost first, from its innermost `root` one. */
export function fromRoot(around) {
  const from = around.findLastIndex((layout) => layout.root);
  return from > 0 ? around.slice(from) : around;
}

// Static segments before parameters before wildcards, segment by segment; then longer first.
const rank = (segment) => (segment.includes('*') ? 2 : segment.includes(':') ? 1 : 0);
function compareSpecificity(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = rank(left[i]) - rank(right[i]);
    if (difference) return difference;
  }
  return right.length - left.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** A matcher over the pages: `match(pathname)` → `{ page, params }` or null. */
export function matcher(pages, URLPatternClass) {
  const compiled = pages.map((page) => ({ page, pattern: new URLPatternClass({ pathname: page.pattern }) }));
  return (pathname) => {
    for (const { page, pattern } of compiled) {
      const found = pattern.exec({ pathname });
      if (found) {
        const params = {};
        for (const [key, value] of Object.entries(found.pathname.groups)) if (value !== undefined) params[key] = value;
        return { page, params };
      }
    }
    return null;
  };
}
