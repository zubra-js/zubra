// Size budgets: the runtime as an app ships it (bundled, minified, compressed). A budget is
// raised only on purpose, in the same change as what needed the bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGETS = {
  // Everything, the Signals implementation included. (12 KB until 2.7, whose progressive
  // enhancement — hydrated(), the .submit and .mod modifiers, the missing-markers warning — took
  // it to 12.5 KB, and 2.8's server bridge — reading `zb-props`, dropping form fallbacks — to
  // 13 KB, and 3.2's deep reactivity — a state's arrays and objects update the DOM when
  // mutated, `deep.js`, about 370 B — to 13.5 KB, and 4.2's zb-await — an array value waited
  // for together, retry(), delay and keep, about 320 B — to 14 KB, and the DevTools hook's
  // recording side — what each effect binds, each flush, each listener, about 490 B; its reading
  // side loads only when the extension connects — to 14.5 KB. The production build has none of it.
  // And `animate`'s hooks in zb-if and zb-each — about 160 B; leave() and glide() themselves are
  // `src/motion.js`, loaded only by components that animate — to 15 KB, and the list work for
  // the js-framework-benchmark — a keyed zb-each moving only the rows out of order, about 125 B —
  // to 15.25 KB. Clearing a list that is all its parent holds by emptying the parent, about
  // 120 B more, fits within it. The faster Signals core — getPending() in O(pending), nodes in
  // private fields, lazy arrays and children, about 420 B — took it to 15.75 KB, and rows put on
  // the page without markers, cloned from a copy already in the document, with text written in
  // place, about 100 B, to 16 KB. Keeping what someone did to a form before the element started,
  // about 90 B, to 16.25 KB. Watching a slot's own text nodes, so text a framework writes after
  // creating it empty (Angular's `{{ }}`) is slotted, about 90 B, to 16.5 KB; the production
  // build's budget didn't move. Light-DOM slots that hold up in Vue, Svelte and Solid — the
  // page's children kept in order, a stand-in where each element for a named slot belongs, so a
  // run of siblings a framework removes takes those elements with it, and `host.firstChild` —
  // about 450 B, to 17 KB. Interface 4's $element and binders beside $define, which fills in
  // binders for interface 2 and 3 parts, about 100 B, to 17.25 KB: this entry has both, an app
  // only one, since interface 4 output doesn't import $define. $pageStyles, about 190 B, to 17.5 KB:
  // what @zubra/unplugin's light-DOM components import in place of their CSS as text, which
  // takes 0.55 KB off each of the comparison's hosts. Event modifiers in a module of their own,
  // modifiers.js, about 90 B here, to 17.75 KB: a component whose listeners have none no longer
  // carries them, 0.34 KB off the comparison's six. Window listeners, class lists and toggles,
  // style properties and URL checks (parts.js) and the shadow path (shadow.js) named by the output
  // that has them, about 90 B here, to 18 KB: this entry has them all, and each of the
  // comparison's hosts is 0.42 to 0.46 KB smaller. A list's rows found by the places their
  // template's first copy had, a one-element row copied without a fragment, and a list watching
  // its array through one signal, about 230 B, to 18.25 KB: a fifth less script time to create,
  // replace and append 1,000 rows. A named slot passed on to a child component's slot (the
  // content routed by the slot it was passed on to, not its own `slot`), about 60 B, to 18.5 KB.
  // 5.x's TC39 names that the default engine doesn't have (`Signal.subtle.Watcher`, `watched`, the
  // introspection functions) saying so and pointing to signals mode, about 300 B, to 18.75 KB:
  // development only, the production build is byte for byte the same. A dynamic `style:` value
  // that isn't one CSS value is left off, the same check a spread already makes; the pattern is
  // new in this entry, about 30 B, to 18.875 KB. Hydration adopts server markup only when every
  // element's markers, static text and unbound attributes match the template, about 200 B, to
  // 19.25 KB. An adopted element also loses an event handler, srcdoc or ping, about 40 B, to
  // 19.3 KB.)
  'src/index.js': { gzip: 19.3 * 1024 },
  // The production build (the `production` export condition): the same, without hot reloading
  // (12.5 KB until 3.2, 13 KB until 4.2, 13.5 KB until `animate`, 14 KB until the list work,
  // 14.25 KB until the faster Signals core, 14.75 KB until rows without markers, 15 KB until
  // form input kept through hydration, 15.25 KB until slots' stand-ins, 15.75 KB until 5.17, whose
  // messages are only in development, about 0.7 KB; 15.25 KB until a light-DOM component without
  // slots kept the page's children in a fragment of its own, beside the slot router a component
  // with slots now imports, about 170 B here: this entry has both, an app with no slotted
  // component ships about 1.2 KB less; 15.5 KB until $pageStyles and modifiers.js, optional modules
  // in this entry, about 0.25 KB together, which take 0.55 and 0.34 KB off the apps that don't use
  // what they replace; 15.75 KB until parts.js and shadow.js, about 90 B here, 0.42 to 0.46 KB
  // off each of the comparison's hosts; 16 KB until the signal graph's and an effect owner's
  // private fields got short names in this build, about 150 B, which brought it back under; 15.75
  // KB until content given to a slot a child has in more than one branch was checked against the
  // branch the server rendered, about 70 B, 3 B over: this entry has every optional module, and
  // what a server sends, zubra.js, stays under its own budget; 16 KB until a list's rows were
  // found by remembered places, about 230 B; 16.25 KB until server markup is adopted only when it
  // matches the template, about 200 B).
  'dist/production/index.js': { gzip: 16.5 * 1024 },
  // An app that only uses Signals and effects.
  'src/effect.js': { gzip: 4 * 1024 },
  // `animate`'s leave() and glide(), loaded only by components that animate.
  'src/motion.js': { gzip: 1.25 * 1024 },
  // `tracked()`: reads after an `await` in a resource's fetcher, loaded only by components with
  // an async fetcher.
  'src/track.js': { gzip: 0.75 * 1024, external: ['./signal.js', './effect.js'] },
  // `{...spread}`'s binder (3.5), loaded only by components whose template spreads. (1.5 KB until
  // spread onto a Zubra component — its props as props, unset when their key goes, about 110 B.)
  // 1.75 KB until the second security audit: a spread may not set an animation's values or
  // target, a <meta>'s http-equiv, or ping (about 100 B). 1.875 KB until a meta with http-equiv
  // also refuses content, and a style value refuses image() and image-set() (about 60 B).
  'src/spread.js': { gzip: 2 * 1024, external: ['./element.js', './effect.js'] },
  // rovingFocus and typeahead (3.6), for menus, tab lists and toolbars.
  'src/primitives.js': { gzip: 1.25 * 1024 },
  // The Zag adapter (3.6), without Zag itself (an app's dependency, like the machines).
  'src/zag.js': { gzip: 0.5 * 1024, external: ['./element.js', '@zag-js/vanilla'] },
};

