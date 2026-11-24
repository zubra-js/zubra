// 'use collection' in Chromium: state survives a reload, stays out of what's ephemeral, keeps
// documents apart, and follows across elements and tabs. No server holds any of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findCompiler } from '@zubra/server';
import { request as forward } from 'node:http';
import { createSyncServer, allowAnyone, allowReads } from '../src/server.js';
import { startBinary } from './backends.js';

// ZUBRA_SYNC_BACKEND=binary serves /_zb/sync from the zubra-sync binary instead, behind this
// server as a reverse proxy (the deployment the binary's docs describe), so the same tests check
// that the binary and @zubra/sync/server behave alike for real clients.
const viaBinary = process.env.ZUBRA_SYNC_BACKEND === 'binary';
let binary = null;
let presencePosts = 0;
let otherPresencePosts = 0; // presence sent to the second server, /_zb/other
// A peer id the test server says someone else holds (409), and the live streams it can cut.
let squatted = null;
const streams = new Set();
let dropSignals = 0; // a test can lose the next few signaling messages on purpose
let slowPulls = 0; // and hold the next few pulls for 400 ms

findCompiler();
const compiler = await import('@zubra/compiler');
const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = dirname(fileURLToPath(import.meta.resolve('@zubra/runtime')));
const syncDir = join(here, '../src');

const module = (name) => {
  const path = join(here, 'components', `${name}.zb`);
  const response = compiler.request({ emit: 'js', path, files: compiler.sources(path), runtime: '@zubra/runtime' });
  if (!response.ok) throw new Error(response.error);
  return response.output;
};
const page = (body, connected = false, component = 'task-item') => `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: { '@zubra/runtime': '/runtime/index.js', '@zubra/sync': '/sync/index.js' } })}</script>
</head><body>${body}<script type="module">import '/components/${component}.js';</script>${connected?.follow ? `<script type="module">import { follow } from '/sync/follow.js'; window.link = follow(${JSON.stringify(connected.follow)});</script>` : connected ? `<script type="module">import { connect } from '/sync/connect.js'; window.link = connect(${JSON.stringify(connected === true ? { interval: 100, live: false } : connected)});</script>` : ''}</body></html>`;

let server;
let browser;
let base;
const sync = createSyncServer({ authorize: allowAnyone });
// A server that was never told who may write (security audit K2): pages read (allowReads, since
// 6.0 reads too are closed without authorize), writes are refused.
const closed = createSyncServer({ mount: '/_zb/closed', authorize: allowReads() });
// A second server on the same page, for a scope of its own (tasks), to see what each is sent.
const other = createSyncServer({ mount: '/_zb/other', authorize: allowAnyone });
// Servers for a page on another site (http://127.0.0.1:<port> is another site to http://localhost):
// one that lists it in `origins` (filled in once the port is known), and one that doesn't.
const awayOrigins = [];
const away = createSyncServer({ mount: '/_zb/away', authorize: allowAnyone, origins: awayOrigins });
const unlisted = createSyncServer({ mount: '/_zb/unlisted', authorize: allowAnyone });
before(async () => {
  if (viaBinary) binary = await startBinary(['--keep-alive', '200', '--open']);
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.url.startsWith('/_zb/sync/presence')) presencePosts += 1;
    if (req.url.startsWith('/_zb/other/presence')) otherPresencePosts += 1;
    if (url.pathname === '/_zb/sync/live') {
      if (squatted && url.searchParams.get('peer') === squatted) return res.writeHead(409, { 'content-type': 'application/json' }).end('{"error":"That peer id is another viewer\'s; pick another"}');
      const stream = { peer: url.searchParams.get('peer'), res };
      streams.add(stream);
      res.on('close', () => streams.delete(stream));
    }
    if (req.url.startsWith('/_zb/sync/pull') && slowPulls > 0) {
      slowPulls -= 1;
      await new Promise((done) => setTimeout(done, 400));
    }
    if (req.url.startsWith('/_zb/sync/signal') && dropSignals > 0) {
      dropSignals -= 1;
      req.resume();
      return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }
    if (viaBinary && req.url.startsWith('/_zb/sync/')) {
      const target = new URL(binary.base);
      const upstream = forward({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        res.flushHeaders();
        answer.pipe(res);
      });
      res.on('close', () => upstream.destroy());
      // A browser leaving mid-stream, or the binary stopping at the end of the run, cuts the
      // upstream connection: that ends this response, it isn't a failure.
      upstream.on('error', () => res.destroy());
      return req.pipe(upstream);
    }
    if (await closed.handle(req, res)) return;
    if (await other.handle(req, res)) return;
    if (await away.handle(req, res)) return;
    if (await unlisted.handle(req, res)) return;
    if (await sync.handle(req, res)) return;
    const js = (text) => { res.setHeader('content-type', 'text/javascript'); res.end(text); };
    const file = (dir, rest) => {
      const path = normalize(join(dir, rest));
      if (!path.startsWith(dir)) return res.writeHead(404).end();
      try { js(readFileSync(path, 'utf8')); } catch { res.writeHead(404).end(); }
    };
    if (url.pathname.startsWith('/runtime/')) return file(runtimeDir, url.pathname.slice('/runtime/'.length));
    if (url.pathname.startsWith('/sync/')) return file(syncDir, url.pathname.slice('/sync/'.length));
    if (url.pathname.startsWith('/components/')) return js(module(url.pathname.slice('/components/'.length).replace(/\.js$/, '')));
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/two') return res.end(page('<task-item doc="a"></task-item><task-item doc="b"></task-item>'));
    const doc = (url.searchParams.get('doc') ?? 'a').replace(/\W/g, '');
    // A store that takes a while to answer, set up before the element starts.
    if (url.pathname === '/slow') return res.end(page(`<script type="module">import { configure, indexedDBStore } from '/sync/index.js'; const store = indexedDBStore(); configure({ store: { get: (c, k) => new Promise((done) => setTimeout(done, 800)).then(() => store.get(c, k)), set: (c, k, f) => store.set(c, k, f) } });</script><task-item doc="${doc}"></task-item>`));
    // Live only: polling every minute, so anything sooner came over the event stream.
    if (url.pathname === '/live') return res.end(page(`<task-item doc="${doc}"></task-item>`, { interval: 60_000 }));
    const connectTo = url.searchParams.has('rtc') ? { interval: 60_000, webrtc: true } : url.searchParams.has('connect') ? { interval: 60_000 } : false;
    // A board connected to two servers: this one for boards, /_zb/other for tasks.
    if (url.pathname === '/two-servers') return res.end(page(`<board-view doc="${doc}"></board-view><script type="module">import { connect } from '/sync/connect.js'; window.link = connect({ interval: 60_000, scope: { boards: true } }); window.otherLink = connect({ url: '/_zb/other', interval: 60_000, scope: { tasks: true } });</script>`, false, 'board-view'));
    // A page connected to a server on another site, live: ?server=away (it lists this page's site) or unlisted.
    if (url.pathname === '/elsewhere') return res.end(page(`<task-item doc="${doc}"></task-item>`, { url: `${base}/_zb/${url.searchParams.get('server') === 'away' ? 'away' : 'unlisted'}`, interval: 60_000 }));
    if (url.pathname === '/board') return res.end(page(`<board-view doc="${doc}"></board-view>`, connectTo, 'board-view'));
    // Connected, with a store whose next get() waits window.slowNext ms (this device's own edit
    // takes that long to record its clock beside the document), and whose next set() is issued at
    // once but finishes window.slowNextSet ms later (a change from elsewhere is that long in
    // being stored before it's shown). window.dropSets: nothing is stored (a tab closing mid-write).
    if (url.pathname === '/connected-slow') return res.end(page(`<script type="module">import { configure, indexedDBStore } from '/sync/index.js'; const store = indexedDBStore(); window.slowNext = 0; window.slowNextSet = 0; window.slowedSets = 0; const later = (ms) => new Promise((done) => setTimeout(done, ms)); configure({ store: { get: (c, k) => { const wait = window.slowNext; window.slowNext = 0; return later(wait).then(() => store.get(c, k)); }, set: (c, k, f) => { if (window.dropSets) return Promise.resolve(); const wait = window.slowNextSet; window.slowNextSet = 0; if (wait) window.slowedSets++; return store.set(c, k, f).then((r) => later(wait).then(() => r)); } } });</script><task-item doc="${url.searchParams.get('doc').replace(/\W/g, '')}"></task-item>`, true));
    if (url.pathname === '/closed') return res.end(page(`<task-item doc="${doc}"></task-item>`, { url: '/_zb/closed', interval: 100, live: false }));
    if (url.pathname === '/connected') return res.end(page(`<task-item doc="${url.searchParams.get('doc').replace(/\W/g, '')}"></task-item>`, true));
    if (url.pathname === '/same') return res.end(page('<task-item doc="a" class="first"></task-item><task-item doc="a" class="second"></task-item>'));
    // Connected with a scope (?scope= is the JSON connect() gets), live, polling once a minute.
    if (url.pathname === '/scoped') return res.end(page(`<task-item doc="${doc}"></task-item>`, { interval: 60_000, scope: JSON.parse(url.searchParams.get('scope')) }));
    // Following (read-only): ?poll for polling only, ?scope= as /scoped; live otherwise.
    if (url.pathname === '/following') return res.end(page(`<task-item doc="${doc}"></task-item>`, { follow: url.searchParams.has('poll') ? { interval: 100, live: false } : { interval: 60_000, ...(url.searchParams.has('scope') ? { scope: JSON.parse(url.searchParams.get('scope')) } : {}) } }));
    // documents(): a list of every order under a prefix. ?start= is the list the server rendered
    // (JSON); ?connect writes too, ?local has no server, otherwise it follows, live only.
    if (url.pathname === '/orders') {
      const start = (url.searchParams.get('start') ?? '[]').replace(/'/g, '');
      const bare = url.searchParams.has('bare') ? `<script type="module">import { configure, memoryStore } from '/sync/index.js'; const { get, set } = memoryStore(); configure({ store: { get, set } });</script>` : '';
      const body = `${bare}<order-list board="${doc}" orders-now='${start}'></order-list>${url.searchParams.has('card') ? `<script type="module">import '/components/order-card.js';</script><order-card doc="${doc}/${url.searchParams.get('card').replace(/\W/g, '')}"></order-card>` : ''}`;
      return res.end(page(body, url.searchParams.has('local') ? false : url.searchParams.has('connect') ? { interval: 60_000 } : { follow: { interval: 60_000 } }, 'order-list'));
    }
    // A board whose server keeps an index document (boards/<doc>): following, live only.
    if (url.pathname === '/kitchen') return res.end(page(`<order-board board="${doc}" open-now='${JSON.stringify((url.searchParams.get('open') ?? '').split(',').filter(Boolean).map((key) => key.replace(/\W/g, '')))}'></order-board>`, { follow: { interval: 60_000 } }, 'order-board'));
    res.end(page('<task-item doc="a"></task-item>'));
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  awayOrigins.push(`http://127.0.0.1:${server.address().port}`);
  // Real local addresses in ICE candidates (Chromium hides them behind mDNS names by default,
  // which a test machine may not resolve).
  browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  server?.close();
  binary?.close();
});

