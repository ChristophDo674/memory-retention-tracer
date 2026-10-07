import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRetentionTracer } from '../src/index.js';

test('registerRoot returns a root id and sets the entry scope', () => {
  const t = new MemoryRetentionTracer();
  const id = t.registerRoot('entry', []);
  assert.equal(id, '__root__');
  const results = t.trace({});
  assert.deepEqual(results, []);
});

test('root that captures the target is reported as a single-element path', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  t.registerRoot('entry', [target]);
  const results = t.trace(target);
  assert.equal(results.length, 1);
  assert.equal(results[0].retainer, '__root__');
  assert.deepEqual(results[0].path, ['entry']);
});

test('a child scope retaining the target yields the full chain', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  t.registerRoot('main');
  t.registerScope('fn1', '__root__', 'fn1');
  t.registerScope('fn2', 'fn1', 'fn2', [target]);
  const results = t.trace(target);
  assert.equal(results.length, 1);
  assert.equal(results[0].retainer, 'fn2');
  assert.deepEqual(results[0].path, ['main', 'fn1', 'fn2']);
});

test('multiple retainers are each reported with their own path', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  t.registerRoot('root');
  t.registerScope('a', '__root__', 'a', [target]);
  t.registerScope('b', '__root__', 'b', [target]);
  t.registerScope('a1', 'a', 'a1', [target]);
  const results = t.trace(target);
  assert.equal(results.length, 3);
  // Sorted by path length then scope id: root-not-a-retainer here.
  // Paths: a -> ['root','a'] (len 2), b -> ['root','b'] (len 2), a1 -> ['root','a','a1'] (len 3)
  assert.deepEqual(results[0].path, ['root', 'a']);
  assert.deepEqual(results[1].path, ['root', 'b']);
  assert.deepEqual(results[2].path, ['root', 'a', 'a1']);
});

test('a parent on the path that does NOT directly capture the target is not a retainer', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  const other = {};
  t.registerRoot('root');
  // 'middle' captures `other`, not the target, so it is on the path but not a retainer.
  t.registerScope('middle', '__root__', 'middle', [other]);
  t.registerScope('leaf', 'middle', 'leaf', [target]);
  const results = t.trace(target);
  assert.equal(results.length, 1);
  assert.equal(results[0].retainer, 'leaf');
  assert.deepEqual(results[0].path, ['root', 'middle', 'leaf']);
});

test('reference equality: structurally identical but distinct objects are not the same', () => {
  const t = new MemoryRetentionTracer();
  const a = { x: 1 };
  const b = { x: 1 };
  t.registerRoot('root', [a]);
  const results = t.trace(b);
  assert.deepEqual(results, []);
});

test('addCapture augments an already-registered scope', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  t.registerRoot('root');
  t.registerScope('s', '__root__', 's');
  // Nothing captured yet.
  assert.deepEqual(t.trace(target), []);
  t.addCapture('s', target);
  const results = t.trace(target);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].path, ['root', 's']);
});

test('addCapture on an unknown scope throws', () => {
  const t = new MemoryRetentionTracer();
  t.registerRoot('root');
  assert.throws(() => t.addCapture('nope', {}), /not registered/);
});

test('registerScope before registerRoot throws', () => {
  const t = new MemoryRetentionTracer();
  assert.throws(() => t.registerScope('s', '__root__', 's'), /registerRoot/);
});

test('registerRoot called twice throws', () => {
  const t = new MemoryRetentionTracer();
  t.registerRoot('root');
  assert.throws(() => t.registerRoot('again'), /already been called/);
});

test('registerScope with unknown parent throws', () => {
  const t = new MemoryRetentionTracer();
  t.registerRoot('root');
  assert.throws(() => t.registerScope('s', 'ghost', 's'), /not registered/);
});

test('registerScope with a duplicate scopeId throws', () => {
  const t = new MemoryRetentionTracer();
  t.registerRoot('root');
  t.registerScope('s', '__root__', 's');
  assert.throws(() => t.registerScope('s', '__root__', 's2'), /already registered/);
});

test('trace without a root throws', () => {
  const t = new MemoryRetentionTracer();
  assert.throws(() => t.trace({}), /no root scope/);
});

test('trace rejects non-object targets', () => {
  const t = new MemoryRetentionTracer();
  t.registerRoot('root');
  assert.throws(() => t.trace(null), /non-null object/);
  assert.throws(() => t.trace('string'), /non-null object/);
  assert.throws(() => t.trace(42), /non-null object/);
});

test('registerRoot validates its arguments', () => {
  const t = new MemoryRetentionTracer();
  assert.throws(() => t.registerRoot(''), /non-empty string/);
  assert.throws(() => t.registerRoot(123), /non-empty string/);
  assert.throws(() => t.registerRoot('ok', 'not-array'), /captures must be an array/);
});

test('registerScope validates its arguments', () => {
  const t = new MemoryRetentionTracer();
  t.registerRoot('root');
  assert.throws(() => t.registerScope('', '__root__', 's'), /non-empty string/);
  assert.throws(() => t.registerScope('s', '', 's'), /non-empty string/);
  assert.throws(() => t.registerScope('s', '__root__', ''), /non-empty string/);
  assert.throws(() => t.registerScope('s', '__root__', 's', 'nope'), /captures must be an array/);
});

test('a scope capturing the target twice is reported once', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  t.registerRoot('root');
  t.registerScope('s', '__root__', 's', [target, target, target]);
  const results = t.trace(target);
  assert.equal(results.length, 1);
});

test('deeply nested single retainer produces a long path', () => {
  const t = new MemoryRetentionTracer();
  const target = {};
  t.registerRoot('r');
  t.registerScope('a', '__root__', 'a');
  t.registerScope('b', 'a', 'b');
  t.registerScope('c', 'b', 'c');
  t.registerScope('d', 'c', 'd', [target]);
  const results = t.trace(target);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].path, ['r', 'a', 'b', 'c', 'd']);
});
