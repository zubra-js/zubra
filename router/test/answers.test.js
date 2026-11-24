import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedLocation, redirect } from '../src/answers.js';

test('redirect locations cannot hide an external origin behind control characters', () => {
  const base = new URL('https://site.example/start');
  for (const location of ['/\t/evil.example/login', '/\n\\evil.example/login', '/cart\r', '\0/cart']) {
    for (const external of [false, true]) {
      assert.throws(() => checkedLocation(redirect(location, { external }), base), /control character/);
    }
  }
  assert.equal(checkedLocation(redirect('//evil.example/login'), base), '/evil.example/login');
  assert.equal(checkedLocation(redirect('/cart?x=1'), base), '/cart?x=1');
  assert.equal(checkedLocation(redirect('https://other.example/', { external: true }), base), 'https://other.example/');
  assert.throws(() => checkedLocation(redirect('https://other.example/'), base), /another site/);
  // Behind a proxy that ends TLS the request is http:// and the page https://: this host by either
  // scheme is this site, written as a path so the browser keeps the scheme it's on.
  const behind = new URL('http://site.example/start');
  assert.equal(checkedLocation(redirect('https://site.example/cart?x=1#top'), behind), '/cart?x=1#top');
  assert.equal(checkedLocation(redirect('http://site.example/cart'), base), '/cart', 'an https page is never sent to http');
  assert.equal(checkedLocation(redirect('https://site.example//evil.example/'), behind), '/evil.example/');
  for (const other of ['https://site.example:8443/', 'https://evilsite.example/', 'https://sub.site.example/']) {
    assert.throws(() => checkedLocation(redirect(other), behind), /another site/, other);
  }
});
