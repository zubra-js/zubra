// The prototype in src/refresh.js: a plain form post whose form names the parts it changes is sent
// with fetch, and those parts come from the page the server redirects to. Real Chromium, a plain
// server: nothing here is Zubra's but the script.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const script = readFileSync(new URL('../src/refresh.js', import.meta.url));
let server, browser, base;
let count = 0;
const posts = [];

const page = (url) => `<!doctype html><title>Bag (${count})</title>
<nav id="site">Bag (${count})</nav>
${url.searchParams.has('bare') ? '<p id="bare">No notice here</p>' : `<div id="said" role="status">${url.searchParams.get('done') ?? ''}</div>`}
<input id="typed">
<form id="add" method="post" action="/add" data-zb-refresh="site said"><input name="item" value="bread"><button name="qty" value="2">Add</button></form>
<form id="plain" method="post" action="/add"><button>Plain</button></form>
<form id="away" method="post" action="/away" data-zb-refresh="site said"><button>Away</button></form>
<form id="missing" method="post" action="/add" data-zb-refresh="site nowhere"><button>Missing</button></form>
<form id="shown" method="post" action="/shown" data-zb-refresh="site said"><button>Shown</button></form>
<form id="self" method="post" action="/?self" data-zb-refresh="site said"><button>Self</button></form>
<form id="gone" method="post" action="/gone" data-zb-refresh="site said"><button>Gone</button></form>
<script type="module" src="/refresh.js"></script>`;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/refresh.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        posts.push({ path: url.pathname, type: req.headers['content-type'], body });
        count++;
        // Answered with a page, no redirect: one of its own, and this page again with a problem.
        if (url.pathname === '/shown') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Shown</title><h1 id="shown-page">The post\'s own page</h1>');
        if (url.searchParams.has('self')) return res.writeHead(422, { 'content-type': 'text/html' }).end(page(new URL('/?done=Not+that+many+left.', url)));
        const to = url.pathname === '/away' ? '/other' : url.pathname === '/gone' ? '/?bare' : '/?done=Added.';
        res.writeHead(303, { location: to }).end();
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/other') return res.end('<!doctype html><title>Other</title><nav id="site">Bag</nav><div id="said"></div><h1 id="other">Another page, with the same parts</h1>');
    res.end(page(url));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** A page with something typed (state a reload would lose) and a count of document requests. */
async function open() {
  const tab = await browser.newPage();
  const seen = { documents: 0, posted: 0 };
  tab.on('request', (request) => {
    if (request.resourceType() !== 'document') return;
    seen.documents++;
    if (request.method() === 'POST') seen.posted++;
  });
  await tab.goto(`${base}/`);
  await tab.fill('#typed', 'still here');
  seen.documents = seen.posted = 0;
  posts.length = 0;
  return { tab, seen };
}

test('a form that names its parts posts with fetch: the parts change, the page and its state stay', async () => {
  const { tab, seen } = await open();
  const before = count;
  await tab.evaluate(() => {
    window.kept = document.getElementById('said');
    document.addEventListener('refresh', (event) => (window.refreshed = event.detail.url));
  });
  await tab.click('#add button');
  await tab.waitForFunction(() => document.getElementById('said').textContent === 'Added.');
  assert.equal(await tab.textContent('#site'), `Bag (${before + 1})`);
  assert.equal(await tab.title(), `Bag (${before + 1})`);
  assert.equal(seen.documents, 0, 'no page was loaded');
  assert.equal(await tab.inputValue('#typed'), 'still here');
  assert.equal(await tab.evaluate(() => window.kept === document.getElementById('said')), true, 'the part itself is the same element');
  assert.equal(new URL(tab.url()).search, '?done=Added.', 'the address is where the server sent it');
  assert.equal(await tab.evaluate(() => window.refreshed), `${base}/?done=Added.`);
  assert.equal(await tab.getAttribute('#add', 'aria-busy'), null);
  // What the browser would have sent: urlencoded, the pressed button's name and value included.
  assert.deepEqual(posts, [{ path: '/add', type: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'item=bread&qty=2' }]);
  await tab.close();
});

test("a form without the attribute, or naming a part the page doesn't have, posts as the browser does", async () => {
  for (const form of ['#plain', '#missing']) {
    const { tab, seen } = await open();
    await Promise.all([tab.waitForURL(/done=Added/), tab.click(`${form} button`)]);
    assert.equal(seen.posted, 1, `${form}: the browser posted it, not fetch`);
    assert.equal(await tab.inputValue('#typed'), '', `${form}: the page was loaded again`);
    assert.equal(posts.length, 1, form);
    await tab.close();
  }
});

test('a redirect to another page, or to one without the parts, is followed as a navigation, posting once', async () => {
  for (const [form, lands] of [['#away', '#other'], ['#gone', '#bare']]) {
    const { tab } = await open();
    await tab.click(`${form} button`);
    await tab.waitForSelector(lands);
    assert.equal(await tab.locator('#typed').count() ? await tab.inputValue('#typed') : '', '', `${form}: a page was loaded`);
    assert.equal(posts.length, 1, `${form} posted once`);
    await tab.close();
  }
});

test('when the request fails, the browser posts the form itself', async () => {
  const { tab, seen } = await open();
  await tab.route('**/add', (route) => (route.request().resourceType() === 'fetch' ? route.abort() : route.continue()));
  await Promise.all([tab.waitForURL(/done=Added/), tab.click('#add button')]);
  assert.ok(seen.documents >= 1);
  assert.deepEqual(posts.map((post) => post.body), ['item=bread&qty=2'], 'once, with the button');
  await tab.close();
});

test('a canceled submit and a data-zb-native form are left alone', async () => {
  const { tab, seen } = await open();
  await tab.evaluate(() => document.getElementById('add').addEventListener('submit', (event) => event.preventDefault(), { capture: true }));
  await tab.click('#add button');
  await tab.waitForTimeout(200);
  assert.equal(posts.length, 0);
  await tab.close();
  const second = await open();
  await second.tab.evaluate(() => document.getElementById('add').setAttribute('data-zb-native', ''));
  await Promise.all([second.tab.waitForURL(/done=Added/), second.tab.click('#add button')]);
  assert.ok(second.seen.documents >= 1);
  assert.equal(seen.documents, 0);
  await second.tab.close();
});

test('a post answered with a page and no redirect: this page again is merged, another is shown, each posted once', async () => {
  const { tab, seen } = await open();
  await tab.click('#self button');
  await tab.waitForFunction(() => document.getElementById('said').textContent === 'Not that many left.');
  assert.equal(await tab.inputValue('#typed'), 'still here');
  assert.equal(seen.documents, 0);
  await tab.click('#shown button');
  await tab.waitForSelector('#shown-page');
  assert.equal(new URL(tab.url()).pathname, '/shown');
  assert.equal(seen.posted, 0, 'fetch posted it');
  assert.deepEqual(posts.map((post) => post.path), ['/', '/shown']);
  await tab.close();
});
