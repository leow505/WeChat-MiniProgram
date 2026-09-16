/**
 * Event reads, creation, and organizer actions. DESIGN.md §3.5, §3.6, §4, §5, §7.
 *
 * Reads go through here rather than straight from the client because signups carry
 * openids and membership names carry real names — §11 keeps those collections
 * cloud-function-only.
 */
const rules = require('./rules')
const formats = require('./formats')
const naming = require('./naming')
const clubs = require('./clubs')
const signups = require('./signups')
const { fail } = require('./errors')
const { db, _, signupId, getOrNull } = require('./db')

const ACTIVE_STATES = ['ROSTER', 'WAITLIST']

/** Club ids where the caller is an active member. */
async function myActiveClubIds(openid) {
  const r = await db
    .collection('club_members')
    .where({ openid, status: naming.MemberStatus.ACTIVE })
    .get()
  return r.data.map((m) => m.club_id)
}

/** Shape shared by list and detail, so the two views can't disagree. §5 */
function card(ev, mine) {
  const joined = mine && ACTIVE_STATES.indexOf(mine.state) !== -1
  return Object.assign({}, ev, {
    status: rules.statusOf(ev),
    seats_left: rules.seatsLeft(ev),
    total_seats_left: rules.totalSeatsLeft(ev),
    my_state: joined ? mine.state : null,
    my_guest_count: mine ? (mine.guests || []).length : 0,
  })
}

/**
 * Sessions from clubs the caller actually belongs to. §3.6, §7
 *
 * Deliberately NOT a public feed: browsing strangers' sessions is the deferred
 * community feature (§13), and without it a public session from someone you have
 * no relationship to has no reason to appear here. Such a session is still
 * reachable by its share link — sharing is the distribution mechanism, listing is
 * discovery, and only the latter is on hold.
 *
 * Your own club-less sessions don't need to appear either: creating one enrols you,
 * so they arrive via mineList().
 */
async function list(_payload, openid) {
  const now = Date.now()
  const clubIds = await myActiveClubIds(openid)
  if (!clubIds.length) return []

  const r = await db
    .collection('events')
    .where({ lifecycle: 'ACTIVE', end_at: _.gt(now), club_id: _.in(clubIds) })
    .orderBy('start_at', 'asc')
    .limit(60)
    .get()

  const mine = await db
    .collection('signups')
    .where({ openid, state: _.in(ACTIVE_STATES) })
    .get()
  const byEvent = {}
  mine.data.forEach((s) => {
    byEvent[s.event_id] = s
  })

  return r.data.map((ev) => card(ev, byEvent[ev._id]))
}

async function mineList(_payload, openid) {
  const now = Date.now()
  const rows = await db
    .collection('signups')
    .where({ openid, state: _.in(ACTIVE_STATES) })
    .get()
  if (!rows.data.length) {
    return { upcoming: [], past: [], owing: summarizeOwing([], {}) }
  }

  const ids = rows.data.map((s) => s.event_id)
  const events = await db.collection('events').where({ _id: _.in(ids) }).get()
  const byId = {}
  events.data.forEach((ev) => {
    byId[ev._id] = ev
  })

  /**
   * Unpaid shares ride along. §9.4
   *
   * Without this the only route to a debt is remembering to open the session it came
   * from, which for a finished session means expanding the collapsed history — and a
   * notice nobody finds is not a notice. Enforcement is still deferred (§9.3); this
   * is purely so the money is visible.
   */
  const owedRows = await db
    .collection('bill_shares')
    .where({ openid, event_id: _.in(ids), status: 'UNPAID' })
    .get()
  const owedByEvent = {}
  owedRows.data.forEach((s) => {
    owedByEvent[s.event_id] = s
  })

  /**
   * Whether each of those debts is late, which needs the bill it belongs to: the clock
   * starts at publication, not at play (§9.3). One read for every session owed on, so
   * the list of what you owe can say which ones are overdue instead of leaving that to
   * be discovered a session at a time.
   */
  const owedBills = {}
  const owedIds = Object.keys(owedByEvent)
  if (owedIds.length) {
    const bills = await db.collection('event_bills').where({ _id: _.in(owedIds) }).get()
    bills.data.forEach((b) => {
      owedBills[b._id] = b
    })
  }

  const upcoming = []
  const past = []
  rows.data.forEach((s) => {
    const ev = byId[s.event_id]
    if (!ev) return
    const owed = owedByEvent[s.event_id]
    const bill = owed ? owedBills[s.event_id] : null
    const c = Object.assign(card(ev, s), {
      my_share_minor: owed ? owed.share_minor : 0,
      my_share_status: owed ? owed.status : '',
      my_share_due_at: bill ? bill.due_at || 0 : 0,
      my_share_overdue: !!owed && rules.isShareOverdue(owed, bill ? bill.due_at : 0),
    })
    if (ev.end_at > now) upcoming.push(c)
    else past.push(c)
  })
  upcoming.sort((a, b) => a.start_at - b.start_at)
  past.sort((a, b) => b.start_at - a.start_at)

  return { upcoming, past, owing: summarizeOwing(owedRows.data, byId) }
}

