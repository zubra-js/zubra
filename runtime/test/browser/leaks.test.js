// Leaks: elements that are removed (by hand, or by React and Vue unmounting them) can be
// garbage-collected, even when they read a signal that outlives them. Counted with the DevTools
// protocol: force a collection, then count the live instances of each element class.
// `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site, engine } from './harness.js';

// The DevTools protocol is Chromium's.
const skip = engine !== 'chromium' && 'counting live objects needs Chromium';

useBrowser({
  shared: join(here, 'fixtures/shared.zb'),
  card: join(here, 'fixtures/card.zb'),
  rating: join(here, 'fixtures/rating.zb'),
  badge: join(here, 'fixtures/badge.zb'),
  inbox: join(here, 'fixtures/inbox.zb'),
  'slot-card-shadow': join(here, 'fixtures/slot-card-shadow.zb'),
}, {
  'shared-state.js': "import { state } from '@zubra/runtime';\nexport const shared = state(1);\nwindow.shared = shared;\n",
});

const src = join(here, '../../src').replaceAll('\\', '/');
const pageModules = {
  name: 'page-modules',
  setup(builder) {
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: args.path, external: true }));
    // ZUBRA_ENGINE=signals: the wrappers' engine is the page's (harness.js serves it as signal.js).
    if (process.env.ZUBRA_ENGINE === 'signals') builder.onResolve({ filter: /^\.\/signal\.js$/ }, (args) => ({ path: join(args.resolveDir, 'signal-tc39.js') }));
  },
};

before(async () => {
  const entry = join(site, 'leak-apps.entry.jsx');
  writeFileSync(entry, `
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { createApp, h } from 'vue';
    import { wrap as react } from '${src}/react.js';
    import { wrap as vue } from '${src}/vue.js';
    import Card from '/card.js';
    import Rating from '/rating.js';
    const ReactCard = react(Card), ReactRating = react(Rating);
    const VueCard = vue(Card), VueRating = vue(Rating);
    window.mountReact = (count) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const rows = Array.from({ length: count }, (_, i) => (
        <ReactCard key={i} heading={'h' + i}><p>{i}</p><ReactRating value={i % 3} onValueChange={() => {}} /></ReactCard>
      ));
      flushSync(() => root.render(<>{rows}</>));
      return () => { flushSync(() => root.unmount()); host.remove(); };
    };
    window.mountVue = (count) => {
      const host = document.createElement('div');
      document.body.append(host);
      const app = createApp({ render: () => Array.from({ length: count }, (_, i) =>
        h(VueCard, { key: i, heading: 'h' + i }, { default: () => [h('p', String(i)), h(VueRating, { modelValue: i % 3 })] })) });
      app.mount(host);
      return () => { app.unmount(); host.remove(); };
    };
  `);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, 'leak-apps.js'), jsx: 'automatic',
    plugins: [pageModules], logLevel: 'error', nodePaths: [join(here, '../../node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  });
});

/** Live instances of each tag's element class, after a forced garbage collection. */
async function live(page, tags) {
  const client = await page.context().newCDPSession(page);
  const counts = {};
  for (let round = 0; round < 3; round++) await client.send('HeapProfiler.collectGarbage');
  for (const tag of tags) {
    const { result: prototype } = await client.send('Runtime.evaluate', { expression: `customElements.get(${JSON.stringify(tag)}).prototype` });
    const { objects } = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
    const { result } = await client.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    counts[tag] = result.value;
    await client.send('Runtime.releaseObject', { objectId: objects.objectId });
  }
  await client.detach();
  return counts;
}

/**
 * The live counts once what was removed has been collected. In Chromium an element and a
 * MutationObserver watching it (a light-DOM component with slots) form a cycle between V8 and
 * Blink's heap, and a busy machine can need more than one collection to free it: CI saw all 100
 * Vue-mounted cards survive the first count once in a while, with their slotted ratings already
 * gone. So count again, collecting each time, until every count is 0 or `deadline` ms pass. A real
 * leak never reaches 0, and still fails with its counts.
 */
async function collected(page, tags, deadline = 5000) {
  const until = Date.now() + deadline;
  for (;;) {
    const counts = await live(page, tags);
    if (Object.values(counts).every((count) => count === 0) || Date.now() > until) return counts;
    await page.waitForTimeout(100);
  }
}

const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await Promise.all([...document.querySelectorAll('*')].filter((el) => el.localName.startsWith('zb-')).map((el) => el.updateComplete));
});

