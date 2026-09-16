const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const present = require('../../utils/present')
const fmt = require('../../utils/format')
const rules = require('../../utils/rules')

const STATUSES = ['NOT_BOOKED', 'PENDING', 'CONFIRMED']
// Same ladder the create form offers, so a session's rules read the same in both
// places. 0 means "right up to the start", which maps to AT_EVENT_START.
const WITHDRAW_HOURS = [0, 2, 6, 12, 24]

Page({
  data: {
    t: {},
    eventId: '',
    ev: null,
    booking: null,
    statusOptions: [],
    courtText: '',
    courtCount: 0,
    capacity: 0,
    maleSlots: 0,
    femaleSlots: 0,
    courtStatus: 'NOT_BOOKED',
    balanced: false,
    coverageText: '',
    totalCost: '',
    perPersonText: '',
    currency: 'CAD',
    // signup rules, editable after posting (§3.1, §3.2, §3.4)
    minPlayers: 0,
    maxGuests: 0,
    deadlineRule: 'AT_EVENT_START',
    deadlineDate: '',
    deadlineTime: '',
    withdrawIdx: 2,
    withdrawLabels: [],
    signupClosed: false,
  },

  onLoad(q) {
    this.setData({ eventId: q.id })
  },

  onShow() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.manageGame })
    this.setData({
      t,
      statusOptions: STATUSES.map((v) => ({ value: v, label: t['cs' + v] })),
      withdrawLabels: WITHDRAW_HOURS.map((h) =>
        h === 0 ? t.untilStart : i18n.t('hours', { n: h })
      ),
    })
    this.load()
  },

  /**
   * Both reads fire together. The booking helper doesn't depend on the detail
   * response — only the coverage *sentence* needs the court count, and that's
   * assembled after both land.
   */
  load() {
    const t = i18n.pack()
    const eventId = this.data.eventId

    return Promise.all([
      api.call('event.detail', { eventId }),
      api.call('venue.bookingHelper', { eventId }).catch(() => null),
    ])
      .then(([raw, booking]) => {
        if (!raw.can_manage) {
          wx.showToast({ title: i18n.errText({ code: 'NOT_ADMIN' }), icon: 'none' })
          setTimeout(() => wx.navigateBack(), 900)
          return
        }
        const cap = raw.capacity_by_gender || { male: 0, female: 0 }
        const courtCount = raw.court_count || 0

        this.setData({
          ev: Object.assign(present.eventCard(raw, t), {
            roster: present.withGender(raw.roster).map((p) =>
              Object.assign({}, p, { initial: present.initial(p.name) })
            ),
            waitlist: present.withGender(raw.waitlist).map((p) =>
              Object.assign({}, p, { initial: present.initial(p.name) })
            ),
          }),
          balanced: raw.roster_mode === 'GENDER_BALANCED',
          courtText: (raw.court_assignments || []).map((c) => c.label).join(', '),
          courtStatus: raw.court_status,
          courtCount,
          capacity: raw.capacity,
          maleSlots: cap.male,
          femaleSlots: cap.female,
          booking,
          coverageText: this.coverageText(booking, courtCount, t),
          totalCost:
            fmt.toMajorInput(raw.cost_total_minor, raw.currency || 'CAD') ||
            this.data.totalCost,
          currency: raw.currency || 'CAD',
          minPlayers: raw.min_players || 0,
          maxGuests: raw.max_guests_per_member || 0,
          deadlineRule: raw.join_deadline_rule || 'AT_EVENT_START',
          // A session closing at start has no deadline of its own, so seed the
          // pickers 6h before it — the same default the create form uses.
          deadlineDate: this.deadlineParts(raw).date,
          deadlineTime: this.deadlineParts(raw).time,
          withdrawIdx: this.withdrawIndexOf(raw),
          // The note about reopening is only worth saying once signup has closed.
          signupClosed: raw.status === 'SIGNUP_CLOSED' || raw.status === 'FULL_CLOSED',
        })
        this.refreshPerPerson()
      })
      .catch((err) => wx.showToast({ title: i18n.errText(err), icon: 'none' }))
  },

  /** §3.8 — how many memberships this booking needs versus how many we hold. */
  coverageText(booking, courtCount, t) {
    const c = booking && booking.coverage
    if (!c) return ''
    if (!c.capped) return t.coverageUncapped
    return c.ok
      ? i18n.t('coverageOk', { courts: courtCount, needed: c.needed, have: c.have })
      : i18n.t('coverageShort', { needed: c.needed, have: c.have })
  },

  onTotalCost(e) {
    this.setData({ totalCost: e.detail.value }, () => this.refreshPerPerson())
  },

  /**
   * Indicative only: it divides by seats taken right now, so it moves as people
   * join or drop. The binding split happens when the bill is published. §9.2
   */
  refreshPerPerson() {
    const minor = fmt.toMinor(this.data.totalCost, this.data.currency)
    const seats = (this.data.ev && this.data.ev.roster_count) || 0
    if (!minor || !seats) {
      this.setData({ perPersonText: '' })
      return
    }
    const per = rules.perPersonPreview(minor, seats)
    this.setData({
      perPersonText: i18n.t('perPersonApprox', {
        amount: fmt.money(per, this.data.currency),
      }),
    })
  },

  // --- courts ---------------------------------------------------------------
  onCourtText(e) {
    this.setData({ courtText: e.detail.value })
  },

  setStatus(e) {
    this.setData({ courtStatus: e.currentTarget.dataset.value })
  },

  step(e) {
    const { k, d } = e.currentTarget.dataset
    const delta = Number(d)
    const bounds = {
      courtCount: [0, 12],
      capacity: [1, 64],
      maleSlots: [0, 32],
      femaleSlots: [0, 32],
      minPlayers: [0, 64],
      maxGuests: [0, 3],
    }[k]
    const next = Math.min(bounds[1], Math.max(bounds[0], this.data[k] + delta))
    if (next === this.data[k]) return

    const patch = { [k]: next }
    if (k === 'maleSlots') patch.capacity = next + this.data.femaleSlots
    if (k === 'femaleSlots') patch.capacity = this.data.maleSlots + next
    this.setData(patch)
  },

  saveCourts() {
    const t = this.data.t
    const labels = this.data.courtText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)

    const payload = {
      eventId: this.data.eventId,
      court_status: this.data.courtStatus,
      court_assignments: labels.map((label) => ({ label })),
      court_count: this.data.courtCount,
      total_cost_minor: this.data.totalCost === ''
        ? null
        : fmt.toMinor(this.data.totalCost, this.data.currency),
    }

    api
      .callWithToast('event.setCourts', payload)
      .then(() => {
        wx.showToast({ title: t.savedToast, icon: 'none' })
        this.load()
      })
      .catch(() => {})
  },

  // --- signup rules (§3.1, §3.2, §3.4) --------------------------------------
  /**
   * Picker values for the join deadline. A session that closes at its start time has
   * no deadline of its own, so seed them 6h before — the create form's default, which
   * makes "switch to a custom time" land somewhere sensible rather than on today.
   */
  deadlineParts(raw) {
    if (raw.join_deadline_rule === 'AT_TIME' && raw.join_deadline_local) {
      return fmt.splitLocal(raw.join_deadline_local)
    }
    return fmt.splitLocal(fmt.addHoursLocal(raw.start_local, -6))
  },

  withdrawIndexOf(raw) {
    if (raw.withdraw_rule === 'AT_EVENT_START') return 0
    const i = WITHDRAW_HOURS.indexOf(raw.withdraw_hours_before)
    return i === -1 ? 2 : i
  },

  onDeadlineRule(e) {
    this.setData({ deadlineRule: e.currentTarget.dataset.value })
  },
  onDeadlineDate(e) {
    this.setData({ deadlineDate: e.detail.value })
  },
  onDeadlineTime(e) {
    this.setData({ deadlineTime: e.detail.value })
  },
  onWithdraw(e) {
    this.setData({ withdrawIdx: Number(e.detail.value) })
  },

  /**
   * Save the signup rules. §3.1
   *
   * Raising the cap or pushing the deadline back is the whole point — on the day more
   * people want to play than the plan allowed, and reposting would throw away the
   * roster. Lowering the cap below the current roster costs somebody their seat, so
   * that direction confirms first (§3.5).
   */
  saveRules() {
    const t = this.data.t
    const d = this.data
    const hours = WITHDRAW_HOURS[d.withdrawIdx]
    const deadline =
      d.deadlineRule === 'AT_TIME' ? fmt.fromPickers(d.deadlineDate, d.deadlineTime) : null

    const payload = {
      eventId: d.eventId,
      capacity: d.capacity,
      capacity_by_gender: d.balanced ? { male: d.maleSlots, female: d.femaleSlots } : null,
      min_players: d.minPlayers,
      max_guests_per_member: d.maxGuests,
      join_deadline_rule: d.deadlineRule,
      join_deadline_at: deadline ? deadline.utc : null,
      join_deadline_local: deadline ? deadline.local : '',
      withdraw_rule: hours === 0 ? 'AT_EVENT_START' : 'HOURS_BEFORE_START',
      withdraw_hours_before: hours,
    }

    const seated = this.data.ev.roster_count
    const proceed = () =>
      api
        .callWithToast('event.updateRules', payload)
        .then((res) => {
          wx.showToast({
            title: res.bumped_count
              ? i18n.t('capacityShrinkWarn', { n: res.bumped_count })
              : t.rulesSavedToast,
            icon: 'none',
          })
          this.load()
        })
        .catch(() => {})

    if (payload.capacity < seated) {
      wx.showModal({
        title: t.adjustCapacity,
        content: i18n.t('capacityShrinkWarn', { n: seated - payload.capacity }),
        success: (r) => {
          if (r.confirm) proceed()
        },
      })
      return
    }
    proceed()
  },

  copyMembership(e) {
    const t = this.data.t
    wx.setClipboardData({
      data: e.currentTarget.dataset.name,
      success: () => wx.showToast({ title: t.copied, icon: 'success' }),
    })
  },

  /**
   * Every membership name at once, comma-separated. §3.8
   *
   * A venue that caps courts per membership makes booking three courts a three-card job,
   * so the list is what the organizer actually needs at the counter — copying names one
   * at a time meant six taps and a lost clipboard.
   *
   * Comma-separated, matching how court labels are entered and shown elsewhere in this
   * screen. It also survives a single-line input, which newlines don't.
   *
   * Names only, no card numbers: this goes into a name field often enough that mixing in
   * anything else would have to be deleted again.
   */
  copyAllMemberships() {
    const t = this.data.t
    const holders = (this.data.booking && this.data.booking.holders) || []
    const names = holders.map((h) => h.membership_name).filter(Boolean)
    if (!names.length) return

    wx.setClipboardData({
      data: names.join(', '),
      success: () =>
        wx.showToast({ title: i18n.t('copiedCount', { n: names.length }), icon: 'success' }),
    })
  },

  // --- roster ---------------------------------------------------------------
  removePlayer(e) {
    const { openid, name } = e.currentTarget.dataset
    const t = this.data.t
    wx.showModal({
      title: t.removeFromGame,
      content: i18n.t('confirmRemove', { who: name }),
      success: (r) => {
        if (!r.confirm) return
        api
          .callWithToast('event.removeSignup', { eventId: this.data.eventId, targetOpenid: openid })
          .then(() => this.load())
          .catch(() => {})
      },
    })
  },

  duplicate() {
    wx.redirectTo({ url: `/pages/create/create?duplicateFrom=${this.data.eventId}` })
  },

  openBill() {
    wx.navigateTo({ url: `/pages/bill/bill?id=${this.data.eventId}` })
  },

  cancelGame() {
    const t = this.data.t
    wx.showModal({
      title: t.cancelGame,
      content: t.confirmCancelGame,
      success: (r) => {
        if (!r.confirm) return
        api
          .callWithToast('event.cancel', { eventId: this.data.eventId })
          .then(() => {
            wx.showToast({ title: t.cancelledToast, icon: 'success' })
            setTimeout(() => wx.navigateBack(), 700)
          })
          .catch(() => {})
      },
    })
  },
})
