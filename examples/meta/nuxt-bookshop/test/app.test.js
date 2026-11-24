// The bookshop in Chromium: `nuxt build`, the Nitro server, then the list (filtered on the
// server through a zubra segmented control) and the editor (four zubra controls on v-model).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { shot } from '../../../../demos/shot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside this repository: the CLI from `cargo build`, unless zubra.wasm is built (see README).
const cli = join(root, '../../../target/debug', process.platform === 'win32' ? 'zubra.exe' : 'zubra');
if (!process.env.ZUBRA_COMPILER && existsSync(cli)) process.env.ZUBRA_COMPILER = cli;
let base; // where the server says it listens
let server, browser;

/** A port nothing is listening on (the OS picks it), so two runs can't collide. */
const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** Starts the built Nitro server with extra environment, once it answers: its URL and process. */
async function start(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, '.output/server/index.mjs')], { cwd: root, stdio: 'pipe', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env } });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => (output += chunk));
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const url = /Listening on:?\s*(https?:\/\/\S+)/.exec(output)?.[1];
      if (url) resolve(url.replace(/\/$/, '').replace('[::]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1'));
    });
    child.on('exit', (code) => reject(new Error(`the server exited with ${code}:\n${output}`)));
  });
  // Then until it answers: the line can come a moment before the socket takes connections.
  for (let tries = 0; ; tries++) {
    try {
      await fetch(`${url}/api/books`);
      break;
    } catch (error) {
      if (tries === 50) throw new Error(`the server said ${url} but doesn't answer there:\n${output}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return { url, child };
}

before(async () => {
  execFileSync(process.execPath, [join(root, 'node_modules/nuxt/bin/nuxt.mjs'), 'build'], { cwd: root, stdio: 'pipe' });
  ({ url: base, child: server } = await start());
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
});
beforeEach(() => fetch(`${base}/api/reset`, { method: 'POST' }));

async function open(path) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(base + path);
  return { page, messages };
}

test('the list: server-rendered, filtered by genre through v-model on a zubra element', async () => {
  const { page, messages } = await open('/');
  await page.waitForSelector('stock-meter [role=meter]');
  assert.equal(await page.locator('.books li').count(), 7);
  await shot(page, 'nuxt-bookshop');
  assert.equal(await page.textContent('li[data-id=b4] stock-meter span'), 'Out of stock');
  assert.equal(await page.textContent('li[data-id=b2] stock-meter span'), '2 left: reorder');

  await page.click('segmented-control button[data-value=kids]');
  await page.waitForFunction(() => document.querySelectorAll('.books li').length === 2);
  assert.match(page.url(), /\?genre=kids$/);
  // A shareable URL: loaded directly, the server filters.
  const direct = await open('/?genre=nonfiction');
  await direct.page.waitForSelector('segmented-control button[aria-pressed=true]');
  assert.equal(await direct.page.locator('.books li').count(), 2);
  assert.equal(await direct.page.getAttribute('segmented-control button[aria-pressed=true]', 'data-value'), 'nonfiction');
  assert.deepEqual([...messages, ...direct.messages], [], 'no hydration mismatches');
  await page.close();
  await direct.page.close();
});

test('without JavaScript: the stock meters (light DOM) and the genre switch (a declarative shadow root) are in the server HTML', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // The stock meter is a light-DOM component: the Vue wrapper wrote its props and its rendered
  // children (3.3); the segmented control is shadow DOM, filled by @zubra/server's injectShadowRoots.
  assert.match(html, /<stock-meter zb-props="[^"]*">\s*<div role="meter"/, 'the Vue wrapper wrote zb-props and the light-DOM content');
  assert.match(html, /<segmented-control zb-props="[^"]*"><template shadowrootmode="open">/, 'the shadow root');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  assert.equal(await page.textContent('li[data-id=b4] stock-meter span'), 'Out of stock');
  assert.equal(await page.textContent('li[data-id=b2] stock-meter span'), '2 left: reorder');
  assert.equal(await page.locator('segmented-control button').count() >= 3, true);
  await context.close();
});

test('editing: money, stock, tags and featured on v-model, saved through the API', async () => {
  const { page, messages } = await open('/books/b2');
  await page.waitForSelector('quantity-stepper button.more');
  assert.equal(await page.isDisabled('button:has-text("Save")'), true, 'nothing changed yet');
  await page.click('quantity-stepper button.more');
  await page.click('quantity-stepper button.more');
  assert.equal(await page.textContent('.stock stock-meter span'), '4 left: reorder', 'the meter follows the stepper');
  await page.click('quantity-stepper button.more');
  assert.equal(await page.textContent('.stock stock-meter span'), '5 in stock');
  await page.fill('money-input input', '23.5');
  await page.locator('money-input input').blur();
  assert.equal(await page.inputValue('money-input input'), '23.50');
  await page.fill('tag-input input', 'Staff Pick');
  await page.press('tag-input input', 'Enter');
  await page.click('toggle-switch button');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('[role=status]');

  const saved = await (await fetch(`${base}/api/books/b2`)).json();
  assert.deepEqual({ price: saved.price, stock: saved.stock, tags: saved.tags, featured: saved.featured }, { price: 23.5, stock: 5, tags: ['historical', 'staff-pick'], featured: true });
  await page.reload();
  await page.waitForSelector('tag-input .tag');
  assert.deepEqual(await page.locator('tag-input .tag').evaluateAll((tags) => tags.map((tag) => tag.textContent.replace('×', '').trim())), ['historical', 'staff-pick']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('the API validates what the editor sends', async () => {
  const response = await fetch(`${base}/api/books/b1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: -1, stock: 1.5, tags: [], featured: false }) });
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).data, { price: 'A price between 0 and 1,000.', stock: 'Stock is a whole number from 0 to 999.' });
});

