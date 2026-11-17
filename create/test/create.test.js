// create-zubra: what it writes for each framework, and its command line. (The apps it writes are
// built and used in Chromium by examples/frameworks/test/create.test.js and the plugin's tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAMEWORKS, create, parse } from '../index.js';

const work = () => mkdtempSync(join(tmpdir(), 'create-zubra-'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// The starter page's components: the counter, the examples, and the page's own three.
const COMPONENTS = ['hello-counter', 'todo-list', 'rating-input', 'async-tip', 'example-card', 'zubra-examples', 'zubra-welcome'];

// (The server app has no plugin and no build: its own test is below.)
for (const framework of Object.keys(FRAMEWORKS).filter((framework) => framework !== 'server')) {
  test(`${framework}: an app with the component, the plugin, a test, and no placeholders left`, () => {
    const dir = join(work(), 'My App');
    const files = create(dir, framework);
    for (const file of ['.gitignore', 'README.md', 'package.json', 'src/style.css', ...COMPONENTS.map((name) => `src/components/${name}.zb`), 'test/app.test.js', 'test/build.js', 'AGENTS.md', 'skills/zubra-component/SKILL.md', 'skills/zubra-consume/SKILL.md']) {
      assert.ok(files.includes(file), `${file} in ${files.join(', ')}`);
    }
    for (const file of files) {
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /\{\{(name|title|version|framework)\}\}/, file);
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-app');
    assert.equal(pkg.dependencies['@zubra/runtime'], `^${version}`);
    assert.equal(pkg.devDependencies['@zubra/unplugin'], `^${version}`);
    assert.ok(pkg.scripts.dev && pkg.scripts.build && pkg.scripts.test);
    const config = files.find((file) => /^(vite|astro)\.config\./.test(file));
    assert.match(readFileSync(join(dir, config), 'utf8'), /@zubra\/unplugin\/(vite|astro)/);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /^# My App/);
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /^# My App/);
    // The starter page: the welcome, the counter the page binds to, and the examples, in the
    // framework's own entry (as tags, or as the components React, Vue and Astro import).
    const page = files.filter((file) => /^(index\.html|server\.js|src\/(App\.(jsx|vue|svelte)|app\.ts|main\.js|pages\/index\.astro))$/.test(file)).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
    for (const tag of ['zubra-welcome', 'hello-counter', 'zubra-examples']) {
      const component = tag.replace(/(^|-)(\w)/g, (_, _dash, letter) => letter.toUpperCase());
      assert.match(page, new RegExp(`<(${tag}|${component})[\\s>/]|page\\.render\\('${tag}'`), `${tag} in the ${framework} page`);
    }
    assert.match(page, /heading(="|: ')My App/);
    // What the docs in the app say is there, is there: every component is in both tables.
    for (const doc of ['AGENTS.md', 'README.md']) {
      const text = readFileSync(join(dir, doc), 'utf8');
      for (const name of COMPONENTS) assert.ok(text.includes(`\`${name}.zb\``), `${doc} mentions ${name}.zb`);
      assert.doesNotMatch(text, /No framework/);
    }
  });
}

for (const framework of ['react', 'angular']) {
  test(`${framework} with --typescript: the component in TypeScript, a tsconfig.json, and \`npm run check\``, () => {
    const dir = join(work(), 'app');
    const files = create(dir, framework, { typescript: true });
    assert.ok(files.includes('tsconfig.json'));
    assert.match(readFileSync(join(dir, 'src/components/hello-counter.zb'), 'utf8'), /<script lang="ts">\n {2}interface Props \{/);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.check, 'zubra check --types src');
    assert.ok(pkg.devDependencies.typescript);
    assert.ok(pkg.devDependencies['@zubra/compiler'], 'the `zubra` command');
    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    // Angular keeps its own (its compiler needs it); the others get one.
    if (framework === 'angular') assert.match(tsconfig, /angularCompilerOptions/);
    else assert.match(tsconfig, /"include": \["src"\]/);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /npm run check {3}# type-checks the components/);
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /`npm run check` type-checks every component/);
  });
}

test('without --typescript, nothing about TypeScript changes', () => {
  const dir = join(work(), 'app');
  const files = create(dir, 'vue');
  assert.ok(!files.includes('tsconfig.json'));
  assert.doesNotMatch(readFileSync(join(dir, 'src/components/hello-counter.zb'), 'utf8'), /lang="ts"/);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.check, undefined);
  assert.equal(pkg.devDependencies.typescript, undefined);
});

test('refuses a directory with files in it, and an unknown framework', () => {
  const dir = work();
  writeFileSync(join(dir, 'keep.txt'), '');
  assert.throws(() => create(dir, 'react'), /isn't empty/);
  assert.throws(() => create(join(dir, 'new'), 'ember'), /unknown framework "ember"/);
  mkdirSync(join(dir, 'empty'));
  assert.ok(create(join(dir, 'empty'), 'vanilla').length > 0, 'an empty directory is fine');
});

test('command line: arguments, and a run without a terminal', () => {
  assert.deepEqual(parse(['app', '--framework', 'vue']), { dir: 'app', framework: 'vue', typescript: null, yes: false, help: false });
  assert.deepEqual(parse(['--template=react', '-y']), { dir: null, framework: 'react', typescript: null, yes: true, help: false });
  assert.equal(parse(['--typescript']).typescript, true);
  assert.equal(parse(['--ts']).typescript, true);
  assert.equal(parse(['--js']).typescript, false);
  assert.throws(() => parse(['a', 'b']), /unexpected argument b/);
  const cwd = work();
  const out = execFileSync(process.execPath, [new URL('../index.js', import.meta.url).pathname, 'site', '--framework', 'svelte'], { cwd, encoding: 'utf8' });
  assert.match(out, /A Zubra app \(Svelte\) is in site/);
  assert.match(out, /cd site\n {2}npm install/);
  assert.match(out, /made of the examples in src\/components\//);
  assert.match(readFileSync(join(cwd, 'site/src/App.svelte'), 'utf8'), /<hello-counter/);
  // No terminal and no framework: plain HTML, in zb-app.
  execFileSync(process.execPath, [new URL('../index.js', import.meta.url).pathname], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(readFileSync(join(cwd, 'zb-app/index.html'), 'utf8'), /<hello-counter/);
  // --typescript says how to check.
  const typed = execFileSync(process.execPath, [new URL('../index.js', import.meta.url).pathname, 'typed', '--framework', 'vanilla', '--typescript'], { cwd, encoding: 'utf8' });
  assert.match(typed, /A Zubra app \(No framework \(plain HTML and JavaScript\), TypeScript\) is in typed/);
  assert.match(typed, /npm run check {3}type-checks the components/);
});

test("no starter component has a registry component's name, so `zubra add` never finds its file taken", () => {
  for (const name of COMPONENTS) {
    assert.ok(!existsSync(new URL(`../../registry/components/${name}.zb`, import.meta.url)), `registry/components/${name}.zb exists: \`npx zubra add ${name}\` would refuse in a new app`);
  }
});

test('the server app: a Node server, a form with a server function, no bundler, and its own docs', () => {
  const dir = join(work(), 'shop');
  const files = create(dir, 'server', { name: 'My Shop' });
  for (const file of ['server.js', 'src/notes.js', 'src/components/guest-book.zb', 'skills/zubra-server/SKILL.md', 'test/app.test.js']) assert.ok(files.includes(file), file);
  // No build step: nothing of Vite's, and not the shared test's build helper.
  assert.deepEqual(files.filter((file) => /vite|index\.html|test\/build\.js/.test(file)), []);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@zubra/actions', '@zubra/compiler', '@zubra/runtime', '@zubra/server']);
  for (const name of Object.keys(manifest.dependencies)) assert.equal(manifest.dependencies[name], `^${version}`);
  assert.deepEqual(Object.keys(manifest.devDependencies), ['playwright']);
  // Restarts for src/ too: a 'use server' function is loaded once, at start.
  assert.equal(manifest.scripts.dev, 'node --watch-path=src --watch-path=server.js server.js');
  const server = readFileSync(join(dir, 'server.js'), 'utf8');
  assert.match(server, /heading: 'My Shop'/);
  assert.match(server, /<title>My Shop<\/title>/);
  // The handlers in the order that works, and one page object that renders and finishes.
  assert.ok(server.indexOf('actions.handle(req, res)') < server.indexOf('zubra.handle(req, res)'));
  assert.equal(server.match(/= zubra\.page\(\)/g).length, 1);
  for (const file of files) assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /\{\{(name|title|version|framework)\}\}/, file);
  // Its docs are its own: the server, the guest book, and nothing about a dev server's hot reload.
  for (const doc of ['AGENTS.md', 'README.md']) {
    const text = readFileSync(join(dir, doc), 'utf8');
    for (const name of [...COMPONENTS, 'guest-book']) assert.ok(text.includes(`\`${name}.zb\``), `${doc} mentions ${name}.zb`);
    assert.match(text, /server\.js/);
    assert.doesNotMatch(text, /hot reload|vite|\{\{/i);
  }
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /skills\/zubra-server\/SKILL\.md/);
  // With --typescript: the check script, and the docs say so.
  const typed = join(work(), 'typed-shop');
  create(typed, 'server', { typescript: true });
  assert.equal(JSON.parse(readFileSync(join(typed, 'package.json'), 'utf8')).scripts.check, 'zubra check --types src');
  assert.match(readFileSync(join(typed, 'README.md'), 'utf8'), /^npm run check {3}# type-checks the components[^\n]*\nnpm test {8}# starts the server/m);
  assert.match(readFileSync(join(typed, 'AGENTS.md'), 'utf8'), /`npm run check` type-checks every component/);
});
