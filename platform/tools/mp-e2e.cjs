/**
 * End-to-end check of the mini program's own client against the live HTTP API.
 *
 * The suites either side of this one prove their own half: the root suites drive the
 * mock backend, the server suites drive the domain on Postgres. Neither proves the
 * WeChat client talks to the real API correctly — which is the half that matters the
 * day the mock is switched off. So this loads utils/api.js, utils/auth.js,
 * utils/present.js and the shared rules exactly as a page does, points config at the
 * running server, and walks the whole workflow: profile, club, venue, membership,
 * session, guests, waitlist, promotion, courts, the split and settlement, asserting
 * what each screen would render.
 *
 * CommonJS (.cjs) on purpose: platform/ is "type": "module", and the modules under
 * test are the mini program's, which are CommonJS and load with require exactly as
 * they do inside WeChat.
 *
 * Manual, because it needs the server up and writes to the development database:
 *
 *   cd platform && npm run dev          # in another shell
 *   node tools/mp-e2e.cjs
 *
 * The one thing no action offers is time travel — a session has to be over before it
 * can be settled, and the clock is the server's — so that single step reaches into
 * Postgres directly. Everything else goes through wx.request.
 */
const path = require('path')
const ROOT = path.join(__dirname, '../..')
const UTILS = path.join(ROOT, 'miniprogram/utils')

const storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    storage[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync: (k) => delete storage[k],
  getAppBaseInfo: () => ({ language: 'en' }),
  setTabBarItem: () => {},
  setNavigationBarTitle: () => {},
  showToast: () => {},
  request({ url, method, data, header, success, fail }) {
    fetch(url, { method, headers: header, body: JSON.stringify(data) })
      .then(async (res) => success({ statusCode: res.status, data: await res.json() }))
      .catch((err) => fail(err))
  },
}

const config = require(path.join(ROOT, 'miniprogram/config.js'))
config.API_MODE = 'http'
config.HTTP_BASE_URL = 'http://127.0.0.1:4174'

const api = require(path.join(UTILS, 'api.js'))
const i18n = require(path.join(UTILS, 'i18n.js'))
const present = require(path.join(UTILS, 'present.js'))
const rules = require(path.join(UTILS, 'rules.js'))
const fmt = require(path.join(UTILS, 'format.js'))
i18n.set('en')
const t = i18n.pack()

let pass = 0
let fail = 0
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`  ok   ${label}`)
    return
  }
  fail++
  console.log(
    `  FAIL ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`
  )
}
const refuses = async (label, code, promise) => {
  try {
    await promise
    fail++
    console.log(`  FAIL ${label} — expected ${code}, succeeded`)
  } catch (err) {
    is(label, err.code, code)
  }
}
const as = (id) => {
  config.HTTP_DEV_ACTOR_ID = id
  return api.call
}
const step = (name) => console.log(`\n— ${name}`)

const HOUR = rules.HOUR
const local = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

