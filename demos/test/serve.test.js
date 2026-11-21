import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../serve.mjs';

test('an encoded .. under the base cannot read a file outside the gallery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zb-demo-'));
  const dir = join(root, 'site');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.html'), 'ok');
  writeFileSync(join(root, 'secret.txt'), 'SECRET-CANARY');
  const site = await serve(dir, '/zubra/');
  try {
    const get = (path) => fetch(new URL(path, site.url)).then(async (response) => ({ status: response.status, body: await response.text() }));
    assert.equal((await get('/zubra/index.html')).status, 200);
    const escaped = await get('/zubra/..%2fsecret.txt');
    assert.equal(escaped.status, 404);
    assert.equal(escaped.body.includes('SECRET-CANARY'), false);
  } finally {
    site.close();
    rmSync(root, { recursive: true, force: true });
  }
});
