// buildRuntime() (experimental): an app's own build of the runtime, one module with only what its
// components name, served in place of the base and every file beside it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createZubra } from '../src/index.js';
import { buildApp, buildRuntime } from '../src/build.js';

const components = mkdtempSync(join(tmpdir(), 'zubra-build-'));
const write = (name, source) => writeFileSync(join(components, name), source);
// Nothing of what is split off.
write('plain-card.zb', '<script>\n  let count = 0\n</script>\n<plain-card label="Plain">\n  <button class="up" onclick={() => count++}>{label}</button> <output>{count}</output>\n</plain-card>\n');
// An event modifier in the template: the compiler names its binder.
write('key-box.zb', '<script>\n  let said = ""\n</script>\n<key-box>\n  <input onkeydown.enter={() => (said = "enter")}> <output>{said}</output>\n</key-box>\n');
// An event helper called by the script: the script's own import names it.
write('guard-link.zb', "<script>\n  import { prevent } from '@zubra/runtime'\n  let went = 0\n  const go = prevent(() => went++)\n</script>\n<guard-link>\n  <a href=\"/elsewhere\" onclick={go}>go</a> <output>{went}</output>\n</guard-link>\n");
// Context, both ends.
write('theme-box.zb', "<script>\n  import { provide } from '@zubra/runtime'\n  import { theme } from './theme.js'\n  import './theme-name.zb'\n  provide(theme, 'dark')\n</script>\n<theme-box>\n  <theme-name></theme-name>\n</theme-box>\n");
write('theme-name.zb', "<script>\n  import { inject } from '@zubra/runtime'\n  import { theme } from './theme.js'\n  const name = inject(theme)\n</script>\n<theme-name>\n  <output>{name}</output>\n</theme-name>\n");
// A plain module beside them, which names the runtime itself.
write('theme.js', "import { createContext } from '@zubra/runtime';\nexport const theme = createContext('light');\n");
// resource().
write('late-word.zb', "<script>\n  import { resource } from '@zubra/runtime'\n  const word = resource(async () => 'ready')\n</script>\n<late-word>\n  <output>{word.value ?? 'waiting'}</output>\n</late-word>\n");
// A form control with a helper, in a shadow root.
write('pick-one.zb', "<script>\n  import { formValue } from '@zubra/runtime'\n  let value = 'a'\n  formValue(() => value)\n</script>\n<pick-one shadow form-associated>\n  <button class=\"b\" onclick={() => (value = 'b')}>b</button>\n</pick-one>\n");

// Spread attributes: their binder is an entry of its own (`@zubra/runtime/spread`).
write('spread-box.zb', '<script>\n  let attrs = { title: "spread", "data-n": 1 }\n</script>\n<spread-box>\n  <p {...attrs}>p</p>\n</spread-box>\n');

const layout = (body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}${script}</body></html>`;
const preloaded = (html) => [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((match) => match[1]);
const runtime_ = (list) => list.filter((url) => url.startsWith('/_zubra/runtime/')).map((url) => url.slice('/_zubra/runtime/'.length)).sort();
/** The page of `tags`, each rendered once (theme-box has a theme-name inside; pick-one is in a form). */
function pageOf(zubra, tags, script) {
  const page = zubra.page();
  const body = tags.map((tag) => (tag === 'pick-one' ? `<form>${page.render(tag).replace('<pick-one', '<pick-one name="pick"')}</form>` : page.render(tag))).join('');
  return page.finish(layout(body, script));
}

let browser;
let runtime;
const servers = [];
before(async () => {
  browser = await chromium.launch();
  runtime = await buildRuntime({ components });
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
  rmSync(components, { recursive: true, force: true });
});
async function serving(zubra, html) {
  const server = createServer((request, response) => {
    if (zubra.handle(request, response)) return;
    response.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const ALL = ['plain-card', 'key-box', 'guard-link', 'theme-box', 'late-word', 'pick-one', 'spread-box'];
const text = async (zubra, path) => (await zubra.fetch(new Request(`http://localhost${path}`))).text();

