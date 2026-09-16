/**
 * Local mock backend — the same action surface as cloudfunctions/api.
 *
 * Enforces the same rules (rules.js / naming.js are the shared, duplicated
 * sources) but skips §6's transactions: a single-threaded mock has no concurrent
 * writers, which is exactly why the real backend needs them and this doesn't.
 *
 * Failures are thrown as codes, matching the server contract in §10.1, so the UI's
 * localization path gets exercised too.
 */
const rules = require('./rules')
const naming = require('./naming')
const store = require('./mock-store')

const DEFAULT_ACTOR_ID = store.ME
let currentActorId = DEFAULT_ACTOR_ID

const actorId = () => currentActorId
const now = store.now

function fail(code) {
  const err = new Error(code)
  err.code = code
  return Promise.reject(err)
}

function ensureActor(db) {
  const id = actorId()
  if (db.users[id]) return db.users[id]

  const timestamp = now()
  db.users[id] = {
    _id: id,
    nickname: '',
    avatar_url: '',
    gender: rules.Gender.UNSPECIFIED,
    locale: '',
    events_played: 0,
    no_shows: 0,
    late_withdrawals: 0,
    total_paid_minor: 0,
    created_at: timestamp,
    updated_at: timestamp,
  }
  return db.users[id]
}

// --- ids -------------------------------------------------------------------
const sid = (eventId, openid) => `${eventId}_${openid}`
const mid = (clubId, openid) => `${clubId}_${openid}`
const vmid = (openid, venueId) => `${openid}_${venueId}`

// --- shared helpers --------------------------------------------------------

function activeSignups(db, eventId) {
  return Object.values(db.signups).filter(
    (s) => s.event_id === eventId && (s.state === 'ROSTER' || s.state === 'WAITLIST')
  )
}

function myMember(db, clubId, openid) {
  return clubId ? db.club_members[mid(clubId, openid)] || null : null
}

function myActiveClubIds(db, openid) {
  return Object.values(db.club_members)
    .filter((m) => m.openid === openid && m.status === 'ACTIVE')
    .map((m) => m.club_id)
}

/** Display name resolution, club-aware. §3.8 */
function nameFor(db, openid, club) {
  const user = db.users[openid]
  const member = club ? db.club_members[mid(club._id, openid)] : null
  const membership = club && club.primary_venue_id
    ? db.venue_memberships[vmid(openid, club.primary_venue_id)]
    : null
  const resolved = naming.displayName({ user, member, membership, club })
  if (resolved) return resolved
  return openid === actorId() ? 'Me' : 'Player'
}

function applyCounts(ev, target, demand, seats, sign) {
  if (target === 'ROSTER') {
    ev.roster_count += sign * seats
    if (demand && demand.any == null) {
      ev.roster_by_gender.male += sign * demand.male
      ev.roster_by_gender.female += sign * demand.female
    }
  } else {
    ev.waitlist_count += sign * seats
  }
}

/**
 * Apply a capacity change, bumping whoever no longer fits. §3.5
 *
 * Shared by the court flow — fewer courts secured than planned — and by a deliberate
 * roster change from the manage screen, because the consequence is identical either way
 * and LIFO bumping is not a thing to implement twice.
 */
function applyCapacityChange(db, ev, nextCapacity, nextByGender) {
  const balanced = rules.isBalanced(ev)
  const oldByGender = ev.capacity_by_gender || { male: 0, female: 0 }
  const shrinking =
    nextCapacity < ev.capacity ||
    (balanced &&
      nextByGender &&
      ((nextByGender.male || 0) < oldByGender.male ||
        (nextByGender.female || 0) < oldByGender.female))

  let bumped = []
  if (shrinking) {
    const rosterRows = Object.values(db.signups).filter(
      (s) => s.event_id === ev._id && s.state === 'ROSTER'
    )
    const plan = rules.planCapacityBump(ev, rosterRows, nextCapacity, nextByGender)
    bumped = plan.bumped

    // Bumped parties go to the FRONT of the queue — they held a seat and lost it to a
    // decision they didn't make, so they outrank people already waiting. §3.5
    bumped.forEach((rid) => {
      const row = db.signups[rid]
      row.state = 'WAITLIST'
      row.queued_at = row.joined_at - rules.HOUR
      row.state_changed_at = now()
      ev.waitlist_count += rules.seatsFor(row.guests)
    })

    ev.roster_count = plan.seated
    ev.roster_by_gender = plan.by_gender
  }

  ev.capacity = nextCapacity
  if (balanced) ev.capacity_by_gender = nextByGender
  return { bumped, shrinking }
}

/** Promote the first waitlisted party that fits the gap. §3.9 leapfrog rule */
function promoteFromWaitlist(db, ev) {
  if (now() >= rules.joinDeadlineAt(ev)) return []

  const queue = Object.values(db.signups)
    .filter((s) => s.event_id === ev._id && s.state === 'WAITLIST')
    .sort((a, b) => a.queued_at - b.queued_at)

  const promoted = []
  for (const s of queue) {
    const demand = rules.demandOf(ev, s.gender, s.guests)
    if (!demand || !rules.fitsGap(ev, demand)) continue

    const seats = rules.seatsFor(s.guests)
    applyCounts(ev, 'WAITLIST', demand, seats, -1)
    applyCounts(ev, 'ROSTER', demand, seats, +1)
    s.state = 'ROSTER'
    s.promoted_at = now()
    s.state_changed_at = now()
    s.queued_at = null
    promoted.push(s.openid)
  }
  return promoted
}

function eventCard(db, ev) {
  const mine = db.signups[sid(ev._id, actorId())]
  const joined = mine && (mine.state === 'ROSTER' || mine.state === 'WAITLIST')
  return Object.assign({}, ev, {
    status: rules.statusOf(ev),
    seats_left: rules.seatsLeft(ev),
    total_seats_left: rules.totalSeatsLeft(ev),
    my_state: joined ? mine.state : null,
    my_guest_count: mine ? mine.guests.length : 0,
    club_name: ev.club_id && db.clubs[ev.club_id] ? db.clubs[ev.club_id].name : '',
  })
}

function canManage(db, ev, openid) {
  if (ev.creator_openid === openid) return true
  return naming.canAdminClub(myMember(db, ev.club_id, openid))
}

function membershipsForVenue(db, venueId, openids) {
  const out = {}
  if (!venueId) return out
  openids.forEach((o) => {
    const m = db.venue_memberships[vmid(o, venueId)]
    if (m) out[o] = m
  })
  return out
}

// --- bills -----------------------------------------------------------------

const DEFAULT_GRACE_HOURS = 12

/** The two rates a split depends on, resolved the same way for every bill action. */
function billContext(db, eventId) {
  const ev = db.events[eventId]
  if (!ev) return null
  const club = ev.club_id ? db.clubs[ev.club_id] : null
  const venue = ev.venue_id ? db.venues[ev.venue_id] : null
  return {
    ev,
    club,
    venue,
    // The venue decides what a guest costs, not the event. §3.7
    surcharge_minor:
      venue && venue.guest_policy === 'SURCHARGE' ? venue.guest_surcharge_minor || 0 : 0,
    grace_hours: (club && club.settlement_grace_hours) || DEFAULT_GRACE_HOURS,
  }
}

function eventSignups(db, eventId) {
  return Object.values(db.signups).filter((s) => s.event_id === eventId)
}