const ready = (page) => page.waitForFunction(() => customElements.get('task-item'));
/** Wait for IndexedDB's write to land (the store writes behind the UI). */
const stored = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 100)));

test('state survives a reload; ephemeral state and the defaults don\'t overwrite it', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(`${base}/`);
  await ready(tab);
  await tab.check('input[type=checkbox]');
  await tab.fill('.title', 'Buy milk');
  await tab.click('.tag');
  await tab.click('.tag');
  await tab.click('.edit');
  assert.equal(await tab.textContent('.editing'), 'editing');
  await stored(tab);
  await tab.reload();
  await ready(tab);
  await tab.waitForSelector('.state:has-text("done")');
  assert.equal(await tab.inputValue('.title'), 'Buy milk');
  assert.equal(await tab.textContent('.tags'), 't0,t1'); // a mutated array is stored too
  assert.equal(await tab.isChecked('input[type=checkbox]'), true);
  assert.equal(await tab.textContent('.editing'), 'viewing'); // ephemeral: back to its default
  const raw = await tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['tasks', 'a']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.deepEqual(raw, { completed: true, title: 'Buy milk', tags: ['t0', 't1'] });
  assert.deepEqual(errors, []);
  await context.close();
});

test('each document is its own; elements showing the same one follow each other', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/two`);
  await ready(tab);
  await tab.fill('task-item[doc=a] .title', 'Only A');
  await stored(tab);
  await tab.reload();
  await ready(tab);
  await tab.waitForFunction(() => document.querySelector('task-item[doc=a] .title').value === 'Only A');
  assert.equal(await tab.inputValue('task-item[doc=b] .title'), 'Untitled');

  await tab.goto(`${base}/same`);
  await ready(tab);
  await tab.waitForFunction(() => document.querySelector('.second .title').value === 'Only A');
  await tab.fill('.first .title', 'Both');
  await tab.waitForFunction(() => document.querySelector('.second .title').value === 'Both');
  await context.close();
});

test('another tab follows, with no server involved', async () => {
  const context = await browser.newContext();
  const one = await context.newPage();
  const two = await context.newPage();
  await one.goto(`${base}/`);
  await two.goto(`${base}/`);
  await ready(one);
  await ready(two);
  await one.check('input[type=checkbox]');
  await one.fill('.title', 'From tab one');
  await two.waitForSelector('.state:has-text("done")');
  await two.waitForFunction(() => document.querySelector('.title').value === 'From tab one');
  await context.close();
});

// Two browser contexts have separate storage: two devices.
async function device(doc) {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/connected?doc=${doc}`);
  await ready(tab);
  return { context, tab };
}
const title = (tab, value) => tab.waitForFunction((value) => document.querySelector('.title').value === value, value, { timeout: 5000 });
/** Until `check()` is true, or a failure after five seconds. */
const waitFor = async (check) => {
  for (const until = Date.now() + 5000; !(await check()); ) {
    if (Date.now() > until) throw new Error('not within 5 s');
    await new Promise((done) => setTimeout(done, 50));
  }
};

