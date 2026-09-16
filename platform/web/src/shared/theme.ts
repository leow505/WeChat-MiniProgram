/**
 * Colour scheme preference.
 *
 * The OS setting is the default, because that is what most people expect. But it
 * is only a default: someone reading a roster in bright sun wants light even at
 * 9pm, and a phone permanently in dark mode is not a statement about this app. So
 * the choice is explicit and remembered, with "system" as one of the three states.
 *
 * The resolved scheme is written to `data-theme` on <html>, which the stylesheet
 * uses to override the `prefers-color-scheme` default. `theme-color` is kept in
 * step so the browser chrome matches on mobile.
 */

import { computed, ref, watchEffect } from 'vue'

export type ThemeChoice = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'group_play_theme'

/** Matches the --bg token of each scheme, for the mobile browser chrome. */
const CHROME_COLOR: Record<'light' | 'dark', string> = {
  light: '#f2f4f6',
  dark: '#0a0e11',
}

function stored(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Private mode; fall through to the system default.
  }
  return 'system'
}

const choice = ref<ThemeChoice>(stored())

const systemPrefersDark = ref(
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
)

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  // The OS setting can change while the page is open — on a schedule, usually.
  query.addEventListener('change', (event) => {
    systemPrefersDark.value = event.matches
  })
}

/** What is actually on screen, once "system" is resolved. */
export const resolvedTheme = computed<'light' | 'dark'>(() => {
  if (choice.value === 'system') return systemPrefersDark.value ? 'dark' : 'light'
  return choice.value
})

export const themeChoice = computed(() => choice.value)

export const themeChoices: ThemeChoice[] = ['system', 'light', 'dark']

export function setTheme(next: ThemeChoice): void {
  choice.value = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // The choice simply will not outlive the tab.
  }
}

/** Apply the resolved scheme to the document. Called once from main.ts. */
export function installTheme(): void {
  watchEffect(() => {
    const root = document.documentElement
    // "system" leaves the attribute off, so the media query in the stylesheet
    // stays in charge rather than being shadowed by an explicit value.
    if (choice.value === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice.value)

    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      document.head.appendChild(meta)
    }
    meta.setAttribute('content', CHROME_COLOR[resolvedTheme.value])
  })
}