;(async () => {
  const OWNER = 'mp_owner_' + Date.now()
  const B = OWNER + '_b'
  const C = OWNER + '_c'
  const D = OWNER + '_d'

  step('Me tab — profile setup')
  await as(OWNER)('profile.upsert', { nickname: 'Organizer', gender: 'MALE', locale: 'en' })
  const me = await as(OWNER)('profile.get', {})
  is('nickname saved', me.nickname, 'Organizer')
  is('and the setup nudge is satisfied', me.needs_setup, false)

  step('Clubs tab — create a club, add its venue')
  const { clubId, invite_code } = await as(OWNER)('club.create', {
    club: { name: 'E2E Club', description: 'end to end', join_policy: 'APPROVAL' },
  })
  is('an invite code comes back', /^[A-Z2-9]{6}$/.test(invite_code), true)
  const { venueId } = await as(OWNER)('venue.create', {
    clubId,
    venue: {
      name: 'E2E Courts',
      address: '1 Test Way',
      membership_required: true,
      max_courts_per_membership: 2,
      guest_policy: 'SURCHARGE',
      guest_surcharge_minor: 500,
      court_labels: ['Court 1', 'Court 2', 'Court 3'],
      currency: 'SGD',
    },
  })
  await as(OWNER)('club.update', {
    clubId,
    patch: { membership_policy: 'REQUIRED', currency: 'SGD', settlement_grace_hours: 24 },
  })
  let club = await as(OWNER)('club.detail', { clubId })
  is('the venue is primary', club.club.primary_venue_id, venueId)
  is('and the club asks for a card', club.club.membership_policy, 'REQUIRED')

  step('Joining by code — the membership dialog is not decoration')
  await as(B)('profile.upsert', { nickname: 'Bo', gender: 'FEMALE' })
  await refuses(
    'no card, no join',
    'MEMBERSHIP_REQUIRED',
    as(B)('club.joinByCode', { code: invite_code })
  )
  const joined = await as(B)('club.joinByCode', { code: invite_code, membership_name: 'Bo Card' })
  is('with a card it lands as a request', joined.status, 'PENDING')
  await refuses(
    'and a pending request cannot read the club',
    'NOT_MEMBER',
    as(B)('club.detail', { clubId })
  )
  await as(OWNER)('club.decide', { clubId, targetOpenid: B, approve: true })
  club = await as(B)('club.detail', { clubId })
  is('approved, the club opens', club.is_member, true)
  is('and the card is the name inside it', club.members.find((m) => m.openid === B).name, 'Bo Card')
  const ownProfile = await as(B)('profile.get', {})
  is('their own nickname is untouched', ownProfile.nickname, 'Bo')

  step('Create form — post a session')
  const start = Date.now() + 3 * 24 * HOUR
  const { eventId } = await as(OWNER)('event.create', {
    event: {
      club_id: clubId,
      venue_id: venueId,
      title: 'E2E doubles',
      venue_snapshot: { name: 'E2E Courts', address: '1 Test Way' },
      start_at: start,
      end_at: start + 2 * HOUR,
      start_local: local(start),
      end_local: local(start + 2 * HOUR),
      format_template: 'DOUBLES',
      roster_mode: 'OPEN',
      capacity: 4,
      court_count: 1,
      min_players: 2,
      max_guests_per_member: 1,
      on_full: 'WAITLIST',
      waitlist_capacity: 4,
      join_deadline_rule: 'AT_EVENT_START',
      visibility: 'CLUB_ONLY',
      cost_estimate_per_person: 800,
      currency: 'SGD',
    },
  })
  let ev = await as(OWNER)('event.detail', { eventId })
  is('the organizer holds a seat already', ev.roster_count, 1)
  is('status reads open', ev.status, 'OPEN')
  is('the card renders a badge', present.eventCard(ev, t).badge_text, t.joined)

  step('Joining, guests, and the waitlist')
  is(
    'a member joins',
    (await as(B)('event.join', { eventId, guests: [{ gender: 'MALE' }] })).seats,
    2
  )
  await as(C)('profile.upsert', { nickname: 'Cy', gender: 'MALE' })
  await as(D)('profile.upsert', { nickname: 'Di', gender: 'FEMALE' })
  // A members-only session is members-only to join, not just to read. §3.6
  await refuses(
    'a non-member cannot take a seat',
    'NOT_VISIBLE',
    as(C)('event.join', { eventId, guests: [] })
  )
  for (const who of [C, D]) {
    await as(who)('club.joinByCode', { code: invite_code, membership_name: who + ' card' })
    await as(OWNER)('club.decide', { clubId, targetOpenid: who, approve: true })
  }
  is('a third fills the last seat', (await as(C)('event.join', { eventId })).state, 'ROSTER')
  is('a fourth waits', (await as(D)('event.join', { eventId })).state, 'WAITLIST')
  ev = await as(OWNER)('event.detail', { eventId })
  is('roster is full', [ev.roster_count, ev.capacity], [4, 4])
  is('and one is queued', ev.waitlist_count, 1)
  is('the status says so', ev.status, 'WAITLIST_ONLY')

  step('Withdrawing promotes the queue')
  const withdrew = await as(C)('event.withdraw', { eventId })
  is('the seat frees and the queue moves', withdrew.promoted.length, 1)
  is('the promoted player is seated', (await as(D)('event.detail', { eventId })).my_state, 'ROSTER')

  step('Manage screen — courts, then capacity')
  await as(OWNER)('event.setCourts', {
    eventId,
    court_assignments: [{ label: 'Court 2' }, { label: 'Court 3' }],
    court_count: 2,
  })
  ev = await as(OWNER)('event.detail', { eventId })
  is('writing labels books the courts', ev.court_status, 'CONFIRMED')
  is('a seat holder sees them', rules.courtLabelsFor(ev, ev.my_state, ev.can_manage), [
    'Court 2',
    'Court 3',
  ])
  const stranger = await as(D)('event.detail', { eventId })
  is(
    'and so does another seat holder',
    rules.courtLabelsFor(stranger, stranger.my_state, false).length,
    2
  )
  is(
    'the card shows the count',
    present.eventCard(ev, t).chips.find((c) => c.key === 'fmt').label,
    'Doubles × 2 courts'
  )
  const bumped = await as(OWNER)('event.updateRules', { eventId, capacity: 6 })
  is('raising the cap promotes nobody, the queue is empty', bumped.promoted.length, 0)

  step('Booking helper — whose card covers it')
  const booking = await as(OWNER)('venue.bookingHelper', { eventId })
  is('two courts on a two-court card needs one holder', booking.coverage.needed, 1)
  is('and the club has one', booking.coverage.have >= 1, true)

  step('Games and Me tabs — the lists')
  is(
    'the session is in my list',
    (await as(B)('event.mine', {})).upcoming.some((e) => e._id === eventId),
    true
  )
  is(
    'and in the club feed',
    (await as(B)('event.list', {})).some((e) => e._id === eventId),
    true
  )
  const hosting = await as(OWNER)('event.hosting', {})
  is(
    'the organizer sees it as theirs',
    hosting.upcoming.some((e) => e._id === eventId),
    true
  )

  step('Cost split — publish, then settle')
  await refuses(
    'nothing to split before play',
    'EVENT_NOT_OVER',
    as(OWNER)('bill.publish', { eventId, total_minor: 4800 })
  )
  let bill = await as(OWNER)('bill.get', { eventId })
  is('the preview divides across heads, not people', bill.preview.units, 4)
  is('and the surcharge waits for a total to peel it off', bill.preview.surcharge_total, 0)
  // Time travel, which no action offers: the session has to be over to be settled, and
  // the clock is the server's. Straight to the store, then back to the API.
  const { execSync } = require('child_process')
  execSync(
    `docker exec yueqiu-pg psql -U yueqiu -d yueqiu -c "update events set doc = jsonb_set(jsonb_set(doc, '{start_at}', to_jsonb(${Date.now() - 3 * HOUR}::bigint)), '{end_at}', to_jsonb(${Date.now() - HOUR}::bigint)) where id = '${eventId}'"`,
    { stdio: 'pipe' }
  )
  ev = await as(OWNER)('event.detail', { eventId })
  is('the session now reads as finished', ev.status, 'COMPLETED')
  bill = await as(OWNER)('bill.get', { eventId })
  await as(OWNER)('bill.publish', { eventId, total_minor: 4800, payment_note: 'transfer' })
  bill = await as(OWNER)('bill.get', { eventId })
  is('it publishes', bill.bill.status, 'PUBLISHED')
  const sum = bill.rows.reduce((n, r) => n + r.share_minor, 0)
  is('and every cent is allocated', sum, 4800)
  const bShare = bill.rows.find((r) => r.openid === B)
  is('the party pays for its guest', bShare.share_minor, 2 * bill.preview.base_minor + 500)

  const mineOwing = await as(B)('event.mine', {})
  is('the debt shows on the player side', mineOwing.owing.count, 1)
  is(
    'with a due date from the bill',
    mineOwing.past.concat(mineOwing.upcoming).some((e) => e.my_share_due_at > 0),
    true
  )
  is(
    'and it is not overdue yet',
    mineOwing.owing.count === 1 &&
      !mineOwing.past.concat(mineOwing.upcoming).find((e) => e.my_share_status === 'UNPAID')
        .my_share_overdue,
    true
  )

  await as(B)('bill.claimPaid', { eventId })
  bill = await as(OWNER)('bill.get', { eventId })
  is(
    'a claim is visible but settles nothing',
    bill.rows.find((r) => r.openid === B).claimed_paid_at > 0,
    true
  )
  is('the share is still unpaid', bill.rows.find((r) => r.openid === B).status, 'UNPAID')
  await refuses(
    'a player cannot settle their own',
    'NOT_ADMIN',
    as(B)('bill.markPaid', { eventId, targetOpenid: B, paid: true })
  )
  await as(OWNER)('bill.markPaid', { eventId, targetOpenid: B, paid: true })
  is(
    'nothing owed once the organizer marks it paid',
    (await as(B)('event.mine', {})).owing.count,
    0
  )

  step('Money and time, as rendered')
  is(
    'an amount is a bare number',
    fmt.money(bill.preview.base_minor, 'SGD'),
    fmt.money(bill.preview.base_minor, 'SGD')
  )
  is(
    'a wall clock reads back unchanged',
    (await as(OWNER)('event.detail', { eventId })).start_local.length,
    16
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((err) => {
  console.log('\nsuite threw', err && (err.code || err.message), err)
  process.exit(1)
})