/**
 * What the caller still owes, across sessions. §9.4
 *
 * Currencies are not summed across clubs — a cross-border player could hold shares
 * in two of them, and one number spanning both would be a lie (§10.3). With more
 * than one currency in play the count stands alone and the amounts wait for the
 * per-session view.
 */
function summarizeOwing(shares, eventsById) {
  const byCurrency = {}
  let single = null
  shares.forEach((s) => {
    const ev = eventsById[s.event_id]
    const cur = (ev && ev.currency) || 'CAD'
    byCurrency[cur] = (byCurrency[cur] || 0) + s.share_minor
    single = s
  })
  const currencies = Object.keys(byCurrency)

  return {
    count: shares.length,
    mixed_currency: currencies.length > 1,
    total_minor: currencies.length === 1 ? byCurrency[currencies[0]] : 0,
    currency: currencies.length === 1 ? currencies[0] : '',
    // One outstanding share is the common case, so link straight to it.
    event_id: shares.length === 1 && single ? single.event_id : '',
  }
}

/**
 * Sessions this person runs, and what still wants doing on them. §7, §9
 *
 * The organizer's jobs were only reachable by remembering which session they belonged
 * to and navigating in from the feed — fine when a session was just a roster, not fine
 * once courts and money hang off it. This is the list that answers "what needs me".
 *
 * Scoped to the retention window (§12.1), because a session older than that is about
 * to be purged and nothing can usefully be done to it.
 */
async function hosting(_payload, openid) {
  const now = Date.now()
  const horizon = now - 30 * 24 * rules.HOUR

  const adminRows = await db
    .collection('club_members')
    .where({
      openid,
      status: naming.MemberStatus.ACTIVE,
      role: _.in([naming.Role.OWNER, naming.Role.ADMIN]),
    })
    .get()
  const adminClubIds = adminRows.data.map((m) => m.club_id)

  // Two plain queries rather than one _.or: the shapes differ, and merging by id is
  // clearer than trusting a compound query builder.
  const own = await db
    .collection('events')
    .where({ creator_openid: openid, lifecycle: 'ACTIVE', end_at: _.gt(horizon) })
    .limit(60)
    .get()
  const viaClub = adminClubIds.length
    ? await db
        .collection('events')
        .where({ club_id: _.in(adminClubIds), lifecycle: 'ACTIVE', end_at: _.gt(horizon) })
        .limit(60)
        .get()
    : { data: [] }

  const byId = {}
  own.data.concat(viaClub.data).forEach((ev) => {
    byId[ev._id] = ev
  })
  const events = Object.keys(byId).map((id) => byId[id])
  if (!events.length) return emptyHosting()

  const ids = events.map((ev) => ev._id)
  const bills = await db.collection('event_bills').where({ _id: _.in(ids) }).get()
  const billByEvent = {}
  bills.data.forEach((b) => {
    billByEvent[b.event_id || b._id] = b
  })
  const unpaid = await db
    .collection('bill_shares')
    .where({ event_id: _.in(ids), status: 'UNPAID' })
    .get()
  const unpaidByEvent = {}
  unpaid.data.forEach((s) => {
    const cur = unpaidByEvent[s.event_id] || { count: 0, minor: 0 }
    cur.count += 1
    cur.minor += s.share_minor
    unpaidByEvent[s.event_id] = cur
  })

  return summarizeHosting(events, billByEvent, unpaidByEvent, now)
}