test('buildRuntime: one module with the names the app imports from the runtime, and nothing they do not reach', async () => {
  assert.match(runtime.file, /^app-[0-9a-f]{10}\.js$/);
  // From the components, from the plain module beside them (createContext), and by entry or file.
  for (const name of ['$component', '$r', '$t', '$hydrate', '$modified', '$form', '$shadow', 'spread', 'prevent', 'provide', 'inject', 'createContext', 'resource', 'formValue']) assert.ok(runtime.names.includes(name), name);
  for (const name of ['$await', '$each', 'watch', 'validity', 'keys']) assert.ok(!runtime.names.includes(name), `${name} isn't asked for`);
  const built = await import(`data:text/javascript;base64,${Buffer.from(runtime.code).toString('base64')}`).catch((error) => error);
  // (It is a browser module; what matters here is that it parses and exports exactly the names.)
  if (!(built instanceof Error)) assert.deepEqual(Object.keys(built).sort(), [...runtime.names].sort());
  assert.doesNotMatch(runtime.code, /from\s*["']\.\//, 'it imports nothing of the runtime');
  // The same build twice is the same file; `keep` adds to it.
  assert.equal((await buildRuntime({ components })).file, runtime.file);
  const kept = await buildRuntime({ components, keep: ['watch', 'keys'] });
  assert.ok(kept.names.includes('watch') && kept.names.includes('keys') && kept.file !== runtime.file);
  // Smaller than what these pages load without it: the base and the five files beside it.
  const zubra = createZubra({ components, production: true });
  let split = 0;
  for (const file of ['zubra.js', 'form.js', 'modifiers.js', 'provide.js', 'resource.js', 'shadow.js']) split += gzipSync(await text(zubra, `/_zubra/runtime/${file}`)).length;
  const own = gzipSync(runtime.code).length;
  assert.ok(own < split - 2000, `${own} B against ${split} B`);
});

test('buildRuntime says what is wrong: no runtime here to build, a name the runtime does not have', async () => {
  await assert.rejects(buildRuntime({ components, imports: { '@zubra/runtime': 'https://cdn.example/zubra.js' } }), /served from somewhere else/);
  await assert.rejects(buildRuntime({ components, keep: ['nothingLikeThis'] }), /doesn't have a name a module imports.*nothingLikeThis/s);
});

test('with a built runtime every module takes the runtime from it, whichever entry or file it named, and a page preloads it alone', async () => {
  const zubra = createZubra({ minify: false, components, production: true, runtime });
  const at = `../runtime/${runtime.file}`;
  const guard = await text(zubra, '/_zubra/components/guard-link.js');
  assert.ok(guard.includes(`import { prevent } from '${at}';`), guard.slice(0, 300));
  assert.ok(guard.includes(`from "${at}";`));
  assert.doesNotMatch(guard, /@zubra\/runtime|runtime\/(?:zubra|modifiers)\.js/);
  assert.ok((await text(zubra, '/_zubra/components/theme.js')).startsWith(`import { createContext } from '${at}';`));
  assert.doesNotMatch(await text(zubra, '/_zubra/components/pick-one.js'), /@zubra\/runtime|runtime\/(?:zubra|form|shadow)\.js/);
  const html = pageOf(zubra, ALL);
  assert.deepEqual(runtime_(preloaded(html)), [runtime.file]);
  assert.ok(html.includes(`"@zubra/runtime":"/_zubra/runtime/${runtime.file}"`), 'the bare name is the built module too');
  // And the runtime's other entries, for a script that names one.
  for (const entry of ['spread', 'primitives', 'motion', 'track']) assert.ok(html.includes(`"@zubra/runtime/${entry}":"/_zubra/runtime/${runtime.file}"`), entry);
  assert.doesNotMatch(await text(zubra, '/_zubra/components/spread-box.js'), /@zubra\/runtime|runtime\/spread\.js/);
  const served = await zubra.fetch(new Request(`http://localhost/_zubra/runtime/${runtime.file}`));
  assert.equal(await served.text(), runtime.code);
  assert.match(served.headers.get('cache-control'), /immutable/);
});

test("with a built runtime the runtime's own files say they would be a second copy, and development serves the runtime as it always did", async () => {
  const zubra = createZubra({ components, production: true, runtime });
  for (const file of ['zubra.js', 'core.js', 'form.js', 'spread.js']) assert.match(await text(zubra, `/_zubra/runtime/${file}`), /^throw new Error\("@zubra\/server: this app serves a built runtime .*second copy/, file);
  assert.doesNotMatch(await text(zubra, '/_zubra/runtime/remark.js'), /^throw /);
  const development = createZubra({ components, production: false, runtime });
  assert.doesNotMatch(await text(development, '/_zubra/runtime/base.js'), /^throw /);
  assert.ok(!pageOf(development, ALL).includes(runtime.file));
});

test('a component that names what the built runtime lacks is refused when it is compiled, with what to do', () => {
  const stale = { ...runtime, names: runtime.names.filter((name) => name !== 'prevent') };
  const zubra = createZubra({ components, production: true, runtime: stale });
  assert.throws(() => zubra.module('guard-link'), /guard-link\.zb imports `prevent` from @zubra\/runtime, which the built runtime doesn't have\. Build it again \(buildRuntime\(\)\)/);
  assert.doesNotThrow(() => zubra.module('plain-card'));
});

test('in a browser: every feature works on the built runtime alone, and a page script gets what was kept', async () => {
  const kept = await buildRuntime({ components, keep: ['watch'] });
  const zubra = createZubra({ components, production: true, runtime: kept });
  const script = `<script type="module">
    import { state, watch, provide } from '@zubra/runtime';
    window.checked = [typeof state, typeof watch, typeof provide].join(' ');
  </script>`;
  const html = pageOf(zubra, ALL, script);
  const url = await serving(zubra, html);
  const page = await browser.newPage();
  const errors = [];
  const asked = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('request', (request) => asked.push(new URL(request.url()).pathname));
  try {
    await page.goto(url);
    await page.waitForFunction(() => ['plain-card', 'key-box', 'guard-link', 'theme-box', 'theme-name', 'late-word', 'pick-one', 'spread-box'].every((tag) => customElements.get(tag)));
    assert.equal(await page.evaluate(() => window.checked), 'function function function');
    await page.click('plain-card .up');
    assert.equal(await page.textContent('plain-card output'), '1');
    await page.press('key-box input', 'Enter');
    assert.equal(await page.textContent('key-box output'), 'enter');
    await page.click('guard-link a');
    assert.equal(await page.textContent('guard-link output'), '1');
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.textContent('theme-name output'), 'dark');
    await page.waitForFunction(() => document.querySelector('late-word output').textContent === 'ready');
    await page.click('pick-one .b');
    await page.waitForFunction(() => new FormData(document.querySelector('form')).get('pick') === 'b');
    assert.equal(await page.getAttribute('spread-box p', 'title'), 'spread');
    assert.deepEqual(errors, []);
    assert.deepEqual(runtime_(asked), [kept.file], 'one runtime file, and no other');
  } finally {
    await page.close();
  }
});

test('in a browser: a script that asks the runtime for a name that was not kept fails by that name', async () => {
  const zubra = createZubra({ components, production: true, runtime });
  const html = pageOf(zubra, ['plain-card'], '<script type="module">import { watch } from "@zubra/runtime"; window.got = typeof watch;</script>');
  const url = await serving(zubra, html);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url);
    await page.waitForFunction(() => customElements.get('plain-card'));
    await page.click('plain-card .up');
    assert.equal(await page.textContent('plain-card output'), '1', "the page's components are unharmed");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /does not provide an export named 'watch'/);
  } finally {
    await page.close();
  }
});

// ---- buildApp(): the same module also holds the components and the app's own page scripts.

// A page script of the app's own, which uses the runtime: it must be the components' copy of it.
const scriptsDir = mkdtempSync(join(tmpdir(), 'zubra-build-scripts-'));
const ownScript = join(scriptsDir, 'own.js');
writeFileSync(ownScript, "import { effect, state } from '@zubra/runtime';\nconst ran = state(0);\neffect(() => { window.ownScript = `ran ${ran.get()}`; });\nwindow.bump = () => ran.set(ran.get() + 1);\n");
after(() => rmSync(scriptsDir, { recursive: true, force: true }));
const scriptTags = (html) => [...html.matchAll(/<script type="module"[^>]*>([^<]*)<\/script>/g)].map((match) => match[1]);

test('buildApp: one module with the runtime, every component, the plain modules they import and the scripts named', async () => {
  const app = await buildApp({ components, scripts: [ownScript] });
  assert.match(app.file, /^app-[0-9a-f]{10}\.js$/);
  assert.deepEqual(app.components, ['guard-link', 'key-box', 'late-word', 'pick-one', 'plain-card', 'spread-box', 'theme-box', 'theme-name']);
  assert.equal(app.scripts, true);
  for (const tag of app.components) assert.ok(app.code.includes(`"${tag}"`), `${tag} is defined in it`);
  assert.ok(app.code.includes('ownScript'), 'the script is in it');
  // Nothing left to fetch but the runtime's repair chunk, which is only loaded when needed.
  assert.deepEqual([...app.code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map((match) => match[1]), []);
  assert.ok(app.names.includes('$component') && app.names.includes('provide'), 'and it still exports what a served module or a page script may ask the runtime for');
  assert.equal((await buildApp({ components })).scripts, false);
  // Where @zubra/sync isn't installed for the app, its name is left as it is.
  const syncing = join(scriptsDir, 'syncing.js');
  writeFileSync(syncing, "import { follow } from '@zubra/sync/follow';\nfollow();\n");
  assert.deepEqual([...(await buildApp({ components, scripts: [syncing] })).code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map((match) => match[1]), ['@zubra/sync/follow']);
  await assert.rejects(buildApp({ components, scripts: [join(scriptsDir, 'missing.js')] }), /no script at .*missing\.js/);
});

test("with the app's module a page has one script and one preload, and a component's own address is that module", async () => {
  const app = await buildApp({ components, scripts: [ownScript] });
  const zubra = createZubra({ components, production: true, runtime: app });
  const html = pageOf(zubra, ALL);
  assert.deepEqual(preloaded(html), [`/_zubra/runtime/${app.file}`]);
  assert.deepEqual(scriptTags(html), [`import '/_zubra/runtime/${app.file}';`]);
  assert.equal(await text(zubra, '/_zubra/components/plain-card.js'), `import '../runtime/${app.file}';\n`);
  // A page with no component still gets the module when it holds the app's scripts, and not otherwise.
  assert.deepEqual(scriptTags(zubra.page().finish(layout('<p>plain</p>'))), [`import '/_zubra/runtime/${app.file}';`]);
  const noScripts = createZubra({ components, production: true, runtime: await buildApp({ components }) });
  assert.deepEqual(scriptTags(noScripts.page().finish(layout('<p>plain</p>'))), []);
  // Development: every module on its own, as always.
  assert.ok(scriptTags(pageOf(createZubra({ components, production: false, runtime: app }), ['plain-card']))[0].includes('/_zubra/components/plain-card.js'));
});

test("a component added since the app's module was built is refused when its page is made, with what to do", async () => {
  const folder = mkdtempSync(join(tmpdir(), 'zubra-build-stale-'));
  try {
    cpSync(components, folder, { recursive: true });
    const app = await buildApp({ components: folder });
    writeFileSync(join(folder, 'new-one.zb'), '<new-one>\n  <p>new</p>\n</new-one>\n');
    const zubra = createZubra({ components: folder, production: true, runtime: app });
    const page = zubra.page();
    page.render('new-one');
    assert.throws(() => page.finish(layout('')), /new-one isn't in the app's built module\. Build it again \(buildApp\(\)\)/);
    assert.doesNotThrow(() => pageOf(zubra, ['plain-card']));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("in a browser: the whole page runs from the app's one module, its own script on the components' runtime", async () => {
  const app = await buildApp({ components, scripts: [ownScript] });
  const zubra = createZubra({ components, production: true, runtime: app });
  const html = pageOf(zubra, ALL);
  const url = await serving(zubra, html);
  const page = await browser.newPage();
  const errors = [];
  const asked = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('request', (request) => request.resourceType() === 'script' && asked.push(new URL(request.url()).pathname));
  try {
    await page.goto(url);
    await page.waitForFunction(() => ['plain-card', 'key-box', 'guard-link', 'theme-box', 'theme-name', 'late-word', 'pick-one', 'spread-box'].every((tag) => customElements.get(tag)));
    await page.click('plain-card .up');
    assert.equal(await page.textContent('plain-card output'), '1');
    await page.press('key-box input', 'Enter');
    assert.equal(await page.textContent('key-box output'), 'enter');
    await page.click('guard-link a');
    assert.equal(await page.textContent('guard-link output'), '1');
    assert.equal(await page.textContent('theme-name output'), 'dark');
    await page.waitForFunction(() => document.querySelector('late-word output').textContent === 'ready');
    await page.click('pick-one .b');
    await page.waitForFunction(() => new FormData(document.querySelector('form')).get('pick') === 'b');
    assert.equal(await page.getAttribute('spread-box p', 'title'), 'spread');
    // The app's own script ran, and its effect is on the same runtime (it follows its state).
    assert.equal(await page.evaluate(() => window.ownScript), 'ran 0');
    await page.evaluate(() => window.bump());
    await page.waitForFunction(() => window.ownScript === 'ran 1');
    assert.deepEqual(errors, []);
    assert.deepEqual(asked, [`/_zubra/runtime/${app.file}`], 'one script, and no other');
  } finally {
    await page.close();
  }
});

// An app with @zubra/sync installed: a component kept in a collection, a script of the app's
// that follows the log, and a folder of components that don't use the package.
const synced = mkdtempSync(join(tmpdir(), 'zubra-build-sync-'));
mkdirSync(join(synced, 'node_modules', '@zubra'), { recursive: true });
symlinkSync(fileURLToPath(new URL('../../sync', import.meta.url)), join(synced, 'node_modules', '@zubra', 'sync'), 'dir');
mkdirSync(join(synced, 'components'));
mkdirSync(join(synced, 'plain'));
writeFileSync(join(synced, 'components', 'kept-note.zb'), "<script>\n  'use collection notes by doc'\n  let text = 'first'\n</script>\n<kept-note doc=\"\">\n  <button onclick={() => (text = 'second')}>{text}</button>\n</kept-note>\n");
writeFileSync(join(synced, 'plain', 'plain-card.zb'), '<plain-card>\n  <p>plain</p>\n</plain-card>\n');
const inside = join(synced, 'inside.js');
writeFileSync(inside, "import { currentStore } from '@zubra/sync';\nimport { follow } from '@zubra/sync/follow';\nwindow.inside = currentStore();\nwindow.follow = follow;\n");
after(() => rmSync(synced, { recursive: true, force: true }));
const SYNC_NAMES = ['collection', 'configure', 'currentStore', 'ephemeral', 'indexedDBStore', 'memoryStore', 'newPeerId', 'onPresence', 'onWrite', 'peerId', 'peers', 'presence', 'receive', 'receivePresence', 'startingPull'];

test("buildApp puts @zubra/sync in the module when a component or a script uses it, and says what it exports", async () => {
  const app = await buildApp({ components: join(synced, 'components'), scripts: [inside] });
  assert.deepEqual(app.sync, SYNC_NAMES);
  // Nothing of the package left to fetch: the component's import, the script's, and follow.js's own of the store.
  assert.deepEqual([...app.code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map((match) => match[1]), []);
  assert.match(app.code, /\$zubraSync\b/);
  // By a component alone, and by a script alone.
  assert.deepEqual((await buildApp({ components: join(synced, 'components') })).sync, SYNC_NAMES);
  assert.deepEqual((await buildApp({ components: join(synced, 'plain'), scripts: [inside] })).sync, SYNC_NAMES);
  // connect()'s peer-to-peer module is loaded only when asked for: it stays the server's file.
  const connecting = join(synced, 'connecting.js');
  writeFileSync(connecting, "import { connect } from '@zubra/sync/connect';\nwindow.connect = connect;\n");
  const connected = await buildApp({ components: join(synced, 'plain'), scripts: [connecting] });
  assert.deepEqual([...connected.code.matchAll(/(?:\bfrom|\bimport)\s*\(?["']([^"']+)["']/g)].map((match) => match[1]).filter((to) => to !== './remark.js'), ['../sync/webrtc.js']);
  assert.match(connected.code, /import\("\.\.\/sync\/webrtc\.js"\)/);
  // Installed and not used: not in the module, and nothing said about it.
  const without = await buildApp({ components: join(synced, 'plain') });
  assert.equal('sync' in without, false);
  assert.doesNotMatch(without.code, /\$zubraSync|zubra-sync/);
  // buildRuntime() holds the runtime alone, as before.
  assert.equal('sync' in (await buildRuntime({ components: join(synced, 'components') })), false);
});

test("with @zubra/sync in the app's module, the package's own address answers from that module", async () => {
  const app = await buildApp({ components: join(synced, 'components'), scripts: [inside] });
  const zubra = createZubra({ components: join(synced, 'components'), production: true, runtime: app });
  const page = zubra.page();
  const html = page.finish(layout(page.render('kept-note', { doc: 'n1' })));
  assert.deepEqual(preloaded(html), [`/_zubra/runtime/${app.file}`]);
  assert.deepEqual(scriptTags(html), [`import '/_zubra/runtime/${app.file}';`]);
  assert.equal(await text(zubra, '/_zubra/sync/index.js'), `import { $zubraSync } from '../runtime/${app.file}';\nexport const { ${SYNC_NAMES.join(', ')} } = $zubraSync;\n`);
  // The package's other modules are sent as they are, and take the store from that address.
  assert.match(await text(zubra, '/_zubra/sync/connect.js'), /from"\.\/index\.js"/);
  // A module without the package in it: the package's own file, as always.
  const apart = createZubra({ components: join(synced, 'plain'), production: true, runtime: await buildApp({ components: join(synced, 'plain') }) });
  assert.doesNotMatch(await text(apart, '/_zubra/sync/index.js'), /\$zubraSync/);
  assert.match(await text(apart, '/_zubra/sync/index.js'), /indexedDB/);
});

test("in a browser: a collection component runs from the app's one module, and a script outside it shares its store", async () => {
  const app = await buildApp({ components: join(synced, 'components'), scripts: [inside] });
  const zubra = createZubra({ components: join(synced, 'components'), production: true, runtime: app });
  const made = zubra.page();
  const body = made.render('kept-note', { doc: 'n1' });
  // Two pages of one site (one origin, so one IndexedDB): the app's module alone, and with a script beside it.
  const alone = made.finish(layout(body));
  const beside = made.finish(layout(body, "<script type=\"module\">import { currentStore } from '@zubra/sync'; import { follow } from '@zubra/sync/follow'; import '@zubra/sync/connect'; window.outside = currentStore(); window.followOutside = follow;</script>"));
  const server = createServer((request, response) => {
    if (zubra.handle(request, response)) return;
    response.writeHead(200, { 'content-type': 'text/html' }).end(request.url === '/beside' ? beside : alone);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const outside = `${url}/beside`;
  const page = await browser.newPage();
  const errors = [];
  const asked = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('request', (request) => request.resourceType() === 'script' && asked.push(new URL(request.url()).pathname));
  try {
    await page.goto(url);
    await page.waitForFunction(() => customElements.get('kept-note') && window.inside);
    await page.click('kept-note button');
    assert.equal(await page.textContent('kept-note button'), 'second');
    // Stored: the store the script in the module sees is the one the component wrote to.
    await page.waitForFunction(async () => (await window.inside.get('notes', 'n1'))?.text === 'second');
    assert.deepEqual(asked, [`/_zubra/runtime/${app.file}`], 'one script, and no other');
    // A script outside the module, by the package's name and by its other modules: the same store.
    asked.length = 0;
    await page.goto(outside);
    await page.waitForFunction(() => window.inside && window.outside);
    assert.equal(await page.evaluate(() => window.inside === window.outside), true);
    assert.equal(await page.evaluate(() => window.follow === window.followOutside), false, "follow.js was asked for on its own, and found the module's store");
    assert.deepEqual(asked.sort(), [`/_zubra/runtime/${app.file}`, '/_zubra/sync/connect.js', '/_zubra/sync/fields.js', '/_zubra/sync/follow.js', '/_zubra/sync/index.js'].sort());
    await page.waitForFunction(() => document.querySelector('kept-note button').textContent === 'second');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
