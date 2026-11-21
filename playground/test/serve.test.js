import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../serve.mjs';

test('an encoded .. cannot read a file outside the playground directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zb-play-'));
  const dir = join(root, 'public');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.html'), 'ok');
  writeFileSync(join(root, 'secret.txt'), 'SECRET-CANARY');
  const server = await serve(dir);
  try {
    const get = (path) => fetch(new URL(path, server.url)).then(async (response) => ({ status: response.status, body: await response.text() }));
    assert.deepEqual(await get('/index.html'), { status: 200, body: 'ok' });
    for (const path of ['/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/..%5csecret.txt']) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.body.includes('SECRET-CANARY'), false, path);
    }
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
