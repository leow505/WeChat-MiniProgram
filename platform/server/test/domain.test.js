/**
 * The shared domain logic, running on Postgres.
 *
 * `tests/rules.test.js` at the repository root already proves the pure rules, and
 * proves both copies of them agree. What is unproven until here is that those
 * rules still hold when the store underneath them is Postgres rather than WeChat
 * Cloud DB — especially seat allocation, which is the one place a race corrupts
 * data rather than merely annoying somebody.
 */

import { describe, expect, it } from 'vitest'

import { dispatch } from '../src/domain/index.js'
import { eventInput } from './helpers.js'

const ORGANIZER = 'u_organizer'

/** create() enrols the organizer, so a fresh session already holds one seat. */
async function createEvent(overrides = {}, actor = ORGANIZER) {
  const { eventId } = await dispatch('event.create', { event: eventInput(overrides) }, actor)
  return eventId
}

const detail = (eventId, actor) => dispatch('event.detail', { eventId }, actor)
const join = (eventId, actor, guests = []) => dispatch('event.join', { eventId, guests }, actor)

describe('signing up', () => {
  it('enrols the organizer on create', async () => {
    const eventId = await createEvent()
    const view = await detail(eventId, ORGANIZER)
    expect(view.roster_count).toBe(1)
    expect(view.my_state).toBe('ROSTER')
  })

  it('seats players until the roster is full, then waitlists', async () => {
    const eventId = await createEvent({ capacity: 3 })
    expect((await join(eventId, 'u_a')).state).toBe('ROSTER')
    expect((await join(eventId, 'u_b')).state).toBe('ROSTER')
    // Capacity 3, organizer holds one: the third joiner overflows.
    expect((await join(eventId, 'u_c')).state).toBe('WAITLIST')

    const view = await detail(eventId, 'u_c')
    expect(view.roster_count).toBe(3)
    expect(view.waitlist_count).toBe(1)
  })

  it('refuses a second signup from the same person', async () => {
    const eventId = await createEvent()
    await join(eventId, 'u_a')
    await expect(join(eventId, 'u_a')).rejects.toMatchObject({ code: 'ALREADY_JOINED' })
  })

  it('seats a party together or not at all', async () => {
    // Capacity 4 with the organizer seated leaves 3; a party of 3 fits exactly.
    const eventId = await createEvent({ capacity: 4, max_guests_per_member: 2 })
    const seated = await join(eventId, 'u_a', [{ name: 'Guest 1' }, { name: 'Guest 2' }])
    expect(seated).toEqual({ state: 'ROSTER', seats: 3 })
    expect((await detail(eventId, 'u_a')).roster_count).toBe(4)
  })

  it('waitlists a whole party that cannot fit the gap', async () => {
    // Two seats left, a party of three: all three wait rather than splitting.
    const eventId = await createEvent({ capacity: 3, max_guests_per_member: 2 })
    const result = await join(eventId, 'u_a', [{ name: 'G1' }, { name: 'G2' }])
    expect(result.state).toBe('WAITLIST')
    expect((await detail(eventId, 'u_a')).roster_count).toBe(1)
  })

  it('refuses more guests than the session allows', async () => {
    const eventId = await createEvent({ max_guests_per_member: 1 })
    await expect(join(eventId, 'u_a', [{ name: 'G1' }, { name: 'G2' }])).rejects.toMatchObject({
      code: 'TOO_MANY_GUESTS',
    })
  })

  it('refuses to seat an undeclared gender in a balanced session', async () => {
    const eventId = await createEvent({
      capacity: 4,
      roster_mode: 'GENDER_BALANCED',
      capacity_by_gender: { male: 2, female: 2 },
      format_template: 'MIXED_DOUBLES',
    })
    await expect(join(eventId, 'u_nogender')).rejects.toMatchObject({
      code: 'GENDER_REQUIRED',
    })
  })
})

describe('withdrawing', () => {
  it('frees the seat and promotes the head of the waitlist', async () => {
    const eventId = await createEvent({ capacity: 2 })
    await join(eventId, 'u_a') // fills the roster
    await join(eventId, 'u_b') // waits

    const result = await dispatch('event.withdraw', { eventId }, 'u_a')
    expect(result.promoted).toHaveLength(1)

    const view = await detail(eventId, 'u_b')
    expect(view.my_state).toBe('ROSTER')
    expect(view.roster_count).toBe(2)
  })

  it('skips a waitlisted party too large for the freed gap', async () => {
    // One seat frees up; a party of two is skipped for the single behind it,
    // because an empty paid seat is worse than an out-of-order promotion.
    const eventId = await createEvent({ capacity: 3, max_guests_per_member: 2 })
    await join(eventId, 'u_a')
    await join(eventId, 'u_b')
    await join(eventId, 'u_pair', [{ name: 'G1' }]) // waits, needs 2 seats
    await join(eventId, 'u_single') // waits, needs 1

    await dispatch('event.withdraw', { eventId }, 'u_a')

    expect((await detail(eventId, 'u_single')).my_state).toBe('ROSTER')
    expect((await detail(eventId, 'u_pair')).my_state).toBe('WAITLIST')
  })

  it('refuses to withdraw somebody who never joined', async () => {
    const eventId = await createEvent()
    await expect(dispatch('event.withdraw', { eventId }, 'u_stranger')).rejects.toMatchObject({
      code: 'NOT_JOINED',
    })
  })
})

