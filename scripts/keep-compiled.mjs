#!/usr/bin/env node
// Keeps what a released compiler wrote, so later runtimes are tested against it:
//   node scripts/keep-compiled.mjs 5.20.0
// installs @zubra/compiler at that version from npm (into a temporary folder), compiles
// runtime/test/browser/fixtures/interface/since-4.zb with it, renames its tag zb-since-<digits>,
// and writes fixtures/interface/since-4-<digits>.js. Run it once after each release that changes
// compiled output (CONTRIBUTING.md); never regenerate a kept file. The runtime's
// since-4.test.js and the server's older-output.test.js run every file kept this way.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/keep-compiled.mjs <released version, as 5.20.0>');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'runtime/test/browser/fixtures/interface');
const digits = version.replaceAll('.', '');
const target = join(dir, `since-4-${digits}.js`);
if (existsSync(target)) {
  console.error(`${target} is already kept; a kept file is never regenerated`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), 'zubra-keep-'));
try {
  writeFileSync(join(scratch, 'package.json'), '{"private":true,"type":"module"}\n');
  // (No runtime beside it: the compiler's peer on one is optional.)
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', '--legacy-peer-deps', `@zubra/compiler@${version}`], { cwd: scratch, stdio: 'inherit' });
  const compiler = await import(pathToFileURL(join(scratch, 'node_modules/@zubra/compiler/index.js')));
  const path = join(dir, 'since-4.zb');
  const answer = compiler.request({ emit: 'js', path, files: { [path]: readFileSync(path, 'utf8') }, runtime: '@zubra/runtime' });
  if (!answer.ok) throw new Error(answer.error);
  const tag = `zb-since-${digits}`;
  const module = answer.output.replaceAll('"zb-since"', `"${tag}"`).replace('from since-4.zb', `from since-4-${digits}.zb`);
  if (!module.includes(`"${tag}"`)) throw new Error("the compiled module doesn't name its tag as expected");
  writeFileSync(target, `// Compiled by @zubra/compiler ${version} from since-4.zb, with its tag renamed ${tag}; kept so\n// the runtime keeps reading that output. Do not regenerate.\n${module}`);
  console.log(`kept ${target}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
