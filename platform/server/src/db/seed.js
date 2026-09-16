/**
 * Development seed data.
 *
 * Built by calling the same actions a client calls, rather than by inserting
 * documents. That way the data is valid by construction — counters, deterministic
 * ids and bucket totals are produced by the rules that maintain them — and this
 * script cannot drift into describing a state the application could never reach.
 *
 * The sessions chosen mirror the mini program's demo data: the awkward states are
 * the ones worth having on screen. A session with a waitlist, one exactly full,
 * one with a single seat left, one closing inside the countdown window, and a
 * finished one with a bill to collect.
 *
 * Refuses to run against a production database.
 *
 *   npm run seed
 */

import { loadConfig } from '../config.js'
import { createPool, migrate } from './migrate.js'
import { COLLECTIONS, createStore } from './store.js'
import { dispatch, useStore } from '../domain/index.js'
import { createIdentityService } from '../identity/index.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Demo players. The first is "you" when developing. */
const PEOPLE = [
  { device: 'seed-device-self-00000001', nickname: '', gender: 'UNSPECIFIED' },
  { device: 'seed-device-lin-000000001', nickname: '林昊', gender: 'MALE' },
  { device: 'seed-device-chen-00000001', nickname: '陈小雨', gender: 'FEMALE' },
  { device: 'seed-device-li-0000000001', nickname: '李想', gender: 'MALE' },
  { device: 'seed-device-zhao-00000001', nickname: '赵敏', gender: 'FEMALE' },
  { device: 'seed-device-sun-000000001', nickname: '孙浩', gender: 'MALE' },
  { device: 'seed-device-liu-000000001', nickname: '刘洋', gender: 'FEMALE' },
  { device: 'seed-device-zhang-0000001', nickname: '张伟', gender: 'MALE' },
]

/**
 * Wall-clock string for a timestamp, in the local zone. Time is stored twice —
 * `start_at` for comparisons, `start_local` for display — so a session at 7pm
 * reads as 7pm regardless of who is looking (DESIGN.md §10.2).
 */