describe('concurrency', () => {
  it('never oversells the last seat', async () => {
    // The reason this layer runs on a transactional database at all. Capacity 2
    // with the organizer seated leaves exactly one seat for eight simultaneous
    // requests.
    const eventId = await createEvent({ capacity: 2, on_full: 'CLOSE', waitlist_capacity: 0 })

    const attempts = Array.from({ length: 8 }, (_, i) => join(eventId, `u_race${i}`))
    const results = await Promise.allSettled(attempts)

    const seated = results.filter((r) => r.status === 'fulfilled' && r.value.state === 'ROSTER')
    expect(seated).toHaveLength(1)

    const view = await detail(eventId, ORGANIZER)
    expect(view.roster_count).toBe(2)
    expect(view.roster_count).toBeLessThanOrEqual(view.capacity)
  })

  it('keeps gender buckets consistent under concurrent joins', async () => {
    const eventId = await createEvent({
      capacity: 4,
      roster_mode: 'GENDER_BALANCED',
      capacity_by_gender: { male: 2, female: 2 },
      format_template: 'MIXED_DOUBLES',
      on_full: 'CLOSE',
      waitlist_capacity: 0,
    })
    // The organizer has no declared gender, so no bucket moved on create.
    await Promise.all([
      dispatch('profile.upsert', { nickname: 'F1', gender: 'FEMALE' }, 'u_f1'),
      dispatch('profile.upsert', { nickname: 'F2', gender: 'FEMALE' }, 'u_f2'),
      dispatch('profile.upsert', { nickname: 'F3', gender: 'FEMALE' }, 'u_f3'),
    ])

    const results = await Promise.allSettled([
      join(eventId, 'u_f1'),
      join(eventId, 'u_f2'),
      join(eventId, 'u_f3'),
    ])
    const seated = results.filter((r) => r.status === 'fulfilled').length

    const view = await detail(eventId, ORGANIZER)
    // At most two women can be seated, and the counter must agree with reality.
    expect(view.roster_by_gender.female).toBeLessThanOrEqual(2)
    expect(view.roster_by_gender.female).toBe(seated)
  })

  it('does not double-count a player racing to join twice', async () => {
    const eventId = await createEvent({ capacity: 8 })
    const results = await Promise.allSettled([join(eventId, 'u_twice'), join(eventId, 'u_twice')])
    const succeeded = results.filter((r) => r.status === 'fulfilled').length
    expect(succeeded).toBe(1)
    expect((await detail(eventId, 'u_twice')).roster_count).toBe(2) // organizer + one
  })
})

describe('the organizer', () => {
  it('drains the waitlist when capacity is raised', async () => {
    const eventId = await createEvent({ capacity: 2 })
    await join(eventId, 'u_a') // fills the roster
    await join(eventId, 'u_b') // waits

    // updateRules takes its fields flat on the payload, not nested under a patch.
    const result = await dispatch('event.updateRules', { eventId, capacity: 4 }, ORGANIZER)
    expect(result.promoted.length).toBeGreaterThan(0)

    expect((await detail(eventId, 'u_b')).my_state).toBe('ROSTER')
  })

  it('refuses rule changes from somebody who does not manage the session', async () => {
    const eventId = await createEvent()
    await expect(
      dispatch('event.updateRules', { eventId, capacity: 9 }, 'u_stranger')
    ).rejects.toMatchObject({ code: 'NOT_ADMIN' })
  })

  it('removes a player and promotes from the waitlist', async () => {
    const eventId = await createEvent({ capacity: 2 })
    await join(eventId, 'u_a')
    await join(eventId, 'u_b') // waits

    await dispatch('event.removeSignup', { eventId, targetOpenid: 'u_a' }, ORGANIZER)

    expect((await detail(eventId, 'u_a')).my_state).not.toBe('ROSTER')
    expect((await detail(eventId, 'u_b')).my_state).toBe('ROSTER')
  })

  it('refuses to remove the organizer, who is the one holding the court', async () => {
    const eventId = await createEvent()
    await expect(
      dispatch('event.removeSignup', { eventId, targetOpenid: ORGANIZER }, ORGANIZER)
    ).rejects.toMatchObject({ code: 'CANNOT_REMOVE_ORGANIZER' })
  })

  it('cancels a session', async () => {
    const eventId = await createEvent()
    await dispatch('event.cancel', { eventId }, ORGANIZER)
    expect((await detail(eventId, ORGANIZER)).status).toBe('CANCELLED')
  })
})

