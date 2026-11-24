// The SSR bridge: Solid renders the zubra elements' host tags (the zubra plugin adds `zb-props` in
// the server build, since `prop:` values are properties); @zubra/server gives each shadow-DOM one
// its server-rendered shadow root, each light-DOM one its rendered children (`lightDom: true`;
// Solid leaves nodes it didn't render alone while hydrating, so the board is light DOM since
// 3.3), and form controls a hidden input, so the board shows and the sign-up form submits before
// JavaScript.
import { createMiddleware } from '@solidjs/start/middleware';
import { createZubra } from '@zubra/server';
import { createGuard, fromEnv } from './lib/hosted.js';
import { resetPotluck } from './lib/potluck.js';

const zubra = createZubra({ components: 'zubra' });

// HOSTED_DEMO=1: a public demo, capped and reset daily (src/lib/hosted.js). The guard runs before
// SolidStart's own handler, so before the server functions (and their cross-site check) too.
const settings = fromEnv();
const guard = settings && createGuard({ reset: resetPotluck, ...settings });

export default createMiddleware([
  ...(guard ? [(event) => guard(event.req, event.req.runtime?.node?.req?.socket?.remoteAddress)] : []),
  async (event, next) => {
    const response = await next();
    // A web Response, or H3's response (its body, with the headers on event.res).
    const headers = new Headers(response instanceof Response ? response.headers : event.res?.headers);
    if (!headers.get('content-type')?.includes('text/html') || !response?.body) return response;
    const html = zubra.injectShadowRoots(await new Response(response.body).text(), { lightDom: true });
    headers.delete('content-length');
    return new Response(html, { status: response.status ?? event.res?.status ?? 200, headers });
  },
]);
