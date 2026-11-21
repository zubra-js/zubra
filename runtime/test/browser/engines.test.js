// Cross-browser lifecycle: upgrade and attribute order, moves, window listeners, in-flight
// async work, context subscriptions, and events inside a foreign shadow root.
// `npm run test:browser` — ZUBRA_BROWSER=firefox and =webkit run the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({
  counter: join(here, 'fixtures/counter.zb'),
  'window-count': join(here, 'fixtures/window-count.zb'),
  'nested-window': join(here, 'fixtures/nested-window.zb'),
  'slot-listen': join(here, 'fixtures/slot-listen.zb'),
  'pending-move': join(here, 'fixtures/pending-move.zb'),
  'fetch-user': join(here, 'fixtures/fetch-user.zb'),
  'slotted-click': join(here, 'fixtures/slotted-click.zb'),
});

const settle = (page, selector) => page.evaluate(async (sel) => {
  await Promise.all([...document.querySelectorAll(sel)].map((el) => el.updateComplete));
}, selector);

test('props are right however the element is created, upgraded, or cloned', async () => {
  const { page, messages } = await open('<zb-counter id="pre" label="FromAttr"></zb-counter><div id="box"></div>', {
    modules: ['counter'],
    // Before define(): an own property outranks the attribute the upgrade replays.
    beforeModules: `document.getElementById('pre').label = 'FromProp';`,
  });
  const result = await page.evaluate(async () => {
    const text = (el) => el.querySelector('button').textContent;
    const beforeDefine = text(document.getElementById('pre'));
    const box = document.getElementById('box');

    const created = document.createElement('zb-counter');
    created.setAttribute('label', 'FromAttr');
    box.append(created);
    await created.updateComplete;

    // After define(), a later attribute is a real change and wins.
    const owned = document.createElement('zb-counter');
    owned.label = 'FromProp';
    owned.setAttribute('label', 'FromAttr');
    box.append(owned);
    await owned.updateComplete;

    box.insertAdjacentHTML('beforeend', '<zb-counter label="FromInner"></zb-counter>');
    const inner = box.lastElementChild;
    await inner.updateComplete;

    const copy = created.cloneNode(true);
    box.append(copy);
    await copy.updateComplete;

    return {
      beforeDefine,
      fromAttr: text(created),
      afterDefine: text(owned),
      fromInner: text(inner),
      fromClone: text(copy),
    };
  });
  assert.equal(result.beforeDefine, 'FromProp: 0', 'a property set before define() beats the attribute replay');
  assert.equal(result.fromAttr, 'FromAttr: 0', 'attribute before connect');
  assert.equal(result.afterDefine, 'FromAttr: 0', 'an attribute set after upgrade still applies');
  assert.equal(result.fromInner, 'FromInner: 0', 'innerHTML');
  assert.equal(result.fromClone, 'FromAttr: 0', 'cloneNode upgrades a fresh element');
  assert.deepEqual(messages, []);
  await page.close();
});

