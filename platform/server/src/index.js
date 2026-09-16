/**
 * Server entry point: wire configuration, logging, the database, the domain seam
 * and the HTTP app, then listen. Nothing here contains business logic — this file
 * exists so the pieces can be composed differently in tests.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'

import { loadConfig } from './config.js'
import { createPool, migrate } from './db/migrate.js'
import { createServerQueries } from './db/queries.js'
import { createStore } from './db/store.js'
import { useStore } from './domain/index.js'
import { createApp } from './http/app.js'
import { createIdentityService } from './identity/index.js'
import { createLogger } from './logger.js'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const webDist = resolve(serverDir, '..', 'web', 'dist')

/**
 * Pull the built bundle's <script>/<link> tags out of the web client's
 * index.html, so the server-rendered invite shell can load the same assets. Vite
 * fingerprints filenames on every build, which is why they are read rather than
 * hardcoded.
 */
async function readWebAssetTags() {
  try {
    const html = await readFile(join(webDist, 'index.html'), 'utf8')
    const tags = html.match(/<(?:script|link)[^>]*>(?:<\/script>)?/g) ?? []
    return tags
      .filter((tag) => tag.includes('/assets/') || tag.includes('rel="stylesheet"'))
      .join('\n')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return '' // Web client not built; the API still serves.
  }
}

async function main() {
  const config = loadConfig()
  const logger = createLogger(config)

  const sql = createPool(config)
  await migrate(sql, logger)

  const store = createStore(sql)
  useStore(store)

  const identity = createIdentityService(sql, config, logger)
  const queries = createServerQueries(sql)
  const assetTags = await readWebAssetTags()

  const app = createApp({
    config: {
      ...config,
      webRoot: assetTags ? webDist : null,
      webAssetTags: assetTags,
    },
    logger,
    identity,
    store: queries,
  })

  const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
    logger.info(
      { port: info.port, env: config.NODE_ENV, web: assetTags ? 'bundled' : 'not built' },
      'platform api listening'
    )
  })

  // Finish in-flight requests and close the pool before exiting, so a deploy or a
  // Ctrl-C does not drop a signup mid-transaction.
  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down')
    server.close(async () => {
      await sql.end({ timeout: 5 })
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