describe('reading lists', () => {
  it('returns the caller’s sessions', async () => {
    const eventId = await createEvent()
    await join(eventId, 'u_a')
    const mine = await dispatch('event.mine', {}, 'u_a')
    expect(mine.upcoming.map((e) => e._id)).toContain(eventId)
  })

  it('returns sessions the caller runs, grouped by what needs doing', async () => {
    const eventId = await createEvent()
    const hosting = await dispatch('event.hosting', {}, ORGANIZER)
    expect(hosting.upcoming.map((e) => e._id)).toContain(eventId)
    expect(hosting).toHaveProperty('action_count')
  })

  it('rejects an unknown action', async () => {
    await expect(dispatch('event.nope', {}, ORGANIZER)).rejects.toMatchObject({
      code: 'NO_ACTION',
    })
  })
})

describe('a club page', () => {
  it('is refused to a stranger and to a request still waiting', async () => {
    const { clubId } = await dispatch(
      'club.create',
      { club: { name: 'Members Only', join_policy: 'APPROVAL' } },
      ORGANIZER
    )
    // A pending request is not membership. §3.10
    expect((await dispatch('club.join', { clubId }, 'u_a')).status).toBe('PENDING')
    await expect(dispatch('club.detail', { clubId }, 'u_a')).rejects.toMatchObject({
      code: 'NOT_MEMBER',
    })
    await expect(dispatch('club.detail', { clubId }, 'u_stranger')).rejects.toMatchObject({
      code: 'NOT_MEMBER',
    })

    await dispatch('club.decide', { clubId, targetOpenid: 'u_a', approve: true }, ORGANIZER)
    const view = await dispatch('club.detail', { clubId }, 'u_a')
    expect(view.is_member).toBe(true)
    expect(view.members.map((m) => m.openid)).toContain('u_a')
  })
})

describe('a club that plays on a venue card', () => {
  /** A club whose courts are booked on a member's card, with a venue attached. */
  async function clubOnACard(membership_policy) {
    const { clubId } = await dispatch(
      'club.create',
      { club: { name: 'Card Club', join_policy: 'OPEN', membership_policy } },
      ORGANIZER
    )
    await dispatch(
      'venue.create',
      { clubId, venue: { name: 'Riverside Centre', membership_required: true } },
      ORGANIZER
    )
    return clubId
  }

  it('refuses a join with no card where one is required', async () => {
    const clubId = await clubOnACard('REQUIRED')
    await expect(dispatch('club.join', { clubId }, 'u_a')).rejects.toMatchObject({
      code: 'MEMBERSHIP_REQUIRED',
    })
  })

  it('records the card that arrives with the join, and admits', async () => {
    const clubId = await clubOnACard('REQUIRED')
    const res = await dispatch('club.join', { clubId, membership_name: ' Card Name ' }, 'u_a')
    expect(res.status).toBe('ACTIVE')

    const mine = await dispatch('venue.myMemberships', {}, 'u_a')
    expect(mine.memberships).toHaveLength(1)
    expect(mine.memberships[0].membership_name).toBe('Card Name')
    // Nobody has confirmed it at the door yet.
    expect(mine.memberships[0].verified_at).toBe(null)
  })

  it('shows the card as the name inside the club, and nowhere else', async () => {
    await dispatch('profile.upsert', { nickname: 'Nickname' }, 'u_a')
    const clubId = await clubOnACard('REQUIRED')
    await dispatch('club.join', { clubId, membership_name: 'Card Name' }, 'u_a')

    const view = await dispatch('club.detail', { clubId }, ORGANIZER)
    const member = view.members.find((m) => m.openid === 'u_a')
    expect(member.name).toBe('Card Name')
    expect(member.membership_verified).toBe(false)
    // The name they chose for themselves is untouched by joining.
    expect((await dispatch('profile.get', {}, 'u_a')).nickname).toBe('Nickname')
  })

  it('takes a card a REQUESTED club never insisted on', async () => {
    const clubId = await clubOnACard('REQUESTED')
    expect(
      (await dispatch('club.join', { clubId, membership_name: 'Card Name' }, 'u_a')).status
    ).toBe('ACTIVE')
    expect((await dispatch('venue.myMemberships', {}, 'u_a')).memberships).toHaveLength(1)
  })

  it('ignores one offered to a club that does not ask', async () => {
    const clubId = await clubOnACard('NOT_REQUIRED')
    await dispatch('club.join', { clubId, membership_name: 'Card Name' }, 'u_a')
    expect((await dispatch('venue.myMemberships', {}, 'u_a')).memberships).toHaveLength(0)
  })
})
