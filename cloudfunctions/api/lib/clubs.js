/**
 * Clubs, membership, and roles. DESIGN.md §3.8, §3.10, §4.
 */
const naming = require('./naming')
const { fail } = require('./errors')
const { db, _, getOrNull } = require('./db')

const memberId = (clubId, openid) => `${clubId}_${openid}`

const DEFAULT_EVENT_DEFAULTS = {
  venue_id: null,
  format_template: 'DOUBLES',
  court_count: 2,
  min_players: 4,
  max_guests_per_member: 0,
  on_full: 'WAITLIST',
  join_deadline_rule: 'AT_EVENT_START',
  withdraw_rule: 'HOURS_BEFORE_START',
  withdraw_hours_before: 6,
  visibility: 'CLUB_ONLY',
  cost_estimate_per_person: 0,
  level_hint: 'ANY',
}

async function myMembership(clubId, openid) {
  return getOrNull('club_members', memberId(clubId, openid))
}

/** Throws unless the caller is an active admin or owner. */
async function requireAdmin(clubId, openid) {
  const club = await getOrNull('clubs', clubId)
  if (!club) fail('NOT_FOUND')
  const member = await myMembership(clubId, openid)
  if (!naming.canAdminClub(member)) fail('NOT_ADMIN')
  return { club, member }
}

async function create({ club }, openid) {
  const input = club || {}
  const name = String(input.name || '').trim()
  if (!name) fail('BAD_CLUB_NAME')

  const now = Date.now()
  const policy = naming.JoinPolicy[input.join_policy] || naming.JoinPolicy.APPROVAL

  const doc = {
    name,
    description: String(input.description || '').slice(0, 500),
    cover_url: '',
    owner_openid: openid,
    join_policy: policy,
    // Every club gets one: with discovery deferred it's the only way in. §3.10
    invite_code: naming.generateInviteCode(),
    member_count: 1,
    settlement_grace_hours: 12,
    currency: input.currency || 'CAD',
    membership_policy:
      naming.MembershipPolicy[input.membership_policy] || naming.MembershipPolicy.NOT_REQUIRED,
    venue_ids: [],
    primary_venue_id: null,
    event_defaults: Object.assign({}, DEFAULT_EVENT_DEFAULTS),
    created_at: now,
    updated_at: now,
  }

  const added = await db.collection('clubs').add({ data: doc })
  const clubId = added._id

  const mid = memberId(clubId, openid)
  await db.collection('club_members').doc(mid).set({
    data: {
      _id: mid,
      club_id: clubId,
      openid,
      role: naming.Role.OWNER,
      status: naming.MemberStatus.ACTIVE,
      nickname_override: '',
      reject_reason: '',
      requested_at: now,
      joined_at: now,
    },
  })

  return { clubId, invite_code: doc.invite_code }
}

/** Clubs the caller belongs to. Public club discovery is deferred (§13). */
async function mine(_payload, openid) {
  const memberships = await db
    .collection('club_members')
    .where({ openid, status: _.in([naming.MemberStatus.ACTIVE, naming.MemberStatus.PENDING]) })
    .get()

  const byClub = {}
  memberships.data.forEach((m) => {
    byClub[m.club_id] = m
  })
  const ids = Object.keys(byClub)

  let joined = []
  if (ids.length) {
    const r = await db.collection('clubs').where({ _id: _.in(ids) }).get()
    joined = r.data.map((c) =>
      Object.assign({}, c, {
        my_role: byClub[c._id].role,
        my_status: byClub[c._id].status,
        invite_code: naming.canAdminClub(byClub[c._id]) ? c.invite_code : '',
      })
    )
  }

  // Venue names ride along so the create form can offer a venue picker without a
  // second round trip.
  const venueIds = []
  joined.forEach((c) => (c.venue_ids || []).forEach((v) => venueIds.push(v)))
  const venues = {}
  if (venueIds.length) {
    const r = await db
      .collection('venues')
      .where({ _id: _.in(Array.from(new Set(venueIds))) })
      .get()
    r.data.forEach((v) => {
      venues[v._id] = v
    })
  }

  /**
   * Requests waiting on this person across every club they administer. Surfaced on
   * the tab bar, because an admin shouldn't have to go looking to find out someone
   * is waiting to be let in. §3.10
   */
  const adminClubIds = joined
    .filter((c) => naming.canAdminClub(byClub[c._id]))
    .map((c) => c._id)

  let pending_total = 0
  if (adminClubIds.length) {
    const r = await db
      .collection('club_members')
      .where({ club_id: _.in(adminClubIds), status: naming.MemberStatus.PENDING })
      .limit(200)
      .get()
    // Tallied per club as well as overall: the list shows which club is waiting,
    // the tab bar shows only that something is.
    const byId = {}
    r.data.forEach((m) => {
      byId[m.club_id] = (byId[m.club_id] || 0) + 1
    })
    joined.forEach((c) => {
      c.pending_count = byId[c._id] || 0
    })
    pending_total = r.data.length
  }

  return { joined, venues, pending_total }
}

