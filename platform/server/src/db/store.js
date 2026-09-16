/**
 * Postgres-backed document store implementing the WeChat Cloud Database subset
 * the domain modules use. See cloudfunctions/api/lib/db.js for the seam this
 * plugs into, and DESIGN.md §4–§6 for why the surface mirrors Cloud DB.
 *
 * Storage model: one table per collection, `id text primary key` + `doc jsonb`.
 * The document also carries its own `_id` inside the jsonb, mirroring Cloud DB,
 * so reads return exactly the shape the domain code expects.
 *
 * Supported surface — anything outside it throws, so drift is loud rather than
 * silently wrong:
 *
 *   db.collection(name)
 *     .doc(id).get()            -> { data: doc }   (throws when missing; see getOrNull)
 *     .doc(id).set({ data })    -> upsert, replacing the document
 *     .doc(id).update({ data }) -> partial update honouring inc/push and dotted keys
 *     .doc(id).remove()
 *     .where(q)[.orderBy(f,dir)][.limit(n)][.field(proj)].get() -> { data: [...] }
 *     .where(q).count()         -> { total }
 *     .add({ data })            -> { _id }
 *   db.runTransaction(async (tx) => ...)
 *
 * Query operators are pushed down to SQL (equality via jsonb containment, `in`
 * via `= ANY`, `gt` via jsonb comparison, `or` via SQL OR), so a query reads only
 * the rows it matches instead of loading a collection into memory. Ordering and
 * LIMIT are pushed down too; `.field()` projection is applied to the returned
 * rows, which are already bounded by the query.
 *
 * Concurrency. Cloud DB cannot run a query inside a transaction, so the shared
 * domain code picks a waitlist candidate outside the transaction and re-verifies
 * it inside — optimistic by necessity. We keep that code path untouched, but
 * document reads inside a transaction take `SELECT ... FOR UPDATE` row locks,
 * which is strictly stronger: two players taking the last seat serialize on the
 * event row rather than racing. `where()` through the transaction handle stays
 * unsupported on purpose, so the shared code cannot come to depend on something
 * Cloud lacks.
 *
 * Pooled operations issued while a transaction is open join that transaction
 * rather than taking a second connection — see `activeTransaction` below for why
 * that is required rather than merely tidy.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import { isCommand } from './command.js'

/**
 * The transaction in progress on the current async context, if any.
 *
 * This exists because of a genuine difference between the two backends. Inside
 * its join transaction the shared domain code reads a user profile through the
 * ordinary (non-transactional) handle — `signups.js` does
 * `getOrNull('users', openid)` while holding `tx`. On WeChat Cloud DB that is
 * merely a second API call. On a connection pool it is a deadlock: the
 * transaction holds one connection and waits for a second, and once every
 * connection is held by such a transaction nothing can proceed.
 *
 * So a pooled operation joins the active transaction instead of asking the pool
 * for another connection. Two consequences, both improvements: reads see the
 * transaction's own uncommitted writes, and no amount of concurrency can exhaust
 * the pool this way.
 */
const activeTransaction = new AsyncLocalStorage()

/**
 * Collections this store manages. Declared explicitly so a typo'd collection
 * name fails loudly instead of addressing a table that does not exist. Kept in
 * step with migrations/001_init.sql.
 */
export const COLLECTIONS = [
  'users',
  'events',
  'signups',
  'clubs',
  'club_members',
  'venues',
  'venue_memberships',
  'event_bills',
  'bill_shares',
]

/** Cloud DB throws when a document is missing; the seam's getOrNull maps it to null. */
export class DocumentNotFoundError extends Error {
  constructor(collection, id) {
    super(`document not found: ${collection}/${id}`)
    this.name = 'DocumentNotFoundError'
    this.code = 'DOC_NOT_FOUND'
  }
}

function assertCollection(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`unknown collection: ${name}`)
}

function clone(value) {
  if (value === undefined) return undefined
  return structuredClone(value)
}

// ---------------------------------------------------------------------------
// Update patches
// ---------------------------------------------------------------------------

/**
 * Apply an update patch to a document, in memory. Mirrors Cloud DB semantics:
 *   - `_.inc(n)`  adds to the current numeric value
 *   - `_.push(a)` appends to the current array value
 *   - `'a.b'`     addresses a nested field
 *   - anything else replaces the value
 *
 * Read-modify-write rather than a jsonb_set expression because the same patch
 * shapes must behave identically here and in the mini program's mock store, and
 * because every counter update already runs under a row lock.
 */
export function applyPatch(current, patch) {
  const next = clone(current) ?? {}
  for (const [key, raw] of Object.entries(patch)) {
    if (key.includes('.')) setNested(next, key.split('.'), raw)
    else next[key] = resolveUpdateValue(next[key], raw)
  }
  return next
}

function setNested(root, path, raw) {
  let node = root
  for (const segment of path.slice(0, -1)) {
    if (node[segment] == null || typeof node[segment] !== 'object') node[segment] = {}
    node = node[segment]
  }
  const leaf = path.at(-1)
  node[leaf] = resolveUpdateValue(node[leaf], raw)
}

