// zb-slot in compiled components: light-DOM projection (the default) and native <slot> in
// shadow components, fresh and hydrated. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site, runtimeOnly, production, reported } from './harness.js';

useBrowser({
  card: join(here, 'fixtures/card.zb'),
  panel: join(here, 'fixtures/panel.zb'),
  either: join(here, 'fixtures/either-link.zb'),
  'status-badge': join(here, 'fixtures/status-badge.zb'),
  'alert-banner': join(here, 'fixtures/alert-banner.zb'),
});

const readCard = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('zb-card');
    return {
      header: el.querySelector('header').innerHTML.replace(/<!--.*?-->|<\?zb.*?>/g, ''),
      section: el.querySelector('section')?.innerHTML.replace(/<!--.*?-->|<\?zb.*?>/g, '') ?? null,
      footer: el.querySelector('footer').textContent,
    };
  });

test("the element's own children are moved into its slots", async () => {
  const { page, messages } = await open('<zb-card><h2 slot="title">Mine</h2>\n  <p>Body <b>text</b></p></zb-card>', {
    beforeModules: `window.mine = document.querySelector('zb-card h2'); window.body = document.querySelector('zb-card p');`,
    modules: ['card'],
  });
  assert.deepEqual(await readCard(page), {
    header: '<h2 slot="title">Mine</h2>\n  ', // whitespace goes with the content before it
    section: '<p>Body <b>text</b></p>',
    footer: 'Card footer',
  });
  const same = await page.evaluate(() =>
    document.querySelector('zb-card header h2') === window.mine && document.querySelector('zb-card section p') === window.body);
  assert.equal(same, true, 'the same nodes, moved — not copies');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an empty slot shows its fallback, which stays live', async () => {
  const { page } = await open('<zb-card></zb-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.evaluate(async () => {
    const el = document.querySelector('zb-card');
    el.heading = 'Renamed';
    await el.updateComplete;
  });
  assert.deepEqual(await readCard(page), { header: '<h2>Renamed</h2>', section: '<p>No content</p>', footer: 'Renamed footer' });
  await page.close();
});

test('slotted content inside an zb-if comes back when the branch does', async () => {
  const { page } = await open('<zb-card><p>Kept</p></zb-card>', {
    beforeModules: `window.kept = document.querySelector('zb-card p');`,
    modules: ['card'],
  });
  const toggle = (value) => page.evaluate(async (value) => {
    const el = document.querySelector('zb-card');
    el.open = value;
    await el.updateComplete;
  }, value);
  await toggle(false);
  assert.equal((await readCard(page)).section, null);
  await toggle(true);
  assert.equal((await readCard(page)).section, '<p>Kept</p>');
  assert.equal(await page.evaluate(() => document.querySelector('zb-card section p') === window.kept), true);
  await page.close();
});

test('content for a slot that does not exist is reported', async () => {
  const { page, messages } = await open('<zb-card><p slot="nope">?</p></zb-card>', { modules: ['card'] });
  assert.ok(reported(messages, (message) => message.startsWith('warning:') && message.includes('no slot named "nope"')));
  assert.equal((await readCard(page)).section, '<p>No content</p>');
  await page.close();
});

