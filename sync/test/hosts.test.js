// DNS rebinding: a page on an attacker's domain whose DNS is then pointed at this machine reaches
// the server as the attacker's own site, so the browser lets it read the answers (and sends
// Sec-Fetch-Site: same-origin). Only the Host header still names the attacker's domain. So a
// server anyone may read answers only to names it knows: an IP address, localhost, *.localhost,
// the hosts of its origins, and what it's told (allowedHosts, the binary's --allowed-host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import { createSyncServer, allowAnyone, allowReads } from '../src/server.js';
import { syncObject } from '../src/durable-core.js';
import { durableStorage } from './durable-storage.js';
import { binaryPath, startBinary } from './backends.js';

const pull = (server, host, method = 'GET') => server.fetch(new Request(`http://${host}/_zb/sync/pull?since=0`, { method })).then((response) => response && response.status);
const push = (server, host) => server.fetch(new Request(`http://${host}/_zb/sync/push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ changes: [{ collection: 'tasks', key: 't1', field: 'title', value: 'x', clock: '000000000000001-00000-dev1' }] }),
})).then((response) => response.status);

const ALWAYS = ['localhost', 'localhost:3000', 'tasks.localhost:3000', '127.0.0.1:4000', '10.0.0.5', '[::1]:3000', 'LOCALHOST'];
const ATTACKER = ['evil.example', 'evil.example:4000', 'localhost.evil.example', '127.0.0.1.evil.example', 'app.example.evil.example'];

test('with allowAnyone, a server answers only to addresses, localhost and names it knows', async () => {
  const sync = createSyncServer({ authorize: allowAnyone, origins: ['https://shop.example'], allowedHosts: ['app.example', '.team.example'] });
  for (const host of [...ALWAYS, 'app.example', 'App.Example:8443', 'team.example', 'eu.team.example', 'shop.example']) {
    assert.equal(await pull(sync, host), 200, host);
  }
  for (const host of [...ATTACKER, 'notteam.example', 'shop.example.evil.example']) {
    assert.equal(await pull(sync, host), 403, `read under ${host}`);
    assert.equal(await push(sync, host), 403, `write under ${host}`);
    assert.equal(await pull(sync, host, 'OPTIONS'), 403, `preflight under ${host}`);
  }
  const refused = await (await sync.fetch(new Request('http://evil.example/_zb/sync/pull?since=0'))).json();
  assert.match(refused.error, /doesn't answer to the host "evil\.example".*allowedHosts: \["evil\.example"\]/);
  // Nothing was written under a name it doesn't answer to.
  assert.equal((await (await sync.fetch(new Request('http://localhost/_zb/sync/pull?since=0'))).json()).changes.length, 0);
});

test('the Host header is checked too, when the framework built the URL from an origin of its own', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  const from = (host) => sync.fetch(new Request('http://localhost:3000/_zb/sync/pull?since=0', { headers: host === undefined ? {} : { host } })).then((response) => response.status);
  assert.equal(await from(undefined), 200, 'no Host header: the URL decides');
  assert.equal(await from('localhost:3000'), 200);
  assert.equal(await from('rebind.evil.example:3000'), 403);
  assert.equal(await from('[evil.example'), 403, 'a Host that is not a host');
  const refused = await (await sync.fetch(new Request('http://localhost:3000/_zb/sync/pull?since=0', { headers: { host: 'rebind.evil.example' } }))).json();
  assert.match(refused.error, /"rebind\.evil\.example"/);
});

test('the check is on by default where anyone may read, and off for an app\'s own authorize unless it lists names', async () => {
  assert.equal(await pull(createSyncServer({ authorize: allowAnyone }), 'evil.example'), 403);
  assert.equal(await pull(createSyncServer({ authorize: allowReads() }), 'evil.example'), 403);
  assert.equal(await pull(createSyncServer({ authorize: allowReads(['notes']) }), 'evil.example'), 403);
  // An app's own authorize: a rebinding page carries no cookies of the app's site. Unchanged.
  const own = createSyncServer({ authorize: ({ request }) => request.headers.get('cookie') === 'session=ok' });
  assert.equal(await pull(own, 'app.example'), 200);
  assert.equal(await pull(createSyncServer({ authorize: () => true, allowedHosts: ['app.example'] }), 'evil.example'), 403, 'listed names are checked whatever authorize is');
  assert.equal(await pull(createSyncServer({ authorize: allowAnyone, allowedHosts: true }), 'evil.example'), 200, 'true answers to any name');
  // Not ours at all stays not ours.
  assert.equal(await createSyncServer({ authorize: allowAnyone }).fetch(new Request('http://evil.example/elsewhere')), null);
  assert.throws(() => createSyncServer({ allowedHosts: 'app.example' }), /allowedHosts/);
  assert.throws(() => createSyncServer({ allowedHosts: [7] }), /allowedHosts/);
});

test('through Node\'s http, the Host header is what is checked', async () => {
  const sync = createSyncServer({ authorize: allowAnyone });
  const server = createServer(async (req, res) => { if (!(await sync.handle(req, res))) res.writeHead(404).end(); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const get = (host) => new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port: server.address().port, path: '/_zb/sync/pull?since=0', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  try {
    assert.equal(await get(`localhost:${server.address().port}`), 200);
    assert.equal(await get(`evil.example:${server.address().port}`), 403);
  } finally {
    server.close();
  }
});

test('a Durable Object answers to any name by default: Cloudflare routes a request by its Host', async () => {
  const storage = durableStorage();
  const open = syncObject({ storage }, {}, { authorize: allowAnyone });
  assert.equal((await open.fetch(new Request('https://market.example.workers.dev/_zb/sync/pull?since=0'))).status, 200);
  const listed = syncObject({ storage }, {}, { authorize: allowAnyone, allowedHosts: ['market.example'] });
  assert.equal((await listed.fetch(new Request('https://evil.example/_zb/sync/pull?since=0'))).status, 403);
  storage.close();
});

test('the binary answers only to addresses, localhost and the names it was given', { skip: !binaryPath && 'needs the zubra-sync binary' }, async () => {
  const ask = (base, host, method = 'GET') => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    // Where it listens: `localhost` may have resolved to IPv6, printed as [::1] (a URL's brackets
    // aren't part of the address).
    const address = hostname === 'localhost' ? '127.0.0.1' : hostname.replace(/^\[(.*)\]$/, '$1');
    httpRequest({ host: address, port, method, path: '/_zb/sync/pull?since=0', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
  const open = await startBinary(['--open', '--origin', 'https://shop.example', '--allowed-host', 'sync.internal', '--allowed-host', '.team.example']);
  try {
    for (const host of [...ALWAYS, 'sync.internal:4000', 'eu.team.example', 'team.example', 'shop.example']) {
      assert.equal((await ask(open.base, host)).status, 200, host);
    }
    for (const host of [...ATTACKER, 'sync.internal.evil.example']) {
      assert.equal((await ask(open.base, host)).status, 403, host);
      assert.equal((await ask(open.base, host, 'OPTIONS')).status, 403, `preflight under ${host}`);
    }
    assert.match((await ask(open.base, 'evil.example')).body, /doesn't answer to the host \\"evil\.example\\".*--allowed-host evil\.example/);
  } finally {
    open.close();
  }
  // The name given to --host is its own; `any` turns the check off.
  const named = await startBinary(['--open', '--host', 'localhost']);
  try {
    assert.equal((await ask(named.base, 'evil.example')).status, 403);
  } finally {
    named.close();
  }
  const any = await startBinary(['--open', '--allowed-host', 'any']);
  try {
    assert.equal((await ask(any.base, 'evil.example')).status, 200);
  } finally {
    any.close();
  }
});