test('removed elements are collected, even when they read a signal that outlives them', { skip }, async () => {
  const { page, messages } = await open('<div id="box"></div>', { modules: ['shared', 'card', 'badge', 'inbox'] });
  await page.evaluate(() => {
    const box = document.getElementById('box');
    for (let i = 0; i < 100; i++) {
      box.insertAdjacentHTML('beforeend', `<zb-shared><span>${i}</span></zb-shared><zb-card heading="c${i}"><p>${i}</p></zb-card><zb-inbox></zb-inbox>`);
    }
  });
  await settle(page);
  assert.deepEqual(await live(page, ['zb-shared', 'zb-card', 'zb-inbox', 'my-badge']), { 'zb-shared': 100, 'zb-card': 100, 'zb-inbox': 100, 'my-badge': 200 });
  // Work while connected: the shared signal changes, rows re-render.
  await page.evaluate(() => { window.shared.set(2); });
  await settle(page);
  await page.evaluate(() => { document.getElementById('box').replaceChildren(); window.shared.set(3); });
  await settle(page);
  assert.deepEqual(await collected(page, ['zb-shared', 'zb-card', 'zb-inbox', 'my-badge']), { 'zb-shared': 0, 'zb-card': 0, 'zb-inbox': 0, 'my-badge': 0 });
  assert.deepEqual(messages, []);
  await page.close();
});

for (const framework of ['React', 'Vue']) {
  test(`elements ${framework} unmounts are collected`, { skip }, async () => {
    const { page, messages } = await open('', { modules: ['card', 'rating', 'leak-apps'] });
    await page.evaluate((name) => { window.unmount = window[`mount${name}`](100); }, framework);
    await settle(page);
    assert.deepEqual(await live(page, ['zb-card', 'my-rating']), { 'zb-card': 100, 'my-rating': 100 });
    await page.evaluate(() => window.unmount());
    await page.evaluate(() => { delete window.unmount; });
    await settle(page);
    assert.deepEqual(await collected(page, ['zb-card', 'my-rating']), { 'zb-card': 0, 'my-rating': 0 });
    assert.deepEqual(messages.filter((message) => !/You are running a development build of Vue/.test(message)), []);
    await page.close();
  });
}

test('heap and live instances stay flat after 500 components update 1,000 times and unmount', { skip }, async () => {
  const { page, messages } = await open('<div id="box"></div>', { modules: ['shared', 'card'] });
  const heap = async () => {
    const client = await page.context().newCDPSession(page);
    for (let round = 0; round < 3; round++) await client.send('HeapProfiler.collectGarbage');
    const { usedSize } = await client.send('Runtime.getHeapUsage');
    await client.detach();
    return usedSize;
  };
  const cycle = () => page.evaluate(async () => {
    const box = document.getElementById('box');
    const made = [];
    for (let i = 0; i < 500; i++) {
      const card = document.createElement('zb-card');
      card.setAttribute('heading', `h${i}`);
      const shared = document.createElement('zb-shared');
      box.append(card, shared);
      made.push(card, shared);
    }
    await Promise.all(made.map((el) => el.updateComplete));
    for (let i = 0; i < 1000; i++) {
      window.shared.set(i);
      await Promise.resolve();
    }
    await Promise.all(made.map((el) => el.updateComplete));
    box.replaceChildren();
  });
  await cycle();
  await settle(page);
  const baseline = await heap();
  await cycle();
  await settle(page);
  assert.deepEqual(await collected(page, ['zb-shared', 'zb-card']), { 'zb-shared': 0, 'zb-card': 0 });
  const after = await heap();
  // A retained component graph shows up as megabytes, not allocator noise.
  assert.ok(after < baseline + 8 * 1024 * 1024, `heap grew from ${baseline} to ${after}`);
  assert.deepEqual(messages, []);
  await page.close();
});