test('connected: another device gets the change through the log', async () => {
  const a = await device('first');
  const b = await device('first');
  await a.tab.fill('.title', 'Written on A');
  await a.tab.check('input[type=checkbox]');
  await title(b.tab, 'Written on A');
  try {
    await b.tab.waitForSelector('.state:has-text("done")', { timeout: 5000 });
  } catch (error) {
    const log = await (await fetch(`${base}/_zb/sync/pull?since=0`)).json();
    console.log('DEBUG log', JSON.stringify(log.changes.filter((c) => c.key === 'first')));
    console.log('DEBUG A outbox', await a.tab.evaluate(() => localStorage.getItem('zubra-sync:outbox')), 'B cursor', await b.tab.evaluate(() => localStorage.getItem('zubra-sync:cursor')));
    console.log('DEBUG A state', await a.tab.textContent('.state'));
    throw error;
  }
  // And it's in B's own store, with the clock it won by.
  const stored = await b.tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['tasks', 'first']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.equal(stored.title, 'Written on A');
  assert.match(stored.$clocks.title, /^\d{15}-\d{5}-\w+$/);
  await a.context.close();
  await b.context.close();
});

test('connected: a device that was offline catches up both ways, and concurrent edits converge', async () => {
  const a = await device('second');
  const b = await device('second');
  await a.context.setOffline(true);
  await a.tab.fill('.title', 'A, offline');
  await a.tab.waitForTimeout(30);
  await b.tab.fill('.title', 'B, later');
  await b.tab.waitForTimeout(300);
  assert.equal(await a.tab.inputValue('.title'), 'A, offline'); // still offline: nothing came in
  await a.context.setOffline(false);
  // B's write is later, so both end on it, whichever reached the log first: B must not take
  // A's older write when it pulls it.
  await title(a.tab, 'B, later');
  await b.tab.waitForTimeout(600);
  assert.equal(await b.tab.inputValue('.title'), 'B, later');
  assert.equal(await a.tab.inputValue('.title'), 'B, later');
  // A field only A touched while offline reaches B.
  await a.context.setOffline(true);
  await a.tab.check('input[type=checkbox]');
  await a.tab.waitForTimeout(300); // its pushes fail meanwhile; the write waits in the outbox
  await a.context.setOffline(false);
  await b.tab.waitForSelector('.state:has-text("done")', { timeout: 5000 });
  await a.context.close();
  await b.context.close();
});

test("an older change arriving while this device's own edit is being recorded doesn't replace it", async () => {
  const a = await device('race');
  const context = await browser.newContext();
  const b = await context.newPage();
  await b.goto(`${base}/connected-slow?doc=race`);
  await ready(b);
  // A edits first, offline, so its change is older but reaches the log later.
  await a.context.setOffline(true);
  await a.tab.fill('.title', 'from A, earlier');
  await a.tab.waitForTimeout(50);
  // B edits after it; recording B's clock beside the document is held up for 1.5 s, and in that
  // time A comes back and its older change arrives at B.
  await b.evaluate(() => (window.slowNext = 1500));
  await b.fill('.title', 'from B, later');
  await a.context.setOffline(false);
  await b.waitForTimeout(2500);
  assert.equal(await b.inputValue('.title'), 'from B, later', 'B still shows its own, newer edit');
  await b.reload();
  await ready(b);
  await title(b, 'from B, later');
  await title(a.tab, 'from B, later');
  await a.context.close();
  await context.close();
});

test("an edit made here while an older change from elsewhere is being stored stays on screen, and stored", async () => {
  const a = await device('race2');
  const context = await browser.newContext();
  const b = await context.newPage();
  await b.goto(`${base}/connected-slow?doc=race2`);
  await ready(b);
  await a.context.setOffline(true);
  await a.tab.fill('.title', 'from A, earlier');
  await a.tab.waitForTimeout(50);
  // A's older change reaches B, and storing it takes 1.5 s; B edits the same field meanwhile.
  await b.evaluate(() => (window.slowNextSet = 1500));
  await a.context.setOffline(false);
  await b.waitForFunction(() => window.slowedSets === 1, null, { timeout: 10000 });
  await b.fill('.title', 'from B, later');
  await b.waitForTimeout(2500);
  assert.equal(await b.inputValue('.title'), 'from B, later');
  await b.reload();
  await ready(b);
  await title(b, 'from B, later');
  await title(a.tab, 'from B, later');
  await a.context.close();
  await context.close();
});

test("an edit whose clock wasn't stored before the tab closed still beats an older change", async () => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await a.goto(`${base}/connected-slow?doc=race3`);
  await ready(a);
  const b = await device('race3');
  // B ticks the box offline: an older change that will reach the log late.
  await b.context.setOffline(true);
  await b.tab.check('input[type=checkbox]');
  await b.tab.uncheck('input[type=checkbox]');
  await b.tab.waitForTimeout(50);
  // A ticks it later, offline too, and its tab closes before the clock is stored beside it.
  await context.setOffline(true);
  await a.evaluate(() => (window.slowNext = 60_000));
  await a.check('input[type=checkbox]');
  await a.waitForTimeout(300);
  await a.close();
  // B's older change reaches the log; then A opens the app again.
  await b.context.setOffline(false);
  await b.tab.waitForTimeout(500);
  await context.setOffline(false);
  const again = await context.newPage();
  await again.goto(`${base}/connected?doc=race3`);
  await ready(again);
  await again.waitForTimeout(1000);
  assert.equal(await again.locator('.state').textContent(), 'done', "A's newer tick stands on A");
  await b.tab.waitForSelector('.state:has-text("done")', { timeout: 5000 });
  await b.context.close();
  await context.close();
});

test('an edit that never reached the store before the tab closed is shown again when the app reopens', async () => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await a.goto(`${base}/connected-slow?doc=race4`);
  await ready(a);
  await context.setOffline(true);
  await a.evaluate(() => (window.dropSets = true));
  await a.check('input[type=checkbox]');
  await a.fill('.title', 'kept in the outbox only');
  await a.waitForTimeout(300);
  await a.close();
  // Opened again with the log still out of reach: what waits to be sent is what this device shows.
  await context.setOffline(false);
  const again = await context.newPage();
  await again.route('**/_zb/sync/**', (route) => route.abort('internetdisconnected'));
  await again.goto(`${base}/connected?doc=race4`);
  await ready(again);
  await title(again, 'kept in the outbox only');
  assert.equal(await again.locator('.state').textContent(), 'done');
  await again.unroute('**/_zb/sync/**');
  const other = await device('race4');
  await title(other.tab, 'kept in the outbox only');
  await other.context.close();
  await context.close();
});

test("an unsent edit that a newer change from elsewhere has since beaten isn't put back on reopening", async () => {
  const a = await device('race5');
  const b = await device('race5');
  // A's pushes can't get through, but it still hears from the log.
  await a.tab.route('**/_zb/sync/push', (route) => route.abort('internetdisconnected'));
  await a.tab.fill('.title', 'from A, unsent');
  await a.tab.waitForTimeout(200);
  await b.tab.fill('.title', 'from B, newer');
  await title(a.tab, 'from B, newer');
  // A reopens with its older edit still waiting to be sent.
  await a.tab.close();
  const again = await a.context.newPage();
  await again.route('**/_zb/sync/push', (route) => route.abort('internetdisconnected'));
  await again.goto(`${base}/connected?doc=race5`);
  await ready(again);
  await again.waitForTimeout(800);
  assert.equal(await again.inputValue('.title'), 'from B, newer');
  await a.context.close();
  await b.context.close();
});