for (const [entry, budget] of Object.entries(BUDGETS)) {
  test(`${entry} fits its budget`, async (t) => {
    // Split as a bundler would: remark.js (stripped markup) is imported only when needed.
    // `external`: modules the entry shares with the main runtime, which an app already has.
    const shared = { name: 'shared', setup(build) { build.onResolve({ filter: /.*/ }, (args) => (budget.external?.includes(args.path) ? { path: args.path, external: true } : undefined)); } };
    const result = await build({ entryPoints: { entry: join(here, '../..', entry) }, bundle: true, splitting: true, outdir: '/out', minify: true, format: 'esm', write: false, logLevel: 'silent', plugins: [shared], metafile: true });
    // The entry and the chunks it imports statically: code a lazily loaded module shares with
    // the entry lands in a chunk of its own, and is still shipped up front.
    const outputs = result.metafile.outputs;
    const loaded = new Set();
    const load = (path) => {
      if (loaded.has(path)) return;
      loaded.add(path);
      for (const { path: next, kind } of outputs[path].imports) if (kind === 'import-statement' && outputs[next]) load(next);
    };
    load(Object.keys(outputs).find((path) => path.endsWith('/entry.js')));
    const names = new Set([...loaded].map((path) => path.split('/').pop()));
    const files = result.outputFiles.filter((file) => names.has(basename(file.path)));
    const code = Buffer.concat(files.map((file) => file.contents));
    assert.ok(code.length, `${entry}: no output found`);
    const gzip = gzipSync(code).length;
    t.diagnostic(`${entry}: ${code.length} B minified, ${gzip} B gzip, ${brotliCompressSync(code).length} B brotli`);
    assert.ok(gzip <= budget.gzip, `${gzip} B gzip > ${budget.gzip} B`);
  });
}

