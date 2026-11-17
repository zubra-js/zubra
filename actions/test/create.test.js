// `npm create zubra -- --framework server`: the app is written here (so it resolves this
// package's own dependencies: @zubra/server, the compiler, the runtime, Playwright), then its
// own test runs: the server starts, and the page is used with JavaScript and without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompiler } from '@zubra/server';
import { create } from '../../create/index.js';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The server starter written at `.tmp-create/<name>`, with what `npm install` would give it. */
function starter(name, typescript = false) {
  const dir = join(here, '.tmp-create', name);
  rmSync(dir, { recursive: true, force: true });
  create(dir, 'server', { name: 'server starter', typescript });
  mkdirSync(join(dir, 'node_modules', '@zubra'), { recursive: true });
  symlinkSync(here, join(dir, 'node_modules', '@zubra', 'actions'), 'junction');
  for (const name of ['@zubra/server', '@zubra/compiler', '@zubra/runtime', 'playwright']) symlinkSync(join(here, 'node_modules', name), join(dir, 'node_modules', name), 'junction');
  return dir;
}

/** The starter's `npm run dev` (or `start`) on a port of its own; `stop()` ends it. */
async function running(dir, script, port) {
  const [, ...args] = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts[script].replace(/^NODE_ENV=production /, '').split(' ');
  const child = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, PORT: String(port), NODE_ENV: script === 'start' ? 'production' : '' }, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  const up = async () => {
    for (let waited = 0; waited < 15_000; waited += 100) {
      try {
        await fetch(origin);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`${script} didn't answer on ${port}`);
  };
  await up();
  return { origin, up, stop: () => child.kill() };
}
const empty = (origin) => fetch(`${origin}/_zb/action/guest-book/add`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', origin }, body: 'text=' }).then((response) => response.json());
const edit = (dir, file, from, to) => {
  const text = readFileSync(join(dir, file), 'utf8');
  assert.ok(text.includes(from), `${file} has ${from}`);
  writeFileSync(join(dir, file), text.replace(from, to));
};

test("the server starter in development: an edited 'use server' function is there on the next post, and a component that doesn't compile is a 500 that says why", async () => {
  findCompiler();
  const dir = starter('server-dev');
  const app = await running(dir, 'dev', 4391);
  try {
    assert.deepEqual(await empty(app.origin), { error: 'Write something first.' });
    edit(dir, 'src/components/guest-book.zb', 'Write something first.', 'Say something first.');
    let said;
    for (let waited = 0; waited < 10_000 && said?.error !== 'Say something first.'; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      said = await empty(app.origin).catch(() => null); // (between the old server and the new)
    }
    assert.deepEqual(said, { error: 'Say something first.' });
    edit(dir, 'src/components/hello-counter.zb', '{label}', '{labell}');
    let response;
    for (let waited = 0; waited < 10_000 && response?.status !== 500; waited += 200) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      response = await fetch(app.origin).catch(() => null);
    }
    assert.equal(response?.status, 500);
    const text = await response.text();
    assert.match(text, /unknown reference `labell`/);
    assert.match(text, /hello-counter\.zb:\d+:\d+/);
    assert.match(text, /did you mean `label`\?/);
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server starter in production: an error is a 500 that says nothing of it', async () => {
  findCompiler();
  const dir = starter('server-start');
  // A prop of the wrong type: the components compile, and rendering the page throws.
  edit(dir, 'server.js', "{ label: 'Clicks', count: 2 }", "{ label: 'Clicks', count: 'two' }");
  const app = await running(dir, 'start', 4392);
  try {
    const response = await fetch(app.origin);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Something went wrong');
  } finally {
    app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server starter's own test passes, in JavaScript and with --typescript", () => {
  findCompiler();
  for (const typescript of [false, true]) {
    const dir = starter(typescript ? 'server-ts' : 'server', typescript);
    try {
      execFileSync(process.execPath, ['--test', 'test/app.test.js'], { cwd: dir, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, NODE_ENV: '' } });
    } catch (error) {
      throw new Error(`the server starter's test failed:\n${error.stdout}${error.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