function eventShares(db, eventId) {
  return Object.values(db.bill_shares || {}).filter((s) => s.event_id === eventId)
}

/** Recomputed from the shares, never incremented — no counter to drift. §9.1 */
function refreshBillStatus(db, eventId) {
  const bill = db.event_bills[eventId]
  bill.status = rules.isBillSettled(eventShares(db, eventId)) ? 'SETTLED' : 'PUBLISHED'
  bill.updated_at = now()
  return bill.status
}

function setShareStatus(db, eventId, targetOpenid, status) {
  const ev = db.events[eventId]
  if (!ev) return fail('NOT_FOUND')
  if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')

  const bill = (db.event_bills || {})[eventId]
  if (!bill) return fail('NOT_FOUND')
  if (bill.status === 'VOID') return fail('BILL_VOID')
  if (bill.status === 'DRAFT') return fail('BILL_NOT_PUBLISHED')

  const share = (db.bill_shares || {})[sid(eventId, targetOpenid)]
  if (!share) return fail('NOT_FOUND')

  const paid = status === 'PAID'
  share.status = status
  share.marked_paid_by = paid ? actorId() : null
  share.marked_paid_at = paid ? now() : null
  share.updated_at = now()

  return { status, bill_status: refreshBillStatus(db, eventId) }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

const actions = {
  // --- profile -------------------------------------------------------------
  'profile.get'(db) {
    const u = ensureActor(db)
    return Object.assign({}, u, { needs_setup: !u.nickname })
  },

  'profile.upsert'(db, patch) {
    const u = ensureActor(db)
    if (patch.nickname !== undefined) u.nickname = patch.nickname
    if (patch.avatar_url !== undefined) u.avatar_url = patch.avatar_url
    if (patch.gender !== undefined) u.gender = patch.gender
    u.updated_at = now()
    return Object.assign({}, u, { needs_setup: !u.nickname })
  },

  // --- events --------------------------------------------------------------
  /**
   * Sessions from clubs the caller belongs to — not a public feed. Browsing
   * strangers' sessions is the deferred community feature (§13); a public session
   * stays reachable by share link, just not listed. §3.6, §7
   */
  'event.list'(db) {
    const t = now()
    const clubIds = myActiveClubIds(db, actorId())
    if (!clubIds.length) return []

    return Object.values(db.events)
      .filter(
        (ev) =>
          ev.lifecycle === 'ACTIVE' && ev.end_at > t && clubIds.indexOf(ev.club_id) !== -1
      )
      .sort((a, b) => a.start_at - b.start_at)
      .map((ev) => eventCard(db, ev))
  },

  'event.mine'(db) {
    const t = now()
    const upcoming = []
    const past = []

    /**
     * Unpaid shares ride along. §9.4 — otherwise the only route to a debt is
     * remembering to open the session it came from, and for a finished session that
     * means expanding the collapsed history. A notice nobody finds is not a notice.
     */
    const owed = Object.values(db.bill_shares || {}).filter(
      (s) => s.openid === actorId() && s.status === 'UNPAID'
    )
    const owedByEvent = {}
    owed.forEach((s) => {
      owedByEvent[s.event_id] = s
    })

    Object.values(db.signups)
      .filter((s) => s.openid === actorId() && (s.state === 'ROSTER' || s.state === 'WAITLIST'))
      .forEach((s) => {
        const ev = db.events[s.event_id]
        if (!ev) return
        const mine = owedByEvent[s.event_id]
        const bill = mine ? db.event_bills[s.event_id] : null
        const card = Object.assign(eventCard(db, ev), {
          my_state: s.state,
          my_share_minor: mine ? mine.share_minor : 0,
          my_share_status: mine ? mine.status : '',
          // Late is measured from publication, not from play. §9.3
          my_share_due_at: bill ? bill.due_at || 0 : 0,
          my_share_overdue: !!mine && rules.isShareOverdue(mine, bill ? bill.due_at : 0),
        })
        ;(ev.end_at > t ? upcoming : past).push(card)
      })
    upcoming.sort((a, b) => a.start_at - b.start_at)
    past.sort((a, b) => b.start_at - a.start_at)

    /**
     * Currencies are not summed across clubs: a cross-border player could hold
     * shares in two, and one number spanning both would be a lie (§10.3).
     */
    const byCurrency = {}
    owed.forEach((s) => {
      const cur = (db.events[s.event_id] || {}).currency || 'CAD'
      byCurrency[cur] = (byCurrency[cur] || 0) + s.share_minor
    })
    const currencies = Object.keys(byCurrency)

    return {
      upcoming,
      past,
      owing: {
        count: owed.length,
        mixed_currency: currencies.length > 1,
        total_minor: currencies.length === 1 ? byCurrency[currencies[0]] : 0,
        currency: currencies.length === 1 ? currencies[0] : '',
        // One outstanding share is the common case, so link straight to it.
        event_id: owed.length === 1 ? owed[0].event_id : '',
      },
    }
  },

  /**
   * Sessions I run, and what still wants doing on them. §7, §9
   *
   * The organizer's jobs used to be reachable only by remembering which session they
   * belonged to and navigating in from the feed — fine when a session was just a
   * roster, not fine once courts and money hang off it.
   *
   * Scoped to the retention window (§12.1): a session past it is about to be purged,
   * so nothing useful can be done to it.
   */
  'event.hosting'(db) {
    const t = now()
    const horizon = t - 30 * 24 * rules.HOUR

    const events = Object.values(db.events).filter(
      (ev) =>
        ev.lifecycle === 'ACTIVE' && ev.end_at > horizon && canManage(db, ev, actorId())
    )

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
          status: rules.statusOf(ev),
        }
        if (ev.end_at > t) {
          upcoming.push(row)
          return
        }

        /**
         * Only two things can actually be waiting on the organizer: a finished
         * session whose split was never published, and a published one still owed
         * money. Listing anything else would train people to ignore the list.
         */
        const bill = (db.event_bills || {})[ev._id]
        if (!bill || bill.status === 'DRAFT') {
          actions.push(Object.assign({ kind: 'NEEDS_SPLIT', unpaid_minor: 0 }, row))
          return
        }
        if (bill.status === 'PUBLISHED') {
          const owed = eventShares(db, ev._id).filter((s) => s.status === 'UNPAID')
          if (!owed.length) return
          const minor = owed.reduce((n, s) => n + s.share_minor, 0)
          byCurrency[row.currency] = (byCurrency[row.currency] || 0) + minor
          actions.push(Object.assign({ kind: 'COLLECTING', unpaid_minor: minor }, row))
        }
      })

    // Newest first: the session that just finished is the one you're thinking about.
    actions.sort((a, b) => (b.start_local > a.start_local ? 1 : -1))

    const currencies = Object.keys(byCurrency)
    return {
      upcoming,
      actions,
      action_count: actions.length,
      // Not summed across currencies, same reason as a player's own total (§10.3).
      to_collect: {
        count: actions.filter((a) => a.kind === 'COLLECTING').length,
        mixed_currency: currencies.length > 1,
        total_minor: currencies.length === 1 ? byCurrency[currencies[0]] : 0,
        currency: currencies.length === 1 ? currencies[0] : '',
      },
    }
  },

  /** Feeds the "same as last time" shortcut on the create form. §12.2 */
  'event.myRecent'(db) {
    return {
      recent: Object.values(db.events)
        .filter((ev) => ev.creator_openid === actorId())
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 5)
        .map((ev) => ({
          _id: ev._id,
          title: ev.title,
          format_template: ev.format_template,
          start_local: ev.start_local,
          venue_name: (ev.venue_snapshot || {}).name || '',
        })),
    }
  },

  'event.detail'(db, { eventId }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')

    const club = ev.club_id ? db.clubs[ev.club_id] : null
    const member = myMember(db, ev.club_id, actorId())
    if (!naming.canSeeClubEvent(ev, member) && ev.creator_openid !== actorId()) {
      return fail('NOT_VISIBLE')
    }

    const all = activeSignups(db, eventId)
    const view = (s) => ({
      openid: s.openid,
      name: nameFor(db, s.openid, club),
      avatar_url: (db.users[s.openid] || {}).avatar_url || '',
      gender: s.gender,
      guest_count: s.guests.length,
      guests: s.guests,
      seats: rules.seatsFor(s.guests),
      is_me: s.openid === actorId(),
      joined_at: s.joined_at,
    })

    const roster = all
      .filter((s) => s.state === 'ROSTER')
      .sort((a, b) => a.joined_at - b.joined_at)
      .map(view)
    const waitlist = all
      .filter((s) => s.state === 'WAITLIST')
      .sort((a, b) => a.queued_at - b.queued_at)
      .map(view)

    const bill = (db.event_bills || {})[eventId]
    // My own share rides along, because the banner that persists until settled
    // (§9.4) has to render on the first paint rather than after a second call.
    const myShare =
      bill && bill.status !== 'DRAFT' ? (db.bill_shares || {})[sid(eventId, actorId())] : null
    const mine = db.signups[sid(eventId, actorId())]
    const myState = mine && (mine.state === 'ROSTER' || mine.state === 'WAITLIST') ? mine.state : null
    const myGender = db.users[actorId()].gender
    const manage = canManage(db, ev, actorId())

    // Where *this viewer* would land if they joined now — event status alone can't
    // say, because a balanced roster with female slots free still reads OPEN to a
    // man who would actually be waitlisted. §3.9
    const myDemand = rules.demandOf(ev, myGender, [])
    const myAllocation = myDemand ? rules.allocationFor(ev, myDemand, 1) : null

    let myBucket = null
    if (rules.isBalanced(ev) && myGender !== 'UNSPECIFIED') {
      const key = myGender === 'MALE' ? 'male' : 'female'
      const cap = (ev.capacity_by_gender || {})[key] || 0
      const taken = (ev.roster_by_gender || {})[key] || 0
      myBucket = { gender: myGender, taken, cap, full: taken >= cap }
    }

    return Object.assign(eventCard(db, ev), {
      organizer_name: nameFor(db, ev.creator_openid, club),
      // The club page is members only, so only a member gets a link to it. §3.10
      is_club_member: naming.isActiveMember(myMember(db, ev.club_id, actorId())),
      is_organizer: ev.creator_openid === actorId(),
      can_manage: manage,
      roster,
      waitlist,
      my_state: myState,
      my_gender: myGender,
      my_waitlist_position: myState === 'WAITLIST' ? waitlist.findIndex((p) => p.openid === actorId()) + 1 : 0,
      can_withdraw: !!myState && rules.canWithdraw(ev),
      withdraw_deadline_at: rules.withdrawDeadlineAt(ev),
      join_deadline_at: rules.joinDeadlineAt(ev),
      needs_gender: rules.isBalanced(ev) && myGender === 'UNSPECIFIED',
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
      courts_visible: rules.courtsVisibleTo(ev, myState, manage),
    })
  },

  'event.create'(db, { event }) {
    const input = event || {}
    const clubId = input.club_id || null

    if (clubId) {
      const club = db.clubs[clubId]
      if (!club) return fail('NOT_FOUND')
      const member = myMember(db, clubId, actorId())
      if (!naming.isActiveMember(member)) return fail('NOT_MEMBER')
      if (input.visibility === 'CLUB_ONLY' && !naming.canAdminClub(member)) return fail('NOT_ADMIN')
    }

    const id = store.newId('e')
    const me = db.users[actorId()]
    const balanced = input.roster_mode === 'GENDER_BALANCED'

    db.events[id] = Object.assign(
      {
        _id: id,
        club_id: clubId,
        series_id: null,
        creator_openid: actorId(),
        court_status: 'NOT_BOOKED',
        court_assignments: [],
        courts_visible_to: 'ROSTER',
        waitlist_capacity: 0,
        lifecycle: 'ACTIVE',
        currency: (clubId && db.clubs[clubId].currency) || 'CAD',
        roster_count: 0,
        waitlist_count: 0,
        roster_by_gender: { male: 0, female: 0 },
        waitlist_by_gender: { male: 0, female: 0 },
        created_at: now(),
        updated_at: now(),
      },
      input,
      {
        visibility: input.visibility === 'CLUB_ONLY' && clubId ? 'CLUB_ONLY' : 'PUBLIC',
        join_deadline_local:
          input.join_deadline_rule === 'AT_TIME' ? input.join_deadline_local || '' : '',
      }
    )

    const ev = db.events[id]
    const demand = rules.demandOf(ev, me.gender, [])
    if (demand) {
      db.signups[sid(id, actorId())] = {
        _id: sid(id, actorId()),
        event_id: id,
        club_id: clubId,
        openid: actorId(),
        gender: me.gender,
        state: 'ROSTER',
        guests: [],
        joined_at: now(),
        queued_at: null,
        state_changed_at: now(),
        attendance: 'UNKNOWN',
        withdraw_was_late: false,
      }
      applyCounts(ev, 'ROSTER', demand, 1, +1)
    }

    return { eventId: id }
  },

  'event.join'(db, { eventId, guests = [] }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')

    const member = myMember(db, ev.club_id, actorId())
    if (!naming.canSeeClubEvent(ev, member)) return fail('NOT_VISIBLE')
    if (!rules.isJoinable(ev)) return fail('CLOSED')

    const maxGuests = ev.max_guests_per_member || 0
    if (guests.length > maxGuests) return fail(maxGuests === 0 ? 'NO_GUESTS' : 'TOO_MANY_GUESTS')

    const existing = db.signups[sid(eventId, actorId())]
    if (existing && (existing.state === 'ROSTER' || existing.state === 'WAITLIST')) {
      return fail('ALREADY_JOINED')
    }

    const me = db.users[actorId()]
    const demand = rules.demandOf(ev, me.gender, guests)
    if (!demand) return fail('GENDER_REQUIRED')

    const seats = rules.seatsFor(guests)
    const target = rules.allocationFor(ev, demand, seats)
    if (!target) return fail(rules.totalSeatsLeft(ev) > 0 ? 'PARTY_TOO_BIG' : 'FULL')

    db.signups[sid(eventId, actorId())] = {
      _id: sid(eventId, actorId()),
      event_id: eventId,
      club_id: ev.club_id,
      openid: actorId(),
      gender: me.gender,
      state: target,
      guests,
      joined_at: existing ? existing.joined_at : now(),
      queued_at: target === 'WAITLIST' ? now() : null,
      state_changed_at: now(),
      attendance: 'UNKNOWN',
      withdraw_was_late: false,
    }
    applyCounts(ev, target, demand, seats, +1)
    return { state: target, seats }
  },

  'event.withdraw'(db, { eventId }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    const s = db.signups[sid(eventId, actorId())]
    if (!s || (s.state !== 'ROSTER' && s.state !== 'WAITLIST')) return fail('NOT_JOINED')
    if (!rules.canWithdraw(ev)) return fail('WITHDRAW_CLOSED')

    const demand = rules.demandOf(ev, s.gender, s.guests)
    const seats = rules.seatsFor(s.guests)
    const wasRoster = s.state === 'ROSTER'
    applyCounts(ev, s.state, demand, seats, -1)

    s.state = 'WITHDRAWN'
    s.withdrawn_at = now()
    s.state_changed_at = now()
    s.queued_at = null
    s.withdraw_was_late = rules.isLateWithdrawal(ev)

    const promoted = wasRoster ? promoteFromWaitlist(db, ev) : []
    return { promoted, was_late: s.withdraw_was_late }
  },

  /** §3.7 — reducing frees seats and can admit a waitlisted party. */
  'event.updateGuests'(db, { eventId, guests = [] }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!rules.isJoinable(ev)) return fail('CLOSED')

    const maxGuests = ev.max_guests_per_member || 0
    if (guests.length > maxGuests) return fail(maxGuests === 0 ? 'NO_GUESTS' : 'TOO_MANY_GUESTS')

    const s = db.signups[sid(eventId, actorId())]
    if (!s || s.state !== 'ROSTER') return fail('NOT_JOINED')

    const before = rules.demandOf(ev, s.gender, s.guests)
    const after = rules.demandOf(ev, s.gender, guests)
    if (!after) return fail('GENDER_REQUIRED')

    const seatsBefore = rules.seatsFor(s.guests)
    const seatsAfter = rules.seatsFor(guests)

    // Release then re-seat, so bucket maths lives in one place instead of being
    // special-cased for growth versus shrinkage.
    applyCounts(ev, 'ROSTER', before, seatsBefore, -1)
    if (!rules.rosterHasRoom(ev, after)) {
      applyCounts(ev, 'ROSTER', before, seatsBefore, +1) // put it back
      return fail('FULL')
    }
    applyCounts(ev, 'ROSTER', after, seatsAfter, +1)
    s.guests = guests
    s.state_changed_at = now()

    const promoted = seatsAfter < seatsBefore ? promoteFromWaitlist(db, ev) : []
    return { guest_count: guests.length, promoted }
  },

  'event.duplicate'(db, { eventId }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')

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
  },

  /**
   * Change a live session's signup rules. §3.1, §3.2, §3.4
   *
   * All of these were fixed at creation, which is exactly wrong for the case they most
   * need to serve: on the day, more people want to play than the original plan allowed.
   * Without this the only move is to cancel and repost, throwing away the roster and
   * everyone's place in the queue.
   *
   * Reopening needs no new state — status is derived (§5), so a deadline moved into the
   * future turns SIGNUP_CLOSED back into OPEN by itself. It does need a promotion pass:
   * promotion refuses to run while the deadline has passed, so anyone who queued in the
   * meantime is still sitting there.
   */
  'event.updateRules'(db, payload) {
    const ev = db.events[payload.eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')
    // A cancelled session has no rules worth editing; reposting is the move.
    if (ev.lifecycle !== 'ACTIVE') return fail('NOT_ACTIVE')

    const patch = {}

    if (payload.join_deadline_rule !== undefined) {
      const rule = payload.join_deadline_rule === 'AT_TIME' ? 'AT_TIME' : 'AT_EVENT_START'
      patch.join_deadline_rule = rule
      if (rule === 'AT_TIME') {
        const at = Number(payload.join_deadline_at) || 0
        if (!(at > 0)) return fail('BAD_DEADLINE')
        // §3.1 caps it at the start: joining after the session began is meaningless.
        if (at > ev.start_at) return fail('BAD_DEADLINE')
        patch.join_deadline_at = at
        patch.join_deadline_local = String(payload.join_deadline_local || '')
      } else {
        patch.join_deadline_at = null
        patch.join_deadline_local = ''
      }
    }

    if (payload.withdraw_rule !== undefined) {
      const r = payload.withdraw_rule
      if (['HOURS_BEFORE_START', 'SAME_AS_JOIN_DEADLINE', 'AT_EVENT_START'].indexOf(r) === -1) {
        return fail('BAD_WITHDRAW_RULE')
      }
      patch.withdraw_rule = r
    }
    if (payload.withdraw_hours_before !== undefined) {
      patch.withdraw_hours_before = Math.max(
        0,
        Math.min(72, Number(payload.withdraw_hours_before) || 0)
      )
    }
    if (payload.min_players !== undefined) {
      patch.min_players = Math.max(0, Number(payload.min_players) || 0)
    }
    if (payload.max_guests_per_member !== undefined) {
      patch.max_guests_per_member = Math.min(
        3,
        Math.max(0, Number(payload.max_guests_per_member) || 0)
      )
    }

    const balanced = rules.isBalanced(ev)
    const nextCapacity =
      payload.capacity == null ? ev.capacity : Math.max(1, Number(payload.capacity) || 0)
    const nextByGender = balanced
      ? payload.capacity_by_gender || ev.capacity_by_gender
      : null
    if (balanced && nextByGender) {
      if ((nextByGender.male || 0) + (nextByGender.female || 0) !== nextCapacity) {
        return fail('BAD_CAPACITY')
      }
    }
    const nextMin = patch.min_players == null ? ev.min_players : patch.min_players
    if (nextMin > nextCapacity) return fail('BAD_CAPACITY')

    const shrinking = applyCapacityChange(db, ev, nextCapacity, nextByGender)
    Object.assign(ev, patch)
    ev.updated_at = now()

    // Growing the roster and reopening the deadline can both admit waitlisted parties.
    const promoted = shrinking.shrinking ? [] : promoteFromWaitlist(db, ev)
    return { bumped_count: shrinking.bumped.length, promoted }
  },

  /** §3.5 — record the booking, shrink capacity if fewer courts were secured. */
  'event.setCourts'(db, payload) {
    const {
      eventId,
      court_assignments,
      court_count,
      capacity,
      capacity_by_gender,
      total_cost_minor,
    } = payload
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')

    ev.court_assignments = (court_assignments || [])
      .filter((c) => c && String(c.label || '').trim())
      .map((c) => ({
        label: String(c.label).trim(),
        start_at: c.start_at || null,
        end_at: c.end_at || null,
        note: c.note || '',
        booked_with_membership_openid: c.booked_with_membership_openid || null,
      }))
    // The labels are the booking, so the status follows them. §3.5
    ev.court_status = ev.court_assignments.length ? 'CONFIRMED' : 'NOT_BOOKED'
    if (court_count != null) ev.court_count = Math.max(0, Number(court_count) || 0)

    const balanced = rules.isBalanced(ev)
    const nextCapacity = capacity == null ? ev.capacity : Math.max(1, Number(capacity) || 0)
    const nextByGender = balanced ? capacity_by_gender || ev.capacity_by_gender : null

    if (balanced && nextByGender) {
      if ((nextByGender.male || 0) + (nextByGender.female || 0) !== nextCapacity) {
        return fail('BAD_CAPACITY')
      }
    }

    const { bumped, shrinking } = applyCapacityChange(db, ev, nextCapacity, nextByGender)
    ev.updated_at = now()

    /**
     * The paid total is captured here, not after play: this is when the organizer
     * has the receipt. It lands in a DRAFT bill (§9.1) — a number with no
     * obligations, since publishing the split is a separate act after play (§9.1).
     */
    if (total_cost_minor != null) {
      if (!db.event_bills) db.event_bills = {}
      const existing = db.event_bills[eventId]
      // Never quietly rewrite a bill people are already paying against.
      if (existing && existing.status !== 'DRAFT') return fail('BILL_ALREADY_PUBLISHED')

      db.event_bills[eventId] = {
        _id: eventId,
        event_id: eventId,
        club_id: ev.club_id || null,
        total_minor: Math.max(0, Math.round(Number(total_cost_minor) || 0)),
        currency: ev.currency || 'CAD',
        status: 'DRAFT',
        created_by: actorId(),
        created_at: existing ? existing.created_at : now(),
        updated_at: now(),
      }
    }

    const promoted = shrinking ? [] : promoteFromWaitlist(db, ev)
    return { bumped_count: bumped.length, promoted }
  },

  'event.removeSignup'(db, { eventId, targetOpenid }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')
    if (targetOpenid === ev.creator_openid) return fail('CANNOT_REMOVE_ORGANIZER')

    const s = db.signups[sid(eventId, targetOpenid)]
    if (!s || (s.state !== 'ROSTER' && s.state !== 'WAITLIST')) return fail('NOT_JOINED')

    const demand = rules.demandOf(ev, s.gender, s.guests)
    const seats = rules.seatsFor(s.guests)
    const wasRoster = s.state === 'ROSTER'
    applyCounts(ev, s.state, demand, seats, -1)

    s.state = 'REMOVED'
    s.state_changed_at = now()
    s.queued_at = null

    const promoted = wasRoster ? promoteFromWaitlist(db, ev) : []
    return { promoted }
  },

  'event.cancel'(db, { eventId }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')
    ev.lifecycle = 'CANCELLED'
    ev.updated_at = now()
    return { ok: true }
  },

  // --- bills ---------------------------------------------------------------
  /**
   * The settlement view. §9
   *
   * A manager gets the per-person list, because ticking payments off is the job. A
   * player gets their own share and the aggregate only — who else still owes is the
   * organizer's business, and every row carries an openid (§11).
   */
  'bill.get'(db, { eventId }) {
    const ctx = billContext(db, eventId)
    if (!ctx) return fail('NOT_FOUND')
    const { ev, club, surcharge_minor, grace_hours } = ctx

    const manage = canManage(db, ev, actorId())
    const mine = db.signups[sid(eventId, actorId())]
    if (!manage && !(mine && mine.state === 'ROSTER')) return fail('NOT_VISIBLE')

    const bill = (db.event_bills || {})[eventId] || null
    const all = eventSignups(db, eventId)
    const shares = bill && bill.status !== 'DRAFT' ? eventShares(db, eventId) : []
    const sharesByOpenid = {}
    shares.forEach((s) => {
      sharesByOpenid[s.openid] = s
    })

    const total = (bill && bill.total_minor) || 0
    const dueAt = bill && bill.due_at ? bill.due_at : 0

    // What publishing right now would produce — the preview before publication, and
    // the effect of a revision afterwards.
    const preview = rules.computeShares({
      total_minor: total,
      signups: all,
      guest_surcharge_minor: surcharge_minor,
    })
    const previewByOpenid = {}
    preview.rows.forEach((r) => {
      previewByOpenid[r.openid] = r
    })

    let rows = []
    if (manage) {
      rows = all
        .filter((s) => s.state === 'ROSTER' || sharesByOpenid[s.openid])
        .sort((a, b) => a.joined_at - b.joined_at)
        .map((s) => {
          const share = sharesByOpenid[s.openid] || null
          const pv = previewByOpenid[s.openid] || null
          return {
            openid: s.openid,
            name: nameFor(db, s.openid, club),
            avatar_url: (db.users[s.openid] || {}).avatar_url || '',
            gender: s.gender,
            guest_count: s.guests.length,
            is_me: s.openid === actorId(),
            off_roster: s.state !== 'ROSTER',
            preview_minor: pv ? pv.share_minor : 0,
            units: pv ? pv.units : 0,
            share_minor: share ? share.share_minor : 0,
            status: share ? share.status : '',
            claimed_paid_at: share ? share.player_claimed_paid_at || 0 : 0,
            overdue: rules.isShareOverdue(share, dueAt),
          }
        })
    }

    let paid = 0
    let unpaid = 0
    shares.forEach((s) => {
      if (s.status === 'UNPAID') unpaid += s.share_minor
      else paid += s.share_minor
    })

    const myShare = sharesByOpenid[actorId()] || null

    return {
      event: {
        _id: ev._id,
        title: ev.title,
        start_local: ev.start_local,
        end_local: ev.end_local,
        currency: ev.currency || (club && club.currency) || 'CAD',
        club_id: ev.club_id,
        venue_name: (ev.venue_snapshot || {}).name || '',
      },
      is_manager: manage,
      // Publication waits on play: people can still join up to the deadline and drop up
      // to the withdraw deadline, so any earlier split bills a list that is moving.
      ended: now() >= ev.end_at,
      started: now() >= ev.start_at,
      bill: bill
        ? {
            status: bill.status,
            total_minor: bill.total_minor,
            billed_at: bill.billed_at || 0,
            due_at: dueAt,
            payment_note: bill.payment_note || '',
          }
        : null,
      grace_hours,
      surcharge_minor,
      preview: {
        units: preview.units,
        guest_units: preview.guest_units,
        payer_count: preview.payer_count,
        base_minor: preview.base,
        remainder_minor: preview.remainder,
        surcharge_total: preview.surcharge_total,
        allocated_minor: preview.allocated_minor,
      },
      rows,
      my_share: myShare
        ? {
            share_minor: myShare.share_minor,
            status: myShare.status,
            claimed_paid_at: myShare.player_claimed_paid_at || 0,
            overdue: rules.isShareOverdue(myShare, dueAt),
          }
        : null,
      totals: {
        total_minor: total,
        paid_minor: paid,
        unpaid_minor: unpaid,
        share_count: shares.length,
        settled_count: shares.filter((s) => s.status !== 'UNPAID').length,
      },
    }
  },

  /**
   * Publish the split, or revise a published one. §9.1, §9.4
   *
   * Revising recomputes UNPAID shares only — PAID and WAIVED ones stand and the
   * delta is the admin's to reconcile. `due_at` holds still for the same reason: the
   * obligation was created at first publication.
   *
   * Every head that held a seat pays (§14), so there is nothing to choose here.
   */
  'bill.publish'(db, { eventId, total_minor, payment_note }) {
    const ctx = billContext(db, eventId)
    if (!ctx) return fail('NOT_FOUND')
    const { ev, surcharge_minor, grace_hours } = ctx
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')
    if (now() < ev.end_at) return fail('EVENT_NOT_OVER')

    if (!db.event_bills) db.event_bills = {}
    if (!db.bill_shares) db.bill_shares = {}

    const existing = db.event_bills[eventId]
    if (existing && existing.status === 'VOID') return fail('BILL_VOID')

    const total =
      total_minor != null
        ? Math.max(0, Math.round(Number(total_minor) || 0))
        : (existing && existing.total_minor) || 0
    if (!(total > 0)) return fail('NO_TOTAL')

    const result = rules.computeShares({
      total_minor: total,
      signups: eventSignups(db, eventId),
      guest_surcharge_minor: surcharge_minor,
    })
    if (!result.rows.length) return fail('NO_PAYERS')

    const republish = !!existing && existing.status !== 'DRAFT'
    const billedAt = republish && existing.billed_at ? existing.billed_at : now()
    const dueAt =
      republish && existing.due_at ? existing.due_at : rules.dueAt(billedAt, grace_hours)

    const prior = {}
    if (republish) {
      eventShares(db, eventId).forEach((s) => {
        prior[s.openid] = s
      })
    }

    result.rows.forEach((row) => {
      const was = prior[row.openid]
      // Already settled: leave it exactly as it stands. §9.4
      if (was && was.status !== 'UNPAID') return

      const id = sid(eventId, row.openid)
      db.bill_shares[id] = {
        _id: id,
        event_id: eventId,
        club_id: ev.club_id || null,
        openid: row.openid,
        share_minor: row.share_minor,
        units: row.units,
        guest_units: row.guest_units,
        status: 'UNPAID',
        marked_paid_by: null,
        marked_paid_at: null,
        player_claimed_paid_at: was ? was.player_claimed_paid_at || 0 : 0,
        created_at: was ? was.created_at : now(),
        updated_at: now(),
      }
    })

    // Someone excluded since the last publication stops owing — unless they already
    // paid, in which case the row stands and the refund is the admin's to sort out.
    const stillOwed = {}
    result.rows.forEach((r) => {
      stillOwed[r.openid] = true
    })
    Object.keys(prior).forEach((o) => {
      if (!stillOwed[o] && prior[o].status === 'UNPAID') delete db.bill_shares[sid(eventId, o)]
    })

    db.event_bills[eventId] = {
      _id: eventId,
      event_id: eventId,
      club_id: ev.club_id || null,
      total_minor: total,
      currency: ev.currency || 'CAD',
      billed_at: billedAt,
      due_at: dueAt,
      payment_note:
        payment_note != null
          ? String(payment_note).slice(0, 200)
          : (existing && existing.payment_note) || '',
      payment_qr_url: (existing && existing.payment_qr_url) || '',
      status: 'PUBLISHED',
      created_by: (existing && existing.created_by) || actorId(),
      created_at: existing ? existing.created_at : now(),
      updated_at: now(),
    }

    return {
      status: refreshBillStatus(db, eventId),
      revised: republish,
      due_at: dueAt,
      share_count: result.rows.length,
      allocated_minor: result.allocated_minor,
    }
  },

  /** §9.3 — players cannot mark their own; only the organizer sees money arrive. */
  'bill.markPaid'(db, { eventId, targetOpenid, paid }) {
    return setShareStatus(db, eventId, targetOpenid, paid === false ? 'UNPAID' : 'PAID')
  },

  /** An admin can write a share off — a comped court, a made-good. §9.4 */
  'bill.waive'(db, { eventId, targetOpenid, waived }) {
    return setShareStatus(db, eventId, targetOpenid, waived === false ? 'UNPAID' : 'WAIVED')
  },

  /**
   * "I've paid". §9.4 — deliberately does not settle the share; it raises the
   * discrepancy for the admin. A self-marked ledger would be no ledger.
   */
  'bill.claimPaid'(db, { eventId }) {
    const share = (db.bill_shares || {})[sid(eventId, actorId())]
    if (!share) return fail('NOT_FOUND')
    if (share.status !== 'UNPAID') return { claimed_paid_at: 0 }

    share.player_claimed_paid_at = now()
    share.updated_at = now()
    return { claimed_paid_at: share.player_claimed_paid_at }
  },

  /**
   * Void a bill — a cancelled session, a comped court. §9.4
   *
   * Outstanding shares are waived rather than left sitting: blocked status is
   * derived from a query for overdue UNPAID rows (§9.3), so an UNPAID row under a
   * voided bill would enforce a debt that no longer exists.
   */
  'bill.void'(db, { eventId }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')

    const bill = (db.event_bills || {})[eventId]
    if (!bill) return fail('NOT_FOUND')

    eventShares(db, eventId).forEach((s) => {
      if (s.status !== 'UNPAID') return
      s.status = 'WAIVED'
      s.updated_at = now()
    })
    bill.status = 'VOID'
    bill.updated_at = now()
    return { status: 'VOID' }
  },

  // --- clubs ---------------------------------------------------------------
  'club.create'(db, { club }) {
    const input = club || {}
    const name = String(input.name || '').trim()
    if (!name) return fail('BAD_CLUB_NAME')

    const id = store.newId('c')
    const policy = naming.JoinPolicy[input.join_policy] || 'APPROVAL'
    db.clubs[id] = {
      _id: id,
      name,
      description: input.description || '',
      cover_url: '',
      owner_openid: actorId(),
      join_policy: policy,
      // Every club gets one: with discovery deferred it's the only way in. §3.10
      invite_code: naming.generateInviteCode(),
      member_count: 1,
      settlement_grace_hours: 12,
      currency: input.currency || 'CAD',
      membership_policy: naming.MembershipPolicy[input.membership_policy] || 'NOT_REQUIRED',
      venue_ids: [],
      primary_venue_id: null,
      event_defaults: null,
      created_at: now(),
      updated_at: now(),
    }
    db.club_members[mid(id, actorId())] = {
      _id: mid(id, actorId()),
      club_id: id,
      openid: actorId(),
      role: 'OWNER',
      status: 'ACTIVE',
      nickname_override: '',
      reject_reason: '',
      requested_at: now(),
      joined_at: now(),
    }
    return { clubId: id, invite_code: db.clubs[id].invite_code }
  },

  'club.mine'(db) {
    const mineRows = Object.values(db.club_members).filter(
      (m) => m.openid === actorId() && (m.status === 'ACTIVE' || m.status === 'PENDING')
    )
    const byClub = {}
    mineRows.forEach((m) => {
      byClub[m.club_id] = m
    })

    const joined = Object.keys(byClub)
      .map((id) => db.clubs[id])
      .filter(Boolean)
      .map((c) =>
        Object.assign({}, c, {
          my_role: byClub[c._id].role,
          my_status: byClub[c._id].status,
          invite_code: naming.canAdminClub(byClub[c._id]) ? c.invite_code : '',
        })
      )

    // Venue names ride along so the create form's venue picker needs no second call.
    const venues = {}
    joined.forEach((c) =>
      (c.venue_ids || []).forEach((v) => {
        if (db.venues[v]) venues[v] = db.venues[v]
      })
    )

    // Requests waiting on me across clubs I administer — drives the tab-bar dot.
    const adminIds = joined.filter((c) => naming.canAdminClub(byClub[c._id])).map((c) => c._id)
    const pendingRows = Object.values(db.club_members).filter(
      (m) => m.status === 'PENDING' && adminIds.indexOf(m.club_id) !== -1
    )
    // Per club for the list, overall for the tab-bar dot.
    joined.forEach((c) => {
      c.pending_count = pendingRows.filter((m) => m.club_id === c._id).length
    })

    return { joined, venues, pending_total: pendingRows.length }
  },

  'club.detail'(db, { clubId }) {
    const club = db.clubs[clubId]
    if (!club) return fail('NOT_FOUND')

    const me = myMember(db, clubId, actorId())
    const isAdmin = naming.canAdminClub(me)
    const isMember = naming.isActiveMember(me)

    // Members only, and a pending request is not membership. §3.10
    if (!isMember) return fail('NOT_MEMBER')

    const rows = Object.values(db.club_members).filter((m) => m.club_id === clubId)
    const memberRows = rows.filter((m) => m.status === 'ACTIVE')
    const pendingRows = isAdmin ? rows.filter((m) => m.status === 'PENDING') : []

    const openids = memberRows.concat(pendingRows).map((m) => m.openid)
    const memberships = membershipsForVenue(db, club.primary_venue_id, openids)

    const view = (m) => ({
      openid: m.openid,
      role: m.role,
      status: m.status,
      gender: (db.users[m.openid] || {}).gender || 'UNSPECIFIED',
      name: nameFor(db, m.openid, club),
      has_membership: !!memberships[m.openid],
      membership_verified: !!(memberships[m.openid] && memberships[m.openid].verified_at),
      joined_at: m.joined_at,
      requested_at: m.requested_at,
    })

    const t = now()
    const upcoming = Object.values(db.events)
      .filter(
        (ev) =>
          // Every caller here is a member, so there is no visibility filter left. §3.6
          ev.club_id === clubId && ev.lifecycle === 'ACTIVE' && ev.end_at > t
      )
      .sort((a, b) => a.start_at - b.start_at)
      .map((ev) => eventCard(db, ev))

    return {
      club: Object.assign({}, club, { invite_code: isAdmin ? club.invite_code : '' }),
      my_role: me ? me.role : null,
      my_status: me ? me.status : null,
      is_admin: isAdmin,
      is_member: isMember,
      is_owner: naming.isOwner(me),
      members: memberRows.map(view).sort((a, b) => a.joined_at - b.joined_at),
      pending: pendingRows.map(view).sort((a, b) => a.requested_at - b.requested_at),
      pending_count: pendingRows.length,
      venues: (club.venue_ids || []).map((v) => db.venues[v]).filter(Boolean),
      my_membership: memberships[actorId()] || null,
      upcoming,
    }
  },

  'club.join'(db, { clubId, membership_name, membership_no }) {
    const club = db.clubs[clubId]
    if (!club) return fail('NOT_FOUND')

    const existing = myMember(db, clubId, actorId())
    const outcome = naming.joinOutcome(club, existing)
    if (outcome.error) return fail(outcome.error)

    // A club that asks for a venue membership asks on the join tap, so the name is
    // recorded before admission rather than on a screen only members can open. §3.8
    if (
      club.membership_policy !== 'NOT_REQUIRED' &&
      club.primary_venue_id &&
      String(membership_name || '').trim()
    ) {
      const recorded = actions['venue.upsertMembership'](db, {
        venueId: club.primary_venue_id,
        membership_name,
        membership_no,
      })
      if (recorded && typeof recorded.then === 'function') return recorded
    }

    if (club.membership_policy === 'REQUIRED') {
      const membership = club.primary_venue_id
        ? db.venue_memberships[vmid(actorId(), club.primary_venue_id)]
        : null
      if (!naming.membershipSatisfied(club, membership)) return fail('MEMBERSHIP_REQUIRED')
    }

    db.club_members[mid(clubId, actorId())] = {
      _id: mid(clubId, actorId()),
      club_id: clubId,
      openid: actorId(),
      role: 'MEMBER',
      status: outcome.status,
      nickname_override: existing ? existing.nickname_override : '',
      reject_reason: '',
      requested_at: now(),
      joined_at: outcome.status === 'ACTIVE' ? now() : null,
    }
    if (outcome.status === 'ACTIVE') club.member_count += 1
    return { status: outcome.status }
  },

  /** The code identifies the club, so the joiner never needs its id. */
  'club.joinByCode'(db, { code, membership_name, membership_no }) {
    const c = String(code || '').trim().toUpperCase()
    if (!c) return fail('BAD_INVITE_CODE')
    // Guard the empty string, which every non-invite club stores.
    const club = Object.values(db.clubs).find((x) => x.invite_code && x.invite_code === c)
    if (!club) return fail('BAD_INVITE_CODE')
    return actions['club.join'](db, { clubId: club._id, membership_name, membership_no })
  },

  'club.decide'(db, { clubId, targetOpenid, approve, reason }) {
    const club = db.clubs[clubId]
    if (!club) return fail('NOT_FOUND')
    if (!naming.canAdminClub(myMember(db, clubId, actorId()))) return fail('NOT_ADMIN')

    const target = db.club_members[mid(clubId, targetOpenid)]
    if (!target || target.status !== 'PENDING') return fail('NO_PENDING_REQUEST')

    if (approve) {
      target.status = 'ACTIVE'
      target.joined_at = now()
      target.reject_reason = ''
      club.member_count += 1
      return { status: 'ACTIVE' }
    }
    target.status = 'REJECTED'
    target.reject_reason = String(reason || '')
    return { status: 'REJECTED' }
  },

  'club.setRole'(db, { clubId, targetOpenid, role }) {
    const me = myMember(db, clubId, actorId())
    if (!naming.canAdminClub(me)) return fail('NOT_ADMIN')
    if (!naming.isOwner(me)) return fail('NOT_OWNER')
    if (targetOpenid === actorId()) return fail('CANNOT_CHANGE_OWN_ROLE')
    if (role !== 'ADMIN' && role !== 'MEMBER') return fail('BAD_ROLE')

    const target = db.club_members[mid(clubId, targetOpenid)]
    if (!naming.isActiveMember(target)) return fail('NOT_MEMBER')
    target.role = role
    return { role }
  },

  'club.removeMember'(db, { clubId, targetOpenid }) {
    const club = db.clubs[clubId]
    const me = myMember(db, clubId, actorId())
    if (!naming.canAdminClub(me)) return fail('NOT_ADMIN')

    const target = db.club_members[mid(clubId, targetOpenid)]
    if (!naming.isActiveMember(target)) return fail('NOT_MEMBER')
    if (target.role === 'OWNER') return fail('CANNOT_REMOVE_OWNER')
    if (target.role === 'ADMIN' && !naming.isOwner(me)) return fail('NOT_OWNER')

    target.status = 'REMOVED'
    target.role = 'MEMBER'
    club.member_count -= 1
    return { ok: true }
  },

  'club.leave'(db, { clubId }) {
    const club = db.clubs[clubId]
    const me = myMember(db, clubId, actorId())
    if (!naming.isActiveMember(me)) return fail('NOT_MEMBER')
    if (me.role === 'OWNER') return fail('OWNER_CANNOT_LEAVE')
    me.status = 'REMOVED'
    club.member_count -= 1
    return { ok: true }
  },

  'club.update'(db, { clubId, patch }) {
    const club = db.clubs[clubId]
    if (!club) return fail('NOT_FOUND')
    if (!naming.canAdminClub(myMember(db, clubId, actorId()))) return fail('NOT_ADMIN')

    const p = patch || {}
    if (p.name !== undefined) {
      const name = String(p.name).trim()
      if (!name) return fail('BAD_CLUB_NAME')
      club.name = name
    }
    if (p.description !== undefined) club.description = p.description
    if (p.join_policy !== undefined) {
      if (!naming.JoinPolicy[p.join_policy]) return fail('BAD_JOIN_POLICY')
      club.join_policy = p.join_policy
    }
    if (p.membership_policy !== undefined) {
      if (!naming.MembershipPolicy[p.membership_policy]) return fail('BAD_MEMBERSHIP_POLICY')
      club.membership_policy = p.membership_policy
    }
    if (p.settlement_grace_hours !== undefined) {
      club.settlement_grace_hours = Math.max(1, Math.min(168, Number(p.settlement_grace_hours) || 12))
    }
    if (p.currency !== undefined) {
      // Any well-formed ISO 4217 code, not just the ones the picker offers. §10.3
      const cur = String(p.currency).toUpperCase()
      if (!/^[A-Z]{3}$/.test(cur)) return fail('BAD_CURRENCY')
      club.currency = cur
    }
    if (p.primary_venue_id !== undefined) club.primary_venue_id = p.primary_venue_id || null
    if (p.event_defaults !== undefined) club.event_defaults = p.event_defaults
    if (p.rotate_invite_code) club.invite_code = naming.generateInviteCode()
    club.updated_at = now()

    return { club }
  },

  // --- venues and memberships ---------------------------------------------
  'venue.create'(db, { clubId, venue }) {
    const club = db.clubs[clubId]
    if (!club) return fail('NOT_FOUND')
    if (!naming.canAdminClub(myMember(db, clubId, actorId()))) return fail('NOT_ADMIN')

    const input = venue || {}
    const name = String(input.name || '').trim()
    if (!name) return fail('BAD_VENUE')

    const id = store.newId('v')
    db.venues[id] = {
      _id: id,
      name,
      address: input.address || '',
      location: null,
      tz_label: input.tz_label || '',
      currency: input.currency || '',
      membership_required: !!input.membership_required,
      max_courts_per_membership: Number(input.max_courts_per_membership) || 0,
      guest_policy: input.guest_policy || 'ALLOWED',
      guest_surcharge_minor: Number(input.guest_surcharge_minor) || 0,
      court_labels: input.court_labels || [],
      created_by: actorId(),
      created_at: now(),
    }
    club.venue_ids = (club.venue_ids || []).concat([id])
    if (!club.primary_venue_id) club.primary_venue_id = id
    club.updated_at = now()

    return { venueId: id }
  },

  'venue.listForClub'(db, { clubId }) {
    const club = db.clubs[clubId]
    if (!club) return fail('NOT_FOUND')
    const venues = (club.venue_ids || []).map((v) => db.venues[v]).filter(Boolean)
    const my = {}
    venues.forEach((v) => {
      const m = db.venue_memberships[vmid(actorId(), v._id)]
      if (m) my[v._id] = m
    })
    return { venues, my_memberships: my }
  },

  'venue.upsertMembership'(db, { venueId, membership_name, membership_no }) {
    const venue = db.venues[venueId]
    if (!venue) return fail('NOT_FOUND')
    const name = String(membership_name || '').trim()
    if (!name) return fail('BAD_MEMBERSHIP_NAME')

    const id = vmid(actorId(), venueId)
    const existing = db.venue_memberships[id]
    const sameName = existing && existing.membership_name === name

    db.venue_memberships[id] = {
      _id: id,
      openid: actorId(),
      venue_id: venueId,
      membership_name: name,
      membership_no: membership_no || '',
      // Editing the name drops verification — an admin confirmed the old one.
      verified_by: sameName ? existing.verified_by : null,
      verified_at: sameName ? existing.verified_at : null,
      created_at: existing ? existing.created_at : now(),
      updated_at: now(),
    }
    return { membership: db.venue_memberships[id] }
  },

  'venue.myMemberships'(db) {
    const rows = Object.values(db.venue_memberships).filter((m) => m.openid === actorId())
    const venues = {}
    rows.forEach((r) => {
      if (db.venues[r.venue_id]) venues[r.venue_id] = db.venues[r.venue_id]
    })
    return { memberships: rows, venues }
  },

  'venue.verifyMembership'(db, { clubId, venueId, targetOpenid, verified }) {
    if (!naming.canAdminClub(myMember(db, clubId, actorId()))) return fail('NOT_ADMIN')
    const row = db.venue_memberships[vmid(targetOpenid, venueId)]
    if (!row) return fail('NOT_FOUND')
    row.verified_by = verified ? actorId() : null
    row.verified_at = verified ? now() : null
    return { ok: true }
  },

  /** §3.8 — whose card can book these courts, and do we hold enough? */
  'venue.bookingHelper'(db, { eventId }) {
    const ev = db.events[eventId]
    if (!ev) return fail('NOT_FOUND')
    if (!canManage(db, ev, actorId())) return fail('NOT_ADMIN')
    if (!ev.venue_id) return { venue: null, holders: [], coverage: null }

    const venue = db.venues[ev.venue_id]
    const openids = activeSignups(db, eventId).map((s) => s.openid)
    const memberships = membershipsForVenue(db, ev.venue_id, openids)

    const holders = Object.keys(memberships).map((o) => ({
      openid: o,
      nickname: (db.users[o] || {}).nickname || '',
      membership_name: memberships[o].membership_name,
      membership_no: memberships[o].membership_no || '',
      verified: !!memberships[o].verified_at,
    }))

    const coverage = naming.bookingCoverage(
      ev.court_count || 0,
      venue ? venue.max_courts_per_membership : 0,
      holders.length
    )
    return { venue, holders, coverage }
  },

  /**
   * The demo's joinable clubs, for the tourist-mode hint under the invite-code field.
   *
   * Club discovery is deferred (§13), so a club you are not in is reachable only by
   * its code — which left the whole join flow undemonstrable unless you had read the
   * README. Mock only: in cloud or http mode the action does not exist, the client's
   * call fails with NO_ACTION, and no hint is shown.
   */
  'dev.inviteCodes'(db) {
    const mine = {}
    Object.values(db.club_members)
      .filter((member) => member.openid === actorId())
      .forEach((member) => {
        mine[member.club_id] = true
      })
    const codes = Object.values(db.clubs)
      .filter((club) => !mine[club._id] && club.invite_code)
      .map((club) => ({
        code: club.invite_code,
        name: club.name,
        membership_policy: club.membership_policy,
      }))
    return { codes }
  },

  /**
   * Put the demo back to its seeded state. §12 (developer affordance, not a rule)
   *
   * Mutated in place rather than written straight to storage: dispatch persists the db
   * it loaded *before* the action ran, so a fresh seed written behind its back was
   * overwritten the moment this returned — the button on the Me tab reported success
   * and changed nothing.
   */
  'dev.reset'(db) {
    const fresh = store.seed()
    Object.keys(db).forEach((key) => delete db[key])
    Object.assign(db, fresh)
    return { ok: true }
  },
}

function dispatch(action, payload, options = {}) {
  const fn = actions[action]
  if (!fn) return fail('NO_ACTION')

  const previousActorId = currentActorId
  currentActorId = options.actorId || DEFAULT_ACTOR_ID
  const db = store.load()
  ensureActor(db)
  let out
  try {
    out = fn(db, payload || {})
  } catch (err) {
    currentActorId = previousActorId
    return Promise.reject(err)
  }
  currentActorId = previousActorId
  // A rejected promise means the action refused before mutating; don't persist.
  if (out && typeof out.then === 'function') return out
  store.save(db)
  return Promise.resolve(out)
}

module.exports = { dispatch, reset: store.reset, ME: DEFAULT_ACTOR_ID }
