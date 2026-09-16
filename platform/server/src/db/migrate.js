/**
 * Postgres connection and migration runner.
 *
 * Migrations are plain .sql files applied in filename order and recorded in
 * `schema_migrations`, each inside its own transaction. No migration framework:
 * the schema is small, and a readable SQL file is easier to review than a
 * generated one.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import postgres from 'postgres'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function createPool({ DATABASE_URL, isProduction }) {
  return postgres(DATABASE_URL, {
    max: isProduction ? 10 : 4,
    idle_timeout: 30,
    connect_timeout: 10,
    // Documents are stored as jsonb and read back as objects; no extra parsing.
    onnotice: () => {},
  })
}

export async function migrate(sql, logger = console) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((row) => row.name))

  let count = 0
  for (const name of files) {
    if (applied.has(name)) continue
    const statements = await readFile(join(migrationsDir, name), 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(statements)
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`
    })
    logger.info?.({ migration: name }, 'migration applied')
    count += 1
  }
  return { applied: count, total: files.length }
}

/** Entry point for `npm run migrate`. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('../config.js')
  const config = loadConfig()
  const sql = createPool(config)
  try {
    const result = await migrate(sql)
    console.log(`migrations: ${result.applied} applied, ${result.total} total`)
  } finally {
    await sql.end()
  }
}