async function detail({ clubId }, openid) {
  const club = await getOrNull('clubs', clubId)
  if (!club) fail('NOT_FOUND')

  const me = await myMembership(clubId, openid)
  const isAdmin = naming.canAdminClub(me)
  const isMember = naming.isActiveMember(me)

  const memberRows = await db
    .collection('club_members')
    .where({ club_id: clubId, status: naming.MemberStatus.ACTIVE })
    .limit(200)
    .get()

  const pendingRows = isAdmin
    ? await db
        .collection('club_members')
        .where({ club_id: clubId, status: naming.MemberStatus.PENDING })
        .limit(100)
        .get()
    : { data: [] }

  const openids = memberRows.data.concat(pendingRows.data).map((m) => m.openid)
  const users = await usersByIds(openids)
  const memberships = await membershipsForVenue(club.primary_venue_id, openids)

  const view = (m) => ({
    openid: m.openid,
    role: m.role,
    status: m.status,
    gender: (users[m.openid] || {}).gender || 'UNSPECIFIED',
    name: naming.displayName({
      user: users[m.openid],
      member: m,
      membership: memberships[m.openid],
      club,
    }),
    has_membership: !!memberships[m.openid],
    membership_verified: !!(memberships[m.openid] && memberships[m.openid].verified_at),
    joined_at: m.joined_at,
    requested_at: m.requested_at,
  })

  const venues = club.venue_ids && club.venue_ids.length
    ? (await db.collection('venues').where({ _id: _.in(club.venue_ids) }).get()).data
    : []

  // Upcoming sessions: CLUB_ONLY ones are only listed to actual members. §3.6
  const now = Date.now()
  const eventQuery = { club_id: clubId, lifecycle: 'ACTIVE', end_at: _.gt(now) }
  if (!isMember) eventQuery.visibility = 'PUBLIC'
  const events = await db
    .collection('events')
    .where(eventQuery)
    .orderBy('start_at', 'asc')
    .limit(20)
    .get()

  return {
    club: Object.assign({}, club, { invite_code: isAdmin ? club.invite_code : '' }),
    my_role: me ? me.role : null,
    my_status: me ? me.status : null,
    is_admin: isAdmin,
    is_member: isMember,
    is_owner: naming.isOwner(me),
    members: memberRows.data.map(view).sort((a, b) => a.joined_at - b.joined_at),
    pending: pendingRows.data.map(view).sort((a, b) => a.requested_at - b.requested_at),
    pending_count: pendingRows.data.length,
    venues,
    my_membership: memberships[openid] || null,
    upcoming: events.data,
  }
}

async function usersByIds(ids) {
  const unique = Array.from(new Set(ids)).filter(Boolean)
  if (!unique.length) return {}
  const r = await db.collection('users').where({ _id: _.in(unique) }).get()
  const map = {}
  r.data.forEach((u) => {
    map[u._id] = u
  })
  return map
}