// The same build as a public demo (HOSTED_DEMO=1, as deploy/nuxt-bookshop runs it): the notice and
// the caps of server/hosted.js, through Nitro, with the headers Railway's proxy sends.
const HOST = 'nuxt-bookshop-production.up.railway.app';
const DEMO = { HOSTED_DEMO: '1', TRUST_PROXIES: '1' };
const NOTICE = '<p class="demo-notice">Demo: data resets daily.</p>';

/** A raw request to `url` (http.request, so Host can be the public one), with a JSON body. */
const raw = (url, method, path, { headers = {}, body, chunked = false } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const sent = { host: HOST, 'content-type': 'application/json', ...(data && !chunked ? { 'content-length': data.length } : {}), ...headers };
  const req = request(`${url}${path}`, { method, headers: sent }, (response) => {
    let text = '';
    response.on('data', (chunk) => (text += chunk)).on('end', () => resolve({ status: response.statusCode, text }));
  });
  req.on('error', reject);
  if (data && chunked) for (let at = 0; at < data.length; at += 4096) req.write(data.subarray(at, at + 4096));
  req.end(data && !chunked ? data : undefined);
});
const edit = (stock) => ({ price: 21, stock, tags: ['historical'], featured: false });
const fromPage = (visitor, site = true) => ({ origin: `https://${HOST}`, 'x-forwarded-proto': 'https', 'x-forwarded-for': visitor, ...(site ? { 'sec-fetch-site': 'same-origin' } : {}) });
/** Waits out the end of a minute, so a test's writes are counted in one. */
const sameMinute = async () => {
  if (Date.now() % 60_000 > 50_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - (Date.now() % 60_000) + 50));
};

test('hosted: every page says the data resets, and only when hosted', async () => {
  const demo = await start(DEMO);
  try {
    for (const path of ['/', '/?genre=kids', '/books/b2']) assert.ok((await (await fetch(demo.url + path)).text()).includes(NOTICE), path);
    assert.ok(!(await (await fetch(`${base}/`)).text()).includes('class="demo-notice"'));
    const page = await browser.newPage();
    await page.goto(`${demo.url}/books/b2`);
    await page.waitForSelector('quantity-stepper button.more');
    assert.equal(await page.textContent('.demo-notice'), 'Demo: data resets daily.');
    // Saving from the page passes the same-site check.
    await page.click('quantity-stepper button.more');
    await page.click('button:has-text("Save")');
    await page.waitForSelector('[role=status]');
    assert.equal((await (await fetch(`${demo.url}/api/books/b2`)).json()).stock, 3);
    await page.click('a:has-text("Books")');
    await page.waitForSelector('h1:has-text("Books")');
    assert.equal(await page.locator('.demo-notice').count(), 1, 'still there after client-side navigation');
    await page.close();
  } finally {
    demo.child.kill();
  }
});

