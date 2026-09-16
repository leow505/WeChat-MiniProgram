/**
 * Seat allocation. DESIGN.md §6, §3.9.
 *
 * Two players tapping "join" on the last seat is the obvious way to corrupt a
 * roster, so every count change happens inside a transaction.
 *
 * Platform constraint that shapes the design: cloud DB transactions support
 * doc() reads and writes but NOT where() queries. Picking the head of the
 * waitlist needs a query, so promotion is optimistic — choose the candidate
 * outside the transaction, re-verify inside it, retry on a lost race.
 */
const rules = require('./rules')
const { fail } = require('./errors')
const { db, _, signupId, getOrNull, txGetOrNull } = require('./db')

/** Bucket counters only move for a balanced roster; OPEN mode has none. */
function countPatch(target, demand, seats, sign) {
  if (target === 'WAITLIST') return { waitlist_count: _.inc(sign * seats) }

  const patch = { roster_count: _.inc(sign * seats) }
  if (demand && demand.any == null) {
    patch['roster_by_gender.male'] = _.inc(sign * demand.male)
    patch['roster_by_gender.female'] = _.inc(sign * demand.female)
  }
  return patch
}

function normalizeGuests(ev, guests) {
  const list = Array.isArray(guests) ? guests : []
  return list.map((g) => ({
    name: (g && g.name) || '',
    gender: (g && g.gender) || rules.Gender.UNSPECIFIED,
  }))
}

async function join({ eventId, guests }, openid) {
  const id = signupId(eventId, openid)
  const now = Date.now()

  return db.runTransaction(async (tx) => {
    const ev = await txGetOrNull(tx, 'events', eventId)
    if (!ev) fail('NOT_FOUND')
    if (!rules.isJoinable(ev, now)) fail('CLOSED')

    const party = normalizeGuests(ev, guests)
    const maxGuests = ev.max_guests_per_member || 0
    if (party.length > maxGuests) fail(maxGuests === 0 ? 'NO_GUESTS' : 'TOO_MANY_GUESTS')

    const existing = await txGetOrNull(tx, 'signups', id)
    if (existing && (existing.state === 'ROSTER' || existing.state === 'WAITLIST')) {
      fail('ALREADY_JOINED')
    }

    // Gender is read from the profile, never from the client, and snapshotted onto
    // the signup so later profile edits can't silently re-bucket a live roster.
    const me = await getOrNull('users', openid)
    const gender = (me && me.gender) || rules.Gender.UNSPECIFIED

    const demand = rules.demandOf(ev, gender, party)
    if (!demand) fail('GENDER_REQUIRED')

    const seats = rules.seatsFor(party)
    const target = rules.allocationFor(ev, demand, seats)
    if (!target) fail(rules.totalSeatsLeft(ev) > 0 ? 'PARTY_TOO_BIG' : 'FULL')

    const doc = {
      event_id: eventId,
      club_id: ev.club_id || null,
      openid,
      gender,
      state: target,
      guests: party,
      joined_at: existing ? existing.joined_at : now,
      queued_at: target === 'WAITLIST' ? now : null,
      state_changed_at: now,
      attendance: 'UNKNOWN',
      withdraw_was_late: false,
    }

    // A rejoin updates the row it already owns — one signup per person per event,
    // forever, which is what makes the deterministic _id a double-join guard. §4
    if (existing) {
      await tx.collection('signups').doc(id).update({ data: doc })
    } else {
      await tx.collection('signups').doc(id).set({ data: Object.assign({ _id: id }, doc) })
    }

    await tx
      .collection('events')
      .doc(eventId)
      .update({ data: countPatch(target, demand, seats, +1) })

    return { state: target, seats }
  })
}

async function withdraw({ eventId }, openid) {
  const id = signupId(eventId, openid)
  const now = Date.now()

  const outcome = await db.runTransaction(async (tx) => {
    const ev = await txGetOrNull(tx, 'events', eventId)
    if (!ev) fail('NOT_FOUND')

    const s = await txGetOrNull(tx, 'signups', id)
    if (!s || (s.state !== 'ROSTER' && s.state !== 'WAITLIST')) fail('NOT_JOINED')
    if (!rules.canWithdraw(ev, now)) fail('WITHDRAW_CLOSED')

    const demand = rules.demandOf(ev, s.gender, s.guests)
    const seats = rules.seatsFor(s.guests)
    const wasLate = rules.isLateWithdrawal(ev, now)

    await tx.collection('signups').doc(id).update({
      data: {
        state: 'WITHDRAWN',
        withdrawn_at: now,
        state_changed_at: now,
        withdraw_was_late: wasLate,
        queued_at: null,
      },
    })
    await tx
      .collection('events')
      .doc(eventId)
      .update({ data: countPatch(s.state, demand, seats, -1) })

    return { freedRoster: s.state === 'ROSTER', wasLate }
  })

  // Deliberately outside the withdrawal transaction: the drop is already durable,
  // so a failure here leaves a vacancy for the next pass to fill rather than
  // rolling back somebody's withdrawal.
  const promoted = outcome.freedRoster ? await fillVacancies(eventId) : []
  return { promoted, was_late: outcome.wasLate }
}

/**
 * Change how many guests you're bringing while signup is open. §3.7
 *
 * Reducing frees seats and can admit a waitlisted party; increasing only succeeds
 * if the buckets have room.
 */
