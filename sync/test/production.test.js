// The production build (`dist/production`, what @zubra/server sends in production): current with
// src/, smaller, and the same modules with the same exports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER } from '../scripts/build-production.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('dist/production is built from the current src (npm run build)', () => {
  execFileSync(process.execPath, [join(root, 'scripts/build-production.js'), '--check'], { stdio: 'pipe' });
});

test('each browser module keeps its exports and imports, and is about half the bytes', async () => {
  for (const file of BROWSER) {
    const source = await import(join(root, 'src', file));
    const built = await import(join(root, 'dist/production', file));
    assert.deepEqual(Object.keys(built).sort(), Object.keys(source).sort(), file);
    // (Comment lines left out: the source's own examples import things too.)
    const imports = (code) => [...code.replace(/^\s*\/\/.*$/gm, '').matchAll(/\b(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)].map((match) => match[1]).sort();
    const text = (dir) => readFileSync(join(root, dir, file), 'utf8');
    assert.deepEqual(imports(text('dist/production')), imports(text('src')), `${file}'s imports`);
    const gzipped = (dir) => gzipSync(text(dir), { level: 9 }).length;
    // follow.js is small enough that what can't shrink (its imports, paths, the warning) weighs more.
    const most = file === 'follow.js' ? 0.65 : 0.6;
    assert.ok(gzipped('dist/production') < gzipped('src') * most, `${file}: ${gzipped('dist/production')} B against ${gzipped('src')} B`);
  }
});