function emptyHosting() {
  return {
    upcoming: [],
    actions: [],
    action_count: 0,
    to_collect: { count: 0, total_minor: 0, currency: '', mixed_currency: false },
  }
}

/**
 * Split what the organizer runs into "waiting on me" and "coming up".
 *
 * Only two things can be waiting: a finished session whose split was never published,
 * and a published one still owed money. Everything else is either upcoming or done, so
 * listing it as an action would train people to ignore the list.
 */
function summarizeHosting(events, billByEvent, unpaidByEvent, now) {
  const upcoming = []
  const actions = []
  const byCurrency = {}

  events
    .slice()
    .sort((a, b) => a.start_at - b.start_at)
    .forEach((ev) => {
      const row = {
        _id: ev._id,
        title: ev.title,
        start_local: ev.start_local,
        end_local: ev.end_local,
        currency: ev.currency || 'CAD',
        roster_count: ev.roster_count,
        capacity: ev.capacity,
        court_status: ev.court_status,
        status: rules.statusOf(ev, now),
      }

      if (ev.end_at > now) {
        upcoming.push(row)
        return
      }

      const bill = billByEvent[ev._id]
      const owed = unpaidByEvent[ev._id]

      if (!bill || bill.status === rules.BillStatus.DRAFT) {
        actions.push(Object.assign({ kind: 'NEEDS_SPLIT', unpaid_minor: 0 }, row))
        return
      }
      if (bill.status === rules.BillStatus.PUBLISHED && owed) {
        byCurrency[row.currency] = (byCurrency[row.currency] || 0) + owed.minor
        actions.push(Object.assign({ kind: 'COLLECTING', unpaid_minor: owed.minor }, row))
      }
    })

  // Newest first: a session that just finished is the one you're thinking about.
  actions.sort((a, b) => (b.start_local > a.start_local ? 1 : -1))

  const currencies = Object.keys(byCurrency)
  return {
    upcoming,
    actions,
    action_count: actions.length,
    // Not summed across currencies, for the same reason as a player's own total
    // (§10.3) — a club abroad and a club at home don't share a unit.
    to_collect: {
      count: actions.filter((a) => a.kind === 'COLLECTING').length,
      mixed_currency: currencies.length > 1,
      total_minor: currencies.length === 1 ? byCurrency[currencies[0]] : 0,
      currency: currencies.length === 1 ? currencies[0] : '',
    },
  }
}

/**
 * Sessions this person has organized, newest first. Feeds the "same as last time"
 * shortcut on the create form (§12.2) — deliberately a thin payload, since it only
 * has to label a chip.
 */
async function myRecent(_payload, openid) {
  const r = await db
    .collection('events')
    .where({ creator_openid: openid })
    .orderBy('created_at', 'desc')
    .limit(5)
    .field({ title: true, format_template: true, start_local: true, venue_snapshot: true })
    .get()

  return {
    recent: r.data.map((ev) => ({
      _id: ev._id,
      title: ev.title,
      format_template: ev.format_template,
      start_local: ev.start_local,
      venue_name: (ev.venue_snapshot || {}).name || '',
    })),
  }
}