function resolveUpdateValue(currentValue, raw) {
  if (!isCommand(raw)) return clone(raw)
  switch (raw.op) {
    case 'inc':
      return (Number(currentValue) || 0) + raw.value
    case 'push':
      return (Array.isArray(currentValue) ? currentValue : []).concat(clone(raw.value))
    default:
      throw new Error(`unsupported update command: ${raw.op}`)
  }
}

// ---------------------------------------------------------------------------
// Query compilation
// ---------------------------------------------------------------------------

/**
 * Compile a Cloud-style query object into a SQL fragment, or null when the query
 * is empty. `_id` is compiled against the indexed primary-key column; every other
 * field is compiled against the jsonb document.
 */
function compileWhere(sql, query) {
  const conditions = Object.entries(query ?? {}).map(([field, condition]) =>
    compileCondition(sql, field, condition)
  )
  if (!conditions.length) return null
  return conditions.reduce((acc, fragment) => sql`${acc} AND ${fragment}`)
}

function compileCondition(sql, field, condition) {
  if (isCommand(condition)) {
    switch (condition.op) {
      case 'in': {
        // An empty list matches nothing, which `= ANY('{}')` would also do, but
        // spelling it out avoids depending on empty-array parameter handling.
        if (!condition.value.length) return sql`false`
        if (field === '_id') return sql`id = ANY(${sql.array(condition.value.map(String))})`
        return sql`${accessor(sql, field)} = ANY(${jsonbArray(sql, condition.value)})`
      }
      case 'gt':
        // jsonb comparison, which orders numbers numerically (not lexically).
        return sql`${accessor(sql, field)} > ${sql.json(condition.value)}`
      case 'or': {
        if (!condition.value.length) return sql`false`
        const alternatives = condition.value.map((clause) => compileCondition(sql, field, clause))
        return sql`(${alternatives.reduce((acc, fragment) => sql`${acc} OR ${fragment}`)})`
      }
      default:
        throw new Error(`unsupported query command: ${condition.op}`)
    }
  }

  if (field === '_id') return sql`id = ${String(condition)}`
  if (field.includes('.')) {
    return sql`doc #> ${sql.array(field.split('.'))} = ${sql.json(condition)}`
  }
  // Scalars use jsonb containment, which is exactly equality for a scalar and can
  // use the GIN index. Arrays and objects must not: `@>` is *subset* containment,
  // so `{tags:['a','b']} @> {tags:['a']}` is true. The domain only ever compares
  // scalars today, and this branch keeps that from becoming a silent mismatch if
  // that changes.
  if (condition !== null && typeof condition === 'object') {
    return sql`doc -> ${field} = ${sql.json(condition)}`
  }
  return sql`doc @> ${sql.json({ [field]: condition })}`
}

function accessor(sql, field) {
  if (field.includes('.')) return sql`doc #> ${sql.array(field.split('.'))}`
  return sql`doc -> ${field}`
}

function jsonbArray(sql, values) {
  return sql`${sql.array(values.map((value) => JSON.stringify(value)))}::jsonb[]`
}

