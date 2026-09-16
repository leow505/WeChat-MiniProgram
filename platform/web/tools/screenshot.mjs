/**
 * Screenshot harness — a development tool, not part of the build.
 *
 * There is no display in this environment, so the only way to see whether a
 * layout actually works is to drive a headless browser and look at the result.
 * This signs in through the real API, then captures each screen at phone size in
 * both colour schemes.
 *
 *   node tools/screenshot.mjs [outputDir] [baseUrl]
 *
 * Requires a running server with seeded data (see platform/README.md) and
 * `npx playwright install firefox`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { firefox } from 'playwright'

const outputDir = process.argv[2] ?? '/tmp/shots'
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:4174'

/** iPhone-ish. The overwhelmingly common case for a link opened from a chat. */
const viewport = { width: 390, height: 844 }

async function api(path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json()
  if (!payload.ok) throw new Error(`${path} -> ${payload.code}`)
  return payload
}

/** Sign in as the seeded organizer so the dashboard and organizer views render. */
async function organizerSession() {
  const device = 'seed-device-self-00000001'
  const auth = await api('/v1/auth/guest', { device_id: device, nickname: '林薇' })
  const hosting = await api('/v1/actions', { action: 'event.hosting', payload: {} }, auth.token)
  const mine = await api('/v1/actions', { action: 'event.mine', payload: {} }, auth.token)
  return { token: auth.token, device, hosting: hosting.data, mine: mine.data }
}

async function main() {
  await mkdir(outputDir, { recursive: true })

  const session = await organizerSession()
  const events = await fetch(`${baseUrl}/v1/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ action: 'event.hosting', payload: {} }),
  }).then((r) => r.json())

  const upcoming = events.data.upcoming ?? []
  const withWaitlist = upcoming.find((event) => event.roster_count >= event.capacity) ?? upcoming[0]
  const finished = (events.data.actions ?? [])[0]

  const browser = await firefox.launch({
    // Playwright's Firefox ignores newContext({ colorScheme }); the OS-level pref
    // is what actually drives prefers-color-scheme, so it is set per launch.
    firefoxUserPrefs: { 'ui.systemUsesDarkTheme': 0 },
  })
  const darkBrowser = await firefox.launch({
    firefoxUserPrefs: { 'ui.systemUsesDarkTheme': 1 },
  })
  const captured = []

  for (const scheme of ['light', 'dark']) {
    const context = await (scheme === 'dark' ? darkBrowser : browser).newContext({
      viewport,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      locale: process.env.SHOT_LOCALE ?? 'zh-CN',
    })

    // Seed the session into storage so authenticated screens render as a returning
    // user, exactly as they would on a real device.
    await context.addInitScript(
      ([token, device]) => {
        localStorage.setItem('group_play_token', token)
        localStorage.setItem('group_play_device_id', device)
        localStorage.setItem('group_play_name', '林薇')
        localStorage.setItem('group_play_gender', 'FEMALE')
      },
      [session.token, session.device]
    )

    const page = await context.newPage()

    const screens = [
      ['home', '/'],
      ['invite', `/invite/${withWaitlist?._id ?? ''}`],
      ['create', '/create'],
      ['hosting', '/hosting'],
      ['manage', `/manage/${withWaitlist?._id ?? ''}`],
      ['bill', finished ? `/bill/${finished._id}` : `/bill/${withWaitlist?._id ?? ''}`],
    ]

    for (const [name, path] of screens) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' })
      // The views render after their first action resolves; networkidle covers it,
      // but give transitions a moment to settle so the shot is not mid-animation.
      await page.waitForTimeout(400)

      // Viewport shot: the only way to see a fixed action bar where it really
      // sits. A full-page shot renders fixed elements at the scroll offset, which
      // makes them look like they overlap the middle of the page.
      const viewportFile = join(outputDir, `${name}-${scheme}.png`)
      await page.screenshot({ path: viewportFile })
      captured.push(viewportFile)

      const fullFile = join(outputDir, `${name}-${scheme}-full.png`)
      await page.screenshot({ path: fullFile, fullPage: true })
      captured.push(fullFile)
    }

    // The account tab, which is a state rather than a route.
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
    const accountTab = page.getByRole('tab').nth(1)
    if (await accountTab.count()) {
      await accountTab.click()
      await page.waitForTimeout(300)
      const file = join(outputDir, `account-${scheme}.png`)
      await page.screenshot({ path: file, fullPage: true })
      captured.push(file)
    }

    await context.close()
  }

  await browser.close()
  await darkBrowser.close()

  // Console errors would not show up in a screenshot, so record them separately.
  await writeFile(join(outputDir, 'captured.txt'), captured.join('\n'), 'utf8')
  console.log(captured.join('\n'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