test('hydrates supplied slot content as-is and binds the fallback of empty slots', { skip: runtimeOnly }, async () => {
  const slots = join(site, 'card.slots.json');
  writeFileSync(slots, JSON.stringify({ title: '<h2>Server title</h2>' }));
  const html = compiler(join(here, 'fixtures/card.zb'), '--slots', slots);
  assert.match(html, /<\?zb \[!\?><h2>Server title<\/h2><\?zb \]\?>/);
  assert.match(html, /<\?zb \[\?><p>No content<\/p><\?zb \]\?>/);
  const { page, messages } = await open(html, {
    beforeModules: `window.before = [...document.querySelectorAll('zb-card *')];`,
    modules: ['card'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-card');
    const same = [...el.querySelectorAll('*')].every((node, i) => node === window.before[i]);
    el.heading = 'Updated';
    el.open = false;
    await el.updateComplete;
    el.open = true;
    await el.updateComplete;
    return { same };
  });
  assert.equal(result.same, true);
  assert.deepEqual(await readCard(page), { header: '<h2>Server title</h2>', section: '<p>No content</p>', footer: 'Updated footer' },
    'supplied content is static; the fallback and the rest are live');
  assert.deepEqual(messages, []);
  await page.close();
});

test('shadow components use native slots', async () => {
  const { page, messages } = await open('<zb-panel><h3 slot="title">Mine</h3>Body</zb-panel><zb-panel id="empty"></zb-panel>', { modules: ['panel'] });
  const result = await page.evaluate(async () => {
    const [full, empty] = document.querySelectorAll('zb-panel');
    const assigned = (el, selector) => el.shadowRoot.querySelector(selector).assignedNodes().map((node) => node.textContent);
    const before = { title: assigned(full, 'slot[name=title]'), body: assigned(full, 'slot:not([name])') };
    const fallback = empty.shadowRoot.querySelector('slot[name=title]').textContent;
    empty.heading = 'Shadow heading';
    await empty.updateComplete;
    return { before, fallback, after: empty.shadowRoot.querySelector('slot[name=title]').textContent };
  });
  assert.deepEqual(result.before, { title: ['Mine'], body: ['Body'] });
  assert.equal(result.fallback, 'Panel');
  assert.equal(result.after, 'Shadow heading');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a server-rendered shadow component hydrates its declarative shadow root', async () => {
  const slots = join(site, 'panel.slots.json');
  writeFileSync(slots, JSON.stringify({ title: '<h3>Server</h3>' }));
  const html = compiler(join(here, 'fixtures/panel.zb'), '--slots', slots);
  assert.match(html, /<template shadowrootmode="open">.*<slot name="title"><h3>Panel<\/h3><\/slot>.*<\/template><h3 slot="title">Server<\/h3>/s);
  const { page, messages } = await open(html, {
    beforeModules: `window.slotEl = document.querySelector('zb-panel').shadowRoot.querySelector('slot[name=title]');`,
    modules: ['panel'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-panel');
    const slot = el.shadowRoot.querySelector('slot[name=title]');
    el.heading = 'Changed';
    await el.updateComplete;
    return { same: slot === window.slotEl, assigned: slot.assignedNodes().map((node) => node.textContent), fallback: slot.textContent };
  });
  assert.equal(result.same, true, 'the declarative shadow root is reused');
  assert.deepEqual(result.assigned, ['Server']);
  assert.equal(result.fallback, 'Changed');
  assert.deepEqual(messages, []);
  await page.close();
});

// ---- content changed after startup, the way frameworks change it ----------------------------

/** Run `fn(card)` in the page, wait for DOM observers and updates, then read the card. */
async function change(page, fn) {
  await page.evaluate(`(async () => { const card = document.querySelector('zb-card'); (${fn})(card);
    await new Promise((resolve) => setTimeout(resolve)); await card.updateComplete; })()`);
  return readCard(page);
}

test("the host's child methods put content into its slots after startup", async () => {
  const { page, messages } = await open('<zb-card></zb-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });

  // React: appendChild / insertBefore(node, sibling) / removeChild on the host.
  let card = await change(page, (el) => {
    window.b = Object.assign(document.createElement('p'), { textContent: 'b' });
    el.appendChild(window.b);
    el.insertBefore(Object.assign(document.createElement('p'), { textContent: 'a' }), window.b);
    const title = Object.assign(document.createElement('h2'), { textContent: 'T' });
    title.slot = 'title';
    el.appendChild(title);
  });
  assert.deepEqual(card, { header: '<h2 slot="title">T</h2>', section: '<p>a</p><p>b</p>', footer: 'Card footer' });

  card = await change(page, (el) => { el.removeChild(window.b); el.removeChild(el.querySelector('[slot=title]')); });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<p>a</p>', footer: 'Card footer' }, 'an emptied slot shows its fallback again');

  card = await change(page, (el) => el.replaceChild(Object.assign(document.createElement('i'), { textContent: 'i' }), el.querySelector('section p')));
  assert.equal(card.section, '<i>i</i>');

  // Vue: textContent for text-only children; React: innerHTML for dangerouslySetInnerHTML.
  card = await change(page, (el) => { el.textContent = 'just text'; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: 'just text', footer: 'Card footer' });
  card = await change(page, (el) => { el.innerHTML = '<b>bold</b><h2 slot="title">H</h2>'; });
  assert.deepEqual(card, { header: '<h2 slot="title">H</h2>', section: '<b>bold</b>', footer: 'Card footer' });
  card = await change(page, (el) => { el.textContent = ''; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });

  card = await change(page, (el) => {
    const fragment = document.createDocumentFragment();
    fragment.append('x', document.createElement('hr'));
    el.append(fragment, 'y');
  });
  assert.equal(card.section, 'x<hr>y');
  card = await change(page, (el) => el.replaceChildren('only'));
  assert.equal(card.section, 'only');

  assert.equal(await page.evaluate(() => {
    try { document.querySelector('zb-card').removeChild(document.createElement('p')); return 'no error'; } catch (error) { return error.name; }
  }), 'NotFoundError', 'removing something that was never there still throws');
  assert.deepEqual(messages, []);
  await page.close();
});

test("moveBefore on the host moves content within its slot, keeping the node (Preact 11 reorders keyed children with it)", async () => {
  const { page, messages } = await open('<zb-card></zb-card>', { modules: ['card'] });
  const has = await page.evaluate(() => typeof Element.prototype.moveBefore === 'function');
  if (!has) {
    // A browser without moveBefore(): the host doesn't claim one, so a framework that asks for
    // it by name (Preact: `parentDom.moveBefore && …`) takes its insertBefore path.
    assert.equal(await page.evaluate(() => 'moveBefore' in document.querySelector('zb-card')), false);
    await page.close();
    return;
  }
  let card = await change(page, (el) => {
    window.items = ['a', 'b', 'c'].map((text) => Object.assign(document.createElement('p'), { textContent: text }));
    for (const item of window.items) el.appendChild(item);
    const title = Object.assign(document.createElement('h2'), { textContent: 'T' });
    title.slot = 'title';
    el.appendChild(title);
  });
  assert.equal(card.section, '<p>a</p><p>b</p><p>c</p>');

  // Preact 11, reversing a keyed list: host.moveBefore(node, sibling), sibling null for the end.
  card = await change(page, (el) => {
    const [a, b, c] = window.items;
    el.moveBefore(c, a);
    el.moveBefore(a, null);
  });
  assert.equal(card.section, '<p>c</p><p>b</p><p>a</p>');
  assert.equal(card.header, '<h2 slot="title">T</h2>', "another slot's content stays where it is");
  assert.deepEqual(
    await page.evaluate(() => { const [a, b, c] = window.items; const section = document.querySelector('zb-card section'); return [...section.children].map((node) => [a, b, c].indexOf(node)); }),
    [2, 1, 0],
    'the same nodes, moved: not copies',
  );

  // What the host holds is still what a framework reads back and removes.
  card = await change(page, (el) => el.removeChild(window.items[1]));
  assert.equal(card.section, '<p>c</p><p>a</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content removed through its real parent leaves its slot (Vue removes via parentNode)', async () => {
  const { page } = await open('<zb-card><p id="mine">mine</p></zb-card>', { modules: ['card'] });
  const card = await change(page, () => { const p = document.getElementById('mine'); p.parentNode.removeChild(p); });
  assert.equal(card.section, '<p>No content</p>');
  // Moved elsewhere by the page: no longer the card's, so it isn't pulled back later.
  await change(page, (el) => { window.away = document.createElement('p'); el.appendChild(window.away); });
  await change(page, () => document.body.append(window.away));
  const after = await change(page, (el) => el.appendChild(document.createElement('hr')));
  assert.equal(after.section, '<hr>');
  assert.equal(await page.evaluate(() => window.away.parentNode === document.body), true);
  await page.close();
});

test('content for a slot that is not rendered waits, and can still be removed', async () => {
  const { page, messages } = await open('<zb-card open="false"></zb-card>', { modules: ['card'] });
  let card = await change(page, (el) => {
    window.kept = Object.assign(document.createElement('p'), { textContent: 'kept' });
    window.gone = Object.assign(document.createElement('p'), { textContent: 'gone' });
    el.append(window.kept, window.gone);
  });
  assert.equal(card.section, null, 'the branch holding the slot is off');
  await change(page, () => window.gone.parentNode.removeChild(window.gone));
  card = await change(page, (el) => { el.open = true; });
  assert.equal(card.section, '<p>kept</p>');
  card = await change(page, (el) => { el.open = false; });
  card = await change(page, (el) => { el.open = true; });
  assert.equal(card.section, '<p>kept</p>', 'it comes back each time the branch does');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content for a slot that does not exist is reported, not shown', async () => {
  const { page, messages } = await open('<zb-card></zb-card>', { modules: ['card'] });
  const card = await change(page, (el) => {
    const stray = document.createElement('p');
    stray.slot = 'nope';
    el.appendChild(stray);
  });
  assert.equal(card.section, '<p>No content</p>');
  assert.ok(reported(messages, (message) => message.includes('has no slot named "nope"')), messages.join('\n'));
  await page.close();
});

test("changing a slotted element's slot attribute moves it to that slot", async () => {
  const { page } = await open('<zb-card><h2 slot="title" id="t">T</h2></zb-card>', { modules: ['card'] });
  let card = await change(page, () => { document.getElementById('t').slot = ''; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<h2 slot="" id="t">T</h2>', footer: 'Card footer' },
    'the slot it left shows its fallback again');
  card = await change(page, () => { document.getElementById('t').slot = 'title'; });
  assert.deepEqual(card, { header: '<h2 slot="title" id="t">T</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.close();
});

test('a showing fallback is kept, not re-rendered, when its slot stays empty', async () => {
  const { page } = await open('<zb-card></zb-card>', { modules: ['card'] });
  await page.evaluate(() => { window.fallback = document.querySelector('zb-card section p'); });
  await change(page, (el) => { el.textContent = ''; });
  assert.equal(await page.evaluate(() => window.fallback === document.querySelector('zb-card section p')), true);
  await page.close();
});

test('content present at startup for a slot that is not rendered can be removed while it waits', async () => {
  const { page, messages } = await open('<zb-card open="false"><p id="early">early</p><p>stays</p></zb-card>', {
    beforeModules: "window.early = document.getElementById('early');",
    modules: ['card'],
  });
  await change(page, () => window.early.parentNode.removeChild(window.early));
  const card = await change(page, (el) => { el.open = true; });
  assert.equal(card.section, '<p>stays</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content removed through its real parent stays out when the host gets new content at once', async () => {
  // Vue's update order: remove the old child via parentNode, then insert the new one via the host.
  const { page } = await open('<zb-card><p id="old">old</p></zb-card>', { modules: ['card'] });
  const card = await change(page, (el) => {
    const old = document.getElementById('old');
    old.parentNode.removeChild(old);
    el.insertBefore(document.createTextNode('new'), null);
  });
  assert.equal(card.section, 'new');
  await page.close();
});

test("framework markers stay with their content, so a framework can update a slot by its markers (Lit's parts)", async () => {
  // Lit renders `${cond ? html`<h2 slot="title">…` : nothing}` as: start comment, content, then
  // the whitespace after it as the end. It clears and refills between those, through their parent.
  const { page, messages } = await open('<zb-card><!--start--><h2 slot="title">T</h2>\n<!--items--><p>1</p></zb-card>', {
    beforeModules: "window.start = document.querySelector('zb-card').firstChild; window.end = document.querySelector('zb-card h2').nextSibling;",
    modules: ['card'],
  });
  let card = await readCard(page);
  assert.equal(card.header, '<h2 slot="title">T</h2>\n');
  card = await change(page, () => { while (window.start.nextSibling !== window.end) window.start.nextSibling.remove(); });
  assert.equal(card.header, '<h2>Card</h2>', 'emptied through its markers: the fallback shows');
  card = await change(page, () => {
    const h2 = Object.assign(document.createElement('h2'), { textContent: 'again', slot: 'title' });
    window.end.parentNode.insertBefore(h2, window.end);
  });
  assert.equal(card.header, '<h2 slot="title">again</h2>\n', 'refilled next to its markers, while they waited in the park');
  assert.equal(card.section, '<p>1</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test("content inserted next to another slot's marker moves to its own slot (Svelte's anchors)", async () => {
  const { page } = await open('<zb-card><p>1</p><!--anchor--></zb-card>', {
    beforeModules: "window.anchor = document.querySelector('zb-card').lastChild;",
    modules: ['card'],
  });
  const card = await change(page, () => {
    const h2 = Object.assign(document.createElement('h2'), { textContent: 'T', slot: 'title' });
    window.anchor.parentNode.insertBefore(h2, window.anchor);
  });
  assert.equal(card.header, '<h2 slot="title">T</h2>');
  assert.equal(card.section, '<p>1</p>');
  await page.close();
});

test("elements for one slot inserted together next to another slot's marker all move there (Angular's @if)", async () => {
  // Moving the first out of the list being walked used to skip the one after it (#262).
  const { page, messages } = await open('<zb-card><p>1</p><!--anchor--></zb-card>', {
    beforeModules: "window.anchor = document.querySelector('zb-card').lastChild;",
    modules: ['card'],
  });
  const card = await change(page, () => {
    for (const text of ['A', 'B', 'C']) {
      const h2 = Object.assign(document.createElement('h2'), { textContent: text, slot: 'title' });
      window.anchor.parentNode.insertBefore(h2, window.anchor);
    }
  });
  assert.equal(card.header, '<h2 slot="title">A</h2><h2 slot="title">B</h2><h2 slot="title">C</h2>');
  assert.equal(card.section, '<p>1</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an empty text node is slotted once it has text, and leaves when emptied (Angular\'s {{ }})', async () => {
  // Angular creates the text node for {{ }} empty and writes it afterwards. Empty text is a
  // marker, so it waited in the park and nothing heard it being written (#261).
  const { page, messages } = await open('<zb-card id="alone"></zb-card><zb-card id="after"><h2 slot="title">T</h2></zb-card>', {
    beforeModules: `
      window.alone = document.createTextNode('');
      document.getElementById('alone').append(window.alone);
      window.after = document.createTextNode('');
      document.getElementById('after').append(window.after);`,
    modules: ['card'],
  });
  const read = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    const clean = (el) => el.innerHTML.replace(/<!--.*?-->|<\?zb.*?>/g, '');
    return ['alone', 'after'].map((id) => [clean(document.querySelector(`#${id} header`)), clean(document.querySelector(`#${id} section`))].join(' | '));
  });
  assert.deepEqual(await read(), ['<h2>Card</h2> | <p>No content</p>', '<h2 slot="title">T</h2> | <p>No content</p>']);
  await page.evaluate(() => { window.alone.data = 'Hello'; window.after.data = 'World'; });
  assert.deepEqual(await read(), ['<h2>Card</h2> | Hello', '<h2 slot="title">T</h2> | World'], 'text is the default slot\'s, even after a named slot\'s element');
  await page.evaluate(() => { window.alone.data = 'Again'; });
  assert.deepEqual((await read())[0], '<h2>Card</h2> | Again');
  await page.evaluate(() => { window.alone.data = ''; });
  assert.deepEqual((await read())[0], '<h2>Card</h2> | <p>No content</p>', 'emptied, the fallback is back');
  await page.evaluate(() => { window.alone.data = 'Back'; });
  assert.deepEqual((await read())[0], '<h2>Card</h2> | Back');
  // One added after startup, through the host (as Angular does once the element is defined).
  await page.evaluate(() => { window.late = document.createTextNode(''); document.getElementById('after').append(window.late); window.late.data = '!'; });
  assert.deepEqual((await read())[1], '<h2 slot="title">T</h2> | World!');
  assert.deepEqual(messages, []);
  await page.close();
});

test("a framework's empty-text anchors stay with the content they bracket, so it can reorder through their parent (Vue's fragments)", async () => {
  // Vue brackets a v-for (any fragment) with two empty text nodes, and moves rows through the
  // start anchor's real parent. After a named slot's content, the start anchor used to join that
  // slot (whitespace goes with what's before it), so the reorder threw.
  const { page, messages } = await open('<zb-card><h2 slot="title">T</h2></zb-card>', {
    beforeModules: `
      const card = document.querySelector('zb-card');
      window.start = document.createTextNode('');
      window.end = document.createTextNode('');
      window.rows = ['1', '2', '3'].map((text) => Object.assign(document.createElement('p'), { textContent: text }));
      card.append(window.start, ...window.rows, window.end);`,
    modules: ['card'],
  });
  let card = await readCard(page);
  assert.equal(card.header, '<h2 slot="title">T</h2>');
  assert.equal(card.section, '<p>1</p><p>2</p><p>3</p>');
  assert.equal(await page.evaluate(() => window.start.parentNode === window.rows[0].parentNode && window.end.parentNode === window.rows[0].parentNode), true, 'both anchors are with the rows');
  card = await change(page, () => {
    const [one, , three] = window.rows;
    window.start.parentNode.insertBefore(three, one); // as Vue moves a keyed row
  });
  assert.equal(card.section, '<p>3</p><p>1</p><p>2</p>', 'and the new order stands');
  assert.deepEqual(messages, []);
  await page.close();
});

test('markers and whitespace alone leave a slot empty', async () => {
  const { page } = await open('<zb-card>\n  <!--marker-->\n</zb-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.close();
});

test('text alone given to an element whose template starts with a condition is slotted, and follows the branch that shows', async () => {
  const { page, messages } = await open('<zb-either>Save <b>now</b></zb-either><zb-either href="/go">Go</zb-either><zb-either></zb-either><zb-either href="/x"><b>Bold</b></zb-either><zb-either>Plain</zb-either>', { modules: ['either'] });

  const read = () => page.evaluate(() => [...document.querySelectorAll('zb-either')].map((el) => {
    const inner = el.querySelector('.either');
    return `${inner.localName}:${inner.innerHTML.replace(/<!--.*?-->|<\\?zb.*?>/g, '')}`;
  }));
  // Content shaped like the template is checked for stripped server markup first (remark.js, a
  // dynamic import), so those elements render a moment later: updateComplete waits for that.
  await page.evaluate(() => Promise.all([...document.querySelectorAll('zb-either')].map((el) => el.updateComplete)));
  assert.deepEqual(await read(), ['button:Save <b>now</b>', 'a:Go', 'button:Fallback', 'a:<b>Bold</b>', 'button:Plain'], 'text alone is content too, not server markup');
  await page.evaluate(async () => {
    const [first, second] = document.querySelectorAll('zb-either');
    window.bold = first.querySelector('b');
    first.href = '/now';
    second.href = '';
    await first.updateComplete;
    await second.updateComplete;
  });
  assert.deepEqual(await read(), ['a:Save <b>now</b>', 'button:Go', 'button:Fallback', 'a:<b>Bold</b>', 'button:Plain']);
  assert.equal(await page.evaluate(() => document.querySelector('zb-either a b') === window.bold), true, 'the same nodes, moved');
  assert.deepEqual(messages, []);
  await page.close();
});

test('text given to a template that is only regions renders at once, without loading remark.js', async () => {
  // What React and Svelte do (text, then connect): the element's template starts with a condition,
  // but the markup holds none of the elements its blocks start with (a, button), so it is the
  // page's own content, not server markup that lost its comments: no check, no wait. whenDefined
  // resolves right after the upgrade, so a render that waits for an import isn't there yet.
  const { page, messages } = await open('<zb-either>Save</zb-either><zb-either href="/go"><b>Go</b></zb-either>', {
    modules: ['either'],
    beforeModules: `window.rendered = customElements.whenDefined('zb-either').then(() =>
      [...document.querySelectorAll('zb-either')].map((el) => el.querySelector('.either')?.textContent ?? null));`,
  });
  assert.deepEqual(await page.evaluate(() => window.rendered), ['Save', 'Go']);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('remark'))), false, 'remark.js was not loaded');
  assert.deepEqual(messages, []);
  await page.close();
});

test('updateComplete waits for a first render that is waiting on the check for stripped server markup', { skip: runtimeOnly }, async () => {
  // Server markup of the same component with its markers stripped does hold a root (the button):
  // remark.js, a dynamic import, puts them back before the element starts. Asked for as soon as the
  // element is defined, updateComplete has to wait for that.
  const html = compiler(join(here, 'fixtures/either-link.zb')).replace(/<!--[^]*?-->|<\?zb[^]*?>/g, '');
  assert.match(html, /<button class="either"/);
  const { page, messages } = await open(html, {
    modules: ['either'],
    beforeModules: `window.started = customElements.whenDefined('zb-either').then(async () => {
      const el = document.querySelector('zb-either');
      await el.updateComplete;
      return el.matches(':state(hydrated)');
    });`,
  });
  assert.equal(await page.evaluate(() => window.started), true);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('remark'))), true, 'it had to load remark.js');
  assert.deepEqual(messages, []);
  await page.close();
});

const clean = (html) => html.replace(/<!--.*?-->|<\?zb.*?>/g, '').replace(/\s+/g, ' ').trim();

test("a child shaped like the component's own root is the page's content, not server markup that lost its markers", async () => {
  // The badge's template is one <span> around its slot, so a page's <span> child has the shape of
  // the badge's server markup with its markers stripped. It used to be adopted as the badge's own
  // root: it got the badge's class and its text became the slot's content (#267).
  const { page, messages } = await open('<status-badge id="one"><span id="mine">hi</span></status-badge><status-badge id="two"><span id="blank"></span></status-badge>', {
    beforeModules: "window.mine = document.getElementById('mine'); window.blank = document.getElementById('blank');",
    modules: ['status-badge'],
  });
  const read = (id) => page.evaluate((id) => document.getElementById(id).innerHTML, id);
  assert.equal(clean(await read('one')), '<span class="badge-neutral"><span id="mine">hi</span></span>');
  assert.equal(clean(await read('two')), '<span class="badge-neutral"><span id="blank"></span></span>', 'an empty one too');
  assert.equal(await page.evaluate(() => document.getElementById('mine') === window.mine && document.getElementById('blank') === window.blank), true, 'the same nodes, moved');
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('remark'))), false, 'nothing to put back: remark.js was not loaded');
  assert.deepEqual(messages, []);
  await page.close();
});

test("a child shaped like the component's own root keeps text a framework writes into it later (Angular's {{ }} in @for)", async () => {
  // The blank text node was dropped when the <span> was taken for the badge's root, so the text
  // written a moment later went nowhere (#267).
  const { page, messages } = await open('<main></main>', {
    modules: ['status-badge'],
    beforeModules: `
      const badge = document.createElement('status-badge');
      window.span = document.createElement('span');
      window.text = document.createTextNode('');
      window.span.append(window.text);
      badge.append(window.span);
      document.querySelector('main').append(badge);`,
  });
  await page.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); window.text.data = 'later'; });
  assert.equal(clean(await page.evaluate(() => document.querySelector('status-badge').innerHTML)), '<span class="badge-neutral"><span>later</span></span>');
  assert.equal(await page.evaluate(() => window.text.isConnected && window.text.parentNode === window.span), true);
  assert.deepEqual(messages, []);
  await page.close();
});

test('text a framework writes into a slot after the element was moved still reaches the slot (Angular, re-attached)', async () => {
  // A slot hears that a text node got words through an observer, which disconnect drops so a
  // detached element isn't retained. Connecting again must observe the text nodes too, not only
  // the host and the park: from 6.0.3 it didn't, so a label written after a move never showed.
  const { page, messages } = await open('<main></main>', {
    modules: ['card'],
    beforeModules: `
      const card = document.createElement('zb-card');
      window.text = document.createTextNode('');
      card.append(window.text);
      document.querySelector('main').append(card);`,
  });
  assert.equal((await readCard(page)).section, '<p>No content</p>', 'an empty text node is not content');
  await page.evaluate(async () => {
    const card = document.querySelector('zb-card');
    const main = card.parentNode;
    card.remove();
    main.append(card); // moved: disconnected, then connected again
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.text.data = 'Hello';
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal((await readCard(page)).section, 'Hello', 'the text written after the move is in the slot');
  assert.equal(await page.evaluate(() => window.text.isConnected && window.text.parentNode === document.querySelector('zb-card section')), true, 'the same text node, moved into the slot');
  assert.deepEqual(messages, []);
  await page.close();
});

// A slot attribute changed while the element was off the page went unseen: its observer stops
// when it leaves (so it can't be kept alive), and connecting again only dropped what had left.
// Found by the 6.0.6 pre-release audit in --emit element output; the runtime had it since 6.0.3.
test('a slot attribute changed while the element was detached takes effect when it is back', async () => {
  const { page, messages } = await open('<main><zb-card><b>Moved</b></zb-card></main>', { modules: ['card'] });
  assert.equal((await readCard(page)).section, '<b>Moved</b>');
  await page.evaluate(async () => {
    const card = document.querySelector('zb-card');
    const main = card.parentNode;
    card.remove();
    card.querySelector('b').setAttribute('slot', 'title');
    main.append(card);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const card = await readCard(page);
  assert.equal(card.header, '<b slot="title">Moved</b>', 'in the title slot');
  assert.equal(card.section, '<p>No content</p>', 'and out of the default one');
  assert.deepEqual(messages, []);
  await page.close();
});

test('every slotted text node is heard after a move, not only the first', async () => {
  const { page, messages } = await open('<main></main>', {
    modules: ['card'],
    beforeModules: `
      const card = document.createElement('zb-card');
      window.first = document.createTextNode('');
      window.second = document.createTextNode('');
      card.append(window.first, window.second);
      document.querySelector('main').append(card);`,
  });
  await page.evaluate(async () => {
    const card = document.querySelector('zb-card');
    const main = card.parentNode;
    card.remove();
    main.append(card);
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.second.data = 'Hello';
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal((await readCard(page)).section, 'Hello');
  assert.deepEqual(messages, []);
  await page.close();
});

// Security audit of #436: what left a slot while its element was detached stayed in the slot's
// list, so connecting again put it back: an element took a node another component now holds.
test("an element connected again doesn't take back a node that left it while it was detached", async () => {
  const { page, messages } = await open('<main><zb-card id="a"></zb-card><zb-card id="b"><p>B body</p></zb-card></main>', {
    beforeModules: "window.moved = document.createTextNode('A text'); document.getElementById('a').append(window.moved);",
    modules: ['card'],
  });
  const where = () => page.evaluate(() => ({
    moved: window.moved.parentNode?.closest?.('zb-card')?.id ?? null,
    a: document.querySelector('#a section').textContent.trim(),
  }));
  assert.deepEqual(await where(), { moved: 'a', a: 'A text' });
  await page.evaluate(async () => {
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    const main = a.parentNode;
    a.remove();
    b.append(window.moved); // B's now, while A was detached
    main.prepend(a);
    await new Promise((resolve) => setTimeout(resolve, 30));
    a.open = false;
    await a.updateComplete;
    a.open = true;
    await a.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.deepEqual(await where(), { moved: 'b', a: 'No content' });
  assert.deepEqual(messages, []);
  await page.close();
});

test('server markup that lost its markers is told from page content by data-zb-filled on the host', { skip: runtimeOnly }, async () => {
  // The server writes data-zb-filled on a light-DOM host that has slots, naming the ones it
  // filled: that host's marker-less children are its own markup, and hydrate in place.
  const strip = (html) => html.replace(/<!--[^]*?-->|<\?zb[^]*?>/g, '');
  writeFileSync(join(site, 'badge-slots.json'), JSON.stringify({ default: '<span id="given">3</span>' }));
  const empty = strip(compiler(join(here, 'fixtures/status-badge.zb')));
  const given = strip(compiler(join(here, 'fixtures/status-badge.zb'), '--slots', join(site, 'badge-slots.json'), '--slots-html'));
  assert.match(empty, /^<status-badge data-zb-filled>\s*<span class="badge-neutral"><\/span>/);
  assert.match(given, /^<status-badge data-zb-filled="default">\s*<span class="badge-neutral"><span id="given"[^>]*>3<\/span><\/span>/);
  const { page, messages } = await open(`<div id="empty">${empty}</div><div id="given-to">${given}</div>`, {
    modules: ['status-badge'],
    beforeModules: "window.roots = [...document.querySelectorAll('status-badge > span')];",
  });
  await page.waitForFunction(() => [...document.querySelectorAll('status-badge')].every((el) => el.matches(':state(hydrated)')));
  assert.equal(await page.evaluate(() => window.roots.every((root, i) => root === document.querySelectorAll('status-badge')[i].firstElementChild)), true, "the server's spans are the badges' roots: nothing rendered fresh");
  assert.equal(clean(await page.evaluate(() => document.querySelector('#given-to status-badge').innerHTML)), '<span class="badge-neutral"><span id="given">3</span></span>');
  // And they're live: the slot takes new content, the class follows the prop.
  await page.evaluate(async () => {
    const badge = document.querySelector('#empty status-badge');
    badge.variant = 'success';
    badge.append('9');
    await badge.updateComplete;
  });
  assert.equal(clean(await page.evaluate(() => document.querySelector('#empty status-badge').innerHTML)), '<span class="badge-success">9</span>');
  assert.deepEqual(messages, []);
  await page.close();
  // A slot the host doesn't name holds its fallback or nothing: content there isn't the server's.
  const odd = await open('<status-badge data-zb-filled><span id="mine">hi</span></status-badge>', { modules: ['status-badge'] });
  await odd.page.waitForSelector('status-badge:state(hydrated)');
  assert.equal(clean(await odd.page.evaluate(() => document.querySelector('status-badge').innerHTML)), '<span class="badge-neutral"><span id="mine">hi</span></span>');
  await odd.page.close();
});

// ---- the page's children in order: stand-ins, and the frameworks that remove runs of siblings

// The banner's two slot areas, markers and stand-ins left out; `settle` lets the observer run.
const readBanner = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve));
  const text = (selector) => [...document.querySelector(selector).childNodes]
    .map((node) => (node.nodeType === 1 ? `<${node.localName}>${node.textContent}` : node.nodeType === 3 ? node.data : ''))
    .join('');
  return { body: text('alert-banner .body'), actions: text('alert-banner .actions') };
});
// What each test starts from: a message, then a block of an extra <span> and two buttons for
// the actions slot. `make` builds the block's nodes on `window`.
const make = `
  window.el = (tag, text, slot) => Object.assign(document.createElement(tag), { textContent: text }, slot ? { slot } : {});
  window.block = () => [window.extra = el('span', ' and extra'), window.act = el('button', 'Act', 'actions'), window.skip = el('button', 'Skip', 'actions')];`;

test('a lone text child is written through host.firstChild (Solid)', async () => {
  // Solid updates a lone dynamic text child in place, `parent.firstChild.data = value`. The
  // host's first child was the component's own markup, so the write went there (#268).
  const { page, messages } = await open('<main></main>', {
    modules: ['status-badge'],
    beforeModules: `
      window.badge = document.createElement('status-badge');
      window.badge.textContent = '0';
      document.querySelector('main').append(window.badge);`,
  });
  const read = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    return window.badge.innerHTML.replace(/<!--.*?-->/g, '').replace(/\s+/g, ' ').trim();
  });
  assert.equal(await read(), '<span class="badge-neutral">0</span>');
  await page.evaluate(() => { window.badge.firstChild.data = '1'; });
  assert.equal(await read(), '<span class="badge-neutral">1</span>');
  await page.evaluate(() => { window.badge.firstChild.data = '2'; });
  assert.equal(await read(), '<span class="badge-neutral">2</span>');
  assert.equal(await page.evaluate(() => { window.badge.textContent = ''; return window.badge.firstChild; }), null, 'no children of the page: none');
  assert.deepEqual(messages, []);
  await page.close();
});

test("host.firstChild is the page's first child, whichever slot it is in", async () => {
  const { page, messages } = await open('<alert-banner><button slot="actions" id="a">Act</button><span id="m">msg</span></alert-banner>', { modules: ['alert-banner'] });
  assert.equal(await page.evaluate(() => document.querySelector('alert-banner').firstChild.id), 'a');
  // The loop that empties an element by its first child ends, and leaves the component's own markup.
  const left = await page.evaluate(() => {
    const banner = document.querySelector('alert-banner');
    let turns = 0;
    while (banner.firstChild && turns++ < 10) banner.removeChild(banner.firstChild);
    return [turns, !!banner.querySelector('.body'), banner.querySelectorAll('#a, #m').length];
  });
  assert.deepEqual(left, [2, true, 0]);
  assert.deepEqual(messages, []);
  await page.close();
});

test("an element inserted before one in another slot keeps that place among the page's children", async () => {
  // React and Vue insert before a sibling: insertBefore(node, sibling), where the sibling can be
  // an element that lives in another slot.
  const { page, messages } = await open('<alert-banner><span>one</span><button slot="actions">Act</button><span>three</span></alert-banner>', { modules: ['alert-banner'] });
  await page.evaluate(() => {
    const banner = document.querySelector('alert-banner');
    banner.insertBefore(Object.assign(document.createElement('span'), { textContent: 'two' }), banner.querySelector('button'));
  });
  assert.deepEqual(await readBanner(page), { body: '<span>one<span>two<span>three', actions: '<button>Act' });
  assert.deepEqual(messages, []);
  await page.close();
});

test("a fragment removed from its start anchor to its end anchor takes the elements it has in other slots (Vue's v-if on a <template>)", async () => {
  // Vue removes a fragment by walking nextSibling from its start anchor to its end anchor,
  // removing each through its parentNode. The buttons were in the actions slot, where the walk
  // never came, so they stayed (#269).
  const { page, messages } = await open('<alert-banner><span>msg</span></alert-banner>', { modules: ['alert-banner'], beforeModules: make });
  const add = () => page.evaluate(() => {
    const banner = document.querySelector('alert-banner');
    window.start = document.createTextNode('');
    window.end = document.createTextNode('');
    banner.insertBefore(window.start, null);
    banner.insertBefore(window.end, null);
    for (const node of window.block()) banner.insertBefore(node, window.end);
  });
  const removeRange = () => page.evaluate(() => {
    let node = window.start;
    while (node !== window.end) {
      const next = node.nextSibling;
      node.parentNode.removeChild(node);
      node = next;
    }
    window.end.parentNode.removeChild(window.end);
  });
  await add();
  assert.deepEqual(await readBanner(page), { body: '<span>msg<span> and extra', actions: '<button>Act<button>Skip' });
  await removeRange();
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '' });
  await add();
  await removeRange();
  await add();
  assert.deepEqual(await readBanner(page), { body: '<span>msg<span> and extra', actions: '<button>Act<button>Skip' }, 'and again, with no leftovers');
  assert.equal(await page.evaluate(() => document.querySelector('alert-banner').innerHTML.match(/<!--zb-slot-->/g).length), 2, 'one stand-in for each');
  assert.deepEqual(messages, []);
  await page.close();
});

test("a block removed from its first node to its last, which is in another slot, goes whole and takes nothing else (Svelte's {#if})", async () => {
  // Svelte inserts a block before its anchor and removes it from its first node to its last by
  // nextSibling. The last was moved to the actions slot, so the walk ran on to the end of the
  // parent: it took Svelte's anchor and the slot's closing marker, and left the buttons (#269).
  const { page, messages } = await open('<alert-banner><span>msg</span> <!----></alert-banner>', {
    modules: ['alert-banner'],
    beforeModules: `${make} window.anchor = document.querySelector('alert-banner').lastChild;`,
  });
  const add = () => page.evaluate(() => {
    const fragment = document.createDocumentFragment();
    fragment.append(...window.block());
    window.anchor.before(fragment);
  });
  const removeBlock = () => page.evaluate(() => {
    for (let node = window.extra; node !== null;) {
      const next = node === window.skip ? null : node.nextSibling;
      node.remove();
      node = next;
    }
  });
  await add();
  assert.deepEqual(await readBanner(page), { body: '<span>msg <span> and extra', actions: '<button>Act<button>Skip' });
  await removeBlock();
  assert.deepEqual(await readBanner(page), { body: '<span>msg ', actions: '' });
  assert.equal(await page.evaluate(() => window.anchor.isConnected && window.anchor.parentNode === document.querySelector('alert-banner .body')), true, "Svelte's anchor is back where it was");
  // (`]` from @zubra/runtime, `/slot` in --emit element output.)
  assert.match(await page.evaluate(() => document.querySelector('alert-banner .body').lastChild.data), /^(\]|\/slot)$/, "and so is the slot's closing marker");
  await add();
  assert.deepEqual(await readBanner(page), { body: '<span>msg <span> and extra', actions: '<button>Act<button>Skip' }, 'the block comes back');
  await removeBlock();
  assert.deepEqual(await readBanner(page), { body: '<span>msg ', actions: '' });
  assert.deepEqual(messages, []);
  await page.close();
});