test('a long time offline: edits wait one per field, outlive the tab, and merge when it next opens', async () => {
  const a = await device('away');
  const b = await device('away');
  await a.context.setOffline(true);
  // A long session offline: a few hundred keystrokes and a checkbox, with pushes failing meanwhile.
  await a.tab.click('.title');
  await a.tab.keyboard.type('notes from the river '.repeat(15), { delay: 0 });
  await a.tab.check('input[type=checkbox]');
  await a.tab.waitForTimeout(300);
  const waiting = await a.tab.evaluate(() => JSON.parse(localStorage.getItem('zubra-sync:outbox')).map((c) => c.field).sort());
  assert.deepEqual(waiting, ['completed', 'title'], 'one change per field, not one per keystroke');
  // The tab is closed before the network comes back; the others carry on.
  await a.tab.close();
  await b.tab.fill('.title', 'B, while A was away');
  await b.tab.waitForTimeout(300);
  // Back online, the app is opened again: what waited goes, and the newer title stands.
  await a.context.setOffline(false);
  const again = await a.context.newPage();
  await again.goto(`${base}/connected?doc=away`);
  await ready(again);
  await b.tab.waitForSelector('.state:has-text("done")', { timeout: 5000 });
  await title(again, 'B, while A was away');
  assert.equal(await again.locator('.state').textContent(), 'done');
  assert.equal(await again.evaluate(() => JSON.parse(localStorage.getItem('zubra-sync:outbox')).length), 0);
  assert.equal(await b.tab.inputValue('.title'), 'B, while A was away');
  await a.context.close();
  await b.context.close();
});

test('live: a change arrives over the event stream, without waiting for a poll', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await a.newPage();
  const two = await b.newPage();
  await one.goto(`${base}/live?doc=third`);
  await two.goto(`${base}/live?doc=third`);
  await ready(one);
  await ready(two);
  await two.waitForTimeout(300); // let both streams open
  await one.fill('.title', 'Over the stream');
  await title(two, 'Over the stream');
  await a.close();
  await b.close();
});

test('scope: a page gets, and stores, only the documents it asked for, with a cursor of its own', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const scope = { tasks: 'mine' };
  await tab.goto(`${base}/scoped?doc=mine1&scope=${encodeURIComponent(JSON.stringify(scope))}`);
  await ready(tab);
  await tab.waitForTimeout(300); // the live stream opens
  // Another device writes one document out of the page's scope, then one in it.
  const other = await browser.newContext();
  const writer = await other.newPage();
  await writer.goto(`${base}/connected?doc=theirs1`);
  await ready(writer);
  await writer.fill('.title', 'Not for that page');
  await writer.goto(`${base}/connected?doc=mine1`);
  await ready(writer);
  await writer.fill('.title', 'For that page');
  await title(tab, 'For that page');
  const keys = await tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').getAllKeys();
      request.onsuccess = () => done(request.result.map((key) => key.join('/')));
    };
  }));
  assert.ok(keys.includes('tasks/mine1'), keys.join(', '));
  assert.ok(!keys.includes('tasks/theirs1'), `stored only what it asked for: ${keys.join(', ')}`);
  const cursors = await tab.evaluate(() => Object.keys(localStorage).filter((name) => name.startsWith('zubra-sync:cursor')));
  assert.deepEqual(cursors, [`zubra-sync:cursor:${JSON.stringify(scope)}`]);
  await context.close();
  await other.close();
});

test('a device whose cursor is past the end of the log (a new log) starts over and catches up', async () => {
  const context = await browser.newContext();
  // As if this device had read far into a log that has since been replaced.
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('zubra-sync:cursor', '999999');
      sessionStorage.setItem('seeded', '1');
    }
  });
  const writer = await browser.newContext();
  const other = await writer.newPage();
  await other.goto(`${base}/connected?doc=restart1`);
  await ready(other);
  await other.fill('.title', 'Written before');
  await other.waitForTimeout(300);
  const tab = await context.newPage();
  await tab.goto(`${base}/connected?doc=restart1`);
  await ready(tab);
  await title(tab, 'Written before');
  // And it carries on from the log's real cursor: a later change still arrives.
  await other.fill('.title', 'Written after');
  await title(tab, 'Written after');
  assert.ok(Number(await tab.evaluate(() => localStorage.getItem('zubra-sync:cursor'))) < 999999);
  await context.close();
  await writer.close();
});

test('fresh first: a returning device never shows what it stored last time over what the log has now', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/connected?doc=fresh1`);
  await ready(tab);
  await tab.fill('.title', 'Last visit');
  await tab.waitForTimeout(400); // pushed, and stored on this device
  await tab.goto('about:blank');
  // While it's away, someone else changes it.
  const away = await browser.newContext();
  const other = await away.newPage();
  await other.goto(`${base}/connected?doc=fresh1`);
  await ready(other);
  await title(other, 'Last visit');
  await other.fill('.title', 'Changed since');
  await other.waitForTimeout(400);
  await away.close();
  // It comes back. Every value the title shows from the very start is recorded; its first pull
  // takes 400 ms, so a stored value applied before it would be on screen for that long.
  await tab.addInitScript(() => {
    window.shown = [];
    const look = () => {
      const value = document.querySelector('task-item .title')?.value;
      if (value !== undefined && value !== window.shown.at(-1)) window.shown.push(value);
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  slowPulls = 1;
  await tab.goto(`${base}/connected?doc=fresh1`);
  await title(tab, 'Changed since');
  const shown = await tab.evaluate(() => window.shown);
  assert.ok(!shown.includes('Last visit'), `never the stored value: ${JSON.stringify(shown)}`);
  await context.close();
});

test('fresh first: offline, the stored document still shows, straight away', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/connected?doc=fresh2`);
  await ready(tab);
  await tab.fill('.title', 'Kept on the device');
  await tab.waitForTimeout(400);
  // Offline: every request to the log fails, as it does without a network.
  await tab.route('**/_zb/sync/**', (route) => route.abort('internetdisconnected'));
  const started = Date.now();
  await tab.goto(`${base}/connected?doc=fresh2`);
  await ready(tab);
  await title(tab, 'Kept on the device');
  assert.ok(Date.now() - started < 1500, 'a failed pull doesn\'t hold it back for the full wait');
  await context.close();
});

test('fresh first: a pull that never answers holds the stored document back for 1.5 s at most', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/connected?doc=fresh3`);
  await ready(tab);
  await tab.fill('.title', 'Stored here');
  await tab.waitForTimeout(400);
  await tab.route('**/_zb/sync/pull**', () => {}); // never answered
  const started = Date.now();
  await tab.goto(`${base}/connected?doc=fresh3`);
  await ready(tab);
  await title(tab, 'Stored here');
  const waited = Date.now() - started;
  assert.ok(waited >= 1400 && waited < 3500, `waited ${waited} ms`);
  await context.close();
});

test('a field the component doesn\'t declare is kept, on the device and in the log, through its edits', async () => {
  // The server writes a field task-item has no `let` for (the kit's hold ceiling writes `since`).
  if (viaBinary) {
    await fetch(`${binary.base}/_zb/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [
      { collection: 'tasks', key: 'extra1', field: 'title', value: 'From the server', clock: '000000000000100-00000-server' },
      { collection: 'tasks', key: 'extra1', field: 'since', value: 1731300000000, clock: '000000000000100-00001-server' },
    ] }) });
  } else {
    await sync.write('tasks', 'extra1', { title: 'From the server', since: 1731300000000 });
  }
  const context = await browser.newContext();
  const errors = [];
  const tab = await context.newPage();
  tab.on('pageerror', (error) => errors.push(error.message));
  tab.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await tab.goto(`${base}/connected?doc=extra1`);
  await ready(tab);
  await title(tab, 'From the server');
  await tab.fill('.title', 'Edited here');
  await tab.waitForTimeout(400); // saved and pushed
  const stored = await tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['tasks', 'extra1']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.equal(stored.title, 'Edited here');
  assert.equal(stored.since, 1731300000000, 'kept on the device');
  const source = viaBinary ? binary.base : base;
  const log = (await (await fetch(`${source}/_zb/sync/pull?since=0`)).json()).changes.filter((c) => c.key === 'extra1');
  assert.deepEqual(log.filter((c) => c.field === 'since').map((c) => c.value), [1731300000000], 'never pushed back or overwritten');
  assert.equal(log.at(-1).field, 'title', 'the edit pushed only the field it changed');
  if (!viaBinary) assert.deepEqual((await sync.documents()).get('tasks', 'extra1'), { title: 'Edited here', since: 1731300000000 });
  assert.deepEqual(errors, []);
  await context.close();
});

