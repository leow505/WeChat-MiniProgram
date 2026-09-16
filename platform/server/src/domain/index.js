/**
 * The domain layer, borrowed whole from the WeChat cloud function.
 *
 * `cloudfunctions/api/lib/` holds the authoritative rules: seat allocation,
 * waitlists, gender buckets, all-or-nothing party seating, club permissions and
 * the money split. Those modules are storage-agnostic — they speak only to the
 * seam in `lib/db.js` — so the platform server injects a Postgres-backed store
 * and runs the same code rather than a second implementation that would drift
 * from it (README: "the mock is not a stub").
 *
 * The lib is CommonJS because a WeChat cloud function is; `createRequire` bridges
 * it into this ESM server. `configure()` must run before any handler executes,
 * which is why it happens at module scope here.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { command } from '../db/command.js'

const require = createRequire(import.meta.url)
const libDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'cloudfunctions',
  'api',
  'lib'
)

const seam = require(join(libDir, 'db.js'))

/**
 * Point the domain modules at a store. Call once at startup, before handlers run.
 * Exposed (rather than done implicitly) so tests can inject a store per database.
 */
export function useStore(store) {
  seam.configure({ db: store, command, cloud: null })
}

// Loading these requires the seam to be configurable, but not yet configured:
// nothing touches the database at import time.
const events = require(join(libDir, 'events.js'))
const signups = require(join(libDir, 'signups.js'))
const profile = require(join(libDir, 'profile.js'))
const clubs = require(join(libDir, 'clubs.js'))
const venues = require(join(libDir, 'venues.js'))
const bills = require(join(libDir, 'bills.js'))
const { AppError } = require(join(libDir, 'errors.js'))

/**
 * The action table. Identical names and shapes to the cloud function's router and
 * the mini program's mock, so one client speaks to all three (DESIGN.md §4).
 *
 * Every handler takes (payload, actorId). The actor is resolved from the session
 * by the HTTP layer and never read from the payload.
 */
export const ACTIONS = Object.freeze({
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
})

export const ACTION_NAMES = Object.keys(ACTIONS)

/**
 * Run one action. Business failures surface as an AppError carrying a stable
 * code; the HTTP layer maps it to a response and the client localizes it.
 */
export async function dispatch(action, payload, actorId) {
  const handler = ACTIONS[action]
  if (!handler) {
    const error = new AppError('NO_ACTION')
    error.status = 404
    throw error
  }
  return handler(payload ?? {}, actorId)
}

export { AppError }
