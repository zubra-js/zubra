// The router in a browser: the shell, a section layout and a page arrive as one document and
// each hydrates where it is, with what's in its slot left alone; links are whole page loads;
// and with JavaScript off every page is still complete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createZubra } from '@zubra/server';
import { createRouter } from '../src/index.js';

const components = fileURLToPath(new URL('./components', import.meta.url));
const cacheDir = fileURLToPath(new URL('./.cache', import.meta.url));
let browser;
let server;
let base;

before(async () => {
  const zubra = createZubra({ components, cache: false });
  const router = await createRouter({ zubra, components, cacheDir, onError: () => {}, context: ({ req }) => ({ person: req?.headers['x-person'] }) });
  server = createServer(async (req, res) => {
    if (zubra.handle(req, res)) return;
    if (await router.handle(req, res)) return;
    await router.notFound(req, res);
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

const open = async (path, options) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  const response = await page.goto(`${base}${path}`);
  return { page, errors, response, close: () => context.close() };
};

test('shell, layout and page hydrate in place: three levels, each working, nothing lost', async () => {
  const { page, errors, close } = await open('/docs/guide/routing');
  await page.waitForFunction(() => ['app-shell', 'docs-shell', 'docs-page'].every((tag) => customElements.get(tag)));
  // The shell is live, and what was in its slot (the layout, and the page in the layout's) is still there.
  await page.click('button.menu');
  await page.waitForSelector('button.menu:has-text("Menu open")');
  assert.equal(await page.textContent('app-shell main docs-shell aside.docs'), 'Docs');
  assert.equal(await page.textContent('app-shell main docs-shell docs-page p.path'), 'guide/routing');
  assert.equal(await page.locator('docs-page').count(), 1, 'rendered once, not again by the browser');
  assert.deepEqual(errors, []);
  await close();
});

test("a page inside a root layout is live, with the layout's props and the current link", async () => {
  const { page, errors, close } = await open('/farm/stock', { extraHTTPHeaders: { 'x-person': 'Lin' } });
  await page.waitForFunction(() => ['farm-shell', 'farm-stock'].every((tag) => customElements.get(tag)));
  await page.click('button.count');
  await page.click('button.count');
  await page.waitForSelector('button.count:has-text("Counted 2")');
  assert.equal(await page.textContent('p.farmer'), 'Lin');
  assert.equal(await page.textContent('p.for'), 'Stock for Lin');
  assert.equal(await page.getAttribute('a[href="/farm/stock"]', 'aria-current'), 'page');
  assert.equal(await page.getAttribute('a[href="/farm"]', 'aria-current'), null);
  assert.equal(await page.locator('app-shell').count(), 0);
  assert.equal(await page.title(), 'Stock');
  // A link is a whole page load: a new document, the other page, its link marked.
  await Promise.all([page.waitForURL(`${base}/farm`), page.click('a[href="/farm"]')]);
  await page.waitForFunction(() => customElements.get('farm-today'));
  assert.equal(await page.textContent('h1'), 'Today');
  assert.equal(await page.getAttribute('a[href="/farm"]', 'aria-current'), 'page');
  assert.equal(await page.textContent('p.farmer'), 'Lin');
  assert.deepEqual(errors, []);
  await close();
});

test('without JavaScript every page is whole: a page, a guard, a redirect, a 404', async () => {
  const { page, response, close } = await open('/farms/hilltop', { javaScriptEnabled: false });
  assert.equal(response.status(), 200);
  assert.equal(await page.textContent('app-shell main farm-page h1'), 'Hilltop Farm');
  assert.equal(await page.title(), 'Hilltop Farm <Tailgate>');
  // The guard: another component at the same URL.
  await page.goto(`${base}/door`);
  assert.equal(new URL(page.url()).pathname, '/door');
  assert.equal(await page.getAttribute('app-shell sign-in form', 'action'), '/staff/sign-in');
  // A redirect lands on the page it names.
  await page.goto(`${base}/old`);
  assert.equal(new URL(page.url()).pathname, '/farms/new');
  assert.equal(await page.textContent('h1'), 'New farm');
  // An unknown path: the app's shell around the error page, as a 404.
  const missing = await page.goto(`${base}/nowhere`);
  assert.equal(missing.status(), 404);
  assert.equal(await page.textContent('app-shell main error-page h1'), 'Nothing here');
  assert.equal(await page.textContent('app-shell header a[href="/"]'), 'Home');
  await close();
});

test('an error page hydrates like any other', async () => {
  const { page, errors, response, close } = await open('/broken');
  assert.equal(response.status(), 500);
  await page.waitForFunction(() => ['app-shell', 'error-page'].every((tag) => customElements.get(tag)));
  await page.click('button.menu');
  await page.waitForSelector('button.menu:has-text("Menu open")');
  assert.equal(await page.textContent('error-page h1'), 'That broke');
  // The browser reports the 500 itself; nothing else went wrong.
  assert.deepEqual(errors.filter((message) => !/500/.test(message)), []);
  await close();
});