const board = async (context, doc, connect = false) => {
  const tab = await context.newPage();
  await tab.goto(`${base}/board?doc=${doc}${connect === 'rtc' ? '&rtc' : connect ? '&connect' : ''}`);
  await tab.waitForFunction(() => customElements.get('board-view'));
  return tab;
};
const point = async (tab, x, y) => {
  const box = await tab.locator('.pad').boundingBox();
  await tab.mouse.move(box.x + x, box.y + y);
};

test('presence: other tabs see where you are, and see you leave; nothing is stored', async () => {
  const context = await browser.newContext();
  const one = await board(context, 'b1');
  const two = await board(context, 'b1');
  await point(one, 40, 30);
  await two.waitForSelector('.other:has-text("40,30")');
  assert.equal(await two.textContent('.count'), '1');
  await point(two, 10, 20);
  await one.waitForSelector('.other:has-text("10,20")');
  assert.equal(await one.textContent('.count'), '1'); // itself isn't a peer
  // Another document's room is another room.
  const elsewhere = await board(context, 'b2');
  await elsewhere.waitForTimeout(200);
  assert.equal(await elsewhere.textContent('.count'), '0');
  await two.click('.stroke');
  await two.waitForTimeout(150);
  await one.close();
  await two.waitForSelector('.count:has-text("0")');
  const stored = await two.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').get(['boards', 'b1']);
      request.onsuccess = () => done(request.result);
    };
  }));
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ['strokes']);
  await context.close();
});

test('presence: moving through many documents leaves nothing behind for the rooms left', async () => {
  const context = await browser.newContext();
  const tab = await board(context, 'start');
  const client = await context.newCDPSession(tab);
  const sets = async () => {
    for (let round = 0; round < 3; round++) await client.send('HeapProfiler.collectGarbage');
    const { result: prototype } = await client.send('Runtime.evaluate', { expression: 'Set.prototype' });
    const { objects } = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
    const { result } = await client.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    await client.send('Runtime.releaseObject', { objectId: objects.objectId });
    return result.value;
  };
  const move = (from, to) => tab.evaluate(async ({ from, to }) => {
    const element = document.querySelector('board-view');
    for (let i = from; i < to; i++) {
      element.setAttribute('doc', `room-${i}`);
      await element.updateComplete;
    }
  }, { from, to });
  await move(0, 20);
  const before = await sets();
  await move(20, 320);
  const after = await sets();
  assert.ok(after - before < 30, `${after - before} more Sets after joining and leaving 300 rooms`);
  await context.close();
});

test('presence: other devices too, through the server, and a closed tab leaves', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await board(a, 'b3', true);
  const two = await board(b, 'b3', true);
  await one.waitForTimeout(300);
  await point(one, 55, 66);
  await two.waitForSelector('.other:has-text("55,66")', { timeout: 5000 });
  await one.close();
  await two.waitForSelector('.count:has-text("0")', { timeout: 5000 });
  await a.close();
  await b.close();
});

test('a tab whose peer id someone else holds now takes a new one, and is live again', { timeout: 20_000 }, async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await board(a, 'b9', true);
  const two = await board(b, 'b9', true);
  const idOf = (page) => page.evaluate(() => import('/sync/index.js').then((sync) => sync.peerId()));
  const first = await idOf(one);
  await one.waitForTimeout(300);
  await point(one, 11, 22);
  await two.waitForSelector('.other:has-text("11,22")', { timeout: 5000 });
  try {
    // Its connection drops for longer than the server keeps the id, and someone else takes it.
    squatted = first;
    for (const stream of streams) if (stream.peer === first) stream.res.destroy();
    let second = first;
    for (let i = 0; i < 50 && second === first; i++) second = await one.waitForTimeout(200).then(() => idOf(one));
    assert.notEqual(second, first, 'a new peer id');
    // Live again, as the new peer: it sees the other device move.
    while (![...streams].some((stream) => stream.peer === second)) await one.waitForTimeout(100);
    await one.waitForTimeout(200);
    await point(two, 77, 88);
    await one.waitForSelector('.other:has-text("77,88")', { timeout: 5000 });
    // And the other device sees it where it was, as the new peer (the old one said goodbye).
    await two.waitForFunction(() => document.querySelector('.count')?.textContent === '1' && document.querySelector('.other')?.textContent === '11,22', null, { timeout: 5000 });
  } finally {
    squatted = null;
    await a.close();
    await b.close();
  }
});

test('presence goes only to the server whose scope has the room', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await a.newPage();
  await one.goto(`${base}/two-servers?doc=b11`);
  await one.waitForFunction(() => customElements.get('board-view') && window.link && window.otherLink);
  const two = await board(b, 'b11', true);
  otherPresencePosts = 0;
  await one.waitForTimeout(300);
  await point(one, 31, 41);
  // Through the server for boards, as ever…
  await two.waitForSelector('.other:has-text("31,41")', { timeout: 5000 });
  await point(one, 32, 42);
  await two.waitForSelector('.other:has-text("32,42")', { timeout: 5000 });
  // …goodbye included…
  await one.close();
  await two.waitForSelector('.count:has-text("0")', { timeout: 5000 });
  // …and none of it to the server for tasks, which has no such room.
  assert.equal(otherPresencePosts, 0);
  await a.close();
  await b.close();
});

test('a connection started after another stopped takes up its live stream, keeping the peer id', { timeout: 20_000 }, async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await board(a, 'b12', true);
  const two = await board(b, 'b12', true);
  const idOf = (page) => page.evaluate(() => import('/sync/index.js').then((sync) => sync.peerId()));
  const first = await idOf(one);
  while (![...streams].some((stream) => stream.peer === first)) await one.waitForTimeout(100);
  // The page moves on to another connection to the same server (an app's next screen, say). The
  // server keeps the stopped stream's peer id for it a while; the new one presents its key.
  await one.evaluate(async () => {
    const { connect } = await import('/sync/connect.js');
    window.link.stop();
    window.link = connect({ interval: 60_000 });
  });
  await one.waitForTimeout(300);
  while (![...streams].some((stream) => stream.peer === first)) await one.waitForTimeout(100);
  await one.waitForTimeout(1500); // long enough for a refusal (409) and a new id
  assert.equal(await idOf(one), first, 'the same peer id');
  // And it's live as that peer: the other device sees it move.
  await point(one, 12, 34);
  await two.waitForSelector('.other:has-text("12,34")', { timeout: 5000 });
  assert.equal(await two.textContent('.count'), '1');
  await a.close();
  await b.close();
});

