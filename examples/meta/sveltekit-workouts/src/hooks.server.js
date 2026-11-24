// The SSR bridge: Svelte renders the zubra elements' host tags; @zubra/server gives each one its
// server-rendered shadow root (and form controls a hidden input), so the page is complete, and
// its form submits, before any JavaScript.
import { createZubra } from '@zubra/server';
import { cap, reset } from '#lib/server/log.js';
import { MAX_WORKOUTS, fromEnv, guard, withNotice } from '#lib/server/hosted.js';

const zubra = createZubra({ components: 'zubra' });

// HOSTED_DEMO=1: a public demo, capped and reset daily (src/lib/server/hosted.js).
const demo = fromEnv();
if (demo) cap(MAX_WORKOUTS);
const check = demo ? guard({ reset, ...demo }) : () => undefined;

export const handle = ({ event, resolve }) => check(event) ?? resolve(event, {
  transformPageChunk: ({ html }) => {
    const page = zubra.injectShadowRoots(html);
    return demo ? withNotice(page) : page;
  },
});
