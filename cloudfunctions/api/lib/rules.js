/**
 * Pure scheduling and allocation rules. DESIGN.md §3, §5, §6, §3.9.
 *
 * KEEP IN SYNC with miniprogram/utils/rules.js — a cloud function only
 * packages files inside its own directory, so this module is deliberately
 * duplicated. It is pure (no wx.*, no db, no i18n) precisely so the two copies
 * stay trivially diffable.
 *
 * This is the authoritative copy. The client mirror is for rendering only; its
 * answers are never trusted here.
 */

const HOUR = 3600 * 1000

const Status = {
  DRAFT: 'DRAFT',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  IN_PROGRESS: 'IN_PROGRESS',
  SCHEDULED: 'SCHEDULED',
  SIGNUP_CLOSED: 'SIGNUP_CLOSED',
  FULL_CLOSED: 'FULL_CLOSED',
  WAITLIST_ONLY: 'WAITLIST_ONLY',
  OPEN: 'OPEN',
}

const Gender = { MALE: 'MALE', FEMALE: 'FEMALE', UNSPECIFIED: 'UNSPECIFIED' }

const BillStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  SETTLED: 'SETTLED',
  VOID: 'VOID',
}
const ShareStatus = { UNPAID: 'UNPAID', PAID: 'PAID', WAIVED: 'WAIVED' }

/** Last moment anyone may join, roster or waitlist. §3.1 */
function joinDeadlineAt(ev) {
  return ev.join_deadline_rule === 'AT_TIME' ? ev.join_deadline_at : ev.start_at
}

/** Last moment a player may withdraw themselves. §3.4 */
function withdrawDeadlineAt(ev) {
  switch (ev.withdraw_rule) {
    case 'SAME_AS_JOIN_DEADLINE':
      return joinDeadlineAt(ev)
    case 'AT_EVENT_START':
      return ev.start_at
    default:
      return ev.start_at - (ev.withdraw_hours_before || 6) * HOUR
  }
}

/**
 * Derived status. §5 — only DRAFT/ACTIVE/CANCELLED are stored, so there is no
 * window where the database disagrees with the clock. Compares UTC ms only
 * (§10.2); the wall-clock strings are for display and never for decisions.
 */
function statusOf(ev, now = Date.now()) {
  if (ev.lifecycle === 'CANCELLED' || ev.lifecycle === 'DRAFT') return ev.lifecycle
  if (now >= ev.end_at) return Status.COMPLETED
  if (now >= ev.start_at) return Status.IN_PROGRESS
  if (now < ev.signup_open_at) return Status.SCHEDULED
  if (now >= joinDeadlineAt(ev)) return Status.SIGNUP_CLOSED

  if (isRosterFull(ev)) {
    return ev.on_full === 'CLOSE' ? Status.FULL_CLOSED : Status.WAITLIST_ONLY
  }
  return Status.OPEN
}

function isBalanced(ev) {
  return ev.roster_mode === 'GENDER_BALANCED'
}

function seatsFor(guests) {
  return 1 + ((guests && guests.length) || 0)
}

/**
 * A party's seat demand.
 *
 * OPEN mode counts heads. GENDER_BALANCED splits them into buckets, and returns
 * null when anyone in the party has no declared gender — an unbucketable party
 * can't be auto-seated, which is the stated consequence in §3.9.
 */
function demandOf(ev, gender, guests) {
  const list = guests || []
  if (!isBalanced(ev)) return { any: 1 + list.length }

  const d = { male: 0, female: 0 }
  const bump = (g) => {
    if (g === Gender.MALE) return ++d.male
    if (g === Gender.FEMALE) return ++d.female
    return 0
  }
  if (!bump(gender)) return null
  for (let i = 0; i < list.length; i++) {
    if (!bump(list[i].gender)) return null
  }
  return d
}

function isRosterFull(ev) {
  if (!isBalanced(ev)) return ev.roster_count >= ev.capacity
  const cap = ev.capacity_by_gender || { male: 0, female: 0 }
  const cur = ev.roster_by_gender || { male: 0, female: 0 }
  return cur.male >= cap.male && cur.female >= cap.female
}

function rosterHasRoom(ev, demand) {
  if (!demand) return false
  if (demand.any != null) return ev.roster_count + demand.any <= ev.capacity

  const cap = ev.capacity_by_gender || { male: 0, female: 0 }
  const cur = ev.roster_by_gender || { male: 0, female: 0 }
  return cur.male + demand.male <= cap.male && cur.female + demand.female <= cap.female
}

/** The waitlist is one queue with a total cap; buckets apply at promotion. §3.9 */
function waitlistHasRoom(ev, seats) {
  const cap = ev.waitlist_capacity || 0
  return cap === 0 || ev.waitlist_count + seats <= cap
}

