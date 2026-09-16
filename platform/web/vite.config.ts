import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * The mini program's pure modules — the scheduling and money rules, the play
 * format templates, the club naming helpers and the bilingual dictionaries — are
 * CommonJS, because a WeChat mini program has no build step. They are also the
 * authoritative definition of how this application behaves.
 *
 * Rather than write a fourth copy of those rules in TypeScript (there are already
 * two, kept in step by tests/rules.test.js), this plugin loads the existing files
 * as ES modules. They are self-contained: no `wx.*` in the rule modules, and only
 * one internal require, which is rewritten below.
 *
 * A copy would drift. This cannot.
 */
function sharedCommonJs(): Plugin {
  const shared = /miniprogram[\\/]utils[\\/](rules|formats|naming|i18n|format)\.js$/

  return {
    name: 'yueqiu:shared-commonjs',
    enforce: 'pre',
    transform(code, id) {
      if (!shared.test(id)) return null
      // `import` declarations are hoisted, so rewriting require() in place is safe.
      const rewritten = code.replace(
        /const\s+(\w+)\s*=\s*require\(('\.\/[^']+')\)/g,
        'import $1 from $2'
      )
      return {
        code: `const module = { exports: {} };\nconst exports = module.exports;\n${rewritten}\nexport default module.exports;\n`,
        map: null,
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), sharedCommonJs()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The shared rule modules, addressed as @shared/rules etc.
      '@shared': fileURLToPath(new URL('../../miniprogram/utils', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The dev server proxies the API so the browser sees one origin, which
      // keeps cookies, CORS and the invite routes behaving as they do in
      // production.
      '/v1': 'http://127.0.0.1:4174',
      '/health': 'http://127.0.0.1:4174',
    },
  },
  build: {
    // Bundles are fetched over mobile data from a chat link, so keep an eye on size.
    chunkSizeWarningLimit: 300,
    sourcemap: true,
  },
})
