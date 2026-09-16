/**
 * Data-access seam. DESIGN.md §4–§6.
 *
 * The domain modules (events, signups, clubs, bills, venues, profile) speak to
 * exactly one storage interface: `db.collection(name)` with `.doc()`, `.where()`,
 * `.orderBy()`, `.limit()`, `.field()`, `.get()`, `.set()`, `.update()`, `.add()`,
 * `.remove()`, plus `db.runTransaction()` and the command helpers on `_`
 * (`inc`, `push`, `in`, `gt`, `or`). That surface is small and deliberately the
 * WeChat Cloud Database API, because this same code runs in two places:
 *
 *   - the WeChat Cloud function, backed by `wx-server-sdk` (the default here);
 *   - the platform HTTP server, backed by a Postgres document store that
 *     implements the identical surface and injects itself through `configure()`.
 *
 * Nothing in the domain modules changes between the two. `configure()` must be
 * called before the first data access when running outside WeChat Cloud; if it
 * is not, the module lazily falls back to `wx-server-sdk` so cloud behaviour is
 * byte-for-byte what it was before this seam existed.
 */

let provider = null

/**
 * Inject a storage provider. Shape:
 *   { db, command }  — where `db` exposes collection()/runTransaction() and
 *   `command` exposes inc/push/in/gt/or. Optionally `cloud` for parity.
 */
function configure(next) {
  provider = next
}

function ensureProvider() {
  if (provider) return provider
  // Lazy default: only require the WeChat SDK when nothing was injected, so the
  // platform server can load these modules without wx-server-sdk present.
  //
  // Initialization ordering matters and is satisfied: index.js calls cloud.init()
  // at module load, before any handler runs, and the first data access happens
  // inside a handler. require() returns the same cached SDK singleton, so
  // cloud.database() here sees the initialized environment — the same state an
  // eager `const db = cloud.database()` at module scope would have produced.
  const cloud = require('wx-server-sdk')
  const database = cloud.database()
  provider = { cloud, db: database, command: database.command }
  return provider
}

const signupId = (eventId, openid) => `${eventId}_${openid}`

/** Cloud DB throws when a doc is missing; callers almost always want null. */
async function getOrNull(collectionName, id) {
  try {
    const r = await ensureProvider().db.collection(collectionName).doc(id).get()
    return r.data
  } catch (e) {
    return null
  }
}

/** Same, but bound to a transaction handle. */
async function txGetOrNull(tx, collectionName, id) {
  try {
    const r = await tx.collection(collectionName).doc(id).get()
    return r.data
  } catch (e) {
    return null
  }
}

// `db` and `_` are exposed as live proxies so existing `const { db, _ } =
// require('./db')` bindings keep working while the underlying provider is chosen
// at (or after) load time. Every property access forwards to the active provider.
const db = new Proxy(
  {},
  {
    get(_target, key) {
      const value = ensureProvider().db[key]
      return typeof value === 'function' ? value.bind(ensureProvider().db) : value
    },
  }
)

const _ = new Proxy(
  {},
  {
    get(_target, key) {
      const command = ensureProvider().command
      const value = command[key]
      return typeof value === 'function' ? value.bind(command) : value
    },
  }
)

module.exports = {
  configure,
  get cloud() {
    return ensureProvider().cloud
  },
  db,
  _,
  signupId,
  getOrNull,
  txGetOrNull,
}
