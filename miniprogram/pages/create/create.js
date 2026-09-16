const api = require('../../utils/api')
const fmt = require('../../utils/format')
const rules = require('../../utils/rules')
const formats = require('../../utils/formats')
const i18n = require('../../utils/i18n')

const DURATIONS = [1, 1.5, 2, 2.5, 3]
const WITHDRAW_HOURS = [0, 2, 6, 12, 24]
const LEVELS = ['ANY', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED']

/** Next 19:00, which is when most club sessions start. */
function defaultStartParts() {
  const d = new Date()
  d.setHours(19, 0, 0, 0)
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: '19:00' }
}

Page({
  data: {
    t: {},
    formatLabels: [],
    durationLabels: [],
    withdrawLabels: [],
    levelLabels: [],
    clubOptions: [],
    clubLabels: [],
    venueOptions: [],
    venueLabels: [],
    allVenues: {},
    recent: [],
    showMore: false,
    playersSummary: '',
    today: '',
    submitting: false,
    balanced: false,
    canClubOnly: false,
    /**
     * The currency of whichever club is selected. §10.3 — the cost field was reading and
     * writing minor units as hundredths regardless, which is wrong wherever the club
     * settles in JPY or KRW, and those are the currencies §10.3 exists for.
     */
    currency: 'CAD',
    f: {},
  },

  toggleMore() {
    this.setData({ showMore: !this.data.showMore })
  },

  onLoad(q) {
    const t = i18n.pack()
    const start = defaultStartParts()
    const startUtc = fmt.fromPickers(start.date, start.time)
    const deadline = fmt.splitLocal(fmt.addHoursLocal(startUtc.local, -6))

    this.setData({
      t,
      formatLabels: formats.ORDER.map((k) => t['fmt' + k]),
      durationLabels: DURATIONS.map((h) => i18n.t('hours', { n: h })),
      withdrawLabels: WITHDRAW_HOURS.map((h) => (h === 0 ? t.untilStart : i18n.t('hours', { n: h }))),
      levelLabels: LEVELS.map((l) => t['lv' + l]),
      today: fmt.nowParts().date,
      f: {
        title: '',
        formatIdx: 0,
        date: start.date,
        time: start.time,
        durationIdx: 2,
        venueName: '',
        venueAddress: '',
        venueId: null,
        courtCount: 2,
        capacity: 8,
        maleSlots: 0,
        femaleSlots: 0,
        minPlayers: 4,
        maxGuests: 0,
        deadlineRule: 'AT_EVENT_START',
        deadlineDate: deadline.date,
        deadlineTime: deadline.time,
        onFull: 'WAITLIST',
        withdrawIdx: 2,
        cost: '',
        levelIdx: 0,
        clubIdx: 0,
        venueIdx: 0,
        visibility: 'PUBLIC',
      },
    })
    wx.setNavigationBarTitle({ title: t.newGame })

    // Clubs first: a duplicate or a ?clubId= needs the options to exist before it
    // can select one. Both reads go out together.
    this.loadContext(q.clubId).then(() => {
      if (q.duplicateFrom) return this.applyDuplicate(q.duplicateFrom)
      this.applyFormat(0, 2)
    })
  },

  loadContext(preselectId) {
    const t = i18n.pack()
    return Promise.all([
      api.call('club.mine'),
      api.call('event.myRecent').catch(() => ({ recent: [] })),
    ])
      .then(([res, mine]) => {
        // Only clubs you can actually post to.
        const usable = res.joined.filter((c) => c.my_status === 'ACTIVE')
        const options = [{ _id: null, name: t.noClub, my_role: null }].concat(usable)
        const idx = preselectId ? Math.max(0, options.findIndex((c) => c._id === preselectId)) : 0

        this.setData({
          clubOptions: options,
          clubLabels: options.map((c) => c.name),
          allVenues: res.venues || {},
          recent: mine.recent || [],
          'f.clubIdx': idx,
        })
        this.syncClubCapabilities(idx)
        this.syncVenueOptions(idx)
      })
      .catch(() => {})
  },

  /**
   * A club plays at the same one or two venues week after week, so offer them as a
   * picker. Index 0 is always "type it in", which is also the only option when
   * there's no club.
   */
  syncVenueOptions(clubIdx) {
    const t = i18n.pack()
    const club = this.data.clubOptions[clubIdx]
    const ids = (club && club.venue_ids) || []
    const venues = ids.map((id) => this.data.allVenues[id]).filter(Boolean)

    const options = [{ _id: null, name: t.venueOther }].concat(venues)

    // Prefill the club's designated main venue — the same one that resolves
    // display names (§3.8), so there's a single notion of "this club's venue"
    // rather than two that can disagree. That's why the club picker sits above
    // this field.
    let idx = 0
    if (club && club.primary_venue_id) {
      const found = options.findIndex((v) => v._id === club.primary_venue_id)
      if (found > 0) idx = found
    }

    this.setData({
      venueOptions: options,
      venueLabels: options.map((v) => v.name),
      'f.venueIdx': idx,
    })
    this.applyVenue(idx)
  },

  applyVenue(idx) {
    const v = this.data.venueOptions[idx]
    if (!v || !v._id) return // "type it in" leaves whatever was typed
    this.setData({
      'f.venueId': v._id,
      'f.venueName': v.name,
      'f.venueAddress': v.address || '',
    })
  },

  onVenue(e) {
    const idx = Number(e.detail.value)
    this.setData({ 'f.venueIdx': idx })
    if (idx === 0) this.setData({ 'f.venueId': null })
    this.applyVenue(idx)
  },

  /** One tap to reuse a past session; only the date needs changing. §12.2 */
  reuse(e) {
    const t = this.data.t
    this.setData({ showMore: false })
    this.applyDuplicate(e.currentTarget.dataset.id).then(() =>
      wx.showToast({ title: t.reusedToast, icon: 'none' })
    )
  },

  /** CLUB_ONLY is an admin act, so the option only appears for admins. §1 */
  syncClubCapabilities(idx) {
    const club = this.data.clubOptions[idx]
    const canClubOnly = !!club && !!club._id && (club.my_role === 'OWNER' || club.my_role === 'ADMIN')
    const patch = { canClubOnly, currency: (club && club.currency) || 'CAD' }
    if (!canClubOnly) patch['f.visibility'] = 'PUBLIC'
    else if (club.event_defaults && club.event_defaults.visibility) {
      patch['f.visibility'] = club.event_defaults.visibility
    }
    this.setData(patch)
  },

  onClub(e) {
    const idx = Number(e.detail.value)
    this.setData({ 'f.clubIdx': idx })
    this.syncClubCapabilities(idx)
    this.syncVenueOptions(idx)
    this.applyClubDefaults(idx)
  },

  /** §12.2 — clubs shouldn't retype the same settings every week. */
  applyClubDefaults(idx) {
    const club = this.data.clubOptions[idx]
    const d = club && club.event_defaults
    if (!d) return

    const fmtIdx = Math.max(0, formats.ORDER.indexOf(d.format_template || 'DOUBLES'))
    const wIdx = Math.max(0, WITHDRAW_HOURS.indexOf(d.withdraw_hours_before))
    this.setData({
      'f.courtCount': d.court_count || this.data.f.courtCount,
      'f.minPlayers': d.min_players == null ? this.data.f.minPlayers : d.min_players,
      'f.maxGuests': d.max_guests_per_member || 0,
      'f.onFull': d.on_full || 'WAITLIST',
      'f.deadlineRule': d.join_deadline_rule || 'AT_EVENT_START',
      'f.withdrawIdx': wIdx === -1 ? 2 : wIdx,
      'f.cost': fmt.toMajorInput(d.cost_estimate_per_person, this.data.currency),
      'f.levelIdx': Math.max(0, LEVELS.indexOf(d.level_hint || 'ANY')),
      'f.venueId': d.venue_id || null,
    })
    this.applyFormat(fmtIdx, d.court_count || this.data.f.courtCount)
  },

  /** §12.2 — "same as last Thursday" is date-only. */
  applyDuplicate(eventId) {
    return api
      .call('event.duplicate', { eventId })
      .then((res) => {
        const p = res.prefill
        const fmtIdx = Math.max(0, formats.ORDER.indexOf(p.format_template))
        const wIdx = WITHDRAW_HOURS.indexOf(p.withdraw_hours_before)
        const clubIdx = Math.max(0, this.data.clubOptions.findIndex((c) => c._id === p.club_id))
        const durIdx = Math.max(0, DURATIONS.indexOf(p.duration_hours))

        this.setData({
          'f.title': p.title,
          'f.venueName': p.venue_snapshot.name,
          'f.venueAddress': p.venue_snapshot.address || '',
          'f.venueId': p.venue_id || null,
          'f.courtCount': p.court_count || 2,
          'f.minPlayers': p.min_players || 0,
          'f.maxGuests': p.max_guests_per_member || 0,
          'f.onFull': p.on_full,
          'f.deadlineRule': p.join_deadline_rule,
          'f.withdrawIdx': wIdx === -1 ? 2 : wIdx,
          'f.cost': fmt.toMajorInput(p.cost_estimate_per_person, this.data.currency),
          'f.levelIdx': Math.max(0, LEVELS.indexOf(p.level_hint)),
          'f.durationIdx': durIdx,
          'f.clubIdx': clubIdx,
          'f.visibility': p.visibility,
        })
        this.syncClubCapabilities(clubIdx)
        this.applyFormat(fmtIdx, p.court_count || 2)
        // Capacity came from the source session, so keep it verbatim rather than
        // re-deriving from the format.
        this.setData(
          {
            'f.capacity': p.capacity,
            'f.maleSlots': (p.capacity_by_gender || {}).male || 0,
            'f.femaleSlots': (p.capacity_by_gender || {}).female || 0,
          },
          () => this.refreshSummary()
        )
      })
      .catch(() => this.applyFormat(0, 2))
  },

  /** A template presets capacity and roster mode; every number stays editable. §3.9 */
  applyFormat(formatIdx, courtCount) {
    const key = formats.ORDER[formatIdx]
    const { capacity, by_gender } = formats.capacityFor(key, courtCount)
    this.setData(
      {
        balanced: formats.isBalanced(key),
        'f.formatIdx': formatIdx,
        'f.capacity': capacity,
        'f.maleSlots': by_gender ? by_gender.male : 0,
        'f.femaleSlots': by_gender ? by_gender.female : 0,
        'f.minPlayers': Math.min(this.data.f.minPlayers, capacity),
      },
      () => this.refreshSummary()
    )
  },

  /**
   * Capacity is stated as a sentence instead of a control, because it's derived —
   * putting a stepper on it invites people to fight the format they just picked.
   * The override still exists under 更多设置 for the odd arrangement.
   */
  refreshSummary() {
    const f = this.data.f
    const key = formats.ORDER[f.formatIdx]
    const label = this.data.t['fmt' + key]

    const summary = this.data.balanced
      ? i18n.t('playersSummaryBalanced', {
          m: f.maleSlots,
          f: f.femaleSlots,
          n: f.maleSlots + f.femaleSlots,
        })
      : i18n.t('playersSummary', { n: f.capacity, fmt: label, courts: f.courtCount })

    this.setData({ playersSummary: summary })
  },

  onFormat(e) {
    this.applyFormat(Number(e.detail.value), this.data.f.courtCount)
  },

  onInput(e) {
    this.setData({ [`f.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  step(e) {
    const { k, d } = e.currentTarget.dataset
    const delta = Number(d)
    const f = this.data.f
    const bounds = {
      courtCount: [1, 12],
      capacity: [2, 64],
      maleSlots: [0, 32],
      femaleSlots: [0, 32],
      minPlayers: [0, f.capacity],
      maxGuests: [0, 3],
    }[k]
    const next = Math.min(bounds[1], Math.max(bounds[0], f[k] + delta))
    if (next === f[k]) return

    if (k === 'courtCount') {
      this.setData({ 'f.courtCount': next })
      this.applyFormat(f.formatIdx, next)
      return
    }

    const patch = { [`f.${k}`]: next }
    // In a balanced format capacity is the sum of the buckets, not independent.
    if (k === 'maleSlots' || k === 'femaleSlots') {
      const male = k === 'maleSlots' ? next : f.maleSlots
      const female = k === 'femaleSlots' ? next : f.femaleSlots
      patch['f.capacity'] = male + female
      if (f.minPlayers > male + female) patch['f.minPlayers'] = male + female
    }
    if (k === 'capacity' && f.minPlayers > next) patch['f.minPlayers'] = next
    this.setData(patch, () => this.refreshSummary())
  },

  onDate(e) {
    this.setData({ 'f.date': e.detail.value })
  },
  onTime(e) {
    this.setData({ 'f.time': e.detail.value })
  },
  onDuration(e) {
    this.setData({ 'f.durationIdx': Number(e.detail.value) })
  },
  onDeadlineDate(e) {
    this.setData({ 'f.deadlineDate': e.detail.value })
  },
  onDeadlineTime(e) {
    this.setData({ 'f.deadlineTime': e.detail.value })
  },
  onDeadlineRule(e) {
    this.setData({ 'f.deadlineRule': e.currentTarget.dataset.v })
  },
  onOnFull(e) {
    this.setData({ 'f.onFull': e.currentTarget.dataset.v })
  },
  onVisibility(e) {
    this.setData({ 'f.visibility': e.currentTarget.dataset.v })
  },
  onWithdraw(e) {
    this.setData({ 'f.withdrawIdx': Number(e.detail.value) })
  },
  onLevel(e) {
    this.setData({ 'f.levelIdx': Number(e.detail.value) })
  },

  build() {
    const f = this.data.f
    const key = formats.ORDER[f.formatIdx]
    const balanced = formats.isBalanced(key)
    const start = fmt.fromPickers(f.date, f.time)
    const hours = DURATIONS[f.durationIdx]
    const withdrawHours = WITHDRAW_HOURS[f.withdrawIdx]
    const deadline =
      f.deadlineRule === 'AT_TIME' ? fmt.fromPickers(f.deadlineDate, f.deadlineTime) : null
    const club = this.data.clubOptions[f.clubIdx] || {}

    return {
      club_id: club._id || null,
      title: f.title.trim(),
      venue_id: f.venueId || null,
      venue_snapshot: { name: f.venueName.trim(), address: f.venueAddress.trim(), tz_label: '' },
      // Both representations, per §10.2: UTC for decisions, wall clock for display.
      start_at: start.utc,
      start_local: start.local,
      end_at: start.utc + hours * rules.HOUR,
      end_local: fmt.addHoursLocal(start.local, hours),
      format_template: key,
      roster_mode: balanced ? 'GENDER_BALANCED' : 'OPEN',
      capacity: balanced ? f.maleSlots + f.femaleSlots : f.capacity,
      capacity_by_gender: balanced ? { male: f.maleSlots, female: f.femaleSlots } : null,
      court_count: f.courtCount,
      min_players: f.minPlayers,
      max_guests_per_member: f.maxGuests,
      on_full: f.onFull,
      waitlist_capacity: 0,
      signup_open_at: Date.now(),
      join_deadline_rule: f.deadlineRule,
      join_deadline_at: deadline ? deadline.utc : null,
      join_deadline_local: deadline ? deadline.local : '',
      withdraw_rule: withdrawHours === 0 ? 'AT_EVENT_START' : 'HOURS_BEFORE_START',
      withdraw_hours_before: withdrawHours,
      visibility: this.data.canClubOnly ? f.visibility : 'PUBLIC',
      cost_estimate_per_person: fmt.toMinor(f.cost, this.data.currency),
      cost_note: '',
      level_hint: LEVELS[f.levelIdx],
    }
  },

  /** Client-side checks are for feedback only; the server validates again. */
  validate(ev) {
    const t = this.data.t
    if (!ev.title) return t.vTitle
    if (!ev.venue_snapshot.name) return t.vVenue
    if (ev.capacity <= 0) return t.vCapacityZero
    if (ev.start_at <= Date.now()) return t.vPast
    if (ev.join_deadline_rule === 'AT_TIME') {
      if (ev.join_deadline_at > ev.start_at) return t.vDeadlineAfterStart
      if (ev.join_deadline_at <= Date.now()) return t.vDeadlinePast
    }
    if (ev.min_players > ev.capacity) return t.vMinTooHigh
    return null
  },

  submit() {
    if (this.data.submitting) return
    const ev = this.build()
    const err = this.validate(ev)
    if (err) {
      wx.showToast({ title: err, icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    api
      .callWithToast('event.create', { event: ev })
      .then((res) => wx.redirectTo({ url: `/pages/event/event?id=${res.eventId}` }))
      .catch(() => this.setData({ submitting: false }))
  },
})
