/**
 * Router cloud function. DESIGN.md §4–§6.
 *
 * One function with an action table rather than a function per action: shared
 * logic stays shared without duplicating lib/ into a dozen directories, and
 * there's one warm pool instead of a dozen cold ones.
 *
 * Every response is `{ ok, data }` or `{ ok: false, code }` — codes, never
 * sentences, so the client owns the wording and one backend serves both locales
 * (§10.1).
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { AppError } = require('./lib/errors')
const events = require('./lib/events')
const signups = require('./lib/signups')
const profile = require('./lib/profile')
const clubs = require('./lib/clubs')
const venues = require('./lib/venues')
const bills = require('./lib/bills')

const ACTIONS = {
  'profile.get': profile.get,
  'profile.upsert': profile.upsert,

  'event.list': events.list,
  'event.mine': events.mineList,
  'event.myRecent': events.myRecent,
  'event.hosting': events.hosting,
  'event.detail': events.detail,
  'event.create': events.create,
  'event.duplicate': events.duplicate,
  'event.setCourts': events.setCourts,
  'event.updateRules': events.updateRules,
  'event.removeSignup': events.removeSignup,
  'event.cancel': events.cancel,

  'event.join': signups.join,
  'event.withdraw': signups.withdraw,
  'event.updateGuests': signups.updateGuests,

  'club.create': clubs.create,
  'club.mine': clubs.mine,
  'club.detail': clubs.detail,
  'club.join': clubs.join,
  'club.joinByCode': clubs.joinByCode,
  'club.leave': clubs.leave,
  'club.update': clubs.update,
  'club.decide': clubs.decide,
  'club.setRole': clubs.setRole,
  'club.removeMember': clubs.removeMember,

  'bill.get': bills.get,
  'bill.publish': bills.publish,
  'bill.markPaid': bills.markPaid,
  'bill.waive': bills.waive,
  'bill.claimPaid': bills.claimPaid,
  'bill.void': bills.voidBill,

  'venue.create': venues.create,
  'venue.listForClub': venues.listForClub,
  'venue.upsertMembership': venues.upsertMembership,
  'venue.myMemberships': venues.myMemberships,
  'venue.verifyMembership': venues.verifyMembership,
  'venue.bookingHelper': venues.bookingHelper,
}

exports.main = async (event) => {
  const { action, payload } = event || {}
  const handler = ACTIONS[action]
  if (!handler) return { ok: false, code: 'NO_ACTION' }

  // The caller's identity comes from the platform, never from the payload.
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, code: 'NO_IDENTITY' }

  try {
    const data = await handler(payload || {}, OPENID)
    return { ok: true, data }
  } catch (err) {
    if (err instanceof AppError) {
      return { ok: false, code: err.code }
    }
    // Unexpected: log it server-side, return something opaque.
    console.error(`[api] ${action} failed`, err)
    return { ok: false, code: 'INTERNAL' }
  }
}
