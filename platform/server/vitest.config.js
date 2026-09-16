import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The domain modules hold one injected store, and every suite shares one test
    // database, so suites must not run concurrently against each other.
    fileParallelism: false,
    setupFiles: ['./test/helpers.js'],
    include: ['test/**/*.test.js'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
