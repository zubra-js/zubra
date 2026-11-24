// `npm start` (after `npm run build`): http://localhost:3000. What react-router-serve does (the
// built assets, compression, React Router's handler), plus a hosted demo's guard.
//
// HOSTED_DEMO=1: a public demo (app/lib/hosted.server.js). Bodies and each visitor's writes are
// capped here, before React Router; the expenses are capped and reset in app/lib/trip.server.js.
// TRUST_PROXIES=n trusts the n proxies in front: the visitor is their X-Forwarded-For entry, and the
// request's URL is https when they say so, so React Router's check that an action's Origin is the
// page's own passes behind a proxy that ends TLS (and still refuses a cross-site post).
import { fileURLToPath } from 'node:url';
import { fromEnv, guard } from './app/lib/hosted.server.js';

// Production unless said otherwise, as react-router-serve, and set before anything loads React:
// React and react-dom each pick their build from it when they load, and must pick the same one.
process.env.NODE_ENV ??= 'production';
const { createRequestHandler } = await import('@react-router/express');
const { default: compression } = await import('compression');
const { default: express } = await import('express');

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/** The app around a server build; `hosted` is a hosted demo's settings (`fromEnv()`), or null. */
export function createApp({ build, hosted = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (hosted?.trustProxies) app.set('trust proxy', hosted.trustProxies);
  app.use(compression());
  app.use('/assets', express.static(here('./build/client/assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(here('./build/client')));
  if (hosted) app.use(guard(hosted));
  app.all('/{*splat}', createRequestHandler({ build, mode: process.env.NODE_ENV }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hosted = fromEnv();
  const app = createApp({ build: await import('./build/server/index.js'), hosted });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`Trip budget on http://localhost:${port}${hosted ? ' (hosted demo)' : ''}`));
}
