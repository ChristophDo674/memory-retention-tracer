/**
 * MemoryRetentionTracer tracks which registered closures retain a given target
 * object reference, and reports the scope chain path from the entry point to
 * each retainer.
 *
 * Design decisions, stated plainly so the reader (and the tests) know exactly
 * what is and is not supported:
 *
 * 1. Closures are registered explicitly via `registerScope`. We do NOT walk
 *    live heap snapshots — JavaScript engines expose nothing standard for that,
 *    and WeakRef + FinalizationRegistry cannot inspect retention. So each
 *    closure that might retain the target must call `registerScope` with its
 *    parent id, a name, and the object references it closes over. This keeps
 *    the library dependency-free and deterministic.
 *
 * 2. The scope chain path is returned as an array of names from the entry
 *    scope down to the retaining scope, inclusive of both ends. If only the
 *    root retains the target, the path is a single-element array containing
 *    the root's name.
 *
 * 3. Equality is reference equality (`===`). Two structurally identical but
 *    distinct objects are NOT considered the same reference. This is the only
 *    sound notion given that the whole point is to trace a *specific* object.
 *
 * 4. A scope is a retainer if any object in its own captured set is the target
 *    reference. We intentionally do NOT transitively follow objects: if scope A
 *    captures object X, and scope B (a child of A) captures the target, B is a
 *    retainer and A is on the path but is NOT itself a retainer unless A also
 *    directly captures the target. This matches the question "which closures
 *    retain THIS object" rather than "which closures keep something alive that
 *    keeps the target alive".
 */
export class MemoryRetentionTracer {
  constructor() {
    // Map of scopeId -> { name, parentId, captures: Set<object> }.
    // A Map is used rather than a plain object so scope ids may be any
    // string without colliding with inherited properties like __proto__.
    this._scopes = new Map();
    this._rootId = null;
  }

  /**
   * Register the entry-point scope. Must be called exactly once before any
   * other scope is registered. Returns the root scope id so callers can pass
   * it to `registerScope` as parentId, though passing null also works because
   * the root is its own logical parent.
   *
   * @param {string} name - Human-readable name for the entry scope.
   * @param {object[]} [captures=[]] - Object references the entry scope closes over.
   * @returns {string} The root scope id.
   */
  registerRoot(name, captures = []) {
    if (this._rootId !== null) {
      throw new Error('registerRoot has already been called; root may only be set once');
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('root name must be a non-empty string');
    }
    if (!Array.isArray(captures)) {
      throw new TypeError('captures must be an array');
    }
    const id = '__root__';
    this._scopes.set(id, {
      name,
      parentId: null,
      captures: new Set(captures),
    });
    this._rootId = id;
    return id;
  }

  /**
   * Register a closure scope under a parent scope.
   *
   * Why explicit ids rather than auto-incrementing counters: the caller is
   * the one that knows the lexical structure of the code, and deterministic
   * ids make test assertions stable without depending on registration order.
   *
   * @param {string} scopeId - Unique id for this scope.
   * @param {string} parentId - Id of the parent scope, or the root id.
   * @param {string} name - Human-readable name shown in path output.
   * @param {object[]} [captures=[]] - Object references this scope closes over.
   * @returns {string} The scope id, for chaining.
   */
  registerScope(scopeId, parentId, name, captures = []) {
    if (this._rootId === null) {
      throw new Error('call registerRoot before registerScope');
    }
    if (typeof scopeId !== 'string' || scopeId.length === 0) {
      throw new TypeError('scopeId must be a non-empty string');
    }
    if (scopeId === this._rootId) {
      throw new Error('scopeId must not equal the root id');
    }
    if (typeof parentId !== 'string' || parentId.length === 0) {
      throw new TypeError('parentId must be a non-empty string');
    }
    if (!this._scopes.has(parentId)) {
      throw new Error(`parent scope "${parentId}" is not registered`);
    }
    if (this._scopes.has(scopeId)) {
      throw new Error(`scope "${scopeId}" is already registered`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('name must be a non-empty string');
    }
    if (!Array.isArray(captures)) {
      throw new TypeError('captures must be an array');
    }
    this._scopes.set(scopeId, {
      name,
      parentId,
      captures: new Set(captures),
    });
    return scopeId;
  }

  /**
   * Add a captured object reference to an already-registered scope. Useful when
   * a closure captures references incrementally (e.g. via a shared array that
   * is mutated after registration) without needing to re-register the scope.
   *
   * @param {string} scopeId - Id of the scope to augment.
   * @param {object} obj - The object reference to record as captured.
   */
  addCapture(scopeId, obj) {
    const scope = this._scopes.get(scopeId);
    if (scope === undefined) {
      throw new Error(`scope "${scopeId}" is not registered`);
    }
    // We store the reference itself, never a copy. The whole point is identity.
    scope.captures.add(obj);
  }

  /**
   * Find every registered scope that directly retains `target` (by reference
   * equality) and return, for each, the chain of scope names from the root
   * down to that retainer.
   *
   * Why a Set is used for deduplication of retainers: a single scope captures
   * the target at most once conceptually, and we report the scope once.
   *
   * @param {object} target - The object reference to search for.
   * @returns {{retainer: string, path: string[]}[]} Array of result objects.
   *   `retainer` is the scope id; `path` is names from root to retainer.
   */
  trace(target) {
    if (this._rootId === null) {
      throw new Error('no root scope has been registered');
    }
    if (target === null || typeof target !== 'object') {
      throw new TypeError('target must be a non-null object');
    }

    const retainers = [];
    for (const [scopeId, scope] of this._scopes) {
      if (scope.captures.has(target)) {
        retainers.push({ retainer: scopeId, path: this._pathToRoot(scopeId) });
      }
    }
    // Sort by path length then lexicographically by scope id so output is
    // deterministic regardless of Map insertion order. Map iteration order is
    // well-defined (insertion order) but we avoid relying on the caller's
    // registration sequence to keep tests and downstream usage stable.
    retainers.sort((a, b) => {
      if (a.path.length !== b.path.length) {
        return a.path.length - b.path.length;
      }
      return a.retainer < b.retainer ? -1 : a.retainer > b.retainer ? 1 : 0;
    });
    return retainers;
  }

  /**
   * Build the list of scope names from the root down to the given scope,
   * inclusive of both ends.
   *
   * @param {string} scopeId
   * @returns {string[]}
   */
  _pathToRoot(scopeId) {
    const names = [];
    let current = scopeId;
    // Guard against any pathological cycle. We construct the tree ourselves
    // and never set parentId to a descendant, but a defensive check costs
    // nothing and prevents an infinite loop if the structure is ever
    // corrupted by future changes.
    const seen = new Set();
    while (current !== null) {
      if (seen.has(current)) {
        throw new Error(`cycle detected in scope chain at "${current}"`);
      }
      seen.add(current);
      const scope = this._scopes.get(current);
      if (scope === undefined) {
        // Should be unreachable given how scopes are registered, but we
        // fail loudly rather than silently produce a partial path.
        throw new Error(`missing scope "${current}" while building path`);
      }
      names.unshift(scope.name);
      current = scope.parentId;
    }
    return names;
  }
}
