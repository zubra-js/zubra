// Component samples in the docs that are shown as the compiler's own output, or that a reader copies
// as a whole component, compile, and the output shown is what the compiler writes. Needs the CLI:
// `cargo build --release` (or $ZUBRA_COMPILER).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const zubra = process.env.ZUBRA_COMPILER ?? join(root, 'target/release/zubra');
const work = mkdtempSync(join(tmpdir(), 'zubra-samples-'));

/** The fenced blocks of `lang` in `markdown` after the heading or text `after`, in order. */
export function blocksAfter(markdown, after, lang) {
  const from = markdown.indexOf(after);
  assert.ok(from >= 0, `"${after}" is not in the page`);
  return [...markdown.slice(from).matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```', 'g'))].map((match) => match[1]);
}

const compile = (source, name, ...args) => {
  const file = join(work, name);
  writeFileSync(file, source);
  return execFileSync(zubra, ['compile', file, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};

test('guide 8: the component, the HTML and the module it shows are what the compiler writes', () => {
  const page = readFileSync(join(root, 'docs/guide/08-read-the-output.md'), 'utf8');
  const [component, html] = blocksAfter(page, '## One component, line by line', 'html');
  const [module] = blocksAfter(page, 'What the browser runs (`--emit js`):', 'js');
  assert.equal(compile(component, 'click-counter.zb').trimEnd(), html);
  assert.equal(compile(component, 'click-counter.zb', '--emit', 'js').trimEnd(), module);
});

test("Sync's presence sample compiles", () => {
  const page = readFileSync(join(root, 'docs/sync.md'), 'utf8');
  const [board] = blocksAfter(page, '## Presence: who else is here', 'html');
  assert.match(board, /<!-- board-view\.zb -->/);
  compile(board, 'board-view.zb', '--emit', 'js');
});

test("Sync's index-document sample compiles, following the list of keys", () => {
  const page = readFileSync(join(root, 'docs/sync.md'), 'utf8');
  const [board] = blocksAfter(page, '### A list that grows', 'html');
  assert.match(board, /<!-- order-board\.zb -->/);
  const module = compile(board, 'order-board.zb', '--emit', 'js');
  assert.match(module, /\$collection\("boards", \["board"\], \$p, \{ open \}\)/);
});

test('blocksAfter finds the blocks after a heading only', () => {
  const page = '# A\n```js\nbefore\n```\n## B\n```js\none\n```\ntext\n```html\nx\n```\n```js\ntwo\n```\n';
  assert.deepEqual(blocksAfter(page, '## B', 'js'), ['one', 'two']);
  assert.throws(() => blocksAfter(page, '## C', 'js'), /not in the page/);
});
