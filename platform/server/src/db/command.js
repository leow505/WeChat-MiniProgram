/**
 * Command sentinels — the platform equivalent of WeChat Cloud's `db.command`.
 *
 * The domain modules build queries and update patches with values like
 * `_.inc(1)`, `_.in([...])`, `_.gt(now)`, `_.push([...])`, `_.or(a, b)`. Cloud DB
 * interprets these server-side. Our document store interprets them in
 * `store.js`. Representing each as a tagged object keeps interpretation explicit
 * and keeps a literal `{ __cmd: ... }` from ever being mistaken for user data.
 */

const CMD = Symbol('yueqiu.command')

function make(op, value) {
  return { [CMD]: true, op, value }
}

/** True when `v` is one of our command sentinels. */
export function isCommand(v) {
  return v != null && typeof v === 'object' && v[CMD] === true
}

export const command = {
  // Update operators
  inc: (n) => make('inc', n),
  push: (items) => make('push', Array.isArray(items) ? items : [items]),
  // Query operators
  in: (list) => make('in', list),
  gt: (v) => make('gt', v),
  or: (...clauses) => make('or', clauses.flat()),
}

export { CMD }
