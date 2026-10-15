# MemoryRetentionTracer

Tracks which closures retain a given object reference and reports the scope chain path from the entry point to each retainer.

```js
import { MemoryRetentionTracer } from './src/index.js';

const tracer = new MemoryRetentionTracer();

const secret = {};

tracer.registerRoot('main');
tracer.registerScope('fetchHandler', '__root__', 'fetchHandler');
tracer.registerScope('parseBody', 'fetchHandler', 'parseBody', [secret]);

for (const { retainer, path } of tracer.trace(secret)) {
  console.log(retainer, path.join(' > '));
  // parseBody main > fetchHandler > parseBody
}
```

## Why this exists

The problem: you hand an object to a chain of callbacks and later wonder why the garbage collector never collects it. Some closure in that chain is still holding a reference, but which one? There is no standard, dependency-free way to inspect live retention in a JavaScript runtime, so this library makes the pragmatic trade of requiring each closure to register itself explicitly with the object references it captures. You get a deterministic, testable scope tree and a `trace(target)` call that reports every registered scope directly retaining that exact reference, plus the name chain from the root down to each retainer.

The trade-off is manual registration. The library cannot see closures you did not register, so it is a tracing aid for code you control, not a heap profiler for arbitrary code.

## Edge cases you will hit

- Equality is reference equality (`===`). Two objects with identical shape but different identity are not the same target. This is deliberate: the question is about a specific object reference, not structural similarity.
- A scope is a retainer only if it directly captures the target. If scope A captures object X and its child scope B captures the target, B is the retainer and A is merely on the path — A is not reported as a retainer unless A also directly captures the target. The library answers "which closures hold this reference," not "which closures keep something alive that transitively keeps the target alive."
- `registerRoot` must be called exactly once before any `registerScope` call. The root id is `__root__`; pass it as the `parentId` of top-level scopes.
- `trace` returns results sorted by path length then scope id, so output order does not depend on registration order.

## API

- `new MemoryRetentionTracer()` — create a tracer.
- `registerRoot(name, captures?)` — register the entry scope; returns `'__root__'`.
- `registerScope(scopeId, parentId, name, captures?)` — register a child scope; returns `scopeId`.
- `addCapture(scopeId, obj)` — record an additional captured reference on an existing scope.
- `trace(target)` — returns `{ retainer: string, path: string[] }[]` for every scope directly retaining `target`.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

