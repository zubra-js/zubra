// A module written by a compiler from before interface 5 (an app that updates @zubra/server and
// @zubra/runtime and keeps its compiler, or compiled files it kept) still starts: it takes
// `$element` from `@zubra/runtime`, which the core this server maps that name to doesn't export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCore } from '../src/core.js';
import runtimeModules, { bundled } from '@zubra/runtime/modules';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, '..', '..', 'runtime');
// since-4.zb as @zubra/compiler 5.18.0 compiled it, kept for the runtime's own tests.
const compiled518 = readFileSync(join(runtime, 'test/browser/fixtures/interface/since-4-518.js'), 'utf8');
// The same import as @zubra/server 5.19.0's compiler wrote it (one statement, no semicolon).
const compiled519 = compiled518.replace('import { $element as $define, $r, $t } from "@zubra/runtime";', 'import { $element as $define, $r, $t } from "@zubra/runtime"');

// Every module kept from a released compiler (scripts/keep-compiled.mjs), as that compiler wrote
// it: [tag, module]. 5.18 and 5.19.0 are interface 4; later ones are what this server maps as is.
const interfaces = join(runtime, 'test/browser/fixtures/interface');
const keptModules = readdirSync(interfaces)
  .filter((name) => /^since-4-\d+\.js$/.test(name))
  .sort()
  .map((name) => [`zb-since-${name.slice('since-4-'.length, -'.js'.length)}`, readFileSync(join(interfaces, name), 'utf8')]);

/** A core whose compiler answers with `output` for the module, as an older compiler would. */
function coreOver(output, options = {}, tag = 'zb-since-518') {
  return createCore({
    request: (body) => {
      if (body.command === 'load') return { ok: true, output: null };
      if (body.emit === 'interface') return { ok: true, output: JSON.stringify({ tag, shadow: false, form: true, props: [] }) };
      if (body.emit === 'js') return { ok: true, output };
      if (body.emit === 'html') return { ok: true, output: `<${tag}></${tag}>` };
      return { ok: true, output: '' };
    },
    files: new Map([[tag, `/c/${tag}.zb`]]),
    sourcesOf: (path) => ({ [path]: `<${tag}></${tag}>` }),
    base: '/_zubra',
    warn: () => {},
    ...options,
  });
}

test("an older module's $element comes from legacy.js beside the core, and the rest of its import stays", () => {
  for (const output of [compiled518, compiled519]) {
    const { body } = coreOver(output).serve('/_zubra/components/zb-since-518.js');
    assert.match(String(body), /import \{ \$element as \$define \} from "\.\.\/runtime\/legacy\.js"; import \{ \$r, \$t \} from "@zubra\/runtime";/);
    assert.doesNotMatch(String(body), /\$element[^;]*from "@zubra\/runtime"/);
    // Its other imports of the runtime are as they were.
    assert.match(String(body), /import \{ state, formValue, signal \} from '@zubra\/runtime';/);
  }
  // `$define` (interfaces 2 and 3) alone in its import, and under another folder.
  const nested = createCore({
    request: (body) => (body.emit === 'js' ? { ok: true, output: 'import { $define } from "@zubra/runtime";\nexport default $define("a-b", {});' } : { ok: true, output: body.command === 'load' ? null : JSON.stringify({ tag: 'a-b', shadow: false, form: false, props: [] }) }),
    files: new Map([['ui/a-b', '/c/ui/a-b.zb']]),
    sourcesOf: (path) => ({ [path]: '<a-b></a-b>' }),
    base: '/_zubra',
    warn: () => {},
  });
  assert.match(String(nested.serve('/_zubra/components/ui/a-b.js').body), /^import \{ \$define \} from "\.\.\/\.\.\/runtime\/legacy\.js";\n/);
  // Where the app says where the runtime is, legacy.js is beside that.
  const elsewhere = coreOver(compiled518, { imports: { '@zubra/runtime': 'https://cdn.example/zubra/core.js' } });
  assert.match(String(elsewhere.serve('/_zubra/components/zb-since-518.js').body), /from "https:\/\/cdn\.example\/zubra\/legacy\.js"/);
});

test("current output, which names neither, isn't touched", () => {
  const current = 'import { $component, $r, $t } from "@zubra/runtime";\nimport { $define as mine } from "./mine.js";\nexport default $component("zb-since-518", {});';
  const { body } = coreOver(current).serve('/_zubra/components/zb-since-518.js');
  assert.ok(String(body).includes('import { $component, $r, $t } from "@zubra/runtime";'));
  assert.doesNotMatch(String(body), /legacy\.js/);
});

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(() => browser?.close());

for (const [name, bundle, dir, modules] of [['file by file (development)', false, 'src', runtimeModules], ['as one file (production)', true, 'dist/bundled', bundled]]) {
  for (const [tag, compiled] of [['zb-since-518', compiled519], ...keptModules]) test(`in a browser, with the runtime ${name}: ${tag === 'zb-since-518' && compiled === compiled519 ? "5.18's module with 5.19.0's import" : `the module kept as ${tag}`} defines its element and it works`, async () => {
    const legacy = /\$element|\{ \$define/.test(compiled.split('\n').find((line) => line.startsWith('import ') && line.includes('"@zubra/runtime"')));
    const core = coreOver(compiled, { bundle, runtimeModules: modules }, tag);
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://x').pathname;
      const served = core.serve(url);
      if (served?.status === 200) return response.writeHead(200, { 'content-type': 'text/javascript' }).end(served.body);
      if (url.startsWith('/_zubra/runtime/')) {
        try {
          return response.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(runtime, dir, url.slice('/_zubra/runtime/'.length))));
        } catch {
          return response.writeHead(404).end();
        }
      }
      const names = [tag];
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head>${core.head(names)}</head><body><form><${tag} name="n"></${tag}></form>${core.scripts(names)}</body></html>`);
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const page = await browser.newPage();
    const errors = [];
    const asked = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    page.on('request', (request) => asked.push(new URL(request.url()).pathname));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction((tag) => customElements.get(tag), tag);
      await page.click(`${tag} .up`);
      await page.waitForFunction((tag) => document.querySelector(`${tag} output`).textContent.startsWith('1 '), tag);
      // What legacy.js fills in for it: form association (the form has its value).
      assert.equal(await page.evaluate(() => new FormData(document.querySelector('form')).get('n')), '1');
      // (The fixture has a `javascript:` link on purpose, which the development build reports.)
      assert.deepEqual(errors.filter((message) => !message.includes('blocked an unsafe URL')), []);
      // Only output from before interface 5 needs legacy.js.
      assert.equal(asked.includes('/_zubra/runtime/legacy.js'), legacy, asked.join(' '));
      assert.ok(asked.includes(`/_zubra/runtime/${bundle ? 'zubra.js' : 'core.js'}`));
    } finally {
      await page.close();
      server.close();
    }
  });
}
