// The app built and started as a public demo (HOSTED_DEMO=1, TRUST_PROXIES=1), beside the other
// test's build (in .next-hosted), and spoken to as Railway's proxy would: Host and Origin the
// public hostname, X-Forwarded-Proto https, X-Forwarded-For the visitor. No browser: the feedback
// form is posted as a page without JavaScript posts it (its Server Action's hidden fields).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITED, NOTICE, TOO_MANY } from '../lib/hosted.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, '../../../target/debug', process.platform === 'win32' ? 'zubra.exe' : 'zubra');
const env = { ...process.env, HOSTED_DEMO: '1', TRUST_PROXIES: '1', NEXT_DIST_DIR: '.next-hosted' };
if (!env.ZUBRA_COMPILER && existsSync(cli)) env.ZUBRA_COMPILER = cli;
const port = 4900 + Math.floor(Math.random() * 200);
const HOST = 'next-conference-production.up.railway.app';
let next, server;

before(async () => {
  next = join(root, 'node_modules/next/dist/bin/next');
  execFileSync(process.execPath, [next, 'build'], { cwd: root, env, stdio: 'pipe' });
  server = spawn(process.execPath, [next, 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, env, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => String(chunk).includes('Ready') && resolve());
    server.on('exit', (code) => reject(new Error(`next start exited with ${code}`)));
  });
});
after(() => server?.kill());

// node:http, as fetch won't send a Host of our choosing.
const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => (text += chunk));
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

const proxied = (from = '203.0.113.10', headers = {}) => ({ host: HOST, origin: `https://${HOST}`, 'x-forwarded-proto': 'https', 'x-forwarded-for': from, ...headers });
const ratings = async (id) => (await send(`/sessions/${id}`)).text.match(/data-testid="ratings">([^<]*)/)[1];

/**
 * The feedback form as the page renders it: its action's hidden fields, and the given fields. As
 * a page without JavaScript posts it, or (`script`) as React calls the action: the form's fields
 * as the action's second argument, and the action's id in a header.
 */
async function feedback(id, fields, { script = false } = {}) {
  const page = (await send(`/sessions/${id}`)).text;
  const form = new FormData();
  const hidden = [...page.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g)].map(([, name, value = '']) => [name, value.replaceAll('&quot;', '"').replaceAll('&amp;', '&')]);
  for (const [name, value] of [...hidden, ...Object.entries(fields)]) form.append(script ? `_1_${name}` : name, value);
  const headers = {};
  if (script) {
    form.append('0', '[null,"$K1"]');
    headers['next-action'] = JSON.parse(hidden.find(([name]) => name === '$ACTION_1:0')[1]).id;
    headers.accept = 'text/x-component';
  }
  const encoded = new Request('http://form.test/', { method: 'POST', body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  return { body, headers: { ...headers, 'content-type': encoded.headers.get('content-type'), 'content-length': String(body.length) } };
}
const post = async (id, fields, headers, options) => {
  const form = await feedback(id, fields, options);
  return send(`/sessions/${id}`, { method: 'POST', body: form.body, headers: { ...form.headers, ...headers } });
};
const script = { script: true };

test('every page says the data resets', async () => {
  for (const path of ['/', '/sessions/s1']) assert.ok((await send(path)).text.includes(`<p class="demo-notice">${NOTICE}</p>`), path);
});

test('behind the proxy, the Server Action takes a same-site post, with or without Sec-Fetch-Site', async () => {
  assert.equal(await ratings('s2'), 'No ratings yet');
  const first = await post('s2', { rating: '4' }, proxied('203.0.113.11', { 'sec-fetch-site': 'same-origin' }));
  assert.equal(first.status, 200);
  assert.match(first.text, /Thanks! You rated it 4 of 5\./);
  const second = await post('s2', { rating: '2' }, proxied('203.0.113.11'));
  assert.equal(second.status, 200);
  assert.equal(await ratings('s2'), '3 ★ from 2 ratings');
  // And as the page's script calls it.
  const called = await post('s2', { rating: '5' }, proxied('203.0.113.11'), script);
  assert.equal(called.status, 200);
  assert.match(called.text, /Thanks! You rated it 5 of 5./);
  assert.equal(await ratings('s2'), '3.7 ★ from 3 ratings');
});

test('a cross-site post is refused, with or without Sec-Fetch-Site', async () => {
  for (const extra of [{ 'sec-fetch-site': 'cross-site' }, {}]) {
    const response = await post('s3', { rating: '1' }, proxied('203.0.113.12', { origin: 'https://evil.example', ...extra }));
    assert.equal(response.status, 500);
    assert.doesNotMatch(response.text, /Thanks!/);
    const called = await post('s3', { rating: '1' }, proxied('203.0.113.12', { origin: 'https://evil.example', ...extra }), script);
    assert.equal(called.status, 500);
    assert.doesNotMatch(called.text, /Thanks!/);
  }
  assert.equal(await ratings('s3'), 'No ratings yet');
});

test('a body over 16 KiB is refused, whether or not it says its length', async () => {
  const big = await feedback('s4', { rating: '5', comment: 'x'.repeat(20_000) });
  assert.equal((await send('/sessions/s4', { method: 'POST', body: big.body, headers: { ...big.headers, ...proxied('203.0.113.13') } })).status, 413);
  // Chunked, the proxy can't tell, and the action reads at most serverActions.bodySizeLimit: Next
  // answers a page's post (not JavaScript's) over it with a 500.
  const chunked = async (form) => {
    const { 'content-length': _, ...headers } = form.headers;
    return (await send('/sessions/s4', { method: 'POST', body: form.body, headers: { ...headers, ...proxied('203.0.113.13') } })).status;
  };
  assert.equal(await chunked(big), 500);
  assert.equal(await ratings('s4'), 'No ratings yet');
  assert.equal(await chunked(await feedback('s4', { rating: '5', comment: 'x'.repeat(1000) })), 200, 'one under it goes through');
  assert.equal(await ratings('s4'), '5 ★ from 1 rating');
});

test('30 writes a minute from one visitor, then 429 (or a message, to the page\'s script), and others still can', async () => {
  // The count starts over each minute: not so close to the next that it would start over midway.
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 20_000) await new Promise((done) => setTimeout(done, left + 100));
  for (let i = 0; i < 30; i++) assert.equal((await post('s5', { rating: '3' }, proxied('203.0.113.14'))).status, 200);
  const refused = await post('s5', { rating: '3' }, proxied('203.0.113.14'));
  assert.equal(refused.status, 429);
  assert.equal((await post('s5', { rating: '3' }, proxied('192.0.2.1, 203.0.113.14'))).status, 429, 'the header a visitor sends doesn\'t make them someone else');
  // A 429 would put Next's error page in place of the page: the action answers instead.
  const called = await post('s5', { rating: '3' }, proxied('203.0.113.14'), script);
  assert.equal(called.status, 200);
  assert.ok(called.text.includes(TOO_MANY));
  assert.equal(await ratings('s5'), '3 ★ from 30 ratings');
  // Another visitor still can, and only the proxy says who is over the limit.
  assert.equal((await post('s5', { rating: '3' }, proxied('203.0.113.15'))).status, 200);
  assert.match((await post('s5', { rating: '3' }, proxied('203.0.113.15', { [LIMITED]: '1' }), script)).text, /Thanks!/);
  assert.equal(await ratings('s5'), '3 ★ from 32 ratings');
});
