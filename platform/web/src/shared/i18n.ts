/**
 * Localization, reusing the mini program's dictionaries.
 *
 * Exposed as a computed pack rather than a function, so templates read `t.join`
 * exactly as the mini program's do, and a language change re-renders. The
 * dictionaries themselves are the same files the WeChat client uses — one place
 * to add a string, one place for a translator to work.
 */

import { computed, ref } from 'vue'

// Side-effect import: installs the browser `wx` shim the dictionary module reads
// as it loads. Must come first.
import './wx-shim'

import i18n from '@shared/i18n'

import { fill, webStrings } from './web-strings'

const current = ref(i18n.init())

/**
 * The active dictionary: the mini program's labels, plus the web-only strings
 * layered on top. Templates read `t.join`, matching the mini program's `data.t`.
 */
export const t = computed<Record<string, string>>(() => {
  const active = current.value
  return { ...i18n.pack(), ...(webStrings[active] ?? webStrings.zh) }
})

/** `tf('seatsLeftN', { n: 3 })` -> "还剩 3 位". */
export function tf(key: string, values: Record<string, string | number>): string {
  return fill(t.value[key] ?? key, values)
}

export const locale = computed(() => current.value)

export const availableLocales = i18n.locales

export function setLocale(next: string): void {
  current.value = i18n.set(next)
}

/**
 * Turn a server error code into text for the active locale. The server sends
 * codes, never sentences, so wording lives here and a third language needs no
 * backend change (DESIGN.md §10.1).
 */
export function errorText(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
  return i18n.errText(code ? { code } : null)
}
