/**
 * Every label the web templates ask for must exist.
 *
 * The mini program has an equivalent check (`tests/i18n.test.js`) and it earns its
 * keep: a missing key renders as blank space, which is easy to ship and hard to
 * notice. This client draws from two dictionaries — the mini program's, plus the
 * web-only strings layered over it — so it checks both.
 *
 * It also catches a subtler mistake that did ship during the redesign: using a
 * dictionary entry that is a *sentence template* (`"{amount} per share"`) as if it
 * were a label, which puts a literal `{amount}` on screen.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The dictionary module reads and writes the chosen locale through `wx` storage.
import '@/shared/wx-shim'

import { webStrings } from '@/shared/web-strings'
import sharedI18n from '@shared/i18n'

const SOURCE_DIRS = ['src/views', 'src/components']

/** Every `t.someKey` reference in the templates and scripts. */
function referencedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>()

  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8')
      // `t.key`, `t.value.key`, and `tf('key', …)`.
      const patterns = [
        /\bt\.value\.([A-Za-z_][\w]*)/g,
        /\bt\.([A-Za-z_][\w]*)/g,
        /\btf\(\s*'([^']+)'/g,
      ]

      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const key = match[1]
          if (!key || key === 'value') continue
          const files = found.get(key) ?? []
          if (!files.includes(file)) files.push(file)
          found.set(key, files)
        }
      }
    }
  }
  return found
}

const web = webStrings

function lookup(key: string, locale: 'zh' | 'en'): string | undefined {
  const overlay = web[locale]?.[key]
  if (overlay !== undefined) return overlay
  // The shared pack is locale-switched globally; read the active one.
  sharedI18n.set(locale)
  const value = sharedI18n.pack()[key]
  return value
}

describe('web labels', () => {
  const keys = [...referencedKeys().entries()]

  it('finds label references to check', () => {
    // Guards the test itself: a broken regex would silently pass everything.
    expect(keys.length).toBeGreaterThan(40)
  })

  it.each(['zh', 'en'] as const)('resolves every referenced key in %s', (locale) => {
    const missing = keys
      .filter(([key]) => lookup(key, locale) === undefined)
      .map(([key, files]) => `${key} (${files.join(', ')})`)

    expect(missing).toEqual([])
  })

  it('never uses a sentence template as a label', () => {
    // A value like "{amount} per share" is meant for tf(); rendering it as t.x
    // puts a literal placeholder on screen.
    const templateKeys = keys
      .filter(([key]) => {
        const value = lookup(key, 'en')
        return typeof value === 'string' && /\{[a-z_]+\}/i.test(value)
      })
      // tf() calls are the legitimate way to use them.
      .filter(([key]) => {
        const usedWithTf = SOURCE_DIRS.some((dir) =>
          readdirSync(dir).some((file) =>
            readFileSync(join(dir, file), 'utf8').includes(`tf('${key}'`)
          )
        )
        return !usedWithTf
      })
      .map(([key, files]) => `${key} (${files.join(', ')})`)

    expect(templateKeys).toEqual([])
  })

  it('keeps the two locales in step', () => {
    const zhKeys = Object.keys(web.zh ?? {}).sort()
    const enKeys = Object.keys(web.en ?? {}).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('does not duplicate a key the shared dictionary already defines', () => {
    // A web-only string that shadows a shared one is a translation that will drift.
    sharedI18n.set('zh')
    const shared = sharedI18n.pack()
    const shadowed = Object.keys(web.zh ?? {}).filter((key) => shared[key] !== undefined)
    expect(shadowed).toEqual([])
  })
})