async function updateGuests({ eventId, guests }, openid) {
  const id = signupId(eventId, openid)
  const now = Date.now()

  const shrank = await db.runTransaction(async (tx) => {
    const ev = await txGetOrNull(tx, 'events', eventId)
    if (!ev) fail('NOT_FOUND')
    if (!rules.isJoinable(ev, now)) fail('CLOSED')

    const party = normalizeGuests(ev, guests)
    const maxGuests = ev.max_guests_per_member || 0
    if (party.length > maxGuests) fail(maxGuests === 0 ? 'NO_GUESTS' : 'TOO_MANY_GUESTS')

    const s = await txGetOrNull(tx, 'signups', id)
    if (!s || s.state !== 'ROSTER') fail('NOT_JOINED')

    const before = rules.demandOf(ev, s.gender, s.guests)
    const after = rules.demandOf(ev, s.gender, party)
    if (!after) fail('GENDER_REQUIRED')

    const seatDelta = rules.seatsFor(party) - rules.seatsFor(s.guests)
    if (seatDelta === 0 && JSON.stringify(before) === JSON.stringify(after)) return false

    // Model the change as a release then a re-seat, so bucket maths stays in one
    // place instead of being special-cased for growth versus shrinkage.
    const released = Object.assign({}, ev, {
      roster_count: ev.roster_count - rules.seatsFor(s.guests),
      roster_by_gender:
        before && before.any == null
          ? {
              male: (ev.roster_by_gender || {}).male - before.male,
              female: (ev.roster_by_gender || {}).female - before.female,
            }
          : ev.roster_by_gender,
    })
    if (!rules.rosterHasRoom(released, after)) fail('FULL')

    const patch = { roster_count: _.inc(seatDelta) }
    if (after.any == null) {
      patch['roster_by_gender.male'] = _.inc(after.male - before.male)
      patch['roster_by_gender.female'] = _.inc(after.female - before.female)
    }

    await tx
      .collection('signups')
      .doc(id)
      .update({ data: { guests: party, state_changed_at: now } })
    await tx.collection('events').doc(eventId).update({ data: patch })

    return seatDelta < 0
  })

  const promoted = shrank ? await fillVacancies(eventId) : []
  return { promoted }
}

/**
 * Organizer-initiated removal. §7
 *
 * Distinct from withdraw: no deadline applies, and the row is marked REMOVED so a
 * later reliability view can tell "dropped out" from "was taken off".
 */
async function forceRemove(eventId, targetOpenid) {
  const id = signupId(eventId, targetOpenid)
  const now = Date.now()

  const freedRoster = await db.runTransaction(async (tx) => {
    const ev = await txGetOrNull(tx, 'events', eventId)
    if (!ev) fail('NOT_FOUND')

    const s = await txGetOrNull(tx, 'signups', id)
    if (!s || (s.state !== 'ROSTER' && s.state !== 'WAITLIST')) fail('NOT_JOINED')

    const demand = rules.demandOf(ev, s.gender, s.guests)
    const seats = rules.seatsFor(s.guests)

    await tx.collection('signups').doc(id).update({
      data: { state: 'REMOVED', state_changed_at: now, queued_at: null },
    })
    await tx
      .collection('events')
      .doc(eventId)
      .update({ data: countPatch(s.state, demand, seats, -1) })

    return s.state === 'ROSTER'
  })

  return freedRoster ? await fillVacancies(eventId) : []
}

/**
 * Promote waitlisted parties into roster vacancies. §3.3, §3.9
 *
 * A party that doesn't fit the remaining gap is skipped rather than blocking the
 * queue — a party of three at the head would otherwise leave a single paid seat
 * empty indefinitely.
 */
async function fillVacancies(eventId, budget = 5) {
  const promoted = []

  for (let attempt = 0; attempt < budget; attempt++) {
    const ev = await getOrNull('events', eventId)
    if (!ev || ev.lifecycle !== 'ACTIVE') break
    if (Date.now() >= rules.joinDeadlineAt(ev)) break
    if (rules.totalSeatsLeft(ev) <= 0) break

    const q = await db
      .collection('signups')
      .where({ event_id: eventId, state: 'WAITLIST' })
      .orderBy('queued_at', 'asc')
      .limit(20)
      .get()

    const candidate = q.data.find((s) => {
      const demand = rules.demandOf(ev, s.gender, s.guests)
      return demand && rules.fitsGap(ev, demand)
    })
    if (!candidate) break

    const ok = await promoteOne(eventId, candidate._id)
    if (ok) promoted.push(candidate.openid)
    // If !ok we lost a race; the loop re-reads and picks again.
  }

  return promoted
}

async function promoteOne(eventId, id) {
  try {
    return await db.runTransaction(async (tx) => {
      const ev = await txGetOrNull(tx, 'events', eventId)
      const s = await txGetOrNull(tx, 'signups', id)
      if (!ev || !s || s.state !== 'WAITLIST') return false

      const demand = rules.demandOf(ev, s.gender, s.guests)
      if (!demand || !rules.fitsGap(ev, demand)) return false

      const seats = rules.seatsFor(s.guests)
      const now = Date.now()

      await tx.collection('signups').doc(id).update({
        data: { state: 'ROSTER', promoted_at: now, state_changed_at: now, queued_at: null },
      })
      await tx
        .collection('events')
        .doc(eventId)
        .update({
          data: Object.assign(
            { waitlist_count: _.inc(-seats) },
            countPatch('ROSTER', demand, seats, +1)
          ),
        })
      return true
    })
  } catch (e) {
    return false
  }
}

module.exports = { join, withdraw, updateGuests, forceRemove, fillVacancies }