/** Keep only projected fields (Cloud `.field({a:true})`); `_id` always rides along. */
function project(doc, projection) {
  if (!projection) return doc
  const out = {}
  if (doc._id !== undefined) out._id = doc._id
  for (const [key, keep] of Object.entries(projection)) {
    if (keep && doc[key] !== undefined) out[key] = doc[key]
  }
  return out
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

class Query {
  #sql
  #collection
  #where = null
  #orderBy = null
  #limit = null
  #projection = null

  /** @param {() => import('postgres').Sql} sql resolved at use time, so a query
   *  issued while a transaction is open runs on that transaction. */
  constructor(sql, collection) {
    this.#sql = sql
    this.#collection = collection
  }

  where(query) {
    this.#where = query
    return this
  }

  orderBy(field, direction = 'asc') {
    const normalized = String(direction).toLowerCase() === 'desc' ? 'desc' : 'asc'
    this.#orderBy = { field, direction: normalized }
    return this
  }

  limit(n) {
    this.#limit = n
    return this
  }

  field(projection) {
    this.#projection = projection
    return this
  }

  async get() {
    const sql = this.#sql()
    const condition = compileWhere(sql, this.#where)
    const whereClause = condition ? sql`WHERE ${condition}` : sql``
    const orderClause = this.#orderBy
      ? this.#orderBy.direction === 'desc'
        ? sql`ORDER BY ${accessor(sql, this.#orderBy.field)} DESC`
        : sql`ORDER BY ${accessor(sql, this.#orderBy.field)} ASC`
      : sql``
    const limitClause = this.#limit == null ? sql`` : sql`LIMIT ${this.#limit}`

    const rows = await sql`
      SELECT doc FROM ${sql(this.#collection)} ${whereClause} ${orderClause} ${limitClause}
    `
    const data = rows.map((row) => project(row.doc, this.#projection))
    return { data }
  }

  async count() {
    const sql = this.#sql()
    const condition = compileWhere(sql, this.#where)
    const whereClause = condition ? sql`WHERE ${condition}` : sql``
    const rows = await sql`
      SELECT count(*)::int AS total FROM ${sql(this.#collection)} ${whereClause}
    `
    return { total: rows[0].total }
  }
}

class DocumentRef {
  #sql
  #collection
  #id
  #lockOnRead

  /** @param {() => import('postgres').Sql} sql resolved at use time. */
  constructor(sql, collection, id, lockOnRead) {
    this.#sql = sql
    this.#collection = collection
    this.#id = id
    this.#lockOnRead = lockOnRead
  }

  async #read() {
    const sql = this.#sql()
    const lock = this.#lockOnRead ? sql`FOR UPDATE` : sql``
    const rows = await sql`
      SELECT doc FROM ${sql(this.#collection)} WHERE id = ${this.#id} ${lock}
    `
    return rows.length ? rows[0].doc : null
  }

  async get() {
    const doc = await this.#read()
    if (!doc) throw new DocumentNotFoundError(this.#collection, this.#id)
    return { data: doc }
  }

  async set({ data }) {
    const sql = this.#sql()
    const doc = clone(data)
    doc._id ??= this.#id
    await sql`
      INSERT INTO ${sql(this.#collection)} (id, doc) VALUES (${this.#id}, ${sql.json(doc)})
      ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()
    `
    return { _id: this.#id }
  }

  async update({ data }) {
    const sql = this.#sql()
    const current = await this.#read()
    if (!current) throw new DocumentNotFoundError(this.#collection, this.#id)
    const next = applyPatch(current, data)
    await sql`
      UPDATE ${sql(this.#collection)}
      SET doc = ${sql.json(next)}, updated_at = now()
      WHERE id = ${this.#id}
    `
    return { updated: 1 }
  }

  async remove() {
    const sql = this.#sql()
    const rows = await sql`
      DELETE FROM ${sql(this.#collection)} WHERE id = ${this.#id} RETURNING id
    `
    return { deleted: rows.length }
  }
}

class Collection {
  #sql
  #name
  #inTransaction

  /** @param {() => import('postgres').Sql} sql resolved at use time. */
  constructor(sql, name, inTransaction = false) {
    assertCollection(name)
    this.#sql = sql
    this.#name = name
    this.#inTransaction = inTransaction
  }

  doc(id) {
    if (id === undefined || id === null || id === '') {
      throw new Error(`${this.#name}.doc() requires an id`)
    }
    return new DocumentRef(this.#sql, this.#name, String(id), this.#inTransaction)
  }

  #query() {
    if (this.#inTransaction) {
      throw new Error('queries are not supported inside a transaction (WeChat Cloud DB parity)')
    }
    return new Query(this.#sql, this.#name)
  }

  where(query) {
    return this.#query().where(query)
  }

  orderBy(field, direction) {
    return this.#query().orderBy(field, direction)
  }

  limit(n) {
    return this.#query().limit(n)
  }

  field(projection) {
    return this.#query().field(projection)
  }

  async count() {
    return this.#query().count()
  }

  async get() {
    return this.#query().get()
  }

  async add({ data }) {
    const sql = this.#sql()
    const doc = clone(data)
    const id = doc._id || `d_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    doc._id = id
    await sql`
      INSERT INTO ${sql(this.#name)} (id, doc) VALUES (${id}, ${sql.json(doc)})
    `
    return { _id: id }
  }
}

/**
 * Build the `db` object injected into the domain seam.
 *
 * `pool` is a `postgres` client. Every statement is a tagged template, so values
 * are bound as parameters and table names go through `sql(identifier)`, which
 * quotes them — no SQL text is assembled from strings.
 */
export function createStore(pool) {
  // Pooled handles resolve their executor at use time: if a transaction is open on
  // this async context they join it, rather than taking a second connection.
  const pooled = () => activeTransaction.getStore() ?? pool

  const transactionHandle = (tx) => ({
    collection(name) {
      // Reads through this handle take row locks; queries are refused.
      return new Collection(() => tx, name, true)
    },
  })

  return {
    collection(name) {
      return new Collection(pooled, name)
    },

    /**
     * Run `work` inside a Postgres transaction. Document reads through the handed
     * out `tx` take `FOR UPDATE` row locks, so concurrent seat changes on one
     * session serialise instead of racing.
     *
     * A nested call becomes a savepoint, so an inner failure does not abort the
     * outer transaction.
     */
    async runTransaction(work) {
      const current = activeTransaction.getStore()
      if (current) {
        return current.savepoint((sp) =>
          activeTransaction.run(sp, () => work(transactionHandle(sp)))
        )
      }
      return pool.begin((tx) => activeTransaction.run(tx, () => work(transactionHandle(tx))))
    },
  }
}
