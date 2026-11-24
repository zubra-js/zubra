// Deploys the hosted demos from this checkout with `railway up`: on your machine or on a runner
// of your own, so Railway needs no access to the GitHub repository. Only the demos whose
// `watchPatterns` (deploy/<demo>/railway.json) match a file changed since <ref> are deployed,
// as a push would rebuild them.
//
//   node deploy/up.mjs --since origin/main     # the demos a change touches
//   node deploy/up.mjs standup hono-bikes      # these, whatever changed
//   node deploy/up.mjs --all --dry-run         # say what would deploy, deploy nothing
//
// Needs the Railway CLI, signed in or with RAILWAY_TOKEN (a project token, kept on the runner,
// never in the repository), and the checkout linked to zubra-demos (`railway link`) or
// RAILWAY_PROJECT_ID set. Refuses uncommitted changes: what's deployed is a commit.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/** A watch pattern (gitignore-style, from the repository root) as a regular expression. */
export function matcher(pattern) {
  const body = pattern.replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  // A pattern without a leading slash matches at any depth, as in a .gitignore.
  return new RegExp(`^${pattern.startsWith('/') ? '' : '(?:.*/)?'}${body}$`);
}

/** The demos (ids) whose watch patterns match any of the changed paths. */
export function affected(changed, services) {
  return Object.entries(services)
    .filter(([, patterns]) => patterns.some((pattern) => changed.some((path) => matcher(pattern).test(path))))
    .map(([id]) => id)
    .sort();
}

/** Every demo in deploy/ and its watch patterns. */
export function services(dir = here) {
  return Object.fromEntries(readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, 'railway.json')))
    .map((id) => [id, JSON.parse(readFileSync(join(dir, id, 'railway.json'), 'utf8')).build?.watchPatterns ?? ['/**']]));
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--') && arg !== '--since'));
  const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : null;
  const named = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--since');
  const all = services();
  for (const id of named) if (!all[id]) throw new Error(`deploy/up: no deploy/${id}/railway.json (demos: ${Object.keys(all).join(', ')})`);
  if (!flags.has('--dry-run') && git('status', '--porcelain')) throw new Error('deploy/up: commit or stash your changes first: what is deployed is a commit');

  let ids;
  if (flags.has('--all')) ids = Object.keys(all).sort();
  else if (named.length) ids = named;
  else if (since) {
    const changed = git('diff', '--name-only', `${since}...HEAD`).split('\n').filter(Boolean);
    ids = affected(changed, all);
    console.log(`deploy/up: ${changed.length} file(s) changed since ${since}`);
  } else throw new Error('deploy/up: name the demos, or pass --since <ref> or --all');

  console.log(ids.length ? `deploy/up: ${ids.join(', ')} at ${git('rev-parse', '--short', 'HEAD')}` : 'deploy/up: nothing to deploy');
  if (flags.has('--dry-run')) return 0;
  let failed = 0;
  for (const id of ids) {
    console.log(`\n== ${id}`);
    // --ci streams the build and exits non-zero if it fails. Windows runs the CLI's npm shim.
    const run = spawnSync('railway', ['up', '--service', id, '--ci'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    if (run.status !== 0) {
      failed += 1;
      console.error(`deploy/up: ${id} failed (exit ${run.status})`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