test('a page on another site that the server lists in `origins` reads, writes and follows it live; one it doesn\'t list gets nothing', async () => {
  const context = await browser.newContext();
  const elsewhere = base.replace('localhost', '127.0.0.1');
  const listed = await context.newPage();
  await listed.goto(`${elsewhere}/elsewhere?server=away&doc=abroad`);
  await ready(listed);
  await listed.waitForTimeout(300); // let the stream open
  // Its edit reaches the server, from another site.
  await listed.fill('.title', 'From another site');
  await waitFor(async () => (await (await away.fetch(new Request(`${base}/_zb/away/pull?since=0`))).json()).changes.some((c) => c.key === 'abroad' && c.value === 'From another site'));
  // And the server's change reaches it over the live stream.
  await away.write('tasks', 'abroad', { title: 'Back from the server' });
  await title(listed, 'Back from the server');

  // A server that doesn't list that site: its browser keeps every answer from the page, and refuses to send its edits.
  const refused = [];
  const stranger = await context.newPage();
  stranger.on('requestfailed', (request) => request.url().includes('/_zb/unlisted/') && refused.push(new URL(request.url()).pathname));
  await unlisted.write('tasks', 'abroad', { title: 'Not for other sites' });
  await stranger.goto(`${elsewhere}/elsewhere?server=unlisted&doc=abroad`);
  await ready(stranger);
  await stranger.fill('.title', 'Let me in');
  await stranger.waitForTimeout(800);
  assert.equal(await stranger.inputValue('.title'), 'Let me in');
  assert.ok(refused.length > 0, 'the browser refused the cross-site requests');
  assert.deepEqual((await (await unlisted.fetch(new Request(`${base}/_zb/unlisted/pull?since=0`))).json()).changes.map((c) => c.value), ['Not for other sites']);
  await context.close();
});

test('webrtc.js is loaded only by a page that asks for webrtc', async () => {
  const fetched = async (mode) => {
    const context = await browser.newContext();
    const tab = await context.newPage();
    const urls = [];
    tab.on('request', (request) => urls.push(new URL(request.url()).pathname));
    await tab.goto(`${base}/board?doc=b9&${mode}`);
    await tab.waitForFunction(() => customElements.get('board-view') && window.link);
    // The live stream opens after webrtc.js, when the page asked for it: by then it's here.
    for (let waited = 0; !urls.some((url) => url === '/_zb/sync/live') && waited < 5000; waited += 50) await tab.waitForTimeout(50);
    assert.ok(urls.includes('/_zb/sync/live'), `${mode}: the live stream opened`);
    await context.close();
    return urls.some((url) => url.endsWith('/sync/webrtc.js'));
  };
  assert.equal(await fetched('connect'), false, 'a connected page without webrtc');
  assert.equal(await fetched('rtc'), true, 'connect({ webrtc: true })');
});

test('webrtc: once two devices have a data channel, presence stops going through the server', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const one = await board(a, 'b5', 'rtc');
  const two = await board(b, 'b5', 'rtc');
  await one.waitForTimeout(300);
  await point(one, 10, 10); // the introduction goes through the server, and starts the channel
  await two.waitForSelector('.other:has-text("10,10")', { timeout: 5000 });
  await point(two, 5, 5);
  await one.waitForSelector('.other:has-text("5,5")', { timeout: 5000 });
  // The channel opens (both ends).
  for (const tab of [one, two]) await tab.waitForFunction(() => window.link.direct().length === 1, null, { timeout: 30_000 });
  presencePosts = 0;
  for (let step = 1; step <= 20; step += 1) {
    await point(one, 20 + step * 2, 30 + step * 2);
    await one.waitForTimeout(20);
  }
  await two.waitForSelector('.other:has-text("60,70")', { timeout: 5000 });
  assert.ok(presencePosts <= 1, `${presencePosts} presence posts went through the server`);
  // A goodbye still goes through the server.
  await one.close();
  await two.waitForSelector('.count:has-text("0")', { timeout: 5000 });
  await a.close();
  await b.close();
});

test('webrtc: a lost signal doesn\'t strand the pair; they start again', async () => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  dropSignals = 1; // the first signal (the offer) never arrives
  const one = await board(a, 'b6', 'rtc');
  const two = await board(b, 'b6', 'rtc');
  // Keep moving (presence through the server is what brings each side back to the pair).
  let moving = true;
  const wiggle = (async () => {
    for (let step = 0; moving; step += 1) {
      await point(one, 10 + (step % 50), 10);
      await point(two, 10, 10 + (step % 50));
      await one.waitForTimeout(150);
    }
  })();
  for (const tab of [one, two]) await tab.waitForFunction(() => window.link.direct().length === 1, null, { timeout: 30_000 });
  moving = false;
  await wiggle;
  assert.equal(dropSignals, 0);
  await a.close();
  await b.close();
});

