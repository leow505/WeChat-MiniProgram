/**
 * The HTTP surface.
 *
 * Exercised through `app.request()` rather than a listening socket: same code
 * path, no port to collide with. What matters here is the boundary — that the
 * acting identity comes from the session and never from the payload, that
 * unknown actions are refused, and that the invite page tells a group chat what
 * it needs without leaking what it should not.
 */

import { describe, expect, it } from 'vitest'

import { inviteDescription, escapeHtml } from '../src/http/invite-page.js'
import { createApp } from '../src/http/app.js'
import { eventInput, identity, queries, silentLogger, store, testConfig } from './helpers.js'

const app = createApp({
  config: { ...testConfig, webRoot: null, webAssetTags: '' },
  logger: silentLogger,
  identity,
  store: queries,
})

const post = (path, body, token) =>
  app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })

const DEVICE = 'browser-device-key-000001'

async function signInAsGuest(nickname = 'Wei', device = DEVICE) {
  const response = await post('/v1/auth/guest', { device_id: device, nickname })
  const body = await response.json()
  return body.token
}

describe('operational endpoints', () => {
  it('reports liveness', async () => {
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('reports readiness including the database', async () => {
    const response = await app.request('/ready')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, database: 'up' })
  })

  it('sets security headers', async () => {
    const response = await app.request('/health')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('authentication', () => {
  it('signs in a guest and stores the nickname through the profile action', async () => {
    const response = await post('/v1/auth/guest', { device_id: DEVICE, nickname: 'Wei' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.token).toBeTruthy()
    expect(body.profile.nickname).toBe('Wei')
  })

  it('rejects a malformed guest request', async () => {
    const response = await post('/v1/auth/guest', { device_id: 'too-short' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, code: 'BAD_REQUEST' })
  })

  it('refuses an action without a session', async () => {
    const response = await post('/v1/actions', { action: 'profile.get' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ ok: false, code: 'NO_IDENTITY' })
  })

  it('refuses an action with a forged session', async () => {
    const response = await post('/v1/actions', { action: 'profile.get' }, 'forged-token')
    expect(response.status).toBe(401)
  })

  it('signs out, and the session stops working', async () => {
    const token = await signInAsGuest()
    expect((await post('/v1/actions', { action: 'profile.get' }, token)).status).toBe(200)

    const signout = await post('/v1/auth/signout', {}, token)
    expect(await signout.json()).toEqual({ ok: true, revoked: 1 })

    expect((await post('/v1/actions', { action: 'profile.get' }, token)).status).toBe(401)
  })

  it('reports AUTH_NOT_CONFIGURED for WeChat when no credentials are set', async () => {
    const response = await post('/v1/auth/wechat', { code: 'abc' })
    expect(response.status).toBe(501)
    expect(await response.json()).toEqual({ ok: false, code: 'AUTH_NOT_CONFIGURED' })
  })
})

describe('the action endpoint', () => {
  it('runs a known action for the session holder', async () => {
    const token = await signInAsGuest()
    const response = await post('/v1/actions', { action: 'profile.get' }, token)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.data.nickname).toBe('Wei')
  })

  it('refuses an action that is not on the list', async () => {
    const token = await signInAsGuest()
    const response = await post('/v1/actions', { action: 'events.dropDatabase' }, token)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, code: 'NO_ACTION' })
  })

  it('requires an action name', async () => {
    const token = await signInAsGuest()
    const response = await post('/v1/actions', { payload: {} }, token)
    expect(response.status).toBe(400)
  })

  it('ignores an actor id supplied in the payload', async () => {
    // The whole identity model rests on this: the caller cannot act as somebody
    // else by naming them.
    const token = await signInAsGuest('Wei')
    const response = await post(
      '/v1/actions',
      {
        action: 'profile.upsert',
        payload: { nickname: 'Wei', openid: 'u_victim', _id: 'u_victim' },
      },
      token
    )
    const body = await response.json()
    expect(body.data._id).not.toBe('u_victim')
  })

  it('returns a business failure as a code, not a 500', async () => {
    const token = await signInAsGuest()
    const response = await post(
      '/v1/actions',
      { action: 'event.detail', payload: { eventId: 'no-such-event' } },
      token
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('carries a full signup flow over HTTP', async () => {
    const organizer = await signInAsGuest('Organizer', 'device-organizer-00001')
    const created = await post(
      '/v1/actions',
      { action: 'event.create', payload: { event: eventInput({ capacity: 2 }) } },
      organizer
    )
    const { eventId } = (await created.json()).data

    const player = await signInAsGuest('Player', 'device-player-000001')

    // Before joining, the session shows no involvement.
    const before = await post(
      '/v1/actions',
      { action: 'event.detail', payload: { eventId } },
      player
    )
    expect((await before.json()).data.my_state).toBeNull()

    const joined = await post(
      '/v1/actions',
      { action: 'event.join', payload: { eventId, guests: [] } },
      player
    )
    expect((await joined.json()).data.state).toBe('ROSTER')

    const view = await post('/v1/actions', { action: 'event.detail', payload: { eventId } }, player)
    const detail = (await view.json()).data
    expect(detail.roster_count).toBe(2)
    // The player's own profile name reaches the roster the organizer reads.
    expect(detail.roster.concat(detail.waitlist).some((p) => p.name === 'Player')).toBe(true)

    await post('/v1/actions', { action: 'event.withdraw', payload: { eventId } }, player)
    const after = await post(
      '/v1/actions',
      { action: 'event.detail', payload: { eventId } },
      player
    )
    expect((await after.json()).data.my_state).toBeNull()
  })

  it('does not expose development-only actions', async () => {
    const token = await signInAsGuest()
    const response = await post('/v1/actions', { action: 'dev.reset' }, token)
    expect(response.status).toBe(404)
  })
})

describe('account management', () => {
  it('reports account status', async () => {
    const token = await signInAsGuest()
    const response = await post('/v1/account/status', {}, token)
    expect((await response.json()).status).toEqual({ providers: ['guest'], recoverable: false })
  })

  it('issues a recovery code and reports the account as recoverable', async () => {
    const token = await signInAsGuest()
    const response = await post('/v1/account/recovery-code', {}, token)
    const body = await response.json()
    expect(body.code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/)
    expect(body.status.recoverable).toBe(true)
  })

  it('restores an account onto a second browser over HTTP', async () => {
    const first = await signInAsGuest('Wei', DEVICE)
    const { code } = await (await post('/v1/account/recovery-code', {}, first)).json()

    const restored = await post('/v1/auth/recovery', {
      code,
      device_id: 'browser-device-key-000002',
    })
    const body = await restored.json()
    expect(body.ok).toBe(true)
    expect(body.profile.nickname).toBe('Wei')
  })

  it('requires a session to manage the account', async () => {
    expect((await post('/v1/account/recovery-code', {})).status).toBe(401)
    expect((await post('/v1/account/status', {})).status).toBe(401)
  })

  it('revokes every session on request', async () => {
    const token = await signInAsGuest()
    const second = await signInAsGuest()
    const response = await post('/v1/account/revoke-sessions', {}, token)
    expect((await response.json()).revoked).toBe(2)
    expect((await post('/v1/actions', { action: 'profile.get' }, second)).status).toBe(401)
  })
})

describe('the invite page', () => {
  async function publicEvent(overrides = {}) {
    const token = await signInAsGuest('Organizer', 'device-organizer-00001')
    const created = await post(
      '/v1/actions',
      { action: 'event.create', payload: { event: eventInput(overrides) } },
      token
    )
    return (await created.json()).data.eventId
  }

  it('renders the session in link-preview tags', async () => {
    // WhatsApp, LINE and Telegram build previews from meta tags and do not run
    // JavaScript, so this has to be server-rendered or the link looks like junk.
    const eventId = await publicEvent({ capacity: 4 })
    const html = await (await app.request(`/invite/${eventId}`)).text()

    expect(html).toContain('<meta property="og:title"')
    expect(html).toContain('Saturday social')
    expect(html).toContain('Sports Hub')
    expect(html).toContain('2026-09-19 19:00')
    expect(html).toMatch(/3 seats left/)
    expect(html).toContain(`/invite/${eventId}`)
  })

  it('says the session is full when it is', async () => {
    const eventId = await publicEvent({ capacity: 1 })
    const html = await (await app.request(`/invite/${eventId}`)).text()
    expect(html).toMatch(/Full/)
  })

  it('reveals nothing about a session that does not exist', async () => {
    const html = await (await app.request('/invite/no-such-event')).text()
    expect(html).toContain('Badminton group play')
    expect(html).not.toContain('Saturday social')
  })

  it('reveals nothing about a club-only session', async () => {
    // Anyone can fetch this URL, so a members-only session must not describe
    // itself to them.
    const eventId = await publicEvent()
    await store
      .collection('events')
      .doc(eventId)
      .update({ data: { visibility: 'CLUB_ONLY' } })

    const html = await (await app.request(`/invite/${eventId}`)).text()
    expect(html).not.toContain('Saturday social')
    expect(html).not.toContain('Sports Hub')
  })

  it('reveals nothing about a cancelled session', async () => {
    const eventId = await publicEvent()
    await store
      .collection('events')
      .doc(eventId)
      .update({ data: { lifecycle: 'CANCELLED' } })
    const html = await (await app.request(`/invite/${eventId}`)).text()
    expect(html).not.toContain('Saturday social')
  })

  it('never places the venue address in a preview', async () => {
    const eventId = await publicEvent()
    const html = await (await app.request(`/invite/${eventId}`)).text()
    expect(html).not.toContain('1 Stadium Drive')
  })

  it('escapes organizer-supplied text', async () => {
    const eventId = await publicEvent({ title: '<script>alert(1)</script>&"x' })
    const html = await (await app.request(`/invite/${eventId}`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('invite page helpers', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('treats null and undefined as empty', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  it('describes when, where and how many seats remain', () => {
    const description = inviteDescription({
      start_local: '2026-09-19T19:00',
      venue_snapshot: { name: 'Sports Hub' },
      capacity: 12,
      roster_count: 8,
      lifecycle: 'ACTIVE',
    })
    expect(description).toBe('2026-09-19 19:00 · Sports Hub · 还剩 4 位 / 4 seats left · 8/12')
  })

  it('uses the singular for one remaining seat', () => {
    const description = inviteDescription({
      start_local: '2026-09-19T19:00',
      capacity: 4,
      roster_count: 3,
      lifecycle: 'ACTIVE',
    })
    expect(description).toContain('1 seat left')
    expect(description).not.toContain('1 seats left')
  })

  it('says cancelled rather than counting seats', () => {
    const description = inviteDescription({
      start_local: '2026-09-19T19:00',
      capacity: 4,
      roster_count: 0,
      lifecycle: 'CANCELLED',
    })
    expect(description).toContain('Cancelled')
  })
})

describe('unknown routes', () => {
  it('returns a code for an unknown API path', async () => {
    const response = await app.request('/v1/nope', { method: 'POST' })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('404s a missing bundle rather than serving the page in its place', async () => {
    // With a web build present, an unknown /assets path must not fall through to
    // index.html: a 200 with text/html makes the browser reject the module on MIME
    // type, which looks like a blank page instead of a missing file.
    const withWeb = createApp({
      config: { ...testConfig, webRoot: '/nonexistent-dist', webAssetTags: '<script></script>' },
      logger: silentLogger,
      identity,
      store: queries,
    })
    const response = await withWeb.request('/assets/index-deadbeef.js')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
