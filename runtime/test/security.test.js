// XSS boundaries: host attributes written by renderToString (Astro and other server
// renderers), and style:property values written by the runtime. `node --test test/security.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRenderer, renderToString } from '../src/server.js';
import { $style } from '../src/parts.js';
import { root, flush } from '../src/effect.js';
import { State } from '../src/signal.js';

const Element = { zubra: { tag: 'zb-audit', slots: [], props: {} } };
registerRenderer('zb-audit', () => '<zb-audit></zb-audit>');

function render(attributes) {
  const errors = [];
  const before = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    return { html: renderToString(Element, { attributes }), errors };
  } finally {
    console.error = before;
  }
}

test('host attributes escape values and keep ordinary ones', () => {
  const { html } = render({ class: 'big "one"', hidden: true, id: null, tabindex: 2 });
  assert.equal(html, '<zb-audit class="big &quot;one&quot;" hidden tabindex="2"></zb-audit>');
});

test('a host attribute name cannot break out of the tag, and a string handler is left off', () => {
  const { html } = render({
    '"><script>alert(1)</script>': 'x',
    onmouseover: 'alert(1)',
    ONCLICK: 'alert(1)',
    innerHTML: '<img src=x onerror=alert(1)>',
    class: 'ok',
  });
  assert.equal(html, '<zb-audit class="ok"></zb-audit>');
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('onmouseover'), false);
  assert.equal(html.includes('onclick'), false);
});

test('unsafe URL host attributes are left off, including ones hidden by a character reference', () => {
  const { html } = render({
    href: 'javascript:alert(1)',
    src: 'data:text/html,<script>alert(1)</script>',
    action: 'vbscript:x',
    formaction: 'javascript&#58;alert(1)',
    srcset: '/a 1x, javascript:alert(1) 2x',
    cite: 'https://example.com/ok',
  });
  assert.equal(html, '<zb-audit cite="https://example.com/ok"></zb-audit>');
  assert.equal(/javascript|vbscript|data:/i.test(html), false);
});

test('a style host attribute escapes </style> and a script', () => {
  const { html } = render({ style: 'color: red; }</style><script>alert(1)</script>' });
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('</style>'), false);
  assert.match(html, /style="color: red; }&lt;\/style&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});

test('style:property refuses a value that is not a single CSS value, and removes one that was safe', () => {
  const styles = new Map();
  const node = {
    style: {
      getPropertyValue: (key) => styles.get(key) ?? '',
      setProperty: (key, value) => styles.set(key, value),
      removeProperty: (key) => styles.delete(key),
    },
  };
  const value = new State('10px');
  const errors = [];
  const before = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const scope = root(() => $style({ style: 'width', value: () => value.get() }, node));
  try {
    assert.equal(styles.get('width'), '10px');
    for (const hostile of ['url(https://evil.test/x)', 'red;background:url(https://evil.test)', '</style><script>alert(1)</script>', 'expression(alert(1))', '@import "x"', 'image-set("https://evil.test/x" 1x)', 'image("https://evil.test/x")']) {
      value.set(hostile);
      flush();
      assert.equal(styles.has('width'), false, hostile);
    }
    assert.ok(errors.length >= 4);
    value.set('2rem');
    flush();
    assert.equal(styles.get('width'), '2rem');
  } finally {
    scope.dispose();
    console.error = before;
  }
});