test('an edit made while the document is still loading is kept, and saved', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/slow?doc=early`);
  await ready(tab);
  await tab.fill('.title', 'Typed before it loaded'); // the store answers 800 ms later
  await tab.waitForTimeout(1200);
  assert.equal(await tab.inputValue('.title'), 'Typed before it loaded');
  await tab.goto(`${base}/slow?doc=early`);
  await ready(tab);
  await tab.waitForFunction(() => document.querySelector('.title').value === 'Typed before it loaded', null, { timeout: 5000 });
  await context.close();
});


test('a read-only server (allowReads): the page still works, its edits stay here, and it says why once', { skip: viaBinary && 'the JavaScript server only' }, async () => {
  await closed.write('tasks', 'shut1', { title: 'From the server' });
  const context = await browser.newContext();
  const tab = await context.newPage();
  const warnings = [];
  tab.on('console', (message) => message.type() === 'warning' && warnings.push(message.text()));
  await tab.goto(`${base}/closed?doc=shut1`);
  await ready(tab);
  await title(tab, 'From the server');
  await tab.fill('.title', 'Edited here');
  await tab.waitForTimeout(700); // several flushes
  assert.equal(await tab.inputValue('.title'), 'Edited here', 'the edit stays on this device');
  assert.deepEqual((await (await closed.fetch(new Request('http://localhost/_zb/closed/pull?since=0'))).json()).changes.map((c) => c.value), ['From the server'], 'nothing from the page reached the log');
  const refused = warnings.filter((text) => text.includes("refused this page's changes"));
  assert.equal(refused.length, 1, `said once: ${JSON.stringify(warnings)}`);
  assert.match(refused[0], /takes no writes from pages/);
  await context.close();
});

test('a refused pull is reported once by connect and follow', async () => {
  for (const path of ['/connected?doc=denied', '/following?poll&doc=denied']) {
    const context = await browser.newContext();
    const tab = await context.newPage();
    const warnings = [];
    tab.on('console', (message) => message.type() === 'warning' && warnings.push(message.text()));
    await tab.route('**/_zb/sync/pull?**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'authorize required' }) }));
    await tab.goto(`${base}${path}`);
    await ready(tab);
    await tab.waitForTimeout(500);
    const refused = warnings.filter((text) => text.includes("refused this page's reads"));
    assert.equal(refused.length, 1, path);
    assert.match(refused[0], /authorize required/);
    await context.close();
  }
});

// ---- follow(): a read-only connection. The reading half is connect()'s, so these run its reading
// tests against follow(), and check what a following page leaves out.

/** A page that follows `doc`, with every request path it makes and its console warnings. */
async function following(doc, query = '') {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const asked = [];
  const warnings = [];
  tab.on('request', (request) => asked.push(`${request.method()} ${new URL(request.url()).pathname}`));
  tab.on('console', (message) => message.type() === 'warning' && warnings.push(message.text()));
  await tab.goto(`${base}/following?doc=${doc}${query}`);
  await ready(tab);
  return { context, tab, asked, warnings };
}
/** Another device, connected, that writes `text` as `doc`'s title. */
async function writes(doc, text) {
  const context = await browser.newContext();
  const writer = await context.newPage();
  await writer.goto(`${base}/connected?doc=${doc}`);
  await ready(writer);
  // What the log has first: a write made before it would carry an older clock than the log's.
  await writer.evaluate(() => window.link.pull());
  await writer.fill('.title', text);
  await stored(writer);
  await writer.evaluate(() => window.link.flush());
  return context;
}

test('follow: a page shows what the log has, then changes as they arrive over the stream, and sends nothing', async () => {
  const first = await writes('f1', 'Already there');
  const { context, tab, asked, warnings } = await following('f1');
  await title(tab, 'Already there');
  for (let waited = 0; !asked.includes('GET /_zb/sync/live') && waited < 5000; waited += 50) await tab.waitForTimeout(50);
  const second = await writes('f1', 'Over the stream');
  await title(tab, 'Over the stream'); // polling is a minute away
  assert.ok(asked.includes('GET /sync/follow.js'));
  for (const never of ['GET /sync/connect.js', 'GET /sync/webrtc.js', 'POST /_zb/sync/push', 'POST /_zb/sync/presence', 'POST /_zb/sync/signal']) {
    assert.ok(!asked.includes(never), `${never}: ${asked.join(', ')}`);
  }
  assert.deepEqual(warnings, []);
  await Promise.all([context.close(), first.close(), second.close()]);
});

test('follow: without the live stream it polls', async () => {
  const { context, tab, asked } = await following('f2', '&poll');
  const writer = await writes('f2', 'By polling');
  await title(tab, 'By polling');
  assert.ok(!asked.includes('GET /_zb/sync/live'), asked.join(', '));
  await Promise.all([context.close(), writer.close()]);
});

test("follow: an edit on the page stays on this device, isn't sent, and is reported once", async () => {
  const { context, tab, asked, warnings } = await following('f3');
  await tab.fill('.title', 'Only here');
  await tab.fill('.title', 'Only here, twice');
  await stored(tab);
  await tab.waitForTimeout(300);
  assert.ok(!asked.some((request) => request.startsWith('POST ')), asked.join(', '));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /follows the log \(follow\(\)\), so its change to "tasks" stays on this device; connect\(\) sends changes/);
  // The log never had it: a connected device sees nothing for the document.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await reader.goto(`${base}/connected?doc=f3`);
  await ready(reader);
  await reader.waitForTimeout(400);
  assert.doesNotMatch(await reader.inputValue('.title'), /Only here/);
  // It is kept on this device, as any unconnected page's state is.
  await tab.reload();
  await ready(tab);
  await title(tab, 'Only here, twice');
  await Promise.all([context.close(), other.close()]);
});

test('follow: a scope gets, and stores, only the documents asked for, under the cursor connect() would use', async () => {
  const scope = { tasks: 'fmine' };
  const { context, tab } = await following('fmine1', `&scope=${encodeURIComponent(JSON.stringify(scope))}`);
  await tab.waitForTimeout(300);
  const outside = await writes('ftheirs1', 'Not for that page');
  const inside = await writes('fmine1', 'For that page');
  await title(tab, 'For that page');
  const keys = await tab.evaluate(() => new Promise((done) => {
    const open = indexedDB.open('zubra-sync');
    open.onsuccess = () => {
      const request = open.result.transaction('docs').objectStore('docs').getAllKeys();
      request.onsuccess = () => done(request.result.map((key) => key.join('/')));
    };
  }));
  assert.ok(keys.includes('tasks/fmine1') && !keys.includes('tasks/ftheirs1'), keys.join(', '));
  assert.deepEqual(await tab.evaluate(() => Object.keys(localStorage).filter((name) => name.startsWith('zubra-sync:cursor'))), [`zubra-sync:cursor:${JSON.stringify(scope)}`]);
  await Promise.all([context.close(), outside.close(), inside.close()]);
});

test('follow: an older change never replaces a newer one, and stop() ends it', async () => {
  const { context, tab } = await following('f5', '&poll');
  const one = await writes('f5', 'First');
  await title(tab, 'First');
  const two = await writes('f5', 'Second');
  await title(tab, 'Second');
  // A change that reaches the log late with an old clock (a device back from offline): the
  // title's first clock again, with another value. The page pulls it and keeps what's newer.
  const log = await (await fetch(`${base}/_zb/sync/pull?since=0`)).json();
  const mine = log.changes.filter((change) => change.key === 'f5' && change.field === 'title');
  const oldest = mine.find((change) => change.value === 'First');
  assert.ok(oldest && mine.at(-1).value === 'Second', JSON.stringify(mine));
  const pushed = await fetch(`${base}/_zb/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ ...oldest, value: 'Stale' }] }) });
  assert.equal(pushed.status, 200);
  await tab.evaluate(() => window.link.pull());
  await tab.waitForTimeout(300);
  assert.equal(await tab.inputValue('.title'), 'Second');
  await tab.evaluate(() => window.link.stop());
  const three = await writes('f5', 'After stopping');
  await tab.waitForTimeout(500);
  assert.equal(await tab.inputValue('.title'), 'Second');
  await Promise.all([context.close(), one.close(), two.close(), three.close()]);
});