async function detail({ eventId }, openid) {
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')

  // Club context drives both visibility and how names are displayed. §3.6, §3.8
  const club = ev.club_id ? await getOrNull('clubs', ev.club_id) : null
  const myMember = ev.club_id ? await clubs.myMembership(ev.club_id, openid) : null
  const isClubAdmin = naming.canAdminClub(myMember)

  if (!naming.canSeeClubEvent(ev, myMember) && ev.creator_openid !== openid) {
    fail('NOT_VISIBLE')
  }

  const rows = await db
    .collection('signups')
    .where({ event_id: eventId, state: _.in(ACTIVE_STATES) })
    .get()

  const openids = rows.data.map((s) => s.openid).concat([ev.creator_openid])
  const users = await clubs.usersByIds(openids)
  const memberships = club
    ? await clubs.membershipsForVenue(club.primary_venue_id, openids)
    : {}
  const memberRows = club
    ? await db
        .collection('club_members')
        .where({ club_id: ev.club_id, openid: _.in(Array.from(new Set(openids))) })
        .get()
    : { data: [] }
  const membersByOpenid = {}
  memberRows.data.forEach((m) => {
    membersByOpenid[m.openid] = m
  })

  const nameOf = (o) =>
    naming.displayName({
      user: users[o],
      member: membersByOpenid[o],
      membership: memberships[o],
      club,
    })

  const view = (s) => ({
    openid: s.openid,
    name: nameOf(s.openid),
    avatar_url: (users[s.openid] && users[s.openid].avatar_url) || '',
    gender: s.gender,
    guest_count: (s.guests || []).length,
    guests: s.guests || [],
    seats: rules.seatsFor(s.guests),
    is_me: s.openid === openid,
    joined_at: s.joined_at,
  })

  const roster = rows.data
    .filter((s) => s.state === 'ROSTER')
    .sort((a, b) => a.joined_at - b.joined_at)
    .map(view)
  const waitlist = rows.data
    .filter((s) => s.state === 'WAITLIST')
    .sort((a, b) => a.queued_at - b.queued_at)
    .map(view)

  const bill = await getOrNull('event_bills', eventId)
  // My own share rides along on the detail read, because the banner that persists
  // until settled (§9.4) has to render on the first paint, not after a second call.
  const myShare =
    bill && bill.status !== 'DRAFT'
      ? await getOrNull('bill_shares', signupId(eventId, openid))
      : null
  const mine = rows.data.find((s) => s.openid === openid) || null
  const myState = mine ? mine.state : null
  const me = users[openid] || (await getOrNull('users', openid))
  const myGender = (me && me.gender) || rules.Gender.UNSPECIFIED
  const canManage = ev.creator_openid === openid || isClubAdmin

  /**
   * Where *this viewer* would land if they joined right now. §3.9
   *
   * Event-level status isn't enough for a balanced roster: a session with female
   * slots free reads as OPEN, but a man tapping 报名 would go to the waitlist. The
   * client needs to say so before he taps, not after.
   */
  const myDemand = rules.demandOf(ev, myGender, [])
  const myAllocation = myDemand ? rules.allocationFor(ev, myDemand, 1) : null

  let myBucket = null
  if (rules.isBalanced(ev) && myGender !== rules.Gender.UNSPECIFIED) {
    const key = myGender === rules.Gender.MALE ? 'male' : 'female'
    const cap = (ev.capacity_by_gender || {})[key] || 0
    const taken = (ev.roster_by_gender || {})[key] || 0
    myBucket = { gender: myGender, taken, cap, full: taken >= cap }
  }

  return Object.assign(card(ev, mine), {
    club_name: club ? club.name : '',
    // Whether the club link on the detail page goes anywhere: its page is members
    // only, so offering the tap to anybody else is a dead end. §3.10
    is_club_member: naming.isActiveMember(myMember),
    organizer_name: nameOf(ev.creator_openid),
    is_organizer: ev.creator_openid === openid,
    can_manage: canManage,
    roster,
    waitlist,
    my_gender: myGender,
    my_waitlist_position:
      myState === 'WAITLIST' ? waitlist.findIndex((p) => p.openid === openid) + 1 : 0,
    can_withdraw: !!myState && rules.canWithdraw(ev),
    withdraw_deadline_at: rules.withdrawDeadlineAt(ev),
    join_deadline_at: rules.joinDeadlineAt(ev),
    needs_gender: rules.isBalanced(ev) && myGender === rules.Gender.UNSPECIFIED,
    my_allocation: myAllocation,
    my_bucket: myBucket,
    // A real total beats the organizer's guess once the courts are paid for. §9.2
    cost_total_minor: bill ? bill.total_minor : 0,
    cost_per_person_minor: bill ? rules.perPersonPreview(bill.total_minor, ev.roster_count) : 0,
    bill_status: bill ? bill.status : '',
    bill_due_at: bill ? bill.due_at || 0 : 0,
    my_share_minor: myShare ? myShare.share_minor : 0,
    my_share_status: myShare ? myShare.status : '',
    my_share_claimed: !!(myShare && myShare.player_claimed_paid_at),
    my_share_overdue: rules.isShareOverdue(myShare, bill ? bill.due_at : 0),
    // Court labels are gated to people actually holding a seat. §3.5
    courts_visible: rules.courtsVisibleTo(ev, myState, canManage),
  })
}