/**
 * Where a party lands, or null if it can't be seated at all.
 * All-or-nothing: a party that doesn't fit the roster entirely goes to the
 * waitlist rather than splitting up. §3.7
 */
function allocationFor(ev, demand, seats) {
  if (rosterHasRoom(ev, demand)) return 'ROSTER'
  if (ev.on_full !== 'WAITLIST') return null
  return waitlistHasRoom(ev, seats) ? 'WAITLIST' : null
}

/** Seats free per bucket, for UI hints and promotion scans. */
function seatsLeft(ev) {
  if (!isBalanced(ev)) {
    return { any: Math.max(0, ev.capacity - ev.roster_count) }
  }
  const cap = ev.capacity_by_gender || { male: 0, female: 0 }
  const cur = ev.roster_by_gender || { male: 0, female: 0 }
  return {
    male: Math.max(0, cap.male - cur.male),
    female: Math.max(0, cap.female - cur.female),
  }
}

function totalSeatsLeft(ev) {
  const l = seatsLeft(ev)
  return l.any != null ? l.any : l.male + l.female
}

/** Does this party fit the gap right now? Used by the promotion scan. §3.9 */
function fitsGap(ev, demand) {
  return rosterHasRoom(ev, demand)
}

function isJoinable(ev, now = Date.now()) {
  const s = statusOf(ev, now)
  return s === Status.OPEN || s === Status.WAITLIST_ONLY
}

function canWithdraw(ev, now = Date.now()) {
  return ev.lifecycle === 'ACTIVE' && now < withdrawDeadlineAt(ev)
}

/** Late drops are flagged for the reliability feature. §3.4, §13 */
function isLateWithdrawal(ev, now = Date.now(), lateWindowHours = 12) {
  return now >= ev.start_at - lateWindowHours * HOUR
}

/**
 * Exact even split of an integer amount. §9.2
 *
 * Returns the per-unit base plus the remainder that has to be handed out one minor
 * unit at a time, so `base * units + remainder === total` always holds and no money
 * is lost or invented to rounding.
 */
function splitEvenly(totalMinor, units) {
  const total = Math.max(0, Math.round(totalMinor || 0))
  if (!(units > 0)) return { base: 0, remainder: total, units: 0 }
  const base = Math.floor(total / units)
  return { base, remainder: total - base * units, units }
}

/**
 * Indicative per-person cost before the bill is published. §9.2
 *
 * Uses the seats currently taken, so it moves as people join — which is why the UI
 * labels it as approximate. The binding split waits on the organizer publishing it.
 */
function perPersonPreview(totalMinor, seatsTaken) {
  return splitEvenly(totalMinor, seatsTaken).base
}

function guestCountOf(signup) {
  return ((signup && signup.guests) || []).length
}

/**
 * Who the bill divides across: every head that held a seat. §9.2, §14
 *
 * Not "everyone who turned up". A seat was yours to release before the deadline or to
 * fill with a replacement, so it is billed whether you used it or not — the court was
 * paid for either way. That makes the split a fact about the roster rather than a
 * judgement about the evening, which is the whole reason there is no attendance step:
 * an organizer who has to tally faces before anyone can be charged is doing
 * bookkeeping the app exists to remove.
 *
 * Waitlisted parties never pay; they never held a seat. `signups.attendance` survives
 * in the schema unwritten, reserved for the reliability signal in §13.
 */
function payersFor(signups) {
  return (signups || [])
    .filter((s) => s.state === 'ROSTER')
    .slice()
    .sort((a, b) => a.joined_at - b.joined_at)
}

/**
 * The exact split of a paid total across a roster. §9.2
 *
 * A party of a member plus `g` guests is one row owing `1 + g` units, because
 * guests have no account and so there is nobody else to bill (§3.7). Where the
 * venue charges non-members a walk-in rate the organizer's total already includes
 * it, so the maths back-solves: peel the surcharges off first, then divide the rest
 * evenly.
 *
 * Invariant: `Σ share_minor === total_minor` whenever anyone is paying at all. No
 * rounding loses or invents money, and the same bill always splits the same way.
 */