test('an index document: a board follows the keys the server keeps, and a new document arrives as a card', { skip: viaBinary && 'the JavaScript server only' }, async () => {
  // The server's side: the order first, then the board's list of keys (docs/sync.md, "A list that grows").
  const place = async (board, key, fields, open) => {
    await sync.write('orders', key, fields);
    await sync.write('boards', board, { open, rev: Date.now() });
  };
  await place('k1', 'k1a', { item: 'Soup', status: 'new' }, ['k1a']);
  const context = await browser.newContext();
  const tab = await context.newPage();
  const asked = [];
  tab.on('request', (request) => asked.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await tab.goto(`${base}/kitchen?doc=k1&open=k1a`);
  const cards = () => tab.locator('order-card').evaluateAll((all) => all.map((card) => `${card.querySelector('.item').textContent}:${card.querySelector('.status').textContent}`));
  const shows = async (expected) => {
    for (let waited = 0; waited < 5000; waited += 50) {
      if (JSON.stringify(await cards()) === JSON.stringify(expected)) return;
      await tab.waitForTimeout(50);
    }
    assert.deepEqual(await cards(), expected);
  };
  await shows(['Soup:new']);
  for (let waited = 0; !asked.includes('GET /_zb/sync/live') && waited < 5000; waited += 50) await tab.waitForTimeout(50);
  const told = Number(await tab.textContent('.told'));
  const pages = asked.filter((request) => request === 'GET /kitchen').length;

  // A new order: its card arrives as data, over the stream (polling is a minute away).
  await place('k1', 'k1b', { item: 'Bread', status: 'new' }, ['k1a', 'k1b']);
  await shows(['Soup:new', 'Bread:new']);
  assert.ok(Number(await tab.textContent('.told')) > told, 'watch() on a field the server changes is told');
  // A card already there is live, as ever; one the server takes off the list goes.
  await sync.write('orders', 'k1a', { status: 'ready' });
  await shows(['Soup:ready', 'Bread:new']);
  await sync.write('boards', 'k1', { open: ['k1b'] });
  await shows(['Bread:new']);
  assert.equal(asked.filter((request) => request === 'GET /kitchen').length, pages, 'the page was not fetched again');
  await context.close();
});

const rows = (tab) => tab.locator('order-list .order').evaluateAll((all) => all.map((row) => row.textContent));
const lists = async (tab, expected) => {
  for (let waited = 0; waited < 5000; waited += 50) {
    if (JSON.stringify(await rows(tab)) === JSON.stringify(expected)) return;
    await tab.waitForTimeout(50);
  }
  assert.deepEqual(await rows(tab), expected);
};

test('documents(): a list of a collection under a prefix; a new document is a new row, as data', { skip: viaBinary && 'the JavaScript server only' }, async () => {
  await sync.write('orders', 'd1/b', { item: 'Soup', status: 'new' });
  await sync.write('orders', 'd1/a', { item: 'Tea', status: 'served' });
  await sync.write('orders', 'd1x/a', { item: 'Elsewhere', status: 'new' });
  const start = encodeURIComponent(JSON.stringify([{ key: 'd1/b', item: 'Soup', status: 'new' }]));
  const live = await browser.newContext();
  const tab = await live.newPage();
  const asked = [];
  tab.on('request', (request) => asked.push(`${request.method()} ${new URL(request.url()).pathname}`));
  await tab.goto(`${base}/orders?doc=d1&start=${start}`);
  await lists(tab, ['Soup:new']);
  // What the store has joins what the page was given: the served order is counted, not shown,
  // and another prefix's isn't there at all.
  for (let waited = 0; (await tab.textContent('.count')) !== '2' && waited < 5000; waited += 50) await tab.waitForTimeout(50);
  assert.equal(await tab.textContent('.count'), '2');
  for (let waited = 0; !asked.includes('GET /_zb/sync/live') && waited < 5000; waited += 50) await tab.waitForTimeout(50);

  // A new document: a new row, in key order, over the stream (polling is a minute away).
  await sync.write('orders', 'd1/ab', { item: 'Bread', status: 'new' });
  await lists(tab, ['Bread:new', 'Soup:new']);
  // A field changing is that row's; a derived list follows (served orders leave, and come back).
  await sync.write('orders', 'd1/b', { status: 'ready' });
  await lists(tab, ['Bread:new', 'Soup:ready']);
  await sync.write('orders', 'd1/ab', { status: 'served' });
  await lists(tab, ['Soup:ready']);
  await sync.write('orders', 'd1/a', { status: 'new' });
  await lists(tab, ['Tea:new', 'Soup:ready']);
  await sync.write('orders', 'd1x/b', { item: 'Elsewhere too', status: 'new' });
  await sync.write('orders', 'd1/c', { item: 'Last', status: 'new' });
  await lists(tab, ['Tea:new', 'Soup:ready', 'Last:new']);
  assert.equal(await tab.textContent('.count'), '4');
  assert.equal(asked.filter((request) => request === 'GET /orders').length, 1, 'the page was not fetched again');

  // The store's all() is the prefix's documents only, by key.
  assert.deepEqual(
    await tab.evaluate(() => import('/sync/index.js').then(({ indexedDBStore }) => indexedDBStore().all('orders', 'd1/')).then((all) => all.map(([key, doc]) => `${key}=${doc.item}`))),
    ['d1/a=Tea', 'd1/ab=Bread', 'd1/b=Soup', 'd1/c=Last'],
  );
  // Another board is another list.
  await tab.evaluate(() => (document.querySelector('order-list').board = 'd1x'));
  await lists(tab, ['Elsewhere:new', 'Elsewhere too:new']);
  // A reload with nothing given: the list is the store's.
  await tab.goto(`${base}/orders?doc=d1`);
  await lists(tab, ['Tea:new', 'Soup:ready', 'Last:new']);
  await live.close();
});

test('documents(): with no server, a list follows the components on the page and in other tabs, and the store after a reload', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/orders?doc=d2&local`);
  await tab.waitForFunction(() => customElements.get('order-list'));
  await lists(tab, []);
  // A change from anywhere on the page (what a connection, or a component's save, delivers).
  await tab.evaluate(() => import('/sync/index.js').then(({ receive }) => receive('orders', 'd2/1', { item: 'Pie', status: 'new' })));
  await lists(tab, ['Pie:new']);
  const second = await context.newPage();
  await second.goto(`${base}/orders?doc=d2&local`);
  await lists(second, ['Pie:new']); // from IndexedDB
  await second.evaluate(() => import('/sync/index.js').then(({ receive }) => receive('orders', 'd2/2', { item: 'Roll', status: 'new' })));
  await lists(tab, ['Pie:new', 'Roll:new']); // from the other tab
  // A component's own edit, on the same page.
  await second.goto(`${base}/orders?doc=d2&local&card=1`);
  await lists(second, ['Pie:new', 'Roll:new']);
  await second.click('order-card .ready');
  await lists(second, ['Pie:ready', 'Roll:new']);
  await lists(tab, ['Pie:ready', 'Roll:new']);
  await context.close();
});

test('documents(): a store without all() says so once, and the list still hears changes', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const errors = [];
  tab.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await tab.goto(`${base}/orders?doc=d3&local&bare&start=${encodeURIComponent(JSON.stringify([{ key: 'd3/1', item: 'Given', status: 'new' }]))}`);
  await lists(tab, ['Given:new']);
  await tab.evaluate(() => import('/sync/index.js').then(({ receive }) => receive('orders', 'd3/2', { item: 'Heard', status: 'new' })));
  await lists(tab, ['Given:new', 'Heard:new']);
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /this store has no all\(collection, prefix\), so documents\("orders"\)/);
  await context.close();
});

// Security audit of #433: the device doesn't check a change's key, and IndexedDB sorts an array
// key after every string, inside the range all() reads. Reading it threw in the cursor's handler,
// which aborted the transaction with nothing said: all() never settled, on every load.
test('documents(): a stored key that is not a string ends the listing; all() still answers', async () => {
  const context = await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(`${base}/orders?doc=d5&local`);
  await tab.waitForFunction(() => customElements.get('order-list'));
  const answers = await tab.evaluate(async () => {
    const { indexedDBStore, receive } = await import('/sync/index.js');
    await receive('orders', 'd5/1', { item: 'Pie', status: 'new' });
    await receive('orders', ['not', 'a', 'string'], { item: 'Odd' });
    const store = indexedDBStore();
    const within = (asked) => Promise.race([asked.then((all) => all.map(([key]) => key).filter((key) => key.startsWith('d5') || key.startsWith('zz'))), new Promise((done) => setTimeout(() => done('never settled'), 2000))]);
    return [await within(store.all('orders', 'd5/')), await within(store.all('orders', 'zz/')), await within(store.all('orders', ''))];
  });
  assert.deepEqual(answers, [['d5/1'], [], ['d5/1']]);
  await lists(tab, ['Pie:new']);
  await context.close();
});