test("a run cleared node by node, skipping those in another slot, goes whole (Solid's <Show>)", async () => {
  // Solid removes a run's nodes one by one, but only those in the parent of the first, and puts
  // an empty text node where the first was. The buttons, in the actions slot, were skipped (#269).
  const { page, messages } = await open('<alert-banner><span>msg</span></alert-banner>', { modules: ['alert-banner'], beforeModules: make });
  await page.evaluate(() => { for (const node of window.block()) document.querySelector('alert-banner').appendChild(node); });
  assert.deepEqual(await readBanner(page), { body: '<span>msg<span> and extra', actions: '<button>Act<button>Skip' });
  const clear = () => page.evaluate(() => {
    const current = [window.extra, window.act, window.skip];
    const parent = current[0].parentNode;
    window.placeholder = document.createTextNode('');
    for (let i = current.length - 1; i >= 0; i--) {
      const isParent = current[i].parentNode === parent;
      if (!i) isParent ? parent.replaceChild(window.placeholder, current[i]) : parent.insertBefore(window.placeholder, null);
      else if (isParent) current[i].remove();
    }
  });
  await clear();
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '' });
  // Back in, where the placeholder is (as Solid's reconcile does), and out again.
  await page.evaluate(() => {
    const parent = window.placeholder.parentNode;
    const after = window.placeholder.nextSibling;
    window.placeholder.remove();
    for (const node of window.block()) parent.insertBefore(node, after);
  });
  assert.deepEqual(await readBanner(page), { body: '<span>msg<span> and extra', actions: '<button>Act<button>Skip' });
  await clear();
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '' });
  assert.deepEqual(messages, []);
  await page.close();
});

