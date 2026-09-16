import { fileURLToPath, URL } from 'node:url'

import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

/**
 * Tests for the pure presentation helpers. The views themselves are verified by
 * typecheck and build here; there is no browser in this environment to drive them.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.ts'],
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('../../miniprogram/utils', import.meta.url)),
      },
    },
  })
)