/** Venue memberships keyed by openid, for one venue. §3.8 */
async function membershipsForVenue(venueId, openids) {
  if (!venueId) return {}
  const unique = Array.from(new Set(openids)).filter(Boolean)
  if (!unique.length) return {}
  const ids = unique.map((o) => `${o}_${venueId}`)
  const r = await db.collection('venue_memberships').where({ _id: _.in(ids) }).get()
  const map = {}
  r.data.forEach((m) => {
    map[m.openid] = m
  })
  return map
}

async function join({ clubId }, openid) {
  const club = await getOrNull('clubs', clubId)
  if (!club) fail('NOT_FOUND')

  const existing = await myMembership(clubId, openid)
  const outcome = naming.joinOutcome(club, existing)
  if (outcome.error) fail(outcome.error)

  // A REQUIRED club needs a membership name on file first. §3.8
  if (club.membership_policy === naming.MembershipPolicy.REQUIRED) {
    const membership = club.primary_venue_id
      ? await getOrNull('venue_memberships', `${openid}_${club.primary_venue_id}`)
      : null
    if (!naming.membershipSatisfied(club, membership)) fail('MEMBERSHIP_REQUIRED')
  }

  const now = Date.now()
  const mid = memberId(clubId, openid)
  const data = {
    club_id: clubId,
    openid,
    role: naming.Role.MEMBER,
    status: outcome.status,
    nickname_override: existing ? existing.nickname_override || '' : '',
    reject_reason: '',
    requested_at: now,
    joined_at: outcome.status === naming.MemberStatus.ACTIVE ? now : null,
  }

  // Deterministic _id: one row per person per club however many attempts. §3.10
  if (existing) {
    await db.collection('club_members').doc(mid).update({ data })
  } else {
    await db.collection('club_members').doc(mid).set({ data: Object.assign({ _id: mid }, data) })
  }

  if (outcome.status === naming.MemberStatus.ACTIVE) {
    await db.collection('clubs').doc(clubId).update({ data: { member_count: _.inc(1) } })
  }

  return { status: outcome.status }
}

/**
 * Join using only an invite code — the code identifies the club, so the joiner
 * never needs its id. Guarded against the empty string, which every non-invite
 * club stores.
 */
async function joinByCode({ code }, openid) {
  const c = String(code || '').trim().toUpperCase()
  if (!c) fail('BAD_INVITE_CODE')

  const r = await db.collection('clubs').where({ invite_code: c }).limit(1).get()
  if (!r.data.length) fail('BAD_INVITE_CODE')

  return join({ clubId: r.data[0]._id }, openid)
}

async function decide({ clubId, targetOpenid, approve, reason }, openid) {
  await requireAdmin(clubId, openid)

  const mid = memberId(clubId, targetOpenid)
  const target = await getOrNull('club_members', mid)
  if (!target || target.status !== naming.MemberStatus.PENDING) fail('NO_PENDING_REQUEST')

  const now = Date.now()
  if (approve) {
    await db.collection('club_members').doc(mid).update({
      data: { status: naming.MemberStatus.ACTIVE, joined_at: now, reject_reason: '' },
    })
    await db.collection('clubs').doc(clubId).update({ data: { member_count: _.inc(1) } })
    return { status: naming.MemberStatus.ACTIVE }
  }

  await db.collection('club_members').doc(mid).update({
    data: {
      status: naming.MemberStatus.REJECTED,
      reject_reason: String(reason || '').slice(0, 200),
    },
  })
  return { status: naming.MemberStatus.REJECTED }
}

