/**
 * Test harness.
 *
 * Tests run against a real PostgreSQL database, not a fake. The whole point of
 * this layer is that seat allocation is transactional and a document store built
 * on jsonb behaves like the one the domain code was written against — neither
 * claim can be tested against a substitute.
 *
 * Set DATABASE_URL to a database you are willing to have truncated. Defaults to
 * the docker-compose instance with a `_test` suffix.
 */

import { afterAll, beforeEach } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createPool, migrate } from '../src/db/migrate.js'
import { createServerQueries } from '../src/db/queries.js'
import { COLLECTIONS, createStore } from '../src/db/store.js'
import { useStore } from '../src/domain/index.js'
import { createIdentityService } from '../src/identity/index.js'

const DEFAULT_URL = 'postgres://yueqiu:yueqiu@127.0.0.1:5432/yueqiu_test'

const IDENTITY_TABLES = ['sessions', 'provider_identities', 'auth_attempts', 'accounts']

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_URL,
  SESSION_SECRET: 'test-secret',
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: '*',
  PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:4174',
  ALLOW_DEV_AUTH: 'false',
})

/** A logger that satisfies the interface and says nothing. */
export const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
}

export const sql = createPool(testConfig)
export const store = createStore(sql)
export const queries = createServerQueries(sql)
export const identity = createIdentityService(sql, testConfig, silentLogger)

// The domain modules are singletons holding one injected store, which is correct
// for a server process and means every suite here shares this database.
useStore(store)

let migrated = false

export async function resetDatabase() {
  if (!migrated) {
    await migrate(sql, silentLogger)
    migrated = true
  }
  await sql.unsafe(
    `TRUNCATE ${[...COLLECTIONS, ...IDENTITY_TABLES].join(', ')} RESTART IDENTITY CASCADE`
  )
}

beforeEach(resetDatabase)

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A week out, so join and withdraw deadlines are both open. */
export const futureStart = () => Date.now() + 7 * 24 * 60 * 60 * 1000

/**
 * A valid event payload. Overrides are shallow-merged, which is enough for the
 * fields tests vary (capacity, waitlist, gender mode).
 */
export function eventInput(overrides = {}) {
  const start = overrides.start_at ?? futureStart()
  return {
    title: 'Saturday social',
    venue_snapshot: { name: 'Sports Hub', address: '1 Stadium Drive' },
    start_at: start,
    end_at: start + 2 * 60 * 60 * 1000,
    start_local: '2026-09-19T19:00',
    end_local: '2026-09-19T21:00',
    format_template: 'SOCIAL_MIXER',
    capacity: 4,
    roster_mode: 'OPEN',
    max_guests_per_member: 2,
    on_full: 'WAITLIST',
    waitlist_capacity: 4,
    currency: 'SGD',
    ...overrides,
  }
}
