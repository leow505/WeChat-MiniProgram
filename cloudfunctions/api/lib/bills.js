/**
 * Attendance, bills, and settlement tracking. DESIGN.md §9.
 *
 * No money moves through the app (§1). This does the arithmetic and the
 * bookkeeping; the transfer happens outside it over whatever the club already uses
 * — e-transfer, PayNow, cash — which is why `payment_note` is free text (§10.3).
 *
 * The split itself lives in `rules.computeShares` so that this file, the mock
 * backend, and the test suite all share one implementation of the money maths.
 *
 * Also deliberately absent: any notion of who turned up. Every head that held a seat
 * pays (§14) — a seat was yours to release before the deadline or to fill with a
 * replacement — so there is no attendance step and no basis to choose. `signups
 * .attendance` stays in the schema unwritten, reserved for §13.
 *
 * Deliberately absent: the overdue block (§9.3). It waits on subscribe messages,
 * because a lockout firing on someone who was never told is worse than no lockout
 * (§9.4), and without a push "told" means "happened to open the app". Overdue is
 * therefore computed and shown here, and enforced nowhere.
 */
const rules = require('./rules')
const naming = require('./naming')
const clubs = require('./clubs')
const events = require('./events')
const { fail } = require('./errors')
const { db, _, getOrNull } = require('./db')

/** One share per player per event, forever — same idiom as signups. §4 */
const shareId = (eventId, openid) => `${eventId}_${openid}`

const DEFAULT_GRACE_HOURS = 12

/**
 * Everything a bill decision needs: the event, who's asking, and the two rates the
 * split depends on. Loaded in one place so publish and get can't disagree about
 * which surcharge or grace period applies.
 */
async function context(eventId, openid) {
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')

  const club = ev.club_id ? await getOrNull('clubs', ev.club_id) : null
  const venue = ev.venue_id ? await getOrNull('venues', ev.venue_id) : null

  return {
    ev,
    club,
    venue,
    is_manager: await events.isManager(ev, openid),
    // The venue decides what a guest costs, not the event. §3.7
    surcharge_minor:
      venue && venue.guest_policy === 'SURCHARGE' ? venue.guest_surcharge_minor || 0 : 0,
    grace_hours: (club && club.settlement_grace_hours) || DEFAULT_GRACE_HOURS,
  }
}

async function signupsFor(eventId) {
  const r = await db.collection('signups').where({ event_id: eventId }).limit(200).get()
  return r.data
}

async function sharesFor(eventId) {
  const r = await db.collection('bill_shares').where({ event_id: eventId }).limit(200).get()
  return r.data
}

/**
 * A bill is SETTLED exactly when nothing is still owed, so the flag is recomputed
 * from the shares rather than incremented — there is no counter to drift, and the
 * §12.1 purge exemption reads the same rows.
 */
async function refreshBillStatus(eventId) {
  const shares = await sharesFor(eventId)
  const status = rules.isBillSettled(shares)
    ? rules.BillStatus.SETTLED
    : rules.BillStatus.PUBLISHED

  await db
    .collection('event_bills')
    .doc(eventId)
    .update({ data: { status, updated_at: Date.now() } })
  return status
}

/**
 * The settlement view, for both audiences.
 *
 * A manager gets the per-person list, because ticking off payments is the whole
 * job. A player gets their own share plus the aggregate and no per-person
 * breakdown: who else still owes is the organizer's business, and every row here
 * carries an openid (§11).
 */