/** Organizer or club admin. */
async function isManager(ev, openid) {
  if (ev.creator_openid === openid) return true
  if (!ev.club_id) return false
  return naming.canAdminClub(await clubs.myMembership(ev.club_id, openid))
}

/** Used by every mutating organizer action. */
async function requireManager(ev, openid) {
  if (!(await isManager(ev, openid))) fail('NOT_ADMIN')
  return true
}

function validate(ev) {
  if (!ev.title || !String(ev.title).trim()) fail('BAD_TITLE')
  if (!ev.venue_snapshot || !ev.venue_snapshot.name) fail('BAD_VENUE')
  if (!(ev.start_at > 0) || !(ev.end_at > ev.start_at)) fail('BAD_TIME')
  if (ev.start_at <= Date.now()) fail('BAD_TIME')
  if (!(ev.capacity > 0)) fail('BAD_CAPACITY')
  if (ev.min_players > ev.capacity) fail('BAD_CAPACITY')
  if (ev.join_deadline_rule === 'AT_TIME') {
    if (!(ev.join_deadline_at > Date.now())) fail('BAD_DEADLINE')
    if (ev.join_deadline_at > ev.start_at) fail('BAD_DEADLINE')
  }
  if (ev.roster_mode === 'GENDER_BALANCED') {
    const g = ev.capacity_by_gender || {}
    if ((g.male || 0) + (g.female || 0) !== ev.capacity) fail('BAD_CAPACITY')
  }
  if (!formats.FORMATS[ev.format_template]) fail('BAD_FORMAT')
}

async function create({ event }, openid) {
  const input = event || {}
  validate(input)

  const clubId = input.club_id || null
  let club = null
  if (clubId) {
    club = await getOrNull('clubs', clubId)
    if (!club) fail('NOT_FOUND')
    const member = await clubs.myMembership(clubId, openid)
    if (!naming.isActiveMember(member)) fail('NOT_MEMBER')
    // A members-only session is a club-admin act. §1
    if (input.visibility === 'CLUB_ONLY' && !naming.canAdminClub(member)) fail('NOT_ADMIN')
  }

  const now = Date.now()
  const balanced = input.roster_mode === 'GENDER_BALANCED'

  // Whitelist rather than spread: the client must not set counters, lifecycle,
  // or creator.
  const doc = {
    club_id: clubId,
    series_id: null,
    creator_openid: openid,
    title: String(input.title).trim(),
    venue_id: input.venue_id || null,
    venue_snapshot: {
      name: input.venue_snapshot.name,
      address: input.venue_snapshot.address || '',
      tz_label: input.venue_snapshot.tz_label || '',
    },
    start_at: input.start_at,
    end_at: input.end_at,
    start_local: input.start_local || '',
    end_local: input.end_local || '',
    format_template: input.format_template,
    roster_mode: balanced ? 'GENDER_BALANCED' : 'OPEN',
    capacity: input.capacity,
    capacity_by_gender: balanced ? input.capacity_by_gender : null,
    roster_by_gender: { male: 0, female: 0 },
    waitlist_by_gender: { male: 0, female: 0 },
    court_count: input.court_count || null,
    court_status: 'NOT_BOOKED',
    court_assignments: [],
    courts_visible_to: 'ROSTER',
    min_players: input.min_players || 0,
    max_guests_per_member: Math.min(3, Math.max(0, input.max_guests_per_member || 0)),
    on_full: input.on_full === 'CLOSE' ? 'CLOSE' : 'WAITLIST',
    waitlist_capacity: input.waitlist_capacity || 0,
    signup_open_at: input.signup_open_at || now,
    join_deadline_rule: input.join_deadline_rule === 'AT_TIME' ? 'AT_TIME' : 'AT_EVENT_START',
    join_deadline_at: input.join_deadline_at || null,
    // Wall clock as well as UTC: §10.2 renders from the string, never the stamp.
    // AT_EVENT_START needs none — the deadline is start_local.
    join_deadline_local:
      input.join_deadline_rule === 'AT_TIME' ? input.join_deadline_local || '' : '',
    withdraw_rule: input.withdraw_rule || 'HOURS_BEFORE_START',
    withdraw_hours_before: input.withdraw_hours_before == null ? 6 : input.withdraw_hours_before,
    visibility: input.visibility === 'CLUB_ONLY' && clubId ? 'CLUB_ONLY' : 'PUBLIC',
    currency: (club && club.currency) || input.currency || 'CAD',
    cost_estimate_per_person: input.cost_estimate_per_person || 0,
    cost_note: input.cost_note || '',
    level_hint: input.level_hint || 'ANY',
    lifecycle: 'ACTIVE',
    roster_count: 0,
    waitlist_count: 0,
    created_at: now,
    updated_at: now,
  }

  const added = await db.collection('events').add({ data: doc })
  const eventId = added._id

  // The organizer goes on their own list — they're the one booking the court. A
  // balanced format can't seat an undeclared gender, so skip rather than corrupt
  // a bucket.
  const me = await getOrNull('users', openid)
  const gender = (me && me.gender) || rules.Gender.UNSPECIFIED
  const demand = rules.demandOf(doc, gender, [])

  if (demand) {
    const sid = signupId(eventId, openid)
    await db.collection('signups').doc(sid).set({
      data: {
        _id: sid,
        event_id: eventId,
        club_id: clubId,
        openid,
        gender,
        state: 'ROSTER',
        guests: [],
        joined_at: now,
        queued_at: null,
        state_changed_at: now,
        attendance: 'UNKNOWN',
        withdraw_was_late: false,
      },
    })
    const patch = { roster_count: _.inc(1) }
    if (demand.any == null) {
      patch['roster_by_gender.male'] = _.inc(demand.male)
      patch['roster_by_gender.female'] = _.inc(demand.female)
    }
    await db.collection('events').doc(eventId).update({ data: patch })
  }

  return { eventId }
}

