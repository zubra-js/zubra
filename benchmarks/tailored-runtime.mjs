// How much of the runtime file @zubra/server sends (dist/bundled/zubra.js) an app's components
// name, measured: the compiled components' imports from `@zubra/runtime` are collected, and a
// file with only those names (and what they reach) is built from the production runtime with
// esbuild, minified. A measurement for roadmap-footprint, not something the server does.
//
//   node benchmarks/tailored-runtime.mjs <components folder> [--write <file>]
//
// Needs the runtime's production build (`npm run build` in runtime/) and the compiler's CLI
// (`cargo build`, or ZUBRA_COMPILER).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { findCompiler } from '../server/src/index.js';

const here = fileURLToPath(new URL('..', import.meta.url));
const { build } = createRequire(join(here, 'runtime/'))('esbuild');
const args = process.argv.slice(2);
const folder = resolve(args[0] ?? '.');
const production = join(here, 'runtime/dist/production');
const gzip = (code) => gzipSync(code, { level: 9 }).length;

const names = new Set();
for (const file of readdirSync(folder, { recursive: true }).filter((file) => file.endsWith('.zb'))) {
  const js = execFileSync(findCompiler().path, ['compile', join(folder, file), '--emit', 'js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const [, list, from] of js.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (from === '@zubra/runtime') for (const one of list.split(',')) names.add(one.trim().split(/\s+as\s+/)[0]);
  }
}
// remark.js stays a file of its own, as it is beside zubra.js.
const result = await build({ stdin: { contents: `export { ${[...names].join(', ')} } from './index.js';`, resolveDir: production }, bundle: true, minify: true, format: 'esm', write: false, target: 'esnext', external: ['./remark.js'] });
const code = result.outputFiles[0].text;
const whole = readFileSync(join(here, 'runtime/dist/bundled/zubra.js'));
console.log(`${names.size} names: ${[...names].sort().join(' ')}`);
console.log(`only those: ${gzip(code)} B gzip; zubra.js: ${gzip(whole)} B gzip (the core; a page with zb-await or slots loads await.js or slots.js as well)`);
if (args.includes('--write')) writeFileSync(args[args.indexOf('--write') + 1], code);
