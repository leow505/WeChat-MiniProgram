import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

/**
 * Lint rules for the platform workspace.
 *
 * The mini program and cloud function are excluded: they are ES5-era CommonJS by
 * necessity (no build step, and a cloud function packages only its own directory),
 * and linting them under these rules would produce noise rather than findings.
 */
export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // Vue single-file components: the SFC parser handles the template, and hands
    // `<script setup lang="ts">` to the TypeScript parser.
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
  },
  {
    files: ['**/*.{js,mjs,ts,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Unused arguments are often deliberate in handler signatures; require a
      // leading underscore to say so.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'vue/multi-word-component-names': 'off',
      // Formatting is Prettier's job, not the linter's.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
    },
  },
  {
    // Tests may assert on things that look unused.
    files: ['**/test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Server code is Node, and its `createApp` is Hono's, not Vue's — the Vue
    // plugin's one-component-per-file rule misreads it.
    files: ['server/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'vue/one-component-per-file': 'off' },
  },
]
