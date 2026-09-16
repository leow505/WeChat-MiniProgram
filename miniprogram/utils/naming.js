/**
 * Club roles, display names, and the booking-helper arithmetic.
 * DESIGN.md §3.8, §3.10.
 *
 * KEEP IN SYNC with cloudfunctions/api/lib/naming.js. Pure — no wx.*, no db — so
 * the two copies stay diffable and tests/rules.test.js can run both.
 */

const Role = { OWNER: 'OWNER', ADMIN: 'ADMIN', MEMBER: 'MEMBER' }
const MemberStatus = {
  ACTIVE: 'ACTIVE',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  REMOVED: 'REMOVED',
}
/**
 * How a club treats someone who arrives at it. Note there is no INVITE_CODE
 * policy: every club has a code, because with public club discovery deferred
 * (§13) the code is the only way to *find* a club. Addressing and admission are
 * separate concerns — the code gets you to the door, the policy decides whether
 * it opens.
 */
const JoinPolicy = { OPEN: 'OPEN', APPROVAL: 'APPROVAL' }
const MembershipPolicy = {
  NOT_REQUIRED: 'NOT_REQUIRED',
  REQUESTED: 'REQUESTED',
  REQUIRED: 'REQUIRED',
}

/**
 * Display name inside a club. §3.8
 *
 * The membership name wins where the club asks for one, because a WeChat nickname
 * ("小明🌸") is useless at a booking counter — the roster should show the name the
 * venue will actually recognize.
 */
function displayName(opts) {
  const { user, member, membership, club } = opts || {}
  const policy = club && club.membership_policy

  if (policy && policy !== MembershipPolicy.NOT_REQUIRED) {
    if (membership && membership.membership_name) return membership.membership_name
  }
  if (member && member.nickname_override) return member.nickname_override
  return (user && user.nickname) || ''
}

function isActiveMember(member) {
  return !!member && member.status === MemberStatus.ACTIVE
}

function canAdminClub(member) {
  return (
    isActiveMember(member) && (member.role === Role.OWNER || member.role === Role.ADMIN)
  )
}

function isOwner(member) {
  return isActiveMember(member) && member.role === Role.OWNER
}

/** Can this person see / join a CLUB_ONLY event? §3.6 */
function canSeeClubEvent(ev, member) {
  if (ev.visibility !== 'CLUB_ONLY') return true
  return isActiveMember(member)
}

/** REQUIRED clubs need a membership name on file before joining. §3.8 */
function membershipSatisfied(club, membership) {
  if (!club || club.membership_policy !== MembershipPolicy.REQUIRED) return true
  return !!(membership && membership.membership_name)
}

/**
 * What happens when someone taps join. §3.10
 *
 * A previously REMOVED member always needs approval, whatever the policy —
 * otherwise removing somebody from an OPEN club accomplishes nothing.
 */
function joinOutcome(club, existingMember) {
  if (existingMember) {
    if (existingMember.status === MemberStatus.ACTIVE) return { error: 'ALREADY_MEMBER' }
    if (existingMember.status === MemberStatus.PENDING) return { error: 'REQUEST_PENDING' }
    if (existingMember.status === MemberStatus.REMOVED) {
      return { status: MemberStatus.PENDING }
    }
  }

  switch (club.join_policy) {
    case JoinPolicy.OPEN:
      return { status: MemberStatus.ACTIVE }
    case JoinPolicy.APPROVAL:
      return { status: MemberStatus.PENDING }
    default:
      return { error: 'BAD_JOIN_POLICY' }
  }
}

/**
 * Booking-helper arithmetic. §3.8
 *
 * Venues often cap how many courts one membership may hold, so booking 3 courts
 * can require 3 different members' cards. This is the sum the organizer needs.
 */
function bookingCoverage(courtsNeeded, maxCourtsPerMembership, membershipCount) {
  const courts = Math.max(0, courtsNeeded || 0)
  const per = maxCourtsPerMembership || 0

  if (per <= 0) {
    // Venue doesn't cap per membership — one card covers the booking.
    return { needed: courts > 0 ? 1 : 0, have: membershipCount, ok: membershipCount >= (courts > 0 ? 1 : 0), capped: false }
  }
  const needed = Math.ceil(courts / per)
  return { needed, have: membershipCount, ok: membershipCount >= needed, capped: true }
}

function generateInviteCode() {
  // Unambiguous alphabet: no O/0, no I/1.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return out
}

module.exports = {
  Role,
  MemberStatus,
  JoinPolicy,
  MembershipPolicy,
  displayName,
  isActiveMember,
  canAdminClub,
  isOwner,
  canSeeClubEvent,
  membershipSatisfied,
  joinOutcome,
  bookingCoverage,
  generateInviteCode,
}
