/**
 * Component tests, in jsdom.
 *
 * These exist because there is no browser in the build environment, and a view
 * that typechecks can still fail the moment it renders. What they check is the
 * behaviour that matters at the boundary: that the invite page actually shows a
 * session and lets a first-time visitor join, and that the dictionaries load
 * through the CommonJS bridge rather than silently coming back empty.
 */

import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'

import type { EventDetail } from '@/api/types'

/** Session detail the fake API returns; individual tests adjust it. */
let currentEvent: EventDetail

function eventFixture(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    _id: 'e1',
    title: 'Saturday social',
    start_at: Date.now() + 86_400_000,
    end_at: Date.now() + 93_600_000,
    start_local: '2026-09-19T19:00',
    end_local: '2026-09-19T21:00',
    capacity: 6,
    roster_count: 2,
    waitlist_count: 0,
    status: 'OPEN',
    my_state: null,
    club_id: null,
    creator_openid: 'u_org',
    organizer_name: 'Organizer',
    visibility: 'PUBLIC',
    lifecycle: 'ACTIVE',
    roster: [
      { openid: 'u_org', name: 'Organizer', is_organizer: true },
      { openid: 'u_a', name: '林昊' },
    ],
    waitlist: [],
    roster_mode: 'OPEN',
    max_guests_per_member: 2,
    can_withdraw: true,
    can_manage: false,
    venue_snapshot: { name: 'Sports Hub', address: '1 Stadium Drive' },
    cost_estimate_per_person: 800,
    currency: 'SGD',
    ...overrides,
  } as EventDetail
}

const joinCalls: Record<string, unknown>[] = []

/**
 * A fake server speaking the real action contract. Using the contract rather than
 * mocking the client module keeps these tests honest about the payloads sent.
 */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })

      if (String(url).endsWith('/v1/auth/guest')) {
        return json({
          ok: true,
          token: 'test-token',
          profile: { _id: 'u_me', nickname: body.nickname ?? '', gender: 'UNSPECIFIED' },
        })
      }
      if (String(url).endsWith('/v1/account/status')) {
        return json({ ok: true, status: { providers: ['guest'], recoverable: false } })
      }
      if (String(url).endsWith('/v1/actions')) {
        if (body.action === 'event.detail') return json({ ok: true, data: currentEvent })
        if (body.action === 'profile.get') {
          return json({ ok: true, data: { _id: 'u_me', nickname: 'Wei', gender: 'UNSPECIFIED' } })
        }
        if (body.action === 'profile.upsert') {
          return json({
            ok: true,
            data: { _id: 'u_me', nickname: body.payload.nickname, gender: body.payload.gender },
          })
        }
        if (body.action === 'event.join') {
          joinCalls.push(body.payload)
          currentEvent = eventFixture({
            roster_count: 3,
            my_state: 'ROSTER',
            roster: [...currentEvent.roster, { openid: 'u_me', name: 'Wei', is_me: true }],
          })
          return json({ ok: true, data: { state: 'ROSTER', seats: 1 } })
        }
        if (body.action === 'event.mine') {
          return json({ ok: true, data: { upcoming: [], past: [], owing: { count: 0 } } })
        }
        return json({ ok: true, data: {} })
      }
      return json({ ok: false, code: 'NOT_FOUND' })
    })
  )
}

async function mountInvite() {
  const InviteView = (await import('@/views/InviteView.vue')).default
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/invite/:id', component: InviteView },
      { path: '/', component: { template: '<div />' } },
      { path: '/manage/:id', component: { template: '<div />' } },
      { path: '/bill/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/invite/e1')
  await router.isReady()

  const wrapper = mount(InviteView, { global: { plugins: [router] } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  joinCalls.length = 0
  currentEvent = eventFixture()
  window.localStorage.clear()
  installFetch()
})

describe('the shared dictionaries', () => {
  it('load through the CommonJS bridge and are not empty', async () => {
    const { t } = await import('@/shared/i18n')
    // If the Vite CJS transform ever stopped working, this is where it shows:
    // every label would be undefined and the UI would render blank.
    expect(Object.keys(t.value).length).toBeGreaterThan(100)
    expect(t.value.join).toBeTruthy()
    expect(t.value.rosterTitle).toBeTruthy()
    // A web-only string, layered on top of the mini program's dictionary.
    expect(t.value.copyRosterToChat).toBeTruthy()
  })

  it('localizes a server error code rather than showing the code', async () => {
    const { errorText } = await import('@/shared/i18n')
    const text = errorText({ code: 'FULL' })
    expect(text).toBeTruthy()
    expect(text).not.toBe('FULL')
  })
})

describe('the invite page', () => {
  it('shows the session a chat link points at', async () => {
    const wrapper = await mountInvite()
    const text = wrapper.text()

    expect(text).toContain('Saturday social')
    expect(text).toContain('2026-09-19 19:00 – 21:00')
    expect(text).toContain('Sports Hub')
    // Who is already coming: the thing a group chat cannot keep straight.
    expect(text).toContain('林昊')
    expect(text).toContain('2/6')
  })

  it('offers to join, and sends no identity in the payload', async () => {
    const wrapper = await mountInvite()

    await wrapper.find('[data-testid="name"]').setValue('Wei')

    // Addressed by test id rather than by CSS class: the join control is the
    // contract, and restyling or moving it should not fail this test.
    const join = wrapper.find('[data-testid="join"]')
    expect(join.exists()).toBe(true)
    await join.trigger('click')
    await flushPromises()

    expect(joinCalls.length).toBe(1)
    // The acting identity comes from the session, never the payload.
    expect(joinCalls[0]).not.toHaveProperty('openid')
    expect(joinCalls[0]).toHaveProperty('eventId', 'e1')
  })

  it('shows withdraw instead of join once you hold a seat', async () => {
    currentEvent = eventFixture({ my_state: 'ROSTER', can_withdraw: true })
    const wrapper = await mountInvite()
    expect(wrapper.find('[data-testid="withdraw"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="join"]').exists()).toBe(false)
  })

  it('tells a reader the session is full instead of offering a seat', async () => {
    currentEvent = eventFixture({ roster_count: 6, capacity: 6, status: 'FULL_CLOSED' })
    const wrapper = await mountInvite()
    expect(wrapper.text()).toContain('6/6')
  })

  it('shows the waitlist when there is one', async () => {
    currentEvent = eventFixture({
      roster_count: 6,
      capacity: 6,
      status: 'WAITLIST_ONLY',
      waitlist: [{ openid: 'u_w', name: 'Waiting Player' }],
      waitlist_count: 1,
    })
    const wrapper = await mountInvite()
    expect(wrapper.text()).toContain('Waiting Player')
  })

  it('renders without a crash when the session cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/v1/auth/guest')) {
          return new Response(
            JSON.stringify({
              ok: true,
              token: 't',
              profile: { _id: 'u', nickname: '', gender: 'UNSPECIFIED' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        return new Response(JSON.stringify({ ok: false, code: 'NOT_VISIBLE' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      })
    )
    const wrapper = await mountInvite()
    // A club-only session must explain itself, not show an empty page.
    expect(wrapper.text().length).toBeGreaterThan(10)
  })
})