async function get({ eventId }, openid) {
  const { ev, club, is_manager, surcharge_minor, grace_hours } = await context(eventId, openid)

  const mySignup = await getOrNull('signups', shareId(eventId, openid))
  const heldASeat = !!mySignup && mySignup.state === 'ROSTER'
  if (!is_manager && !heldASeat) fail('NOT_VISIBLE')

  const bill = await getOrNull('event_bills', eventId)
  const allSignups = await signupsFor(eventId)
  const shares = bill && bill.status !== rules.BillStatus.DRAFT ? await sharesFor(eventId) : []

  const sharesByOpenid = {}
  shares.forEach((s) => {
    sharesByOpenid[s.openid] = s
  })

  const total = (bill && bill.total_minor) || 0
  const dueAt = bill && bill.due_at ? bill.due_at : 0

  /**
   * What publishing right now would produce. The manager sees it as a preview
   * before publication and as the effect of a revision afterwards, so the same
   * numbers drive both phases of the screen.
   */
  const preview = rules.computeShares({
    total_minor: total,
    signups: allSignups,
    guest_surcharge_minor: surcharge_minor,
  })
  const previewByOpenid = {}
  preview.rows.forEach((r) => {
    previewByOpenid[r.openid] = r
  })

  let rows = []
  if (is_manager) {
    // Roster rows, plus anyone holding a share who has since left it — money must
    // not vanish from the screen because a seat was given up after publication.
    const relevant = allSignups.filter(
      (s) => s.state === 'ROSTER' || sharesByOpenid[s.openid]
    )
    const openids = relevant.map((s) => s.openid)
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

    rows = relevant
      .sort((a, b) => a.joined_at - b.joined_at)
      .map((s) => {
        const share = sharesByOpenid[s.openid] || null
        const pv = previewByOpenid[s.openid] || null
        return {
          openid: s.openid,
          name: naming.displayName({
            user: users[s.openid],
            member: membersByOpenid[s.openid],
            membership: memberships[s.openid],
            club,
          }),
          avatar_url: (users[s.openid] || {}).avatar_url || '',
          gender: s.gender,
          guest_count: (s.guests || []).length,
          is_me: s.openid === openid,
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
    if (s.status === rules.ShareStatus.UNPAID) unpaid += s.share_minor
    else paid += s.share_minor
  })

  const myShare = sharesByOpenid[openid] || null

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
    is_manager,
    // Publication waits on play: people can still join up to the deadline and drop up
    // to the withdraw deadline, so any earlier split bills a list that is still moving.
    ended: Date.now() >= ev.end_at,
    started: Date.now() >= ev.start_at,
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
      settled_count: shares.filter((s) => s.status !== rules.ShareStatus.UNPAID).length,
    },
  }
}

/**
 * Publish the split, or revise a published one. §9.1, §9.4
 *
 * Publication is what turns a recorded number into obligations, so it waits until after
 * play — the roster isn't final until then, since people can join up to the deadline and
 * drop up to the withdraw deadline (§3.1, §3.4).
 *
 * Revising recomputes UNPAID shares only. PAID and WAIVED ones stand and the delta
 * is the admin's to reconcile, because a share somebody has already settled must
 * not move underneath them. `due_at` holds still for the same reason: the
 * obligation was created at first publication, and a correction to the total
 * shouldn't quietly shorten or extend anyone's window.
 *
 * The total may be corrected here even after publication — that is an explicit
 * revision, whereas `event.setCourts` refuses, because there the rewrite would be a
 * side effect of editing the court booking.
 */
async function publish({ eventId, total_minor, payment_note }, openid) {
  const { ev, surcharge_minor, grace_hours } = await context(eventId, openid)
  await events.requireManager(ev, openid)

  if (Date.now() < ev.end_at) fail('EVENT_NOT_OVER')

  const existing = await getOrNull('event_bills', eventId)
  if (existing && existing.status === rules.BillStatus.VOID) fail('BILL_VOID')

  const total =
    total_minor != null
      ? Math.max(0, Math.round(Number(total_minor) || 0))
      : (existing && existing.total_minor) || 0
  if (!(total > 0)) fail('NO_TOTAL')

  const allSignups = await signupsFor(eventId)
  const result = rules.computeShares({
    total_minor: total,
    signups: allSignups,
    guest_surcharge_minor: surcharge_minor,
  })
  if (!result.rows.length) fail('NO_PAYERS')

  const republish = !!existing && existing.status !== rules.BillStatus.DRAFT
  const now = Date.now()
  const billedAt = republish && existing.billed_at ? existing.billed_at : now
  const dueAt = republish && existing.due_at ? existing.due_at : rules.dueAt(billedAt, grace_hours)

  const prior = {}
  ;(republish ? await sharesFor(eventId) : []).forEach((s) => {
    prior[s.openid] = s
  })

  for (let i = 0; i < result.rows.length; i++) {
    const row = result.rows[i]
    const was = prior[row.openid]
    // Already settled: leave it exactly as it stands. §9.4
    if (was && was.status !== rules.ShareStatus.UNPAID) continue

    const id = shareId(eventId, row.openid)
    const data = {
      event_id: eventId,
      club_id: ev.club_id || null,
      openid: row.openid,
      share_minor: row.share_minor,
      units: row.units,
      guest_units: row.guest_units,
      status: rules.ShareStatus.UNPAID,
      marked_paid_by: null,
      marked_paid_at: null,
      updated_at: now,
    }
    if (was) {
      await db.collection('bill_shares').doc(id).update({ data })
    } else {
      await db
        .collection('bill_shares')
        .doc(id)
        .set({ data: Object.assign({ _id: id, player_claimed_paid_at: 0, created_at: now }, data) })
    }
  }

  // Someone excluded since the last publication stops owing — unless they already
  // paid, in which case the row stands and the refund is the admin's to sort out.
  const stillOwed = {}
  result.rows.forEach((r) => {
    stillOwed[r.openid] = true
  })
  const orphans = Object.keys(prior).filter(
    (o) => !stillOwed[o] && prior[o].status === rules.ShareStatus.UNPAID
  )
  for (let i = 0; i < orphans.length; i++) {
    await db.collection('bill_shares').doc(shareId(eventId, orphans[i])).remove()
  }

  const billData = {
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
    status: rules.BillStatus.PUBLISHED,
    created_by: (existing && existing.created_by) || openid,
    updated_at: now,
  }
  if (existing) {
    await db.collection('event_bills').doc(eventId).update({ data: billData })
  } else {
    await db
      .collection('event_bills')
      .doc(eventId)
      .set({ data: Object.assign({ _id: eventId, created_at: now }, billData) })
  }

  const status = await refreshBillStatus(eventId)
  return {
    status,
    revised: republish,
    due_at: dueAt,
    share_count: result.rows.length,
    allocated_minor: result.allocated_minor,
  }
}