test('moving an element does not double-bind listeners, and a click still works once', async () => {
  const { page, messages } = await open('<zb-counter label="Clicks"></zb-counter><div id="next"></div>', { modules: ['counter'] });
  await page.click('zb-counter button');
  await settle(page, 'zb-counter');
  const moved = await page.evaluate(async () => {
    const el = document.querySelector('zb-counter');
    const before = window.lifecycle.filter((entry) => entry === 'mount').length;
    document.getElementById('next').appendChild(el);
    await el.updateComplete;
    return { mounts: window.lifecycle.filter((entry) => entry === 'mount').length - before, text: el.querySelector('button').textContent };
  });
  assert.equal(moved.mounts, 1, 'connect runs onMount again, after its cleanup');
  assert.equal(moved.text, 'Clicks: 1');
  await page.click('zb-counter button');
  await settle(page, 'zb-counter');
  assert.equal(await page.textContent('zb-counter button'), 'Clicks: 2', 'one listener, not two');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a window listener is silent while the element is detached or its branch is hidden, then listens once', async () => {
  const { page, messages } = await open('<zb-window-count></zb-window-count>', { modules: ['window-count'] });
  const click = () => page.evaluate(() => {
    const before = window.hits ?? 0;
    window.dispatchEvent(new MouseEvent('click'));
    return (window.hits ?? 0) - before;
  });
  await settle(page, 'zb-window-count');
  assert.equal(await click(), 1);
  await page.evaluate(() => { document.querySelector('zb-window-count').show = false; });
  await settle(page, 'zb-window-count');
  assert.equal(await click(), 0, 'hiding the branch removes the listener');
  await page.evaluate(() => { document.querySelector('zb-window-count').show = true; });
  await settle(page, 'zb-window-count');
  assert.equal(await click(), 1, 'showing it again listens once');
  await page.evaluate(() => document.querySelector('zb-window-count').remove());
  assert.equal(await click(), 0, 'disconnect removes it');
  await page.evaluate(() => document.body.append(document.createElement('zb-window-count')));
  await settle(page, 'zb-window-count');
  assert.equal(await click(), 1, 'a new element listens once');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a nested window listener goes when its outer branch or row goes, and stays gone', async () => {
  const { page, messages } = await open('<zb-nested-window></zb-nested-window>', { modules: ['nested-window'] });
  const click = () => page.evaluate(() => {
    const before = window.hits ?? 0;
    window.dispatchEvent(new MouseEvent('click'));
    return (window.hits ?? 0) - before;
  });
  await settle(page, 'zb-nested-window');
  assert.equal(await click(), 2, 'the nested condition and the row each listen once');
  await page.evaluate(() => { document.querySelector('zb-nested-window').rows = []; });
  await settle(page, 'zb-nested-window');
  assert.equal(await click(), 1, 'removing the row removes its listener');
  await page.evaluate(() => { document.querySelector('zb-nested-window').show = false; });
  await settle(page, 'zb-nested-window');
  assert.equal(await click(), 0, 'hiding the inner branch removes its listener');
  await page.evaluate(() => { document.querySelector('zb-nested-window').outer = false; });
  await settle(page, 'zb-nested-window');
  assert.equal(await click(), 0, 'hiding the outer branch leaves nothing listening');
  await page.evaluate(() => {
    const el = document.querySelector('zb-nested-window');
    el.remove();
    document.body.append(el);
  });
  await settle(page, 'zb-nested-window');
  assert.equal(await click(), 0, 'connecting again does not restore a listener whose branch is gone');
  await page.evaluate(() => {
    const el = document.querySelector('zb-nested-window');
    el.outer = true;
    el.show = true;
    el.rows = ['a'];
  });
  await settle(page, 'zb-nested-window');
  assert.equal(await click(), 2, 'showing both again listens once each');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a window listener in a slot fallback goes when the slot is filled', async () => {
  const { page, messages } = await open('<zb-slot-listen></zb-slot-listen>', { modules: ['slot-listen'] });
  const click = () => page.evaluate(() => {
    const before = window.hits ?? 0;
    window.dispatchEvent(new MouseEvent('click'));
    return (window.hits ?? 0) - before;
  });
  await settle(page, 'zb-slot-listen');
  assert.equal(await click(), 1, 'the fallback listens');
  await page.evaluate(() => {
    const el = document.querySelector('zb-slot-listen');
    window.given = Object.assign(document.createElement('span'), { textContent: 'given' });
    el.append(window.given);
  });
  await settle(page, 'zb-slot-listen');
  assert.equal(await click(), 0, 'filling the slot removes the fallback listener');
  await page.evaluate(() => {
    const el = document.querySelector('zb-slot-listen');
    el.remove();
    document.body.append(el);
  });
  await settle(page, 'zb-slot-listen');
  assert.equal(await click(), 0, 'connecting again does not restore the replaced fallback');
  await page.evaluate(() => document.querySelector('zb-slot-listen').removeChild(window.given));
  await settle(page, 'zb-slot-listen');
  assert.equal(await click(), 1, 'the fallback listens once when it shows again');
  assert.deepEqual(messages, []);
  await page.close();
});

