import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignField, refusedField } from '../src/fields.js';

test('a refused field is not assigned, so __proto__ cannot set a prototype', () => {
  const doc = {};
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'key', '$clocks']) {
    assert.equal(refusedField(name), true, name);
    assert.equal(assignField(doc, name, { admin: true }), false, name);
  }
  assert.equal(doc.admin, undefined);
  assert.equal(Object.prototype.admin, undefined);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.equal(assignField(doc, 'title', 'mine'), true);
  assert.equal(doc.title, 'mine');
  assert.equal(refusedField('proto'), false);
  assert.equal(refusedField('owner'), false);
});