/**
 * Move one share. §9.3 — players cannot mark their own, which `requireManager`
 * enforces; the organizer is the one who can see the money arrive.
 */
async function setShareStatus(eventId, targetOpenid, status, openid) {
  const { ev } = await context(eventId, openid)
  await events.requireManager(ev, openid)

  const bill = await getOrNull('event_bills', eventId)
  if (!bill) fail('NOT_FOUND')
  if (bill.status === rules.BillStatus.VOID) fail('BILL_VOID')
  if (bill.status === rules.BillStatus.DRAFT) fail('BILL_NOT_PUBLISHED')

  const id = shareId(eventId, targetOpenid)
  const share = await getOrNull('bill_shares', id)
  if (!share) fail('NOT_FOUND')

  const now = Date.now()
  const paid = status === rules.ShareStatus.PAID
  await db
    .collection('bill_shares')
    .doc(id)
    .update({
      data: {
        status,
        marked_paid_by: paid ? openid : null,
        marked_paid_at: paid ? now : null,
        updated_at: now,
      },
    })

  return { status, bill_status: await refreshBillStatus(eventId) }
}

function markPaid({ eventId, targetOpenid, paid }, openid) {
  return setShareStatus(
    eventId,
    targetOpenid,
    paid === false ? rules.ShareStatus.UNPAID : rules.ShareStatus.PAID,
    openid
  )
}

/** An admin can write a share off entirely — a comped court, a made-good. §9.4 */
function waive({ eventId, targetOpenid, waived }, openid) {
  return setShareStatus(
    eventId,
    targetOpenid,
    waived === false ? rules.ShareStatus.UNPAID : rules.ShareStatus.WAIVED,
    openid
  )
}

/**
 * "I've paid". §9.4
 *
 * Deliberately does not settle the share: it raises the discrepancy for the admin
 * to look at. A player marking their own payment done would make the whole ledger
 * self-reported.
 */
async function claimPaid({ eventId }, openid) {
  const id = shareId(eventId, openid)
  const share = await getOrNull('bill_shares', id)
  if (!share) fail('NOT_FOUND')
  if (share.status !== rules.ShareStatus.UNPAID) return { claimed_paid_at: 0 }

  const now = Date.now()
  await db
    .collection('bill_shares')
    .doc(id)
    .update({ data: { player_claimed_paid_at: now, updated_at: now } })
  return { claimed_paid_at: now }
}

/**
 * Void a bill — a cancelled session, a venue that comped the court. §9.4
 *
 * Outstanding shares are waived rather than left sitting, because blocked status is
 * derived from a query for overdue UNPAID rows (§9.3): an UNPAID row under a voided
 * bill would enforce a debt that no longer exists.
 */
async function voidBill({ eventId }, openid) {
  const { ev } = await context(eventId, openid)
  await events.requireManager(ev, openid)

  const bill = await getOrNull('event_bills', eventId)
  if (!bill) fail('NOT_FOUND')

  const now = Date.now()
  const shares = await sharesFor(eventId)
  for (let i = 0; i < shares.length; i++) {
    if (shares[i].status !== rules.ShareStatus.UNPAID) continue
    await db
      .collection('bill_shares')
      .doc(shares[i]._id)
      .update({ data: { status: rules.ShareStatus.WAIVED, updated_at: now } })
  }

  await db
    .collection('event_bills')
    .doc(eventId)
    .update({ data: { status: rules.BillStatus.VOID, updated_at: now } })
  return { status: rules.BillStatus.VOID }
}

module.exports = {
  get,
  publish,
  markPaid,
  waive,
  claimPaid,
  voidBill,
  shareId,
  DEFAULT_GRACE_HOURS,
}
