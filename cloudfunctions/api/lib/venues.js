/**
 * Venues and venue memberships. DESIGN.md §3.8.
 *
 * Memberships are keyed by (player, venue), not by club — a club that moves
 * between two venues needs a name for each, and a player shouldn't re-enter the
 * same card for every club that plays there.
 */
const naming = require('./naming')
const clubs = require('./clubs')
const { fail } = require('./errors')
const { db, _, getOrNull } = require('./db')

const membershipId = (openid, venueId) => `${openid}_${venueId}`

async function create({ clubId, venue }, openid) {
  await clubs.requireAdmin(clubId, openid)

  const input = venue || {}
  const name = String(input.name || '').trim()
  if (!name) fail('BAD_VENUE')

  const now = Date.now()
  const doc = {
    name,
    address: String(input.address || '').slice(0, 200),
    location: input.location || null,
    tz_label: String(input.tz_label || ''),
    currency: input.currency ? String(input.currency).toUpperCase().slice(0, 3) : '',
    membership_required: !!input.membership_required,
    max_courts_per_membership: Number(input.max_courts_per_membership) || 0,
    guest_policy: ['ALLOWED', 'SURCHARGE', 'NOT_ALLOWED'].indexOf(input.guest_policy) !== -1
      ? input.guest_policy
      : 'ALLOWED',
    guest_surcharge_minor: Number(input.guest_surcharge_minor) || 0,
    court_labels: Array.isArray(input.court_labels) ? input.court_labels.slice(0, 40) : [],
    created_by: openid,
    created_at: now,
  }

  const added = await db.collection('venues').add({ data: doc })
  const venueId = added._id

  const club = await getOrNull('clubs', clubId)
  const patch = { venue_ids: _.push([venueId]), updated_at: now }
  // First venue becomes primary, since that's what resolves display names. §3.8
  if (!club.primary_venue_id) patch.primary_venue_id = venueId
  await db.collection('clubs').doc(clubId).update({ data: patch })

  return { venueId }
}

async function listForClub({ clubId }, openid) {
  const club = await getOrNull('clubs', clubId)
  if (!club) fail('NOT_FOUND')
  if (!club.venue_ids || !club.venue_ids.length) return { venues: [], my_memberships: {} }

  const venues = (await db.collection('venues').where({ _id: _.in(club.venue_ids) }).get()).data
  const ids = club.venue_ids.map((v) => membershipId(openid, v))
  const rows = (await db.collection('venue_memberships').where({ _id: _.in(ids) }).get()).data

  const my = {}
  rows.forEach((r) => {
    my[r.venue_id] = r
  })
  return { venues, my_memberships: my }
}

/** A player records their own membership; only an admin can mark it verified. */
async function upsertMembership({ venueId, membership_name, membership_no }, openid) {
  const venue = await getOrNull('venues', venueId)
  if (!venue) fail('NOT_FOUND')

  const name = String(membership_name || '').trim()
  if (!name) fail('BAD_MEMBERSHIP_NAME')

  const id = membershipId(openid, venueId)
  const existing = await getOrNull('venue_memberships', id)
  const now = Date.now()

  const data = {
    openid,
    venue_id: venueId,
    membership_name: name.slice(0, 40),
    membership_no: String(membership_no || '').slice(0, 40),
    // Editing the name drops any prior verification — an admin confirmed the old
    // one, not this one.
    verified_by: existing && existing.membership_name === name ? existing.verified_by : null,
    verified_at: existing && existing.membership_name === name ? existing.verified_at : null,
    updated_at: now,
  }

  if (existing) {
    await db.collection('venue_memberships').doc(id).update({ data })
  } else {
    await db
      .collection('venue_memberships')
      .doc(id)
      .set({ data: Object.assign({ _id: id, created_at: now }, data) })
  }
  return { membership: await getOrNull('venue_memberships', id) }
}

async function myMemberships(_payload, openid) {
  const rows = (await db.collection('venue_memberships').where({ openid }).get()).data
  if (!rows.length) return { memberships: [], venues: {} }

  const venueIds = rows.map((r) => r.venue_id)
  const venues = (await db.collection('venues').where({ _id: _.in(venueIds) }).get()).data
  const byId = {}
  venues.forEach((v) => {
    byId[v._id] = v
  })
  return { memberships: rows, venues: byId }
}

async function verifyMembership({ clubId, venueId, targetOpenid, verified }, openid) {
  await clubs.requireAdmin(clubId, openid)

  const id = membershipId(targetOpenid, venueId)
  const row = await getOrNull('venue_memberships', id)
  if (!row) fail('NOT_FOUND')

  await db.collection('venue_memberships').doc(id).update({
    data: verified
      ? { verified_by: openid, verified_at: Date.now() }
      : { verified_by: null, verified_at: null },
  })
  return { ok: true }
}

/**
 * Booking helper for one event. §3.8
 *
 * Answers the organizer's actual question: whose card can I book these courts
 * with, and do we hold enough of them?
 */
async function bookingHelper({ eventId }, openid) {
  const ev = await getOrNull('events', eventId)
  if (!ev) fail('NOT_FOUND')

  const isOrganizer = ev.creator_openid === openid
  let isAdmin = false
  if (ev.club_id) {
    const member = await clubs.myMembership(ev.club_id, openid)
    isAdmin = naming.canAdminClub(member)
  }
  // Membership names are only exposed to whoever is actually doing the booking.
  if (!isOrganizer && !isAdmin) fail('NOT_ADMIN')

  const venueId = ev.venue_id
  if (!venueId) return { venue: null, holders: [], coverage: null }

  const venue = await getOrNull('venues', venueId)
  const signups = await db
    .collection('signups')
    .where({ event_id: eventId, state: _.in(['ROSTER', 'WAITLIST']) })
    .get()

  const openids = signups.data.map((s) => s.openid)
  const memberships = await clubs.membershipsForVenue(venueId, openids)
  const users = await clubs.usersByIds(openids)

  const holders = Object.keys(memberships).map((o) => ({
    openid: o,
    nickname: (users[o] && users[o].nickname) || '',
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
}

module.exports = {
  create,
  listForClub,
  upsertMembership,
  myMemberships,
  verifyMembership,
  bookingHelper,
  membershipId,
}
