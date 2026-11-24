// `npm start`: the help desk on http://localhost:3000 (PORT), with MongoDB when MONGODB_URI is
// set and an in-memory store otherwise.
import { createApp } from './src/app.js';
import { fromEnv } from './src/hosted.js';
import { createStore } from './src/store/index.js';
import { memoryStore } from './src/store/memory.js';

// HOSTED_DEMO=1: a public demo, capped and reset daily (src/hosted.js), always in memory: it
// never opens MongoDB, whatever MONGODB_URI says.
const hosted = fromEnv();
let store;
try {
  store = hosted ? memoryStore() : await createStore();
} catch (error) {
  console.error(`Couldn't open the store (${process.env.MONGODB_URI ? 'MongoDB at MONGODB_URI' : 'memory'}): ${error.message}`);
  process.exit(1);
}
let app;
try {
  // (Production unless NODE_ENV=development: then an edited component shows on the next request,
  // and an error's page says what went wrong.)
  app = createApp({ store, hosted });
} catch (error) {
  console.error(error.message); // no compiler: what to do about it
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`help desk on http://localhost:${port} (${store.kind} store${hosted ? ', hosted demo' : ''})`));