test('hosted: behind the proxy, writes from the shop pass and cross-site ones are refused', async () => {
  const demo = await start(DEMO);
  try {
    let response = await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.10'), body: edit(9) });
    assert.equal(response.status, 200, response.text);
    assert.equal(JSON.parse(response.text).stock, 9);
    response = await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.10', false), body: edit(8) });
    assert.equal(response.status, 200, 'with Origin and no Sec-Fetch-Site');
    response = await raw(demo.url, 'PUT', '/api/books/b2', { headers: { ...fromPage('203.0.113.10'), origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: edit(1) });
    assert.equal(response.status, 403);
    response = await raw(demo.url, 'PUT', '/api/books/b2', { headers: { ...fromPage('203.0.113.10', false), origin: 'https://evil.example' }, body: edit(1) });
    assert.equal(response.status, 403, 'cross-site, Origin only');
    assert.equal((await (await fetch(`${demo.url}/api/books/b2`)).json()).stock, 8);
    assert.equal((await raw(demo.url, 'POST', '/api/reset', { headers: fromPage('203.0.113.10') })).status, 404, 'no reset for visitors');
    assert.equal((await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.10'), body: edit(1.5) })).status, 422, 'the API still validates');
  } finally {
    demo.child.kill();
  }
});

test('hosted: bodies over 16 KiB are refused, with or without a Content-Length', async () => {
  const demo = await start(DEMO);
  try {
    const big = { ...edit(4), tags: ['x'.repeat(20_000)] };
    assert.equal((await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.20'), body: big })).status, 413);
    assert.equal((await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.20'), body: big, chunked: true })).status, 413);
    const small = await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.20'), body: edit(4), chunked: true });
    assert.equal(small.status, 200, small.text);
    assert.equal((await (await fetch(`${demo.url}/api/books/b2`)).json()).stock, 4);
  } finally {
    demo.child.kill();
  }
});

test('hosted: 30 writes a minute from each visitor, by the proxy’s entry in X-Forwarded-For', async () => {
  const demo = await start(DEMO);
  try {
    await sameMinute();
    const write = (visitor) => raw(demo.url, 'PUT', '/api/books/b1', { headers: fromPage(visitor), body: { ...edit(5), price: 18.5 } });
    for (let i = 0; i < 30; i++) assert.equal((await write('203.0.113.30')).status, 200);
    assert.equal((await write('203.0.113.30')).status, 429);
    assert.equal((await write('198.51.100.7, 203.0.113.30')).status, 429, 'a first entry of their own changes nothing');
    assert.equal((await write('203.0.113.31')).status, 200, 'another visitor still can');
  } finally {
    demo.child.kill();
  }
});

test('hosted: the books go back to their seed when a period ends (DEMO_RESET_MINUTES)', async () => {
  const period = 3000;
  const demo = await start({ ...DEMO, DEMO_RESET_MINUTES: String(period / 60_000) });
  try {
    // Just after a period starts, so the edit and the read after it fall in one.
    await new Promise((resolve) => setTimeout(resolve, period - (Date.now() % period) + 100));
    assert.equal((await raw(demo.url, 'PUT', '/api/books/b2', { headers: fromPage('203.0.113.40'), body: edit(9) })).status, 200);
    assert.equal((await (await fetch(`${demo.url}/api/books/b2`)).json()).stock, 9);
    await new Promise((resolve) => setTimeout(resolve, period - (Date.now() % period) + 100));
    assert.equal((await (await fetch(`${demo.url}/api/books/b2`)).json()).stock, 2);
  } finally {
    demo.child.kill();
  }
});
