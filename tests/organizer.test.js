/**
 * Organizer controls over a live session. Run with `node tests/organizer.test.js`.
 *
 * DESIGN.md §3.1, §3.2, §3.4, §3.5 — the settings an organizer picks at creation and
 * then needs to change on the day, because more people turn up than the plan allowed.
 * Reopening is the interesting case: status is derived (§5), so moving a deadline into
 * the future is all it takes, but promotion has to be re-run by hand because it refuses
 * to fire while a deadline has passed.
 *
 * Drives the mock backend, which is the half that runs outside the cloud. The cloud copy
 * is written line-for-line parallel and shares rules.js.
 */
const path = require('path')

const storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    storage[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync: (k) => {
    delete storage[k]
  },
  getAppBaseInfo: () => ({ language: 'zh_CN' }),
}

const UTILS = path.join(__dirname, '../miniprogram/utils')
const mock = require(path.join(UTILS, 'mock.js'))
const rules = require(path.join(UTILS, 'rules.js'))

let pass = 0
let fail = 0

function is(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    return
  }
  fail++
  console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)
}

const call = (action, payload) => mock.dispatch(action, payload)

function refuses(label, code, promise) {
  return promise.then(
    () => {
      fail++
      console.log(`  FAIL ${label}\n    expected ${code}, but it succeeded`)
    },
    (err) => is(label, err.code || err.message, code)
  )
}

const detail = (id) => call('event.detail', { eventId: id })