test('500 window listeners mount, toggle 1,000 times, and unmount without a listener left behind', async () => {
  const { page, messages } = await open('', { modules: ['window-count'] });
  const leaked = await page.evaluate(async () => {
    const made = [];
    for (let i = 0; i < 500; i++) {
      const el = document.createElement('zb-window-count');
      document.body.append(el);
      made.push(el);
    }
    await Promise.all(made.map((el) => el.updateComplete));
    for (let i = 0; i < 1000; i++) {
      made[i % made.length].show = i % 2 === 0;
      await Promise.resolve();
    }
    await Promise.all(made.map((el) => el.updateComplete));
    for (const el of made) el.remove();
    const before = window.hits ?? 0;
    window.dispatchEvent(new MouseEvent('click'));
    return (window.hits ?? 0) - before;
  });
  assert.equal(leaked, 0);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a promise that settles while detached renders when the element comes back, and not before', async () => {
  const { page, messages } = await open('<zb-pending-move></zb-pending-move>', { modules: ['pending-move'] });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-pending-move');
    let resolve;
    el.value = new Promise((done) => { resolve = done; });
    await el.updateComplete;
    const pending = el.querySelector('.pending')?.textContent ?? null;
    el.remove();
    el.label = 'b';
    resolve('ok');
    await new Promise((done) => setTimeout(done, 20));
    const detached = el.querySelector('.done')?.textContent ?? el.querySelector('.pending')?.textContent;
    document.body.append(el);
    for (let i = 0; i < 10 && !el.querySelector('.done'); i++) {
      await el.updateComplete;
      await new Promise((done) => setTimeout(done, 0));
    }
    return { pending, detached, back: el.querySelector('.done')?.textContent ?? null };
  });
  assert.equal(result.pending, 'a');
  assert.equal(result.detached, 'a', 'no settled markup and no label write while detached');
  assert.equal(result.back, 'ok-b');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an in-flight resource aborts when the element leaves and runs again when it returns', async () => {
  const { page, messages } = await open('', {
    modules: ['fetch-user'],
    beforeModules: 'window.requests = []; window.loadUser = (signal) => new Promise((resolve) => { window.requests.push({ signal, resolve }); });',
  });
  const result = await page.evaluate(async () => {
    const el = document.createElement('zb-fetch-user');
    document.body.append(el);
    await el.updateComplete;
    const started = window.requests.length;
    const first = window.requests[0];
    el.remove();
    const aborted = first.signal.aborted;
    document.body.append(el);
    await el.updateComplete;
    return { started, aborted, again: window.requests.length, second: window.requests[1]?.signal.aborted ?? null };
  });
  assert.equal(result.started, 1);
  assert.equal(result.aborted, true);
  assert.equal(result.again, 2);
  assert.equal(result.second, false);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a zb-context signal stops notifying while the element is disconnected', async () => {
  const { page, messages } = await open('', { modules: [] });
  const seen = await page.evaluate(async () => {
    const { state } = await import('@zubra/runtime');
    const { defineContextElement } = await import('/runtime/context-element.js');
    defineContextElement();
    const key = {};
    const theme = state('dark');
    const el = document.createElement('zb-context');
    const seen = [];
    el.context = key;
    el.value = theme;
    document.body.append(el);
    const event = new Event('context-request', { bubbles: true });
    event.context = key;
    event.subscribe = true;
    event.contextTarget = document.body;
    event.callback = (value) => seen.push(value);
    el.dispatchEvent(event);
    el.remove();
    theme.set('light');
    const detached = seen.slice();
    document.body.append(el);
    return { detached, back: seen.slice() };
  });
  assert.deepEqual(seen.detached, ['dark']);
  assert.deepEqual(seen.back, ['dark', 'light']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('clicks, focus and input inside a foreign shadow slot keep the real target', async () => {
  const { page, messages } = await open('<div id="host"></div>', { modules: ['slotted-click'] });
  await page.evaluate(() => {
    const shell = document.createElement('div');
    const root = shell.attachShadow({ mode: 'open' });
    root.innerHTML = '<slot></slot>';
    const el = document.createElement('zb-slotted-click');
    shell.append(el);
    document.getElementById('host').append(shell);
    window.shell = shell;
  });
  await settle(page, 'zb-slotted-click');
  await page.click('zb-slotted-click .inner');
  await page.focus('zb-slotted-click .field');
  await page.type('zb-slotted-click .field', 'a');
  await page.evaluate(() => document.querySelector('zb-slotted-click .field').blur());
  const result = await page.evaluate(() => ({ clicks: window.clicks, order: window.order }));
  assert.deepEqual(result.clicks, [['button', 'button', 'button']]);
  assert.ok(result.order.includes('focusin'), result.order.join(','));
  assert.ok(result.order.includes('input'), result.order.join(','));
  assert.ok(result.order.includes('focusout'), result.order.join(','));
  const inputAt = result.order.indexOf('input');
  const beforeAt = result.order.indexOf('beforeinput');
  if (beforeAt !== -1) assert.ok(beforeAt < inputAt, result.order.join(','));
  assert.deepEqual(messages, []);
  await page.close();
});

test('selfOnly on a shadow host ignores clicks from inside, including slotted light DOM', async () => {
  const { page, messages } = await open('<zb-slotted-click></zb-slotted-click>', { modules: ['slotted-click'] });
  const hits = await page.evaluate(async () => {
    const { selfOnly } = await import('@zubra/runtime');
    const shell = document.createElement('div');
    shell.id = 'shell';
    shell.style.display = 'block';
    shell.style.padding = '12px';
    const root = shell.attachShadow({ mode: 'open' });
    root.innerHTML = '<button class="inside" type="button">in</button><slot></slot>';
    shell.append(document.querySelector('zb-slotted-click'));
    document.body.append(shell);
    let hits = 0;
    shell.addEventListener('click', selfOnly(() => { hits++; }));
    // Inside the shadow tree: event.target is retargeted to the host for this listener.
    root.querySelector('.inside').click();
    document.querySelector('zb-slotted-click .inner').click();
    shell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return hits;
  });
  // The inner click is retargeted to the shell for this listener, so `.self` must use the
  // composed path. The dispatched click targets the shell itself and counts.
  assert.equal(hits, 1);
  assert.deepEqual(messages, []);
  await page.close();
});
