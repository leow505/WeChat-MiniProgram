/**
 * Mock persistence and seed data.
 *
 * Cloud Development is bound to a real mini program account, so under
 * `touristappid` there is no environment to call. This is the storage half of the
 * offline backend; utils/mock.js holds the actions.
 */
const rules = require('./rules')
const fmt = require('./format')

const KEY = 'mock_db_v14'
const ME = 'mock_openid_self'

const now = () => Date.now()

/** Wall clock for a UTC stamp, for seeding deadlines. §10.2 */
function localOf(utcMs) {
  const d = new Date(utcMs)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** Weekday of a slot, so seeded titles can't drift out of sync with their dates. */
function weekdayOf(utcMs) {
  return '周' + WEEKDAY[new Date(utcMs).getDay()]
}

/**
 * A slot N hours out, for exercising the near-deadline countdown.
 *
 * Rounded down to the hour: an unrounded stamp rendered as "03:29-05:29", which reads
 * as a bug rather than as a badminton session.
 */
function slotInHours(hoursAhead, durationHours) {
  const start =
    Math.floor((Date.now() + hoursAhead * rules.HOUR) / rules.HOUR) * rules.HOUR
  return {
    start_at: start,
    start_local: localOf(start),
    end_at: start + durationHours * rules.HOUR,
    end_local: localOf(start + durationHours * rules.HOUR),
  }
}

/** UTC ms + wall clock for "N days from now at HH:00". §10.2 */
function slot(daysAhead, hour, durationHours) {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  d.setHours(hour, 0, 0, 0)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const start = fmt.fromPickers(date, `${pad(hour)}:00`)
  return {
    start_at: start.utc,
    start_local: start.local,
    end_at: start.utc + durationHours * rules.HOUR,
    end_local: fmt.addHoursLocal(start.local, durationHours),
  }
}

function seed() {
  const users = {
    // Nickname left blank on purpose: exercises the setup nudge, and lets the
    // club display name come from the venue membership instead. §3.8
    [ME]: { _id: ME, nickname: '', avatar_url: '', gender: 'UNSPECIFIED' },
    u_lin: { _id: 'u_lin', nickname: '林昊', avatar_url: '', gender: 'MALE' },
    u_chen: { _id: 'u_chen', nickname: '陈小雨', avatar_url: '', gender: 'FEMALE' },
    u_li: { _id: 'u_li', nickname: '李想', avatar_url: '', gender: 'MALE' },
    u_zhao: { _id: 'u_zhao', nickname: '赵敏', avatar_url: '', gender: 'FEMALE' },
    u_sun: { _id: 'u_sun', nickname: '孙浩', avatar_url: '', gender: 'MALE' },
    u_liu: { _id: 'u_liu', nickname: '刘洋', avatar_url: '', gender: 'FEMALE' },
    u_zhang: { _id: 'u_zhang', nickname: '张伟', avatar_url: '', gender: 'MALE' },
    u_wu: { _id: 'u_wu', nickname: '吴静', avatar_url: '', gender: 'FEMALE' },
    u_he: { _id: 'u_he', nickname: '何强', avatar_url: '', gender: 'MALE' },
    u_ma: { _id: 'u_ma', nickname: '马丽', avatar_url: '', gender: 'FEMALE' },
  }

  const venues = {
    v_river: {
      _id: 'v_river',
      name: 'Riverside Centre',
      address: '120 Riverside Way',
      tz_label: 'America/Toronto',
      currency: 'CAD',
      membership_required: true,
      max_courts_per_membership: 2, // drives the booking helper maths §3.8
      guest_policy: 'SURCHARGE',
      guest_surcharge_minor: 500,
      court_labels: ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6'],
      created_by: ME,
      created_at: now(),
    },
    v_north: {
      _id: 'v_north',
      name: 'Northside Hall',
      address: '88 Northside Ave',
      tz_label: 'America/Toronto',
      currency: 'CAD',
      membership_required: false,
      max_courts_per_membership: 0,
      guest_policy: 'ALLOWED',
      guest_surcharge_minor: 0,
      court_labels: ['A', 'B', 'C', 'D'],
      created_by: 'u_chen',
      created_at: now(),
    },
    // The drop-in club's venue. Kept separate from the two above so that recording a
    // card for one club does not silently satisfy the other. §3.8
    v_west: {
      _id: 'v_west',
      name: 'Westside Courts',
      address: '7 West Court Lane',
      tz_label: 'America/Toronto',
      currency: 'CAD',
      membership_required: false,
      max_courts_per_membership: 0,
      guest_policy: 'ALLOWED',
      guest_surcharge_minor: 0,
      court_labels: ['1', '2', '3'],
      created_by: 'u_zhao',
      created_at: now(),
    },
  }

  const clubs = {
    c_thu: {
      _id: 'c_thu',
      name: 'Thursday Smash',
      description: '每周四晚固定打球 · Thursday night regulars',
      cover_url: '',
      owner_openid: ME,
      join_policy: 'APPROVAL',
      invite_code: 'SMASH7',
      member_count: 4,
      settlement_grace_hours: 12,
      currency: 'CAD',
      membership_policy: 'REQUESTED',
      venue_ids: ['v_river'],
      primary_venue_id: 'v_river',
      event_defaults: {
        venue_id: 'v_river',
        format_template: 'DOUBLES',
        court_count: 2,
        min_players: 4,
        max_guests_per_member: 1,
        on_full: 'WAITLIST',
        join_deadline_rule: 'AT_TIME',
        withdraw_rule: 'HOURS_BEFORE_START',
        withdraw_hours_before: 6,
        visibility: 'CLUB_ONLY',
        cost_estimate_per_person: 1200,
        level_hint: 'INTERMEDIATE',
      },
      created_at: now() - 30 * 24 * rules.HOUR,
      updated_at: now(),
    },
    c_open: {
      _id: 'c_open',
      name: 'Open Shuttlers',
      description: 'Open club, all levels welcome',
      cover_url: '',
      owner_openid: 'u_chen',
      join_policy: 'OPEN',
      invite_code: 'OPEN44',
      member_count: 3,
      settlement_grace_hours: 24,
      currency: 'CAD',
      membership_policy: 'NOT_REQUIRED',
      venue_ids: ['v_north'],
      primary_venue_id: 'v_north',
      event_defaults: null,
      created_at: now() - 60 * 24 * rules.HOUR,
      updated_at: now(),
    },
    // Two clubs the seeded user is *not* in, because joining one is the only way to
    // see what a club asks for on the way in. Neither is discoverable (§13), so both
    // are reached from the clubs tab with their invite code:
    //
    //   CARD22 — REQUIRED, so the join asks for the venue membership name and will
    //            not proceed without it. Approval club: the request lands as pending.
    //   DROPS5 — REQUESTED, so the join offers the same field and joins anyway if it
    //            is left blank. Open club: membership is immediate.
    //
    // Their venues are ones the seeded user holds no card for, which is what makes
    // the prompt appear at all. §3.8
    c_card: {
      _id: 'c_card',
      name: 'Northside League',
      description: '订场用会员卡 · Courts are booked on a member card',
      cover_url: '',
      owner_openid: 'u_lin',
      join_policy: 'APPROVAL',
      invite_code: 'CARD22',
      member_count: 2,
      settlement_grace_hours: 12,
      currency: 'CAD',
      membership_policy: 'REQUIRED',
      venue_ids: ['v_north'],
      primary_venue_id: 'v_north',
      event_defaults: null,
      created_at: now() - 45 * 24 * rules.HOUR,
      updated_at: now(),
    },
    c_drop: {
      _id: 'c_drop',
      name: 'Westside Drop-in',
      description: 'Casual drop-in · 会员名可填可不填',
      cover_url: '',
      owner_openid: 'u_zhao',
      join_policy: 'OPEN',
      invite_code: 'DROPS5',
      member_count: 2,
      settlement_grace_hours: 24,
      currency: 'CAD',
      membership_policy: 'REQUESTED',
      venue_ids: ['v_west'],
      primary_venue_id: 'v_west',
      event_defaults: null,
      created_at: now() - 20 * 24 * rules.HOUR,
      updated_at: now(),
    },
  }

  const club_members = {}
  const addMember = (clubId, openid, role, status, agoDays) => {
    const id = `${clubId}_${openid}`
    club_members[id] = {
      _id: id,
      club_id: clubId,
      openid,
      role,
      status,
      nickname_override: '',
      reject_reason: '',
      requested_at: now() - agoDays * 24 * rules.HOUR,
      joined_at: status === 'ACTIVE' ? now() - agoDays * 24 * rules.HOUR : null,
    }
  }
  addMember('c_thu', ME, 'OWNER', 'ACTIVE', 30)
  addMember('c_thu', 'u_lin', 'ADMIN', 'ACTIVE', 25)
  addMember('c_thu', 'u_chen', 'MEMBER', 'ACTIVE', 20)
  addMember('c_thu', 'u_li', 'MEMBER', 'ACTIVE', 10)
  addMember('c_thu', 'u_zhao', 'MEMBER', 'PENDING', 0) // a request to approve §3.10
  addMember('c_open', 'u_chen', 'OWNER', 'ACTIVE', 60)
  addMember('c_open', 'u_sun', 'MEMBER', 'ACTIVE', 40)
  addMember('c_open', ME, 'MEMBER', 'ACTIVE', 15)
  // The two clubs waiting to be joined by code — ME is deliberately absent from both.
  addMember('c_card', 'u_lin', 'OWNER', 'ACTIVE', 45)
  addMember('c_card', 'u_li', 'MEMBER', 'ACTIVE', 20)
  addMember('c_drop', 'u_zhao', 'OWNER', 'ACTIVE', 20)
  addMember('c_drop', 'u_sun', 'MEMBER', 'ACTIVE', 12)

  const venue_memberships = {}
  const addMembership = (openid, venueId, name, no, verified) => {
    const id = `${openid}_${venueId}`
    venue_memberships[id] = {
      _id: id,
      openid,
      venue_id: venueId,
      membership_name: name,
      membership_no: no || '',
      verified_by: verified ? ME : null,
      verified_at: verified ? now() : null,
      created_at: now(),
      updated_at: now(),
    }
  }
  addMembership(ME, 'v_river', 'Demo Player', 'RC-10021', true)
  addMembership('u_lin', 'v_river', 'Lin Hao', 'RC-10044', true)
  addMembership('u_chen', 'v_river', 'Chen Xiaoyu', '', false)
  // Northside: the card the league books on, and one nobody has confirmed yet.
  addMembership('u_lin', 'v_north', 'Lin Hao', 'NS-2041', true)
  addMembership('u_li', 'v_north', 'Li Xiang', '', false)

  const thu = slot(2, 19, 2)
  const sat = slot(4, 10, 2)
  const tue = slot(1, 20, 2)
  const wed = slot(3, 18, 1.5)
  const fri = slot(5, 19, 2)
  const soon = slotInHours(9, 2) // deadline inside the 12h countdown window
  // Three finished sessions, because settlement can only happen after play (§9.1) and
  // every other seeded session is in the future.
  const played = slot(-3, 19, 2)
  const owed = slot(-6, 10, 2)
  const collect = slot(-1, 19, 2)

  const common = {
    court_status: 'NOT_BOOKED',
    court_assignments: [],
    courts_visible_to: 'ROSTER',
    waitlist_capacity: 0,
    level_hint: 'ANY',
    lifecycle: 'ACTIVE',
    currency: 'CAD',
    on_full: 'WAITLIST',
    withdraw_rule: 'HOURS_BEFORE_START',
    withdraw_hours_before: 6,
    waitlist_count: 0,
    series_id: null,
  }

  const events = {
    // Club-scoped, OPEN roster — exercises CLUB_ONLY visibility. §3.6
    e_thu: Object.assign({}, common, thu, {
      _id: 'e_thu',
      club_id: 'c_thu',
      creator_openid: 'u_lin',
      title: weekdayOf(thu.start_at) + '晚双打',
      venue_id: 'v_river',
      venue_snapshot: {
        name: venues.v_river.name,
        address: venues.v_river.address,
        tz_label: venues.v_river.tz_label,
      },
      format_template: 'DOUBLES',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 2,
      capacity: 8,
      min_players: 4,
      signup_open_at: now() - rules.HOUR,
      join_deadline_rule: 'AT_TIME',
      join_deadline_at: thu.start_at - 6 * rules.HOUR,
      join_deadline_local: localOf(thu.start_at - 6 * rules.HOUR),
      visibility: 'CLUB_ONLY',
      max_guests_per_member: 2,
      cost_estimate_per_person: 1200,
      cost_note: '',
      roster_count: 3,
      created_at: now() - 2 * rules.HOUR,
      updated_at: now(),
    }),

    // Public, GENDER_BALANCED — one female slot left. §3.9
    e_sat: Object.assign({}, common, sat, {
      _id: 'e_sat',
      club_id: 'c_open',
      creator_openid: 'u_chen',
      title: weekdayOf(sat.start_at) + '混双',
      venue_id: 'v_north',
      venue_snapshot: {
        name: venues.v_north.name,
        address: venues.v_north.address,
        tz_label: venues.v_north.tz_label,
      },
      format_template: 'MIXED_DOUBLES',
      roster_mode: 'GENDER_BALANCED',
      capacity_by_gender: { male: 4, female: 4 },
      roster_by_gender: { male: 4, female: 3 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 2,
      capacity: 8,
      min_players: 8,
      signup_open_at: now() - 3 * rules.HOUR,
      join_deadline_rule: 'AT_EVENT_START',
      join_deadline_at: null,
      join_deadline_local: '',
      visibility: 'PUBLIC',
      max_guests_per_member: 1,
      cost_estimate_per_person: 1500,
      cost_note: '',
      court_status: 'CONFIRMED',
      court_assignments: [{ label: 'A', note: '' }, { label: 'B', note: '' }],
      roster_count: 7,
      created_at: now() - 3 * rules.HOUR,
      updated_at: now(),
    }),

    // FULL with a waitlist — on_full: WAITLIST, so status is WAITLIST_ONLY and the
    // CTA reads 加入候补. Seats are 8 but only 7 signups: 孙浩 brought a guest,
    // which is why the roster count and the head count differ.
    e_full: Object.assign({}, common, tue, {
      _id: 'e_full',
      club_id: 'c_thu',
      creator_openid: 'u_lin',
      title: weekdayOf(tue.start_at) + '晚双打',
      venue_id: 'v_river',
      venue_snapshot: {
        name: venues.v_river.name,
        address: venues.v_river.address,
        tz_label: venues.v_river.tz_label,
      },
      format_template: 'DOUBLES',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 2,
      capacity: 8,
      min_players: 4,
      signup_open_at: now() - 26 * rules.HOUR,
      join_deadline_rule: 'AT_TIME',
      join_deadline_at: tue.start_at - 6 * rules.HOUR,
      join_deadline_local: localOf(tue.start_at - 6 * rules.HOUR),
      visibility: 'CLUB_ONLY',
      max_guests_per_member: 2,
      cost_estimate_per_person: 1200,
      cost_note: '',
      court_status: 'CONFIRMED',
      court_assignments: [{ label: 'Court 3', note: '' }, { label: 'Court 5', note: '' }],
      roster_count: 8,
      waitlist_count: 3,
      created_at: now() - 26 * rules.HOUR,
      updated_at: now(),
    }),

    // FULL and closed — on_full: CLOSE, so status is FULL_CLOSED, there is no
    // waitlist at all and the CTA is disabled. §3.1
    e_closed: Object.assign({}, common, wed, {
      _id: 'e_closed',
      club_id: 'c_open',
      creator_openid: 'u_chen',
      title: weekdayOf(wed.start_at) + '单打',
      venue_id: 'v_north',
      venue_snapshot: {
        name: venues.v_north.name,
        address: venues.v_north.address,
        tz_label: venues.v_north.tz_label,
      },
      format_template: 'SINGLES',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      on_full: 'CLOSE',
      court_count: 2,
      capacity: 4,
      min_players: 2,
      signup_open_at: now() - 10 * rules.HOUR,
      join_deadline_rule: 'AT_EVENT_START',
      join_deadline_at: null,
      join_deadline_local: '',
      visibility: 'PUBLIC',
      max_guests_per_member: 0,
      cost_estimate_per_person: 900,
      cost_note: '',
      roster_count: 4,
      created_at: now() - 10 * rules.HOUR,
      updated_at: now(),
    }),

    // FULL, waitlist already 2 deep, and ME on neither list — so the CTA offers
    // 加入候补 and the waitlist join can actually be exercised.
    e_joinwait: Object.assign({}, common, fri, {
      _id: 'e_joinwait',
      club_id: 'c_thu',
      creator_openid: 'u_li',
      title: weekdayOf(fri.start_at) + '晚双打',
      venue_id: 'v_river',
      venue_snapshot: {
        name: venues.v_river.name,
        address: venues.v_river.address,
        tz_label: venues.v_river.tz_label,
      },
      format_template: 'DOUBLES',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 1,
      capacity: 4,
      min_players: 4,
      signup_open_at: now() - 5 * rules.HOUR,
      join_deadline_rule: 'AT_EVENT_START',
      join_deadline_at: null,
      join_deadline_local: '',
      visibility: 'CLUB_ONLY',
      max_guests_per_member: 1,
      cost_estimate_per_person: 1000,
      cost_note: '',
      court_status: 'CONFIRMED',
      court_assignments: [{ label: 'Court 1', note: '' }],
      roster_count: 4,
      waitlist_count: 2,
      created_at: now() - 5 * rules.HOUR,
      updated_at: now(),
    }),

    // Starts in 9 hours and closes at start, so the card shows a countdown rather
    // than a date — the near-deadline branch.
    e_soon: Object.assign({}, common, soon, {
      _id: 'e_soon',
      club_id: 'c_thu',
      creator_openid: 'u_chen',
      // Time-neutral on purpose: this slot is 9h from whenever you compile, so a
      // title saying 今晚 was wrong for most of the day. Same trap as the weekday
      // titles below.
      title: '临时约球',
      venue_id: 'v_river',
      venue_snapshot: {
        name: venues.v_river.name,
        address: venues.v_river.address,
        tz_label: venues.v_river.tz_label,
      },
      format_template: 'SOCIAL_MIXER',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 1,
      capacity: 6,
      min_players: 4,
      signup_open_at: now() - rules.HOUR,
      join_deadline_rule: 'AT_EVENT_START',
      join_deadline_at: null,
      join_deadline_local: '',
      visibility: 'CLUB_ONLY',
      max_guests_per_member: 1,
      cost_estimate_per_person: 800,
      cost_note: '',
      level_hint: 'BEGINNER',
      court_status: 'CONFIRMED',
      court_assignments: [{ label: 'Court 2', note: '' }],
      roster_count: 2,
      created_at: now() - rules.HOUR,
      updated_at: now(),
    }),

    // Played 3 days ago with the courts paid for: a DRAFT bill waiting to be split.
    // At Riverside, so the guest surcharge branch of §9.2 is live — 赵敏 brought one
    // guest, and 96 over 7 units peels off the 5 surcharge first.
    e_played: Object.assign({}, common, played, {
      _id: 'e_played',
      club_id: 'c_thu',
      creator_openid: 'u_lin',
      title: weekdayOf(played.start_at) + '晚双打',
      venue_id: 'v_river',
      venue_snapshot: {
        name: venues.v_river.name,
        address: venues.v_river.address,
        tz_label: venues.v_river.tz_label,
      },
      format_template: 'DOUBLES',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 2,
      capacity: 8,
      min_players: 4,
      signup_open_at: played.start_at - 5 * 24 * rules.HOUR,
      join_deadline_rule: 'AT_TIME',
      join_deadline_at: played.start_at - 6 * rules.HOUR,
      join_deadline_local: localOf(played.start_at - 6 * rules.HOUR),
      visibility: 'CLUB_ONLY',
      max_guests_per_member: 2,
      cost_estimate_per_person: 1200,
      cost_note: '',
      court_status: 'CONFIRMED',
      court_assignments: [{ label: 'Court 3', note: '' }, { label: 'Court 4', note: '' }],
      roster_count: 7,
      created_at: played.start_at - 5 * 24 * rules.HOUR,
      updated_at: now(),
    }),

    // Played 6 days ago at Northside, where ME is a plain member rather than an admin —
    // so this one exercises the player's side: a PUBLISHED bill, a share still
    // unpaid, and c_open's 24h grace long since passed so it reads as overdue.
    e_owed: Object.assign({}, common, owed, {
      _id: 'e_owed',
      club_id: 'c_open',
      creator_openid: 'u_chen',
      title: weekdayOf(owed.start_at) + '早双打',
      venue_id: 'v_north',
      venue_snapshot: {
        name: venues.v_north.name,
        address: venues.v_north.address,
        tz_label: venues.v_north.tz_label,
      },
      format_template: 'DOUBLES',
      roster_mode: 'OPEN',
      capacity_by_gender: null,
      roster_by_gender: { male: 0, female: 0 },
      waitlist_by_gender: { male: 0, female: 0 },
      court_count: 1,
      capacity: 4,
      min_players: 4,
      signup_open_at: owed.start_at - 7 * 24 * rules.HOUR,
      join_deadline_rule: 'AT_EVENT_START',
      join_deadline_at: null,
      join_deadline_local: '',
      visibility: 'PUBLIC',
      max_guests_per_member: 0,
      cost_estimate_per_person: 1200,
      cost_note: '',
      court_status: 'CONFIRMED',
      court_assignments: [{ label: 'A', note: '' }],
      roster_count: 4,
      created_at: owed.start_at - 7 * 24 * rules.HOUR,
      updated_at: now(),
    }),
  }

  events.e_collect = Object.assign({}, common, collect, {
    _id: 'e_collect',
    club_id: 'c_thu',
    // You created it, so you see the organizer's side of the bill without having to
    // publish anything first — the state a host is actually in most of the time.
    creator_openid: ME,
    title: weekdayOf(collect.start_at) + '晚双打',
    venue_id: 'v_river',
    venue_snapshot: {
      name: venues.v_river.name,
      address: venues.v_river.address,
      tz_label: venues.v_river.tz_label,
    },
    format_template: 'DOUBLES',
    roster_mode: 'OPEN',
    capacity_by_gender: null,
    roster_by_gender: { male: 0, female: 0 },
    waitlist_by_gender: { male: 0, female: 0 },
    court_count: 2,
    capacity: 8,
    min_players: 4,
    signup_open_at: collect.start_at - 5 * 24 * rules.HOUR,
    join_deadline_rule: 'AT_TIME',
    join_deadline_at: collect.start_at - 6 * rules.HOUR,
    join_deadline_local: localOf(collect.start_at - 6 * rules.HOUR),
    visibility: 'CLUB_ONLY',
    max_guests_per_member: 2,
    cost_estimate_per_person: 1400,
    cost_note: '',
    court_status: 'CONFIRMED',
    court_assignments: [{ label: 'Court 1', note: '' }, { label: 'Court 2', note: '' }],
    roster_count: 6,
    created_at: collect.start_at - 5 * 24 * rules.HOUR,
    updated_at: now(),
  })

  const signups = {}
  const addSignup = (eventId, openid, gender, state, guests, agoHours) => {
    const ts = now() - agoHours * rules.HOUR
    signups[`${eventId}_${openid}`] = {
      _id: `${eventId}_${openid}`,
      event_id: eventId,
      club_id: events[eventId].club_id,
      openid,
      gender,
      state,
      guests: guests || [],
      joined_at: ts,
      queued_at: state === 'WAITLIST' ? ts : null,
      state_changed_at: ts,
      attendance: 'UNKNOWN',
      withdraw_was_late: false,
    }
  }

  addSignup('e_thu', 'u_lin', 'MALE', 'ROSTER', [], 2)
  addSignup('e_thu', 'u_chen', 'FEMALE', 'ROSTER', [], 1.5)
  addSignup('e_thu', 'u_li', 'MALE', 'ROSTER', [], 1)

  addSignup('e_sat', 'u_chen', 'FEMALE', 'ROSTER', [], 3)
  addSignup('e_sat', 'u_zhao', 'FEMALE', 'ROSTER', [], 2.5)
  addSignup('e_sat', 'u_li', 'MALE', 'ROSTER', [], 2)
  addSignup('e_sat', 'u_sun', 'MALE', 'ROSTER', [{ gender: 'MALE' }], 1.5)
  addSignup('e_sat', 'u_lin', 'MALE', 'ROSTER', [{ gender: 'FEMALE' }], 1)

  // e_full: 7 signups filling 8 seats (孙浩 +1), then a 3-deep waitlist with ME
  // second, so the waitlist position line renders.
  addSignup('e_full', 'u_lin', 'MALE', 'ROSTER', [], 26)
  addSignup('e_full', 'u_chen', 'FEMALE', 'ROSTER', [], 25)
  addSignup('e_full', 'u_li', 'MALE', 'ROSTER', [], 24)
  addSignup('e_full', 'u_zhao', 'FEMALE', 'ROSTER', [], 23)
  addSignup('e_full', 'u_sun', 'MALE', 'ROSTER', [{ gender: 'MALE', name: '朋友' }], 22)
  addSignup('e_full', 'u_liu', 'FEMALE', 'ROSTER', [], 21)
  addSignup('e_full', 'u_zhang', 'MALE', 'ROSTER', [], 20)
  addSignup('e_full', 'u_he', 'MALE', 'WAITLIST', [], 8)
  addSignup('e_full', ME, 'UNSPECIFIED', 'WAITLIST', [], 6)
  addSignup('e_full', 'u_ma', 'FEMALE', 'WAITLIST', [], 4)

  // e_joinwait: 4/4 with 2 waiting and ME absent, so 加入候补 is reachable.
  addSignup('e_joinwait', 'u_li', 'MALE', 'ROSTER', [], 5)
  addSignup('e_joinwait', 'u_lin', 'MALE', 'ROSTER', [], 4.5)
  addSignup('e_joinwait', 'u_chen', 'FEMALE', 'ROSTER', [], 4)
  addSignup('e_joinwait', 'u_zhao', 'FEMALE', 'ROSTER', [], 3.5)
  addSignup('e_joinwait', 'u_liu', 'FEMALE', 'WAITLIST', [], 2)
  addSignup('e_joinwait', 'u_zhang', 'MALE', 'WAITLIST', [], 1)

  addSignup('e_soon', 'u_chen', 'FEMALE', 'ROSTER', [], 1)
  addSignup('e_soon', 'u_he', 'MALE', 'ROSTER', [], 0.5)

  // e_closed: exactly at capacity with on_full: CLOSE, so nobody can queue.
  addSignup('e_closed', 'u_chen', 'FEMALE', 'ROSTER', [], 10)
  addSignup('e_closed', 'u_zhao', 'FEMALE', 'ROSTER', [], 9)
  addSignup('e_closed', 'u_he', 'MALE', 'ROSTER', [], 8)
  addSignup('e_closed', 'u_ma', 'FEMALE', 'ROSTER', [], 7)

  // e_played: 6 signups over 7 seats (赵敏 +1). Attendance is left UNKNOWN on every
  // row on purpose — that is the state a real roster is in after play, and §9.2 says
  // it must bill as if everyone were PRESENT.
  addSignup('e_played', 'u_lin', 'MALE', 'ROSTER', [], 100)
  addSignup('e_played', ME, 'UNSPECIFIED', 'ROSTER', [], 99)
  addSignup('e_played', 'u_chen', 'FEMALE', 'ROSTER', [], 98)
  addSignup('e_played', 'u_li', 'MALE', 'ROSTER', [], 97)
  addSignup('e_played', 'u_zhao', 'FEMALE', 'ROSTER', [{ gender: 'MALE', name: '同事' }], 96)
  addSignup('e_played', 'u_sun', 'MALE', 'ROSTER', [], 95)

  // e_collect: six heads, no guests, so 84 divides to a clean 14 each.
  addSignup('e_collect', ME, 'UNSPECIFIED', 'ROSTER', [], 30)
  addSignup('e_collect', 'u_lin', 'MALE', 'ROSTER', [], 29)
  addSignup('e_collect', 'u_chen', 'FEMALE', 'ROSTER', [], 28)
  addSignup('e_collect', 'u_li', 'MALE', 'ROSTER', [], 27)
  addSignup('e_collect', 'u_zhao', 'FEMALE', 'ROSTER', [], 26)
  addSignup('e_collect', 'u_liu', 'FEMALE', 'ROSTER', [], 25)

  // e_owed: a flat 4-way split, already published.
  addSignup('e_owed', 'u_chen', 'FEMALE', 'ROSTER', [], 170)
  addSignup('e_owed', ME, 'UNSPECIFIED', 'ROSTER', [], 169)
  addSignup('e_owed', 'u_sun', 'MALE', 'ROSTER', [], 168)
  addSignup('e_owed', 'u_liu', 'FEMALE', 'ROSTER', [], 167)

  // A DRAFT bill is just the paid total, captured when the courts were confirmed —
  // a number carrying no obligations until it is published (§9.1).
  const event_bills = {
    // Still upcoming: 96 over 8 seats reads as an indicative 12/person.
    e_full: {
      _id: 'e_full',
      event_id: 'e_full',
      club_id: 'c_thu',
      total_minor: 9600,
      currency: 'CAD',
      split_basis: 'ATTENDED',
      status: 'DRAFT',
      created_by: 'u_lin',
      created_at: now(),
      updated_at: now(),
    },
    // Played, courts paid, split not published yet — the state 发布分摊 acts on.
    e_played: {
      _id: 'e_played',
      event_id: 'e_played',
      club_id: 'c_thu',
      total_minor: 9600,
      currency: 'CAD',
      split_basis: 'ATTENDED',
      status: 'DRAFT',
      created_by: 'u_lin',
      created_at: played.start_at,
      updated_at: played.start_at,
    },
    /**
     * Published 6h ago with 12h to run: the state a host spends most of their time in —
     * some money in, some still out, one person claiming they have paid. This is what
     * the mark-paid / 免除 / 撤销 controls act on straight after a reset.
     */
    e_collect: {
      _id: 'e_collect',
      event_id: 'e_collect',
      club_id: 'c_thu',
      total_minor: 8400,
      currency: 'CAD',
      billed_at: now() - 6 * rules.HOUR,
      due_at: rules.dueAt(now() - 6 * rules.HOUR, 12),
      payment_note: '微信转账给我，或者现金',
      payment_qr_url: '',
      status: 'PUBLISHED',
      created_by: ME,
      created_at: now() - 6 * rules.HOUR,
      updated_at: now() - 6 * rules.HOUR,
    },
    // Published 5 days ago against Open Shuttlers' 24h grace, so it is comfortably overdue.
    e_owed: {
      _id: 'e_owed',
      event_id: 'e_owed',
      club_id: 'c_open',
      total_minor: 4800,
      currency: 'CAD',
      split_basis: 'ATTENDED',
      billed_at: owed.end_at,
      due_at: rules.dueAt(owed.end_at, 24),
      payment_note: 'e-transfer 给 chen@example.com',
      payment_qr_url: '',
      status: 'PUBLISHED',
      created_by: 'u_chen',
      created_at: owed.end_at,
      updated_at: owed.end_at,
    },
  }

  // Σ share_minor === total_minor, exactly as rules.computeShares would produce it.
  const bill_shares = {}
  const addShare = (eventId, openid, shareMinor, status, claimedAgoHours) => {
    const id = `${eventId}_${openid}`
    bill_shares[id] = {
      _id: id,
      event_id: eventId,
      club_id: events[eventId].club_id,
      openid,
      share_minor: shareMinor,
      units: 1,
      guest_units: 0,
      status,
      marked_paid_by: status === 'PAID' ? 'u_chen' : null,
      marked_paid_at: status === 'PAID' ? now() - 48 * rules.HOUR : null,
      // "I've paid" raises a discrepancy for the admin; it doesn't settle. §9.4
      player_claimed_paid_at: claimedAgoHours ? now() - claimedAgoHours * rules.HOUR : 0,
      created_at: events[eventId].end_at,
      updated_at: now() - 48 * rules.HOUR,
    }
  }
  // Your own share is settled: you fronted the venue, so you are not chasing yourself.
  addShare('e_collect', ME, 1400, 'PAID')
  addShare('e_collect', 'u_lin', 1400, 'PAID')
  addShare('e_collect', 'u_chen', 1400, 'UNPAID', 2) // says they've paid — §9.4 flag
  addShare('e_collect', 'u_li', 1400, 'UNPAID')
  addShare('e_collect', 'u_zhao', 1400, 'UNPAID')
  addShare('e_collect', 'u_liu', 1400, 'WAIVED') // you wrote one off

  addShare('e_owed', 'u_chen', 1200, 'PAID')
  addShare('e_owed', ME, 1200, 'UNPAID') // yours, overdue → drives the detail banner
  addShare('e_owed', 'u_sun', 1200, 'PAID')
  addShare('e_owed', 'u_liu', 1200, 'WAIVED') // an admin wrote one off, §9.4

  return {
    users,
    events,
    signups,
    clubs,
    club_members,
    venues,
    venue_memberships,
    event_bills,
    bill_shares,
  }
}

function load() {
  const raw = wx.getStorageSync(KEY)
  if (raw && raw.events && raw.clubs && raw.event_bills && raw.bill_shares) return raw
  const seeded = seed()
  wx.setStorageSync(KEY, seeded)
  return seeded
}

function save(db) {
  wx.setStorageSync(KEY, db)
}

function reset() {
  wx.removeStorageSync(KEY)
  return load()
}

function newId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 9)
}

module.exports = { ME, load, save, reset, seed, slot, newId, now }