function localOf(timestamp) {
  const date = new Date(timestamp)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

function sessionInput({ title, start, hours = 2, venue, ...rest }) {
  return {
    title,
    venue_snapshot: { name: venue.name, address: venue.address, tz_label: venue.tz_label },
    venue_id: venue.id,
    start_at: start,
    end_at: start + hours * HOUR,
    start_local: localOf(start),
    end_local: localOf(start + hours * HOUR),
    format_template: 'SOCIAL_MIXER',
    roster_mode: 'OPEN',
    max_guests_per_member: 2,
    on_full: 'WAITLIST',
    waitlist_capacity: 4,
    currency: 'SGD',
    cost_estimate_per_person: 800,
    ...rest,
  }
}

async function main() {
  const config = loadConfig()
  if (config.isProduction) {
    throw new Error('refusing to seed a production database')
  }

  const sql = createPool(config)
  const identity = createIdentityService(sql, config, console)
  useStore(createStore(sql))

  try {
    await migrate(sql, console)

    // Start from empty so the script is repeatable.
    await sql.unsafe(`TRUNCATE ${COLLECTIONS.join(', ')} RESTART IDENTITY CASCADE`)
    await sql`TRUNCATE sessions, provider_identities, auth_attempts, accounts CASCADE`

    // Accounts, through the same guest sign-in a browser uses.
    const players = []
    for (const person of PEOPLE) {
      const { accountId } = await identity.exchangeGuestDevice(person.device)
      await dispatch(
        'profile.upsert',
        { nickname: person.nickname, gender: person.gender, locale: 'zh' },
        accountId
      )
      players.push({ ...person, id: accountId })
    }
    const [me, lin, chen, li, zhao, sun, liu, zhang] = players

    // A club you own, with a venue attached.
    const { clubId } = await dispatch(
      'club.create',
      {
        club: {
          name: 'Thursday Smash',
          description: '每周四晚固定打球 · Thursday night regulars',
          join_policy: 'APPROVAL',
          currency: 'SGD',
        },
      },
      me.id
    )

    const { venueId } = await dispatch(
      'venue.create',
      {
        clubId,
        venue: {
          name: 'Sports Hub Hall 3',
          address: '1 Stadium Drive',
          tz_label: 'Asia/Singapore',
          currency: 'SGD',
          membership_required: true,
          max_courts_per_membership: 2,
          guest_policy: 'SURCHARGE',
          guest_surcharge_minor: 500,
          court_labels: ['Court 1', 'Court 2', 'Court 3', 'Court 4'],
        },
      },
      me.id
    )
    const venue = {
      id: venueId,
      name: 'Sports Hub Hall 3',
      address: '1 Stadium Drive',
      tz_label: 'Asia/Singapore',
    }

    // Club members, so club-only sessions have an audience.
    for (const player of [lin, chen, li, zhao]) {
      await dispatch('club.join', { clubId }, player.id)
      await dispatch('club.decide', { clubId, targetOpenid: player.id, approve: true }, me.id)
    }

    const now = Date.now()
    const created = {}

    // 1. Open with room to spare.
    created.open = (
      await dispatch(
        'event.create',
        {
          event: sessionInput({
            title: '周六社交场 · Saturday social',
            start: now + 3 * DAY + 11 * HOUR,
            venue,
            capacity: 12,
            club_id: clubId,
          }),
        },
        me.id
      )
    ).eventId
    for (const player of [lin, chen, li]) {
      await dispatch('event.join', { eventId: created.open, guests: [] }, player.id)
    }

    // 2. Full, with people waiting — the state the waitlist exists for.
    created.waitlisted = (
      await dispatch(
        'event.create',
        {
          event: sessionInput({
            title: '周四常规局 · Thursday regulars',
            start: now + 5 * DAY + 12 * HOUR,
            venue,
            capacity: 4,
            club_id: clubId,
          }),
        },
        me.id
      )
    ).eventId
    for (const player of [lin, chen, li, zhao, sun]) {
      await dispatch('event.join', { eventId: created.waitlisted, guests: [] }, player.id)
    }

    // 3. One seat left, so the invite preview reads "1 seat left".
    created.almostFull = (
      await dispatch(
        'event.create',
        {
          event: sessionInput({
            title: '周日双打 · Sunday doubles',
            start: now + 6 * DAY + 10 * HOUR,
            venue,
            capacity: 4,
            format_template: 'DOUBLES',
          }),
        },
        me.id
      )
    ).eventId
    for (const player of [lin, chen]) {
      await dispatch('event.join', { eventId: created.almostFull, guests: [] }, player.id)
    }

    // 4. Closing soon: inside the countdown window, and one a player runs rather
    //    than you, so the dashboard shows a session you only joined.
    created.closingSoon = (
      await dispatch(
        'event.create',
        {
          event: sessionInput({
            title: '今晚临时局 · Tonight, short notice',
            start: now + 5 * HOUR,
            venue,
            capacity: 8,
          }),
        },
        lin.id
      )
    ).eventId
    for (const player of [me, chen, liu]) {
      await dispatch('event.join', { eventId: created.closingSoon, guests: [] }, player.id)
    }

    // 5. Finished, with a bill to publish — the settlement flow needs a session
    //    in the past, which only a direct write can produce.
    created.finished = (
      await dispatch(
        'event.create',
        {
          event: sessionInput({
            title: '上周四 · Last Thursday',
            start: now + 2 * DAY,
            venue,
            capacity: 6,
            club_id: clubId,
          }),
        },
        me.id
      )
    ).eventId
    for (const player of [lin, chen, li, zhang]) {
      await dispatch('event.join', { eventId: created.finished, guests: [] }, player.id)
    }
    // Move it into the past now that everybody is seated: joining a finished
    // session is (correctly) refused.
    const pastStart = now - 3 * DAY
    await sql`
      UPDATE events
      SET doc = doc || ${sql.json({
        start_at: pastStart,
        end_at: pastStart + 2 * HOUR,
        start_local: localOf(pastStart),
        end_local: localOf(pastStart + 2 * HOUR),
      })}
      WHERE id = ${created.finished}
    `

    console.log('\nSeeded:')
    console.log(`  club     ${clubId}`)
    console.log(`  venue    ${venueId}`)
    for (const [name, id] of Object.entries(created)) {
      console.log(`  ${name.padEnd(12)} /invite/${id}`)
    }
    console.log('\nSign in as the demo organizer with this browser device id:')
    console.log(`  ${PEOPLE[0].device}`)
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