// What a framework adapter adds to an app that uses only `wrap()` (what a `.zb` import in a
// `.jsx` or `.vue` file compiles to): the framework and the runtime's core are the app's
// already. The server half (`server.js`) and `<zb-context>` are not in it: the first registers
// itself where a server build loads it, the second is defined when a `ZubraContext` is rendered.
// (React's includes `<zb-outlet>`, which `wrap()` itself fills.)
const ADAPTERS = {
  'dist/production/react.js': { gzip: 2 * 1024, external: ['react', 'react-dom', 'react-dom/client'] },
  'dist/production/vue.js': { gzip: 1.5 * 1024, external: ['vue'] },
};

for (const [entry, budget] of Object.entries(ADAPTERS)) {
  test(`${entry}: wrap() alone fits its budget, without the server half or <zb-context>`, async (t) => {
    const core = ['element.js', 'effect.js', 'signal.js', 'signal-impl.js', 'deep.js', 'resource.js', 'index.js'];
    const shared = { name: 'shared', setup(build) { build.onResolve({ filter: /.*/ }, (args) => (budget.external.includes(args.path) || core.includes(args.path.replace(/^\.\//, '')) ? { path: args.path, external: true } : undefined)); } };
    const result = await build({ stdin: { contents: `export { wrap } from ${JSON.stringify(join(here, '../..', entry))};`, resolveDir: here }, bundle: true, minify: true, format: 'esm', write: false, logLevel: 'silent', plugins: [shared] });
    const code = result.outputFiles[0].text;
    const gzip = gzipSync(code).length;
    t.diagnostic(`${entry} (wrap): ${code.length} B minified, ${gzip} B gzip`);
    assert.ok(gzip <= budget.gzip, `${gzip} B gzip > ${budget.gzip} B`);
    assert.ok(!code.includes('shadowrootmode') && !code.includes('data-zb-fallback'), 'no server rendering code');
    assert.ok(!code.includes('zb-context'), 'no <zb-context> element');
  });
}

// What a server without a bundler sends (`@zubra/server` in production): `dist/production` as it
// is, each module its own file, compressed one by one, from the core it maps `@zubra/runtime` to;
// a page adds the binders its components import. 38.4 KB before the production build was
// minified (5.14); 17.9 KB after; 17.2 KB once zb-await's binder, the slot router and $define
// were files of their own, which a page loads only if its components use them (5.18); 18.2 KB
// once event modifiers and form controls were modules of their own too (so a bundler leaves them
// out), two more files in the core's graph. @zubra/server sends the core as one file in
// production (dist/bundled/zubra.js), so this is for a server without a bundler that doesn't.
// 18.75 KB until parts.js and shadow.js (the less common parts and the shadow path, 5.20), two
// more files in the core's graph: element.js 0.4 KB smaller, the two 1.1 KB, since small files
// compress worse on their own (as one file, zubra.js, they cost 60 B). 19.5 KB until a list's
// rows were found by remembered places (about 230 B, in blocks.js and deep.js).
//
// Since the split, what every page loads is base.js and its imports, and core.js (the whole
// script API: the base, context, form helpers, event helpers, shadow roots, resource()) is what a
// page's own script gets from the bare `@zubra/runtime`. So there are two figures. The base:
// 15.9 KB, where every page loaded 19.5. The whole: 20.3 KB, 0.55 KB over what it was, since the
// helpers are two more files (provide.js, and base.js itself) and small files compress worse.
// 20.5 KB until hydration compares static text only, about 40 B, then skips a child
// component's rendered tree, about 15 B more.
const SERVED = 16 * 1024;
const SERVED_WHOLE = 20.75 * 1024;

for (const [entry, budget, what] of [['base.js', SERVED, 'what every page loads'], ['core.js', SERVED_WHOLE, 'the whole script API']]) {
  test(`dist/production as served fits its budget: ${what}`, (t) => {
    const dir = join(here, '../../dist/production');
    const sizes = new Map();
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop();
      if (sizes.has(file)) continue;
      const code = readFileSync(join(dir, file), 'utf8');
      sizes.set(file, gzipSync(code).length);
      for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+)["']/g)) queue.push(match[1]);
    }
    const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    t.diagnostic(`dist/production/${entry} and its ${sizes.size - 1} imports: ${total} B gzip, file by file`);
    assert.ok(total <= budget, `${total} B gzip > ${budget} B`);
  });
}

// The same as one file (`dist/bundled/zubra.js`, what `@zubra/server` sends with `bundle`): the
// modules compress together. 18.6 KB file by file, 16.0 KB as one (5.15); 13.6 KB once zb-await's
// binder, the slot router and $define were files of their own (5.18), which a page loads only if
// its components use them. 14 KB until parts.js and shadow.js (5.20): what a component names
// instead of every element carrying it, about 60 B here, where the core has them all, for 0.42 to
// 0.46 KB off a bundled app. 14.25 KB until private fields got short names in the production
// build, about 145 B. 14 KB until a list's rows were found by remembered places, about 230 B.
// 14.25 KB until a named slot could be passed on to a child component's slot, about 60 B.
// 14.5 KB until server markup is adopted only when it matches the template, about 40 B here.
// 14.625 KB until that check skips a child component's own tree, about 60 B.
const BUNDLED = 14.75 * 1024;

test('dist/bundled/zubra.js fits its budget, under the file-by-file build', (t) => {
  const size = gzipSync(readFileSync(join(here, '../../dist/bundled/zubra.js'), 'utf8')).length;
  t.diagnostic(`dist/bundled/zubra.js: ${size} B gzip`);
  assert.ok(size <= BUNDLED, `${size} B gzip > ${BUNDLED} B`);
});

// `dist/split/zubra.js` (what `@zubra/server` sends since the split): the base alone. Context,
// form controls and their helpers, event modifiers and theirs, shadow roots and resource() are
// files beside it (0.6 to 1.2 KB each), which a page loads only if its components name them.
// 11.7 KB where the whole was 14.3: 2.6 KB less for a page that names none.
const SPLIT = 12 * 1024;
const BESIDE = { 'provide.js': 900, 'modifiers.js': 1100, 'form.js': 1250, 'shadow.js': 650, 'resource.js': 700 };

test('dist/split: the base and each file beside it fit their budgets', (t) => {
  const size = (file) => gzipSync(readFileSync(join(here, '../../dist/split', file), 'utf8')).length;
  t.diagnostic(`dist/split/zubra.js: ${size('zubra.js')} B gzip; ${Object.keys(BESIDE).map((file) => `${file} ${size(file)}`).join(', ')}`);
  assert.ok(size('zubra.js') <= SPLIT, `${size('zubra.js')} B gzip > ${SPLIT} B`);
  for (const [file, budget] of Object.entries(BESIDE)) assert.ok(size(file) <= budget, `${file}: ${size(file)} B gzip > ${budget} B`);
});