/**
 * Prefill for "same as last Thursday". §12.2
 *
 * Returns settings only — no date, no roster, no courts — because the whole point
 * is that the organizer changes the date and nothing else.
 */
async function duplicate({ eventId }, openid) {
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')
  await requireManager(ev, openid)

  return {
    prefill: {
      club_id: ev.club_id,
      title: ev.title,
      venue_id: ev.venue_id,
      venue_snapshot: ev.venue_snapshot,
      format_template: ev.format_template,
      roster_mode: ev.roster_mode,
      capacity: ev.capacity,
      capacity_by_gender: ev.capacity_by_gender,
      court_count: ev.court_count,
      min_players: ev.min_players,
      max_guests_per_member: ev.max_guests_per_member,
      on_full: ev.on_full,
      join_deadline_rule: ev.join_deadline_rule,
      withdraw_rule: ev.withdraw_rule,
      withdraw_hours_before: ev.withdraw_hours_before,
      visibility: ev.visibility,
      cost_estimate_per_person: ev.cost_estimate_per_person,
      level_hint: ev.level_hint,
      duration_hours: Math.round(((ev.end_at - ev.start_at) / rules.HOUR) * 2) / 2,
    },
  }
}

/**
 * Apply a capacity change, bumping whoever no longer fits. §3.5
 *
 * Shared by the court flow — fewer courts secured than planned — and by a deliberate
 * roster change from the manage screen, because the consequence is identical either way
 * and LIFO bumping is not a thing to implement twice.
 *
 * Writes the resulting counters into `data` and reports what it moved.
 */