test('an element in another slot stays when only its neighbours are removed', async () => {
  // Two conditions around an element that is always there: taking one, or both, leaves it.
  const { page, messages } = await open('<alert-banner><span id="a">A</span><button slot="actions">Always</button><span id="b">B</span></alert-banner>', { modules: ['alert-banner'] });
  await page.evaluate(() => { for (const id of ['a', 'b']) { const node = document.getElementById(id); node.parentNode.removeChild(node); } });
  assert.deepEqual(await readBanner(page), { body: '', actions: '<button>Always' });
  // Replaced by text (el.replaceWith('text')): not a run being cleared.
  await page.evaluate(() => {
    const banner = document.querySelector('alert-banner');
    const first = Object.assign(document.createElement('span'), { id: 'c', textContent: 'C' });
    banner.insertBefore(first, banner.querySelector('button'));
    first.replaceWith('text');
  });
  assert.deepEqual(await readBanner(page), { body: 'text', actions: '<button>Always' });
  assert.deepEqual(messages, []);
  await page.close();
});

test('an element removed from a named slot takes its stand-in, however it is removed', async () => {
  const { page, messages } = await open('<alert-banner><span>msg</span><button slot="actions" id="one">1</button><button slot="actions" id="two">2</button><button slot="actions" id="three">3</button></alert-banner>', { modules: ['alert-banner'] });
  const standIns = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    return (document.querySelector('alert-banner').innerHTML.match(/<!--zb-slot-->/g) ?? []).length;
  });
  assert.equal(await standIns(), 3);
  await page.evaluate(() => document.querySelector('alert-banner').removeChild(document.getElementById('one'))); // React, Angular
  assert.equal(await standIns(), 2);
  await page.evaluate(() => document.getElementById('two').remove()); // through its real parent
  assert.equal(await standIns(), 1);
  await page.evaluate(() => document.getElementById('three').removeAttribute('slot')); // to the default slot, where it was
  assert.equal(await standIns(), 0);
  assert.deepEqual(await readBanner(page), { body: '<span>msg<button>3', actions: '' });
  await page.evaluate(() => { document.getElementById('three').slot = 'actions'; });
  assert.equal(await standIns(), 1);
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '<button>3' });
  await page.evaluate(() => { document.querySelector('alert-banner').textContent = ''; });
  assert.equal(await standIns(), 0);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a hot reload keeps one stand-in for each element in a named slot', { skip: runtimeOnly || (production && 'the production build has no hot reloading') }, async () => {
  const { page, messages } = await open('<alert-banner><span>msg</span><button slot="actions">Act</button></alert-banner>', {
    beforeModules: 'globalThis.__ZUBRA_HOT__ = true;',
    modules: ['alert-banner'],
  });
  const reloaded = await page.evaluate(async () => (await import('/alert-banner.js?again')).default.hotReloaded);
  assert.equal(reloaded, true);
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '<button>Act' });
  assert.equal(await page.evaluate(() => document.querySelector('alert-banner').innerHTML.match(/<!--zb-slot-->/g).length), 1);
  // The stand-in is the default slot's alone: more content for the actions slot leaves it be.
  await page.evaluate(() => document.querySelector('alert-banner').append(Object.assign(document.createElement('button'), { textContent: 'Skip', slot: 'actions' })));
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '<button>Act<button>Skip' });
  await page.evaluate(() => document.querySelectorAll('alert-banner button').forEach((button) => button.remove()));
  assert.deepEqual(await readBanner(page), { body: '<span>msg', actions: '' });
  assert.equal(await page.evaluate(() => document.querySelector('alert-banner').innerHTML.includes('zb-slot')), false);
  assert.deepEqual(messages, []);
  await page.close();
});
