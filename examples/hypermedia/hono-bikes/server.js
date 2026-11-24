// `npm start` (Node.js) or `npm run start:bun` (Bun): http://localhost:3000
import { createApp } from './src/app.js';
import { fromEnv } from './src/hosted.js';
import { createStore } from './src/store.js';

// HOSTED_DEMO=1: a public demo, capped and reset daily (src/hosted.js).
const app = createApp({ store: createStore(), cache: !process.env.DEV, hosted: fromEnv() });
const port = Number(process.env.PORT ?? 3000);

let address;
if (globalThis.Bun) {
  address = Bun.serve({ port, fetch: app.fetch }).port;
} else {
  const { serve } = await import('@hono/node-server');
  const server = serve({ fetch: app.fetch, port });
  await new Promise((resolve) => server.once('listening', resolve));
  address = server.address().port;
}
console.log(`Spoke & Chain on http://localhost:${address} (${globalThis.Bun ? `Bun ${Bun.version}` : `Node.js ${process.versions.node}`})`);
