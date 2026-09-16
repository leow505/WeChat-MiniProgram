/**
 * Rule tests. Run with `node tests/rules.test.js` — no framework, no install.
 *
 * These run against BOTH copies of rules.js (client and cloud). The two files are
 * deliberate duplicates because a cloud function can only package its own
 * directory, so the real risk is drift — this suite is what catches it.
 */
const path = require('path')

const COPIES = [
  [
    'client',
    '../miniprogram/utils/rules.js',
    '../miniprogram/utils/formats.js',
    '../miniprogram/utils/naming.js',
  ],
  [
    'cloud',
    '../cloudfunctions/api/lib/rules.js',
    '../cloudfunctions/api/lib/formats.js',
    '../cloudfunctions/api/lib/naming.js',
  ],
]

let pass = 0
let fail = 0

function is(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)
  }
}

function run(name, r, f, n) {
  console.log(`\n[${name}]`)
  const HOUR = r.HOUR
  const now = Date.now()

  const base = {
    lifecycle: 'ACTIVE',
    signup_open_at: now - HOUR,
    start_at: now + 48 * HOUR,
    end_at: now + 50 * HOUR,
    join_deadline_rule: 'AT_EVENT_START',
    on_full: 'WAITLIST',
    waitlist_capacity: 0,
    waitlist_count: 0,
    withdraw_rule: 'HOURS_BEFORE_START',
    withdraw_hours_before: 6,
  }

  // --- OPEN roster ---------------------------------------------------------
  const open = Object.assign({}, base, { roster_mode: 'OPEN', capacity: 8, roster_count: 3 })
  is('open status', r.statusOf(open, now), 'OPEN')
  is('open solo joins roster', r.allocationFor(open, r.demandOf(open, 'MALE', []), 1), 'ROSTER')
  is('unspecified gender is fine in OPEN', r.demandOf(open, 'UNSPECIFIED', []), { any: 1 })

  // All-or-nothing: one seat left, party of two waits together. §3.7
  const tight = Object.assign({}, open, { roster_count: 7 })
  const party2 = r.demandOf(tight, 'MALE', [{ gender: 'MALE' }])
  is('party of 2 with 1 seat waits whole', r.allocationFor(tight, party2, 2), 'WAITLIST')
  is('seats left', r.totalSeatsLeft(tight), 1)

  // on_full = CLOSE means no waitlist at all. §3.1
  const shut = Object.assign({}, tight, { roster_count: 8, on_full: 'CLOSE' })
  is('full + CLOSE status', r.statusOf(shut, now), 'FULL_CLOSED')
  is('full + CLOSE refuses', r.allocationFor(shut, r.demandOf(shut, 'MALE', []), 1), null)

  const overflow = Object.assign({}, tight, { roster_count: 8 })
  is('full + WAITLIST status', r.statusOf(overflow, now), 'WAITLIST_ONLY')

  // --- GENDER_BALANCED -----------------------------------------------------
  const bal = Object.assign({}, base, {
    roster_mode: 'GENDER_BALANCED',
    capacity: 8,
    capacity_by_gender: { male: 4, female: 4 },
    roster_by_gender: { male: 4, female: 3 },
    roster_count: 7,
  })
  is('balanced with one bucket open is not full', r.isRosterFull(bal), false)
  is('balanced status', r.statusOf(bal, now), 'OPEN')
  is('male blocked when male bucket full', r.allocationFor(bal, r.demandOf(bal, 'MALE', []), 1), 'WAITLIST')
  is('female admitted when female bucket open', r.allocationFor(bal, r.demandOf(bal, 'FEMALE', []), 1), 'ROSTER')
  is('balanced seats left per bucket', r.seatsLeft(bal), { male: 0, female: 1 })

  const mixedParty = r.demandOf(bal, 'FEMALE', [{ gender: 'MALE' }])
  is('mixed party demands both buckets', mixedParty, { male: 1, female: 1 })
  is('mixed party blocked by the full bucket', r.allocationFor(bal, mixedParty, 2), 'WAITLIST')

  // No declared gender can't be bucketed. §3.9
  is('unspecified cannot be bucketed', r.demandOf(bal, 'UNSPECIFIED', []), null)
  is('unspecified guest cannot be bucketed', r.demandOf(bal, 'MALE', [{ gender: 'UNSPECIFIED' }]), null)

  const balFull = Object.assign({}, bal, {
    roster_by_gender: { male: 4, female: 4 },
    roster_count: 8,
  })
  is('both buckets full', r.statusOf(balFull, now), 'WAITLIST_ONLY')

  // Leapfrog: the male at the head doesn't fit, the female behind him does. §3.9
  const queue = [
    { gender: 'MALE', guests: [] },
    { gender: 'FEMALE', guests: [] },
  ]
  const firstFit = queue.find((s) => {
    const d = r.demandOf(bal, s.gender, s.guests)
    return d && r.fitsGap(bal, d)
  })
  is('leapfrog skips the blocked head', firstFit.gender, 'FEMALE')

  // --- waitlist cap --------------------------------------------------------
  const capped = Object.assign({}, overflow, { waitlist_capacity: 2, waitlist_count: 2 })
  is('waitlist cap refuses', r.allocationFor(capped, r.demandOf(capped, 'MALE', []), 1), null)
  is('unlimited waitlist accepts', r.waitlistHasRoom(overflow, 99), true)

  // --- deadlines and status ------------------------------------------------
  is('withdraw deadline is 6h before start', r.withdrawDeadlineAt(open), open.start_at - 6 * HOUR)
  is('join deadline defaults to start', r.joinDeadlineAt(open), open.start_at)
  is('can withdraw two days out', r.canWithdraw(open, now), true)
  is('cannot withdraw 1h before start', r.canWithdraw(open, open.start_at - HOUR), false)
  is('late withdrawal flagged inside 12h', r.isLateWithdrawal(open, open.start_at - 6 * HOUR), true)
  is('not late two days out', r.isLateWithdrawal(open, now), false)

  const custom = Object.assign({}, open, {
    join_deadline_rule: 'AT_TIME',
    join_deadline_at: now + 24 * HOUR,
  })
  is('custom deadline honoured', r.joinDeadlineAt(custom), now + 24 * HOUR)
  is('past custom deadline closes signup', r.statusOf(custom, now + 25 * HOUR), 'SIGNUP_CLOSED')
  is('before signup opens', r.statusOf(open, now - 2 * HOUR), 'SCHEDULED')
  is('after start is in progress', r.statusOf(open, open.start_at + HOUR), 'IN_PROGRESS')
  is('after end is completed', r.statusOf(open, open.end_at + HOUR), 'COMPLETED')
  is('cancelled short-circuits', r.statusOf(Object.assign({}, open, { lifecycle: 'CANCELLED' }), now), 'CANCELLED')

  // --- format templates ----------------------------------------------------
  is('mixed doubles on 2 courts', f.capacityFor('MIXED_DOUBLES', 2), {
    capacity: 8,
    by_gender: { male: 4, female: 4 },
  })
  is('doubles on 3 courts', f.capacityFor('DOUBLES', 3), { capacity: 12, by_gender: null })
  is('social mixer on 1 court', f.capacityFor('SOCIAL_MIXER', 1), { capacity: 6, by_gender: null })
  is('singles on 2 courts', f.capacityFor('SINGLES', 2), { capacity: 4, by_gender: null })
  is("women's doubles is single-bucket", f.capacityFor('WOMENS_DOUBLES', 1), {
    capacity: 4,
    by_gender: { male: 0, female: 4 },
  })
  is('mixer formats are balanced', f.isBalanced('MIXED_MIXER'), true)
  is('plain doubles is not balanced', f.isBalanced('DOUBLES'), false)
  is('every ordered format exists', f.ORDER.every((k) => !!f.FORMATS[k]), true)

  // --- capacity shrink / LIFO bump (§3.5) ----------------------------------
  const roster = [
    { _id: 'a', gender: 'MALE', guests: [], joined_at: 100 },
    { _id: 'b', gender: 'FEMALE', guests: [], joined_at: 200 },
    { _id: 'c', gender: 'MALE', guests: [], joined_at: 300 },
    { _id: 'd', gender: 'FEMALE', guests: [], joined_at: 400 },
  ]
  const openEv = Object.assign({}, base, { roster_mode: 'OPEN', capacity: 4, roster_count: 4 })
  const shrink = r.planCapacityBump(openEv, roster, 2, null)
  is('shrink keeps the two earliest', shrink.kept, ['a', 'b'])
  is('shrink bumps the two latest', shrink.bumped, ['c', 'd'])
  is('shrink reports seats used', shrink.seated, 2)

  const noShrink = r.planCapacityBump(openEv, roster, 4, null)
  is('no shrink bumps nobody', noShrink.bumped, [])

  // A party counts as its whole seat demand, so it can be bumped as a unit.
  const withParty = [
    { _id: 'a', gender: 'MALE', guests: [], joined_at: 100 },
    { _id: 'b', gender: 'MALE', guests: [{ gender: 'MALE' }, { gender: 'MALE' }], joined_at: 200 },
  ]
  const partyPlan = r.planCapacityBump(openEv, withParty, 2, null)
  is('a party too big for the gap is bumped whole', partyPlan.bumped, ['b'])
  is('the solo signup keeps its seat', partyPlan.kept, ['a'])

  // Balanced shrink respects each bucket independently.
  const balEv = Object.assign({}, base, {
    roster_mode: 'GENDER_BALANCED',
    capacity: 4,
    capacity_by_gender: { male: 2, female: 2 },
    roster_by_gender: { male: 2, female: 2 },
    roster_count: 4,
  })
  const balPlan = r.planCapacityBump(balEv, roster, 2, { male: 1, female: 1 })
  is('balanced shrink keeps earliest of each bucket', balPlan.kept, ['a', 'b'])
  is('balanced shrink bumps the rest', balPlan.bumped, ['c', 'd'])

  // --- money split (§9.2) --------------------------------------------------
  // The invariant that matters: no minor unit is lost or invented.
  ;[
    [9600, 8],
    [10000, 7],
    [1, 3],
    [0, 4],
    [999, 1],
    [12345, 11],
  ].forEach(([total, units]) => {
    const sp = r.splitEvenly(total, units)
    is(
      `split ${total}/${units} conserves the total`,
      sp.base * sp.units + sp.remainder,
      total
    )
    is(`split ${total}/${units} remainder is under units`, sp.remainder < units, true)
  })
  is('96.00 over 8 seats is 12.00 each', r.splitEvenly(9600, 8), { base: 1200, remainder: 0, units: 8 })
  is('100.00 over 7 seats leaves a remainder', r.splitEvenly(10000, 7), { base: 1428, remainder: 4, units: 7 })
  is('zero seats keeps the whole total unallocated', r.splitEvenly(5000, 0), { base: 0, remainder: 5000, units: 0 })
  is('per-person preview is the base', r.perPersonPreview(9600, 8), 1200)
  is('per-person preview with no seats is 0', r.perPersonPreview(9600, 0), 0)
  is('per-person preview ignores a missing total', r.perPersonPreview(null, 8), 0)

  // --- the published split (§9.2, §14) -------------------------------------
  // Every head that held a seat pays, and nothing else enters into it: a seat was
  // yours to release before the deadline or to fill with a replacement, so it is
  // billed whether you used it or not.
  const signup = (openid, joinedAt, guests, attendance, state) => ({
    openid,
    joined_at: joinedAt,
    guests: guests || [],
    // Still on the row, reserved for §13; deliberately not consulted here.
    attendance: attendance || 'UNKNOWN',
    state: state || 'ROSTER',
  })

  // Four solo players, nothing marked: a plain even split. §9.2
  const four = [
    signup('a', 100),
    signup('b', 200),
    signup('c', 300),
    signup('d', 400),
  ]
  const even = r.computeShares({ total_minor: 4800, signups: four })
  is('four-way even split', even.rows.map((x) => x.share_minor), [1200, 1200, 1200, 1200])
  is('even split conserves the total', even.allocated_minor, 4800)
  is('even split has no remainder', even.remainder, 0)

  // A remainder goes out one minor unit at a time, earliest joiner first.
  const odd = r.computeShares({ total_minor: 1002, signups: four })
  is('remainder to the earliest joiners', odd.rows.map((x) => x.share_minor), [251, 251, 250, 250])
  is('remainder split conserves the total', odd.allocated_minor, 1002)

  // A row marked NO_SHOW is billed exactly like any other: the seat was paid for. §14
  const withNoShow = [
    signup('a', 100),
    signup('b', 200),
    signup('c', 300, [], 'NO_SHOW'),
    signup('d', 400),
  ]
  const marked = r.computeShares({ total_minor: 4800, signups: withNoShow })
  is('a NO_SHOW row still pays', marked.rows.map((x) => x.openid), ['a', 'b', 'c', 'd'])
  is('and pays the same as everyone else', marked.rows.map((x) => x.share_minor), [1200, 1200, 1200, 1200])
  is('attendance cannot change the total', marked.allocated_minor, 4800)
  // The old split_basis input is gone, so passing one must not resurrect it.
  const ignored = r.computeShares({ total_minor: 4800, signups: withNoShow, split_basis: 'ATTENDED' })
  is('a stale split_basis is ignored', ignored.rows.length, 4)

  // Waitlisted parties never pay — they held no seat.
  const withWaiting = four.concat([signup('e', 500, [], 'UNKNOWN', 'WAITLIST')])
  is('the waitlist is not billed', r.computeShares({ total_minor: 4800, signups: withWaiting }).rows.length, 4)

  // A party of a member plus guests is one row owing all its units. §3.7
  const party = [signup('a', 100), signup('b', 200, [{ gender: 'MALE' }, { gender: 'FEMALE' }])]
  const partyBill = r.computeShares({ total_minor: 4800, signups: party })
  is('a party owes its whole party', partyBill.rows.map((x) => x.share_minor), [1200, 3600])
  is('units count seats not heads', partyBill.units, 4)
  is('party split conserves the total', partyBill.allocated_minor, 4800)

  // Guest surcharge: peel it off, split the rest evenly, add it back per guest. §9.2
  const surcharged = r.computeShares({
    total_minor: 4800,
    signups: party,
    guest_surcharge_minor: 500,
  })
  is('surcharge is peeled off before dividing', surcharged.surcharge_total, 1000)
  is('the host pays base + surcharge per guest', surcharged.rows.map((x) => x.share_minor), [950, 3850])
  is('surcharged split conserves the total', surcharged.allocated_minor, 4800)

  // A surcharge exceeding the total means it wasn't in the total; ignore it rather
  // than bill out more than was paid.
  const absurd = r.computeShares({ total_minor: 400, signups: party, guest_surcharge_minor: 90000 })
  is('an impossible surcharge is dropped', absurd.surcharge_minor, 0)
  is('dropped surcharge still conserves the total', absurd.allocated_minor, 400)

  // A remainder larger than the headcount still lands, because it is bounded by
  // units: 1003 over 5 units leaves 3 to place across only 2 payers.
  const bigParty = [signup('a', 100), signup('b', 200, [{}, {}, {}])]
  const spread = r.computeShares({ total_minor: 1003, signups: bigParty })
  is('remainder beyond the headcount is still allocated', spread.allocated_minor, 1003)
  is('remainder rides on units, earliest first', spread.rows.map((x) => x.share_minor), [201, 802])

  // Nobody paying is the honest zero, not a divide-by-zero.
  const nobody = r.computeShares({ total_minor: 4800, signups: [] })
  is('no payers allocates nothing', nobody.allocated_minor, 0)
  is('no payers is reported', nobody.payer_count, 0)

  // The conservation invariant across awkward totals and party shapes.
  ;[
    [9600, four, 0],
    [10000, four, 0],
    [1, four, 0],
    [7, bigParty, 0],
    [12345, party, 500],
    [99999, withNoShow, 250],
    [3, bigParty, 1],
  ].forEach(([total, rows, sur]) => {
    const out = r.computeShares({ total_minor: total, signups: rows, guest_surcharge_minor: sur })
    is(`split of ${total} over ${out.units} units conserves the total`, out.allocated_minor, total)
    is(`split of ${total} bills nobody a negative`, out.rows.every((x) => x.share_minor >= 0), true)
  })

  // --- settlement clock (§9.3) ---------------------------------------------
  // Counted from publication, not from the event: a bill posted three days late
  // must not arrive already overdue.
  is('due 12h after publication by default', r.dueAt(1000, 0), 1000 + 12 * HOUR)
  is('club grace hours honoured', r.dueAt(1000, 24), 1000 + 24 * HOUR)
  is('an unpaid share past due is overdue', r.isShareOverdue({ status: 'UNPAID' }, 1000, 2000), true)
  is('an unpaid share before due is not', r.isShareOverdue({ status: 'UNPAID' }, 5000, 2000), false)
  is('a paid share is never overdue', r.isShareOverdue({ status: 'PAID' }, 1000, 2000), false)
  is('a waived share is never overdue', r.isShareOverdue({ status: 'WAIVED' }, 1000, 2000), false)
  is('an unpublished bill has no due date to pass', r.isShareOverdue({ status: 'UNPAID' }, 0, 2000), false)

  is('settled once nothing is unpaid', r.isBillSettled([{ status: 'PAID' }, { status: 'WAIVED' }]), true)
  is('one unpaid share keeps a bill open', r.isBillSettled([{ status: 'PAID' }, { status: 'UNPAID' }]), false)
  is('a bill with no shares is vacuously settled', r.isBillSettled([]), true)

  // --- club roles and display names (§3.8, §3.10) --------------------------
  const club = { _id: 'c1', membership_policy: 'REQUESTED', join_policy: 'APPROVAL', invite_code: 'ABC123' }
  // The code is addressing, resolved before joinOutcome runs; the policy alone
  // decides admission. §3.10
  const user = { nickname: '小明🌸' }
  const membership = { membership_name: 'Ming Li' }

  is(
    'membership name wins as club display name',
    n.displayName({ user, member: {}, membership, club }),
    'Ming Li'
  )
  is(
    'nickname_override is the fallback',
    n.displayName({ user, member: { nickname_override: 'Ming' }, membership: null, club }),
    'Ming'
  )
  is(
    'plain nickname when the club asks for nothing',
    n.displayName({ user, member: {}, membership, club: { membership_policy: 'NOT_REQUIRED' } }),
    '小明🌸'
  )

  const owner = { role: 'OWNER', status: 'ACTIVE' }
  const admin = { role: 'ADMIN', status: 'ACTIVE' }
  const member = { role: 'MEMBER', status: 'ACTIVE' }
  const pending = { role: 'MEMBER', status: 'PENDING' }
  is('owner can admin', n.canAdminClub(owner), true)
  is('admin can admin', n.canAdminClub(admin), true)
  is('member cannot admin', n.canAdminClub(member), false)
  is('pending member cannot admin', n.canAdminClub(pending), false)
  is('only owner is owner', n.isOwner(admin), false)

  is('club-only event hidden from non-members', n.canSeeClubEvent({ visibility: 'CLUB_ONLY' }, null), false)
  is('club-only event visible to members', n.canSeeClubEvent({ visibility: 'CLUB_ONLY' }, member), true)
  is('public event visible to anyone', n.canSeeClubEvent({ visibility: 'PUBLIC' }, null), true)

  is('open club joins immediately', n.joinOutcome({ join_policy: 'OPEN' }, null).status, 'ACTIVE')
  is('approval club queues', n.joinOutcome({ join_policy: 'APPROVAL' }, null).status, 'PENDING')
  is('approval club queues regardless of how you arrived', n.joinOutcome(club, null).status, 'PENDING')
  is('unknown policy is refused', n.joinOutcome({ join_policy: 'NOPE' }, null).error, 'BAD_JOIN_POLICY')
  is('only two policies exist', Object.keys(n.JoinPolicy).sort(), ['APPROVAL', 'OPEN'])
  is('already a member', n.joinOutcome({ join_policy: 'OPEN' }, owner).error, 'ALREADY_MEMBER')
  is('request already pending', n.joinOutcome({ join_policy: 'OPEN' }, pending).error, 'REQUEST_PENDING')
  // Removing someone from an OPEN club has to mean something.
  is(
    'a removed member needs approval to rejoin an OPEN club',
    n.joinOutcome({ join_policy: 'OPEN' }, { status: 'REMOVED', role: 'MEMBER' }).status,
    'PENDING'
  )

  is('REQUIRED needs a membership name', n.membershipSatisfied({ membership_policy: 'REQUIRED' }, null), false)
  is(
    'REQUIRED satisfied by a name',
    n.membershipSatisfied({ membership_policy: 'REQUIRED' }, membership),
    true
  )
  is('REQUESTED never blocks', n.membershipSatisfied({ membership_policy: 'REQUESTED' }, null), true)

  // --- booking helper arithmetic (§3.8) -----------------------------------
  is('3 courts at 2 per card needs 2 cards', n.bookingCoverage(3, 2, 2), {
    needed: 2,
    have: 2,
    ok: true,
    capped: true,
  })
  is('3 courts at 1 per card needs 3 cards', n.bookingCoverage(3, 1, 2), {
    needed: 3,
    have: 2,
    ok: false,
    capped: true,
  })
  is('uncapped venue needs one card', n.bookingCoverage(4, 0, 1), {
    needed: 1,
    have: 1,
    ok: true,
    capped: false,
  })
  is('no courts needs nothing', n.bookingCoverage(0, 2, 0).needed, 0)

  is('invite codes avoid lookalike characters', /^[A-HJ-NP-Z2-9]{6}$/.test(n.generateInviteCode()), true)
}

COPIES.forEach(([name, rulesPath, formatsPath, namingPath]) => {
  run(
    name,
    require(path.join(__dirname, rulesPath)),
    require(path.join(__dirname, formatsPath)),
    require(path.join(__dirname, namingPath))
  )
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