;(async () => {
  // --- opening up a session that filled ------------------------------------
  // e_joinwait: 4/4 with two parties waiting and a deadline at start time.
  let ev = await detail('e_joinwait')
  is('starts full', [ev.roster_count, ev.capacity], [4, 4])
  is('and reads as waitlist-only', ev.status, 'WAITLIST_ONLY')
  is('two waiting', ev.waitlist.length, 2)

  // Raising the cap admits them, oldest queued first — no separate promote step. Seven
  // rather than six on purpose: filling the new seats exactly would leave the session
  // full again, which is true but doesn't show that it reopened.
  let res = await call('event.updateRules', { eventId: 'e_joinwait', capacity: 7 })
  is('raising the cap promotes from the waitlist', res.promoted.length, 2)
  is('and bumps nobody', res.bumped_count, 0)
  ev = await detail('e_joinwait')
  is('roster grew', [ev.roster_count, ev.capacity], [6, 7])
  is('waitlist drained', ev.waitlist.length, 0)
  is('and it is open again', ev.status, 'OPEN')

  // --- lowering the cap costs the latest joiners their seat (§3.5 LIFO) ----
  res = await call('event.updateRules', { eventId: 'e_joinwait', capacity: 4 })
  is('shrinking bumps the two latest', res.bumped_count, 2)
  is('and promotes nobody, since there is no room', res.promoted.length, 0)
  ev = await detail('e_joinwait')
  is('roster back to the cap', ev.roster_count, 4)
  is('bumped parties are queued again', ev.waitlist.length, 2)

  // --- reopening a closed deadline -----------------------------------------
  // e_full closes 6h before start and is 8/8 with three waiting. Close it now, then
  // reopen it: the point is that nothing but the timestamp has to change.
  const full = await detail('e_full')
  const past = Date.now() - rules.HOUR
  await call('event.updateRules', {
    eventId: 'e_full',
    join_deadline_rule: 'AT_TIME',
    join_deadline_at: past,
    join_deadline_local: '2020-01-01T00:00',
  })
  ev = await detail('e_full')
  is('a deadline in the past closes signup', ev.status, 'SIGNUP_CLOSED')
  is('nobody was promoted into it', ev.roster_count, full.roster_count)

  // Reopen with room to spare, and the queue moves.
  res = await call('event.updateRules', {
    eventId: 'e_full',
    capacity: 12,
    join_deadline_rule: 'AT_EVENT_START',
  })
  is('reopening plus room promotes the queue', res.promoted.length > 0, true)
  ev = await detail('e_full')
  is('and signup is open again', ev.status, 'OPEN')

  // --- deadline validation -------------------------------------------------
  await refuses('a deadline after the start is refused', 'BAD_DEADLINE',
    call('event.updateRules', {
      eventId: 'e_thu',
      join_deadline_rule: 'AT_TIME',
      join_deadline_at: (await detail('e_thu')).start_at + rules.HOUR,
    }))
  await refuses('a missing timestamp is refused', 'BAD_DEADLINE',
    call('event.updateRules', {
      eventId: 'e_thu',
      join_deadline_rule: 'AT_TIME',
      join_deadline_at: 0,
    }))

  // --- withdrawal deadline -------------------------------------------------
  await call('event.updateRules', {
    eventId: 'e_thu',
    withdraw_rule: 'HOURS_BEFORE_START',
    withdraw_hours_before: 24,
  })
  ev = await detail('e_thu')
  is('withdraw window widened', ev.withdraw_deadline_at, ev.start_at - 24 * rules.HOUR)

  await call('event.updateRules', { eventId: 'e_thu', withdraw_rule: 'AT_EVENT_START' })
  ev = await detail('e_thu')
  is('or opened right up to the start', ev.withdraw_deadline_at, ev.start_at)

  await refuses('an unknown withdrawal rule is refused', 'BAD_WITHDRAW_RULE',
    call('event.updateRules', { eventId: 'e_thu', withdraw_rule: 'WHENEVER' }))

  // --- viability and guests ------------------------------------------------
  await refuses('a minimum above the cap is refused', 'BAD_CAPACITY',
    call('event.updateRules', { eventId: 'e_thu', capacity: 8, min_players: 9 }))

  await call('event.updateRules', { eventId: 'e_thu', max_guests_per_member: 99 })
  ev = await detail('e_thu')
  is('guests per member is capped at 3', ev.max_guests_per_member, 3)

  // --- permissions and lifecycle ------------------------------------------
  // e_owed belongs to Open Shuttlers, where the seeded user is a plain member.
  await refuses('a non-manager cannot change the rules', 'NOT_ADMIN',
    call('event.updateRules', { eventId: 'e_owed', capacity: 99 }))

  await call('event.cancel', { eventId: 'e_soon' })
  await refuses('a cancelled session has no rules to change', 'NOT_ACTIVE',
    call('event.updateRules', { eventId: 'e_soon', capacity: 8 }))

  // --- club money settings (§10.3, §9.3) -----------------------------------
  // Both were accepted by club.update from the first commit and reachable from no
  // screen, so every club was silently CAD with a 12h settlement window.
  {
    const fmt = require(path.join(UTILS, 'format.js'))

  let d = await call('club.detail', { clubId: 'c_thu' })
  is('seeded club is CAD', d.club.currency, 'CAD')
  is('seeded grace is 12h', d.club.settlement_grace_hours, 12)

  await call('club.update', { clubId: 'c_thu', patch: { currency: 'sgd', settlement_grace_hours: 48 } })
  d = await call('club.detail', { clubId: 'c_thu' })
  is('currency set and upper-cased', d.club.currency, 'SGD')
  is('grace hours set', d.club.settlement_grace_hours, 48)

  await call('club.update', { clubId: 'c_thu', patch: { currency: 'nope' } })
    .then(() => { bad++; console.log('FAIL bad currency accepted') },
          (e) => is('a malformed code is refused', e.code, 'BAD_CURRENCY'))

  // A new session picks up the club's currency; existing ones keep theirs.
  const before = await call('event.detail', { eventId: 'e_thu' })
  is('an existing session keeps its own currency', before.currency, 'CAD')
  const created = await call('event.create', { event: {
    club_id: 'c_thu', title: 'SGD test', venue_snapshot: { name: 'X' },
    start_at: Date.now() + 86400000, end_at: Date.now() + 90000000,
    format_template: 'DOUBLES', roster_mode: 'OPEN', capacity: 8, min_players: 4,
    on_full: 'WAITLIST', join_deadline_rule: 'AT_EVENT_START', signup_open_at: Date.now(),
  }})
  const fresh = await call('event.detail', { eventId: created.eventId })
  is('a new session inherits the club currency', fresh.currency, 'SGD')

  // A zero-decimal club renders and round-trips without hundredths.
  await call('club.update', { clubId: 'c_thu', patch: { currency: 'JPY' } })
  is('JPY displays whole', fmt.money(2500, 'JPY'), '2500')
  is('JPY round-trips', fmt.toMinor(fmt.toMajorInput(2500, 'JPY'), 'JPY'), 2500)
  is('offered list covers the audience', fmt.CURRENCIES.slice(0, 4), ['CAD','AUD','SGD','GBP'])
  }

  // --- the court flow still owns its own capacity path (§3.5) -------------
  // Fewer courts than planned has to be able to shrink the roster, and it shares the
  // same bump implementation rather than carrying a second one.
  const before = await detail('e_joinwait')
  res = await call('event.setCourts', {
    eventId: 'e_joinwait',
    court_status: 'CONFIRMED',
    court_count: 1,
    capacity: 2,
  })
  is('booking fewer courts bumps the overflow', res.bumped_count > 0, true)
  ev = await detail('e_joinwait')
  is('capacity followed the booking', ev.capacity, 2)
  is('roster fits inside it', ev.roster_count <= 2, true)
  is('and fewer people hold seats than before', ev.roster.length < before.roster.length, true)

  // --- the labels are the booking (§3.5) -----------------------------------
  // There is no status to keep in step: courts named means booked, none means not.
  {
    let ev = await detail('e_thu')
    await call('event.setCourts', {
      eventId: 'e_thu',
      court_assignments: [{ label: 'Court 3' }, { label: 'Court 5' }],
    })
    ev = await detail('e_thu')
    is('writing labels books the courts', ev.court_status, 'CONFIRMED')
    is('and they are what was written', ev.court_assignments.map((c) => c.label), ['Court 3', 'Court 5'])
    is('the organizer sees them', ev.courts_visible, true)

    await call('event.setCourts', { eventId: 'e_thu', court_assignments: [] })
    ev = await detail('e_thu')
    is('clearing them unbooks the courts', ev.court_status, 'NOT_BOOKED')

    // A status sent by a client is not a second source of truth.
    await call('event.setCourts', {
      eventId: 'e_thu',
      court_status: 'CONFIRMED',
      court_assignments: [],
    })
    ev = await detail('e_thu')
    is('a claimed status without labels is ignored', ev.court_status, 'NOT_BOOKED')
  }

  // --- a club page is for members (§3.10) ----------------------------------
  // It used to hand the roster, the venues and the club's sessions to anybody holding
  // the id — including somebody whose request was still waiting.
  {
    const as = (actorId) => (action, payload) => mock.dispatch(action, payload, { actorId })

    const d = await call('club.detail', { clubId: 'c_thu' })
    is('the owner sees the club', d.members.length > 0, true)
    is('and its sessions', d.upcoming.length > 0, true)

    await refuses('a stranger cannot', 'NOT_MEMBER',
      as('u_zhang')('club.detail', { clubId: 'c_thu' }))
    // u_zhao's request is seeded as PENDING.
    await refuses('and neither can a pending request', 'NOT_MEMBER',
      as('u_zhao')('club.detail', { clubId: 'c_thu' }))
    is('a plain member does', (await as('u_li')('club.detail', { clubId: 'c_thu' })).is_member, true)

    // The detail page decides whether to offer the club link from the same fact.
    is(
      'a session tells a member the club is theirs to open',
      (await as('u_li')('event.detail', { eventId: 'e_thu' })).is_club_member,
      true
    )
  }

  // --- a club that plays on somebody's card asks on the join tap (§3.8) ----
  // The membership form is only open to members, so a REQUIRED club could not be
  // joined at all unless the name travels with the join itself.
  {
    const as = (actorId) => (action, payload) => mock.dispatch(action, payload, { actorId })
    const wu = as('u_wu') // 吴静, in neither seeded club and holding no card

    await call('club.update', { clubId: 'c_thu', patch: { membership_policy: 'REQUIRED' } })
    await refuses('a REQUIRED club refuses a join with no card', 'MEMBERSHIP_REQUIRED',
      wu('club.join', { clubId: 'c_thu' }))

    res = await wu('club.join', { clubId: 'c_thu', membership_name: '  Wu Jing  ' })
    is('the name lets the join through', res.status, 'PENDING')
    const mine = await wu('venue.myMemberships', {})
    is('the card is on file, trimmed', mine.memberships[0].membership_name, 'Wu Jing')
    is('against the club primary venue', mine.memberships[0].venue_id, 'v_river')
    is('and starts unverified', mine.memberships[0].verified_at, null)

    await call('club.decide', { clubId: 'c_thu', targetOpenid: 'u_wu', approve: true })
    const d = await call('club.detail', { clubId: 'c_thu' })
    const inClub = d.members.filter((m) => m.openid === 'u_wu')[0]
    is('inside the club they read as the card', inClub.name, 'Wu Jing')
    const own = await wu('profile.get', {})
    is('their own display name is untouched', own.nickname, '吴静')

    // A REQUESTED club takes a name when offered, and admits without one.
    await call('club.update', { clubId: 'c_thu', patch: { membership_policy: 'REQUESTED' } })
    const he = as('u_he')
    res = await he('club.join', { clubId: 'c_thu', membership_name: 'He Qiang' })
    is('a REQUESTED club still records what it is given', res.status, 'PENDING')
    const hisCard = await he('venue.myMemberships', {})
    is('the card is there too', hisCard.memberships[0].membership_name, 'He Qiang')
    const ma = as('u_ma')
    res = await ma('club.join', { clubId: 'c_thu' })
    is('and admits somebody who skipped it', res.status, 'PENDING')
    is('leaving no card behind', (await ma('venue.myMemberships', {})).memberships.length, 0)
  }

  // --- resetting the demo actually resets it -------------------------------
  // Last in the file on purpose: it puts every seeded document back, so anything
  // asserted after it would be asserting against a different session's state.
  //
  // dispatch persists the db it loaded before the action ran, so a reset that wrote a
  // fresh seed straight to storage was overwritten the moment it returned: the button
  // on the Me tab said "done" and changed nothing.
  {
    // e_thu is in the club the seeded user owns, so it is theirs to cancel.
    await call('event.cancel', { eventId: 'e_thu' })
    await call('club.joinByCode', { code: 'DROPS5' })
    is('a cancelled session stays cancelled', (await detail('e_thu')).status, 'CANCELLED')
    const joinedBefore = (await call('club.mine', {})).joined.length

    await call('dev.reset', {})
    is('a reset brings the session back', (await detail('e_thu')).status, 'OPEN')
    is('and undoes the club that was joined', (await call('club.mine', {})).joined.length, joinedBefore - 1)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((err) => {
  console.log('  FAIL suite threw', err)
  process.exit(1)
})
