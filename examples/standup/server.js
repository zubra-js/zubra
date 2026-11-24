// A team standup board: one card per person, edited by everyone at once, offline included.
//
// Each card's state lives in the browser first (IndexedDB, through @zubra/sync), so typing never
// waits on the network. connect() shares it with the team through this server's log, a SQLite
// file, and shows who else is editing a card. The page is rendered on the server with the cards'
// defaults; each card loads its document once it starts.
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createSyncServer, allowAnyone } from '@zubra/sync/server';
import { sqliteLog } from '@zubra/sync/sqlite';
import { cardsOnly, clientAddress, fromEnv, NOTICE, wipe, writeLimit } from './hosted.js';

const here = dirname(fileURLToPath(import.meta.url));
export const team = [
  { doc: 'ada', name: 'Ada' },
  { doc: 'grace', name: 'Grace' },
  { doc: 'linus', name: 'Linus' },
];

/** `hosted`: the settings of a public demo (hosted.js), which caps the log and resets it. */
export async function createApp({ db = join(here, 'standup.db'), cache = true, hosted = null } = {}) {
  const demo = hosted && { resetMinutes: 1440, trustProxies: 0, now: Date.now, ...hosted };
  async function open() {
    if (!demo) {
      const log = await sqliteLog(db);
      // Everyone who can open the board may edit any card: the team's own board on a trusted
      // network. An app on the open internet says who may change what instead (authorize,
      // docs/sync.md), as the hosted demo does.
      return { log, sync: createSyncServer({ log, authorize: allowAnyone }) };
    }
    // A throwaway file, the latest value of each field, and only the cards' fields: at most six rows.
    wipe(db);
    const log = await sqliteLog(db, { keep: 'latest' });
    return { log, sync: createSyncServer({ log, authorize: cardsOnly(team), maxBytes: 64 * 1024, maxChanges: 100 }) };
  }
  let board = await open();
  // The cards start with 'use collection', so they import @zubra/sync: @zubra/server finds it in
  // node_modules, serves it, and puts it in the page's import map.
  const zubra = createZubra({ components: join(here, 'components'), cache });

  // A hosted demo starts over each period: a new, empty log, and every other connection closed, so
  // each page's live stream reconnects to it and is told to start over (`reset`).
  const period = demo ? demo.resetMinutes * 60_000 : Infinity;
  let epoch = demo ? Math.floor(demo.now() / period) : 0;
  let ready = Promise.resolve();
  const allowed = demo && writeLimit({ now: demo.now });
  const connections = new Set();
  function startOver(current) {
    ready = ready.then(async () => {
      board.log.close();
      board = await open();
      for (const socket of connections) if (socket !== current) socket.destroy();
    });
  }

  const server = createServer(async (req, res) => {
    if (demo) {
      if (Math.floor(demo.now() / period) !== epoch) {
        epoch = Math.floor(demo.now() / period);
        startOver(req.socket);
      }
      await ready;
      if (req.method === 'POST' && req.url.startsWith('/_zb/sync/') && !allowed(clientAddress(req, demo.trustProxies))) {
        return res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }).end(JSON.stringify({ error: 'Too many changes from here: slow down' }));
      }
    }
    if (await board.sync.handle(req, res)) return;
    if (zubra.handle(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') return res.writeHead(404).end('Not found');
    const page = zubra.page();
    const cards = team.map((person) => page.render('standup-card', person)).join('\n');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page.finish(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Standup</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
    .demo-notice { margin: 0 0 1rem; padding: 0.4rem 0.8rem; border-radius: 6px; background: #fff4c2; color: #4a3b00; font-size: 0.9rem; }
  </style>
</head>
<body>
  ${demo ? `<p class="demo-notice">${NOTICE}</p>` : ''}
  <h1>Standup</h1>
  <main>${cards}</main>
  <script type="module">
    import { connect } from '@zubra/sync/connect';
    connect();
  </script>
</body>
</html>`));
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  server.on('close', () => board.log.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  // HOSTED_DEMO=1: a public demo, its log capped and reset daily (hosted.js), in a throwaway file.
  const hosted = fromEnv();
  const app = await createApp(hosted ? { hosted, db: join(tmpdir(), 'standup-demo.db') } : {});
  app.listen(port, () => console.log(`Standup on http://localhost:${port}${hosted ? ' (hosted demo)' : ''}`));
}