async function applyCapacityChange(ev, data, capacity, capacityByGender) {
  const balanced = rules.isBalanced(ev)
  const nextCapacity = capacity == null ? ev.capacity : Math.max(1, Number(capacity) || 0)
  const nextByGender = balanced ? capacityByGender || ev.capacity_by_gender : null

  if (balanced && nextByGender) {
    if ((nextByGender.male || 0) + (nextByGender.female || 0) !== nextCapacity) {
      fail('BAD_CAPACITY')
    }
  }

  const shrinking =
    nextCapacity < ev.capacity ||
    (balanced &&
      nextByGender &&
      ((nextByGender.male || 0) < (ev.capacity_by_gender || {}).male ||
        (nextByGender.female || 0) < (ev.capacity_by_gender || {}).female))

  let bumped = []
  if (shrinking) {
    const rosterRows = await db
      .collection('signups')
      .where({ event_id: ev._id, state: 'ROSTER' })
      .get()

    const plan = rules.planCapacityBump(ev, rosterRows.data, nextCapacity, nextByGender)
    bumped = plan.bumped

    // Bumped parties go to the FRONT of the waitlist — they had a seat and lost it to
    // a decision they didn't make, so they outrank people who were already queuing.
    const now = Date.now()
    for (let i = 0; i < bumped.length; i++) {
      const row = rosterRows.data.find((r) => r._id === bumped[i])
      const seats = rules.seatsFor(row.guests)
      await db.collection('signups').doc(bumped[i]).update({
        data: {
          state: 'WAITLIST',
          queued_at: row.joined_at - rules.HOUR, // ahead of the existing queue
          state_changed_at: now,
        },
      })
      await db.collection('events').doc(ev._id).update({
        data: { waitlist_count: _.inc(seats) },
      })
    }

    data.roster_count = plan.seated
    data.roster_by_gender = plan.by_gender
  }

  data.capacity = nextCapacity
  if (balanced) data.capacity_by_gender = nextByGender

  return { bumped, shrinking }
}

/**
 * Change a live session's signup rules. §3.1, §3.2, §3.4
 *
 * All of these were fixed at creation, which is exactly wrong for the case they most
 * need to serve: on the day, more people want to play than the original plan allowed.
 * Without this the organizer's only move is to cancel and repost, which throws away the
 * roster and everyone's place in the queue.
 *
 * Reopening needs no new state — status is derived (§5), so a deadline moved into the
 * future turns SIGNUP_CLOSED back into OPEN by itself. What it does need is a promotion
 * pass, because `fillVacancies` refuses to promote while the deadline has passed: any
 * party that queued in the meantime is still sitting there.
 */
async function updateRules(payload, openid) {
  const { eventId } = payload
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')
  await requireManager(ev, openid)
  // A cancelled session has no rules worth editing; reposting is the move.
  if (ev.lifecycle !== 'ACTIVE') fail('NOT_ACTIVE')

  const data = { updated_at: Date.now() }

  if (payload.join_deadline_rule !== undefined) {
    const rule = payload.join_deadline_rule === 'AT_TIME' ? 'AT_TIME' : 'AT_EVENT_START'
    data.join_deadline_rule = rule
    if (rule === 'AT_TIME') {
      const at = Number(payload.join_deadline_at) || 0
      if (!(at > 0)) fail('BAD_DEADLINE')
      // §3.1 caps it at the start: signing up after the session began is meaningless.
      if (at > ev.start_at) fail('BAD_DEADLINE')
      data.join_deadline_at = at
      data.join_deadline_local = String(payload.join_deadline_local || '')
    } else {
      data.join_deadline_at = null
      data.join_deadline_local = ''
    }
  }

  if (payload.withdraw_rule !== undefined) {
    const r = payload.withdraw_rule
    if (['HOURS_BEFORE_START', 'SAME_AS_JOIN_DEADLINE', 'AT_EVENT_START'].indexOf(r) === -1) {
      fail('BAD_WITHDRAW_RULE')
    }
    data.withdraw_rule = r
  }
  if (payload.withdraw_hours_before !== undefined) {
    data.withdraw_hours_before = Math.max(0, Math.min(72, Number(payload.withdraw_hours_before) || 0))
  }
  if (payload.min_players !== undefined) {
    data.min_players = Math.max(0, Number(payload.min_players) || 0)
  }
  if (payload.max_guests_per_member !== undefined) {
    data.max_guests_per_member = Math.min(3, Math.max(0, Number(payload.max_guests_per_member) || 0))
  }

  const cap = await applyCapacityChange(ev, data, payload.capacity, payload.capacity_by_gender)

  const nextMin = data.min_players == null ? ev.min_players : data.min_players
  if (nextMin > data.capacity) fail('BAD_CAPACITY')

  await db.collection('events').doc(eventId).update({ data })

  // Both growing the roster and reopening the deadline can admit waitlisted parties.
  // Shrinking already did its bumping above, so there is nothing left to fill.
  const promoted = cap.shrinking ? [] : await signups.fillVacancies(eventId)
  return { bumped_count: cap.bumped.length, promoted }
}

