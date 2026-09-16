/**
 * Colour contrast.
 *
 * The palette is readable or it is not, and that is measurable, so it is measured
 * here rather than eyeballed. Every foreground/background pair the design actually
 * puts together must clear WCAG AA — 4.5:1 for body and small text, 3:1 for large
 * text and for non-text boundaries like a progress fill.
 *
 * Five pairs failed when this was first written, including hint text at 3.0:1 and
 * white on the original green at 3.8:1. The token values are read from the
 * stylesheet, so drifting a colour without checking it fails here.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const css = readFileSync('src/styles/app.css', 'utf8')

/**
 * Read a token from a specific block. The light palette is declared in `:root`
 * and repeated under `[data-theme='light']`; dark lives in the media query and
 * under `[data-theme='dark']`.
 */
function tokens(blockPattern: RegExp): Record<string, string> {
  const block = css.match(blockPattern)
  if (!block) throw new Error(`token block not found: ${blockPattern}`)
  const found: Record<string, string> = {}
  for (const match of block[0].matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    found[match[1]!] = match[2]!.trim()
  }
  return found
}

const light = tokens(/:root\s*\{[^}]*--bg:[^}]*\}/)
const dark = tokens(/:root\[data-theme='dark'\]\s*\{[^}]*\}/)

function channels(color: string): [number, number, number] {
  const clean = color.replace('#', '').trim()
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number]
}

/**
 * Resolve a token to opaque channels, compositing over `backdrop` when the token
 * is translucent. The dark palette states its washes as `rgb(r g b / a%)` over the
 * surface beneath, so skipping those would skip the pairs most likely to be thin.
 */
function resolve(color: string, backdrop: string): [number, number, number] {
  const translucent = color.match(/rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)/)
  if (!translucent) return channels(color)

  const alpha = Number(translucent[4]) / 100
  const front = [1, 2, 3].map((i) => Number(translucent[i]) / 255) as [number, number, number]
  const back = channels(backdrop)
  return front.map((value, index) => value * alpha + back[index]! * (1 - alpha)) as [
    number,
    number,
    number,
  ]
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Contrast ratio. `backdrop` is what sits behind the pair, used only to composite
 * a translucent colour.
 */
export function contrast(foreground: string, background: string, backdrop = '#ffffff'): number {
  const resolvedBackground = resolve(background, backdrop)
  const a = luminance(resolve(foreground, background.startsWith('#') ? background : backdrop))
  const b = luminance(resolvedBackground)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/** Pairs the design actually renders together, per scheme. */
function pairs(scheme: Record<string, string>) {
  return [
    ['body text on a card', scheme['--text'], scheme['--surface'], 4.5],
    ['secondary text on a card', scheme['--text-2'], scheme['--surface'], 4.5],
    // Hints, meter notes, section counts and field labels all use --text-3 at
    // 12–13.5px, so they need the small-text ratio, not the large-text one.
    ['tertiary text on a card', scheme['--text-3'], scheme['--surface'], 4.5],
    ['tertiary text on an input', scheme['--text-3'], scheme['--surface-2'], 4.5],
    ['tertiary text on a quiet pill', scheme['--text-3'], scheme['--surface-3'], 4.5],
    ['secondary text on a quiet pill', scheme['--text-2'], scheme['--surface-3'], 4.5],
    // The filled primary button.
    ['button label on accent', scheme['--accent-contrast'], scheme['--accent'], 4.5],
    ['soft button label on accent wash', scheme['--accent-strong'], scheme['--accent-soft'], 4.5],
  ] as const
}

describe.each([
  ['light', light],
  ['dark', dark],
])('%s scheme', (_name, scheme) => {
  it('defines the tokens under test', () => {
    // Guards the parser: a renamed token would otherwise silently skip checks.
    for (const key of ['--text', '--text-2', '--text-3', '--surface', '--accent']) {
      expect(scheme[key], key).toBeTruthy()
    }
  })

  it.each(pairs(scheme))('%s clears WCAG AA', (_label, foreground, background, minimum) => {
    // A translucent wash is composited over the card it sits on.
    const ratio = contrast(foreground, background, scheme['--surface'])
    expect(ratio).toBeGreaterThanOrEqual(minimum)
  })
})

describe('the two schemes', () => {
  it('define the same token names', () => {
    // A token present in one scheme and missing in the other renders as an
    // inherited value, which is how a dark-mode-only contrast bug ships.
    const lightKeys = Object.keys(light).sort()
    const darkKeys = Object.keys(dark).sort()
    expect(darkKeys).toEqual(lightKeys)
  })
})