async function setRole({ clubId, targetOpenid, role }, openid) {
  const { member } = await requireAdmin(clubId, openid)
  // Only an owner promotes admins. §3.10
  if (!naming.isOwner(member)) fail('NOT_OWNER')
  if (targetOpenid === openid) fail('CANNOT_CHANGE_OWN_ROLE')
  if (role !== naming.Role.ADMIN && role !== naming.Role.MEMBER) fail('BAD_ROLE')

  const mid = memberId(clubId, targetOpenid)
  const target = await getOrNull('club_members', mid)
  if (!naming.isActiveMember(target)) fail('NOT_MEMBER')

  await db.collection('club_members').doc(mid).update({ data: { role } })
  return { role }
}

async function removeMember({ clubId, targetOpenid }, openid) {
  const { member } = await requireAdmin(clubId, openid)

  const mid = memberId(clubId, targetOpenid)
  const target = await getOrNull('club_members', mid)
  if (!naming.isActiveMember(target)) fail('NOT_MEMBER')
  if (target.role === naming.Role.OWNER) fail('CANNOT_REMOVE_OWNER')
  if (target.role === naming.Role.ADMIN && !naming.isOwner(member)) fail('NOT_OWNER')

  await db
    .collection('club_members')
    .doc(mid)
    .update({ data: { status: naming.MemberStatus.REMOVED, role: naming.Role.MEMBER } })
  await db.collection('clubs').doc(clubId).update({ data: { member_count: _.inc(-1) } })
  return { ok: true }
}

async function leave({ clubId }, openid) {
  const member = await myMembership(clubId, openid)
  if (!naming.isActiveMember(member)) fail('NOT_MEMBER')
  // An owner has to hand the club over first, or there's nobody to administer it.
  if (member.role === naming.Role.OWNER) fail('OWNER_CANNOT_LEAVE')

  await db
    .collection('club_members')
    .doc(memberId(clubId, openid))
    .update({ data: { status: naming.MemberStatus.REMOVED } })
  await db.collection('clubs').doc(clubId).update({ data: { member_count: _.inc(-1) } })
  return { ok: true }
}

async function update({ clubId, patch }, openid) {
  await requireAdmin(clubId, openid)
  const p = patch || {}
  const data = { updated_at: Date.now() }

  if (p.name !== undefined) {
    const name = String(p.name).trim()
    if (!name) fail('BAD_CLUB_NAME')
    data.name = name
  }
  if (p.description !== undefined) data.description = String(p.description).slice(0, 500)
  if (p.join_policy !== undefined) {
    if (!naming.JoinPolicy[p.join_policy]) fail('BAD_JOIN_POLICY')
    data.join_policy = p.join_policy
  }
  if (p.membership_policy !== undefined) {
    if (!naming.MembershipPolicy[p.membership_policy]) fail('BAD_MEMBERSHIP_POLICY')
    data.membership_policy = p.membership_policy
  }
  if (p.settlement_grace_hours !== undefined) {
    data.settlement_grace_hours = Math.max(1, Math.min(168, Number(p.settlement_grace_hours) || 12))
  }
  if (p.currency !== undefined) {
    // Any well-formed ISO 4217 code, not just the ones the picker offers — a club
    // somewhere unanticipated shouldn't be locked out. §10.3
    const cur = String(p.currency).toUpperCase()
    if (!/^[A-Z]{3}$/.test(cur)) fail('BAD_CURRENCY')
    data.currency = cur
  }
  if (p.primary_venue_id !== undefined) data.primary_venue_id = p.primary_venue_id || null
  if (p.event_defaults !== undefined) {
    data.event_defaults = Object.assign({}, DEFAULT_EVENT_DEFAULTS, p.event_defaults)
  }
  if (p.rotate_invite_code) data.invite_code = naming.generateInviteCode()

  await db.collection('clubs').doc(clubId).update({ data })
  const club = await getOrNull('clubs', clubId)
  return { club }
}

module.exports = {
  create,
  mine,
  detail,
  join,
  joinByCode,
  decide,
  setRole,
  removeMember,
  leave,
  update,
  requireAdmin,
  myMembership,
  membershipsForVenue,
  usersByIds,
  memberId,
  DEFAULT_EVENT_DEFAULTS,
}