test("shadow components made and removed don't leave a reference each behind", { skip }, async () => {
  const { page } = await open('<p>shadow</p>', { modules: ['slot-card-shadow'] });
  const count = async () => {
    const client = await page.context().newCDPSession(page);
    for (let round = 0; round < 3; round++) await client.send('HeapProfiler.collectGarbage');
    const { result: prototype } = await client.send('Runtime.evaluate', { expression: 'WeakRef.prototype' });
    const { objects } = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
    const { result } = await client.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    await client.send('Runtime.releaseObject', { objectId: objects.objectId });
    await client.detach();
    return result.value;
  };
  for (let round = 0; round < 30; round++) {
    await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const made = Array.from({ length: 200 }, () => document.createElement('slot-card-shadow'));
      host.append(...made);
      await Promise.all(made.map((el) => el.updateComplete));
      host.remove();
    });
    await count(); // let what was removed be collected along the way
  }
  // 6000 made, and every one collected (counting again until they are: see collected()).
  assert.deepEqual(await collected(page, ['slot-card-shadow']), { 'slot-card-shadow': 0 });
  // Then their refs go as the registry hears of them (in a later task), and the refs themselves at
  // the next collection. Dev builds keep up to about a thousand more for devtools (devhook.js
  // `early`); the production build none.
  const until = Date.now() + 5000;
  let refs;
  do {
    await page.waitForTimeout(100);
    refs = await count();
  } while (refs >= 1500 && Date.now() < until);
  assert.ok(refs < 1500, `${refs} WeakRefs after 6000 shadow components came and went`);
  await page.close();
});

// Security audit of #436: connecting again watches each slotted text node, so a node that left the
// element while it was detached (moved into the page) used to be watched too. Connected in a
// document that is then dropped (an iframe removed, an inert document), the element is never
// disconnected, and the page's text node held it, its context and that document.
test('an element connected again in a dropped document is not kept by a text node that left it', { skip }, async () => {
  const { page } = await open('<div id="box"></div><div id="elsewhere"></div>', { modules: ['card'] });
  await page.evaluate(() => {
    const box = document.getElementById('box');
    const elsewhere = document.getElementById('elsewhere');
    for (let i = 0; i < 50; i++) {
      for (const kind of ['iframe', 'inert']) {
        const card = document.createElement('zb-card');
        const text = document.createTextNode('');
        card.append(text);
        box.append(card);
        card.remove();
        elsewhere.append(text); // left the card while it was detached: nothing saw it go
        if (kind === 'iframe') {
          const frame = document.createElement('iframe');
          document.body.append(frame);
          frame.contentDocument.body.append(card);
          frame.remove();
        } else {
          document.implementation.createHTMLDocument('').body.append(card);
        }
      }
    }
  });
  assert.deepEqual(await collected(page, ['zb-card']), { 'zb-card': 0 });
  assert.equal(await page.evaluate(() => document.getElementById('elsewhere').childNodes.length), 100, 'the text nodes are still in the page');
  await page.close();
});

// Signals mode kept every effect on one Watcher, which holds what it watches: an element connected
// in a document that is then dropped is never disconnected, so its effects, and it, stayed
// reachable from the page. Each effect has a Watcher of its own now, as the default engine keeps
// no list of what it watches.
test('elements connected in a dropped document are collected with it', { skip }, async () => {
  const { page } = await open('<div id="box"></div>', { modules: ['card'] });
  await page.evaluate(() => {
    for (let i = 0; i < 50; i++) {
      for (const kind of ['iframe', 'inert']) {
        const card = document.createElement('zb-card');
        card.append(document.createTextNode('Kept in the card'));
        if (kind === 'iframe') {
          const frame = document.createElement('iframe');
          document.body.append(frame);
          frame.contentDocument.body.append(card);
          frame.remove();
        } else {
          document.implementation.createHTMLDocument('').body.append(card);
        }
      }
    }
  });
  assert.deepEqual(await collected(page, ['zb-card']), { 'zb-card': 0 });
  await page.close();
});
