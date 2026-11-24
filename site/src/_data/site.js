import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demos } from '../../../demos/list.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
// The build the page belongs to (demos/build.mjs sets it): which examples are live there.
const out = process.env.LANDING_OUT;
const repository = process.env.GITHUB_REPOSITORY ?? 'zubra-js/zubra';
const has = (id) => (out ? existsSync(join(out, 'demos', id, 'index.html')) : false);
const shot = (id) => existsSync(join(repo, 'demos/shots', `${id}.jpg`));

export default {
  version: JSON.parse(readFileSync(join(repo, 'runtime/package.json'), 'utf8')).version,
  // Where the site is served from, for the absolute addresses social cards need (og:image can't be relative).
  origin: process.env.SITE_ORIGIN ?? `https://${repository.split('/')[0]}.github.io`,
  github: `https://github.com/${repository}`,
  marketplace: 'https://marketplace.visualstudio.com/items?itemName=JourneytoCode.zubra',
  groups: [...new Set(demos.map((demo) => demo.group))].map((name) => ({
    name,
    demos: demos.filter((demo) => demo.group === name).map((demo) => ({
      ...demo,
      // `built`: a static example in this build, opened under /demos/. `live` (demos/list.js) is a
      // hosted demo's URL, for the examples that need a server.
      built: has(demo.id),
      shot: shot(demo.id),
      source: `https://github.com/${repository}/tree/main/${demo.dir}`,
    })),
  })),
  count: demos.length,
};