/**
 * Record the court booking, and adjust capacity if fewer courts were secured
 * than planned. §3.5
 */
async function setCourts(payload, openid) {
  const { eventId, court_assignments, court_count, capacity, capacity_by_gender, total_cost_minor } = payload
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')
  await requireManager(ev, openid)

  const assignments = (Array.isArray(court_assignments) ? court_assignments : [])
    .filter((c) => c && String(c.label || '').trim())
    .slice(0, 40)
    .map((c) => ({
      label: String(c.label).trim().slice(0, 24),
      start_at: c.start_at || null,
      end_at: c.end_at || null,
      note: String(c.note || '').slice(0, 60),
      booked_with_membership_openid: c.booked_with_membership_openid || null,
    }))

  const data = {
    court_assignments: assignments,
    /**
     * The labels are the booking. Writing "Court 3, Court 5" is what having courts
     * means, so the status follows them rather than being a second thing to keep in
     * step — an organizer who booked and forgot to flip a segmented control used to
     * leave everyone reading "not booked" under two named courts.
     */
    court_status: assignments.length ? 'CONFIRMED' : 'NOT_BOOKED',
    updated_at: Date.now(),
  }
  if (court_count != null) data.court_count = Math.max(0, Number(court_count) || 0)

  const cap = await applyCapacityChange(ev, data, capacity, capacity_by_gender)
  const bumped = cap.bumped
  const shrinking = cap.shrinking

  await db.collection('events').doc(eventId).update({ data })

  /**
   * The paid total is captured here rather than after play, because this is the
   * moment the organizer has the receipt. It lands in a DRAFT bill (§9.1); publishing
   * the split is a separate act after play, so a draft carries a number and no
   * obligations.
   */
  if (total_cost_minor != null) {
    const total = Math.max(0, Math.round(Number(total_cost_minor) || 0))
    const existing = await getOrNull('event_bills', eventId)
    const now = Date.now()

    // Never quietly rewrite a bill people are already paying against.
    if (existing && existing.status !== 'DRAFT') fail('BILL_ALREADY_PUBLISHED')

    const data = {
      event_id: eventId,
      club_id: ev.club_id || null,
      total_minor: total,
      currency: ev.currency || 'CAD',
      status: 'DRAFT',
      created_by: openid,
      updated_at: now,
    }
    if (existing) {
      await db.collection('event_bills').doc(eventId).update({ data })
    } else {
      await db
        .collection('event_bills')
        .doc(eventId)
        .set({ data: Object.assign({ _id: eventId, created_at: now }, data) })
    }
  }

  // Growing capacity can admit waitlisted parties.
  const promoted = shrinking ? [] : await signups.fillVacancies(eventId)
  return { bumped_count: bumped.length, promoted }
}

/** Organizer removes someone; the freed seat goes to the waitlist. §7 */
async function removeSignup({ eventId, targetOpenid }, openid) {
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')
  await requireManager(ev, openid)
  if (targetOpenid === ev.creator_openid) fail('CANNOT_REMOVE_ORGANIZER')

  const promoted = await signups.forceRemove(eventId, targetOpenid)
  return { promoted }
}

async function cancel({ eventId }, openid) {
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')
  await requireManager(ev, openid)

  await db
    .collection('events')
    .doc(eventId)
    .update({ data: { lifecycle: 'CANCELLED', updated_at: Date.now() } })
  return { ok: true }
}

module.exports = {
  list,
  mineList,
  hosting,
  myRecent,
  detail,
  create,
  duplicate,
  setCourts,
  updateRules,
  removeSignup,
  cancel,
  isManager,
  requireManager,
}