function computeShares(opts) {
  const o = opts || {}
  const total = Math.max(0, Math.round(o.total_minor || 0))
  const payers = payersFor(o.signups)

  let units = 0
  let guestUnits = 0
  payers.forEach((s) => {
    const g = guestCountOf(s)
    units += 1 + g
    guestUnits += g
  })

  /**
   * A surcharge that exceeds the whole total means the organizer's figure doesn't
   * include it — a venue fee they weren't charged, or a stale venue setting. Fall
   * back to a plain even split rather than billing out more than was paid.
   */
  let surcharge = Math.max(0, Math.round(o.guest_surcharge_minor || 0))
  if (guestUnits * surcharge > total) surcharge = 0

  const surchargeTotal = guestUnits * surcharge
  const split = splitEvenly(total - surchargeTotal, units)

  /**
   * The remainder is bounded by *units*, not by headcount, so it is handed out one
   * minor unit per unit in `joined_at` order — a party holding four units can
   * absorb up to four of it. Handing out strictly one per payer, as §9.2 phrases
   * it, would leave money unallocated whenever a party holds several units, and the
   * conservation invariant outranks the phrasing. With no guests the two readings
   * are identical, which is the case that phrasing describes.
   */
  let handed = 0
  const rows = payers.map((s) => {
    const g = guestCountOf(s)
    const u = 1 + g
    const extra = Math.max(0, Math.min(u, split.remainder - handed))
    handed += extra
    return {
      openid: s.openid,
      units: u,
      guest_units: g,
      share_minor: u * split.base + g * surcharge + extra,
    }
  })

  return {
    rows,
    units,
    guest_units: guestUnits,
    payer_count: payers.length,
    surcharge_minor: surcharge,
    surcharge_total: surchargeTotal,
    base: split.base,
    remainder: split.remainder,
    total_minor: total,
    // Equals total_minor unless nobody is paying, when there is nothing to divide.
    allocated_minor: rows.reduce((n, r) => n + r.share_minor, 0),
  }
}

/**
 * When a published bill has to be settled by. §9.3
 *
 * Counted from publication, never from the event: clocking it from event end would
 * instantly overdue everyone the moment an admin posts a bill three days late.
 */
function dueAt(billedAt, graceHours) {
  const grace = graceHours > 0 ? graceHours : 12
  return billedAt + grace * HOUR
}

/**
 * §9.3. Overdue is derived from the clock, never stored, so marking a payment
 * clears it instantly with no stale flag to go wrong.
 *
 * V1 only *shows* this. The block it eventually drives waits on subscribe messages
 * (§8.1) — a lockout firing on someone who was never told is worse than no lockout
 * (§9.4), and without a push "told" means "happened to open the app".
 */
function isShareOverdue(share, billDueAt, now = Date.now()) {
  return !!share && share.status === ShareStatus.UNPAID && !!billDueAt && now > billDueAt
}

/** A bill is settled once no share is still owed. §9.1 */
function isBillSettled(shares) {
  const list = shares || []
  return list.every((s) => s.status !== ShareStatus.UNPAID)
}

/**
 * Who gets bumped when capacity shrinks — e.g. the organizer booked 2 courts
 * instead of 3. §3.5
 *
 * Implemented as re-seating the roster oldest-first into the smaller capacity,
 * which yields LIFO bumping: whoever signed up earliest keeps their place, because
 * they shouldn't lose it to a booking decision they didn't make.
 */
function planCapacityBump(ev, rosterSignups, nextCapacity, nextByGender) {
  const probe = Object.assign({}, ev, {
    capacity: nextCapacity,
    capacity_by_gender: nextByGender || null,
    roster_mode: nextByGender ? 'GENDER_BALANCED' : 'OPEN',
    roster_count: 0,
    roster_by_gender: { male: 0, female: 0 },
  })

  const kept = []
  const bumped = []
  const ordered = (rosterSignups || []).slice().sort((a, b) => a.joined_at - b.joined_at)

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]
    const demand = demandOf(probe, s.gender, s.guests)
    if (demand && rosterHasRoom(probe, demand)) {
      probe.roster_count += seatsFor(s.guests)
      if (demand.any == null) {
        probe.roster_by_gender.male += demand.male
        probe.roster_by_gender.female += demand.female
      }
      kept.push(s._id)
    } else {
      bumped.push(s._id)
    }
  }

  return { kept, bumped, seated: probe.roster_count, by_gender: probe.roster_by_gender }
}

module.exports = {
  HOUR,
  Status,
  Gender,
  BillStatus,
  ShareStatus,
  joinDeadlineAt,
  withdrawDeadlineAt,
  statusOf,
  isBalanced,
  seatsFor,
  demandOf,
  isRosterFull,
  rosterHasRoom,
  waitlistHasRoom,
  allocationFor,
  seatsLeft,
  totalSeatsLeft,
  fitsGap,
  isJoinable,
  canWithdraw,
  isLateWithdrawal,
  planCapacityBump,
  splitEvenly,
  perPersonPreview,
  payersFor,
  computeShares,
  dueAt,
  isShareOverdue,
  isBillSettled,
}
