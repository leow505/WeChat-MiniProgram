const api = require('../../utils/api')
const fmt = require('../../utils/format')
const rules = require('../../utils/rules')
const i18n = require('../../utils/i18n')
const present = require('../../utils/present')
const config = require('../../config')

const ALLOC_CTA = { ROSTER: 'join', WAITLIST: 'joinWaitlist' }

function decorate(ev, t) {
  const joinable = ev.status === 'OPEN' || ev.status === 'WAITLIST_ONLY'
  const maxGuests = ev.max_guests_per_member || 0
  const balanced = ev.roster_mode === 'GENDER_BALANCED'
  const card = present.eventCard(ev, t)

  /**
   * One meta line per person, always rendered, so every cell in the wrap grid is
   * the same height. Gender shows for every format, not only balanced ones, using
   * the same ♂/♀ glyph as the club member list.
   */
  const withPeople = (list) =>
    present.withGender(list).map((p) =>
      Object.assign({}, p, {
        initial: present.initial(p.name),
        guest_mark: p.guest_count > 0 ? '+' + p.guest_count : '',
      })
    )

  /**
   * A recorded total outranks the organizer's pre-booking guess. It's still marked
   * approximate: it divides by the seats taken right now, and the binding split waits
   * on the organizer publishing it after play. §9.2
   */
  const costText = ev.cost_total_minor
    ? i18n.t('perPersonApprox', { amount: fmt.money(ev.cost_per_person_minor, ev.currency) })
    : ev.cost_estimate_per_person
    ? fmt.money(ev.cost_estimate_per_person, ev.currency) + t.perPerson
    : ''
  const deadlineText = joinable
    ? i18n.t('closesIn', { when: fmt.relative(ev.join_deadline_at) })
    : ''

  // Reference settings live behind a disclosure. Building them as one array means
  // the label column can't go ragged.
  const detailRows = [
    { k: t.host, v: ev.organizer_name },
    ev.venue_snapshot.address ? { k: t.address, v: ev.venue_snapshot.address } : null,
    ev.cost_total_minor
      ? { k: t.totalPaid, v: fmt.money(ev.cost_total_minor, ev.currency) }
      : null,
    { k: t.joinDeadline, v: fmt.shortLocal(ev.start_local) && fmt.relative(ev.join_deadline_at) },
    { k: t.withdrawDeadline, v: fmt.relative(ev.withdraw_deadline_at) },
    { k: t.whenFull, v: ev.on_full === 'WAITLIST' ? t.onFullWaitlist : t.onFullClose },
    { k: t.guestsAllowed, v: maxGuests === 0 ? t.noGuests : i18n.t('upToGuests', { n: maxGuests }) },
    ev.min_players > 0 ? { k: t.minToRun, v: String(ev.min_players) } : null,
  ].filter(Boolean)

  /**
   * The unpaid-share banner. §9.4
   *
   * Pushes can't be guaranteed (§8.1), so an in-app banner persists until the share
   * is settled — it's the one channel with no delivery risk. It states the amount,
   * because a nag with no number is just noise.
   */
  const published = ev.bill_status === 'PUBLISHED' || ev.bill_status === 'SETTLED'
  const oweBanner =
    published && ev.my_share_status === 'UNPAID'
      ? i18n.t(ev.my_share_overdue ? 'shareOverdueBanner' : 'shareDueBanner', {
          amount: fmt.money(ev.my_share_minor, ev.currency),
        })
      : ''

  return Object.assign(card, {
    balanced,
    joinable,
    owe_banner: oweBanner,
    owe_overdue: !!ev.my_share_overdue,
    /**
     * The settlement screen is reachable once there's something to do there: a
     * manager can start splitting as soon as play is over, and a player needs the
     * link the moment a bill names them.
     */
    bill_link: (ev.can_manage && ev.status === 'COMPLETED') || (published && !!ev.my_share_status),
    bill_status_label: ev.bill_status ? t['bl' + ev.bill_status] : '',
    /**
     * Label from where *this viewer* would land, not from event status. A balanced
     * session with only female slots left reads OPEN, but a man joining it goes to
     * the waitlist — the button should say so. §3.9
     */
    cta_text: ev.needs_gender
      ? t.join
      : ALLOC_CTA[ev.my_allocation]
      ? t[ALLOC_CTA[ev.my_allocation]]
      : t['status' + ev.status] || '',
    // My own bucket being full is worth flagging even when the event isn't full.
    bucket_full: !!(ev.my_bucket && ev.my_bucket.full),
    // Locale-specific: zh's label carries 位, en's doesn't, because each sentence
    // supplies the rest differently.
    bucket_label: ev.my_bucket
      ? ev.my_bucket.gender === 'MALE'
        ? t.bucketMale
        : t.bucketFemale
      : '',
    where_line: [ev.venue_snapshot.name, card.format_label].filter(Boolean).join(' · '),
    // Composed into one string rather than a justify-between pair, so an empty
    // deadline can't leave a lopsided row.
    hero_sub: [deadlineText, costText].filter(Boolean).join(' · '),
    cap_long: balanced,
    withdraw_deadline_text: fmt.relative(ev.withdraw_deadline_at),
    position_text: ev.my_waitlist_position
      ? i18n.t('yourPosition', { n: ev.my_waitlist_position })
      : '',
    courts_line: (ev.court_assignments || []).map((c) => c.label).join(' · '),
    detailRows,
    roster: withPeople(ev.roster),
    waitlist: withPeople(ev.waitlist),
  })
}

Page({
  data: {
    t: {},
    eventId: '',
    ev: null,
    guests: [],
    guestSeats: 1,
    showGuestPicker: false,
    editingGuests: false,
    showDetails: false,
    genderOptions: [],
    webInviteEnabled: config.API_MODE === 'http' && !!config.PUBLIC_WEB_BASE_URL,
  },

  toggleDetails() {
    this.setData({ showDetails: !this.data.showDetails })
  },

  onLoad(query) {
    this.setData({ eventId: query.id })
  },

  onShow() {
    const t = i18n.pack()
    this.setData({
      t,
      genderOptions: [
        { value: 'MALE', label: t.male },
        { value: 'FEMALE', label: t.female },
      ],
    })
    this.load()
  },

  load() {
    const t = i18n.pack()
    return api
      .call('event.detail', { eventId: this.data.eventId })
      .then((raw) => {
        const ev = decorate(raw, t)
        // Keep an in-progress edit; otherwise mirror whatever the server says the
        // party currently is.
        const mine = ev.roster.concat(ev.waitlist).find((p) => p.is_me)
        const guests = this.data.editingGuests
          ? this.data.guests
          : mine
          ? (mine.guests || []).slice()
          : this.data.guests

        this.setData({
          ev,
          guests,
          showGuestPicker: !ev.my_state && ev.joinable && ev.max_guests_per_member > 0,
          guestSeats: rules.seatsFor(guests),
        })
        wx.setNavigationBarTitle({ title: ev.title })
      })
      .catch((err) => wx.showToast({ title: i18n.errText(err), icon: 'none' }))
  },

  guestMinus() {
    const guests = this.data.guests.slice(0, -1)
    this.setData({ guests, guestSeats: rules.seatsFor(guests) })
  },

  guestPlus() {
    const max = this.data.ev.max_guests_per_member || 0
    if (this.data.guests.length >= max) return
    // A balanced format needs a gender per guest to bucket them; default to male
    // and let the row toggle it. §3.9
    const guests = this.data.guests.concat([{ gender: 'MALE' }])
    this.setData({ guests, guestSeats: rules.seatsFor(guests) })
  },

  setGuestGender(e) {
    const { idx, value } = e.currentTarget.dataset
    const guests = this.data.guests.slice()
    guests[Number(idx)] = { gender: value }
    this.setData({ guests })
  },

  join() {
    const ev = this.data.ev
    const t = this.data.t
    if (!ev.joinable) return

    // A balanced format can't seat an undeclared gender, so ask before the server
    // has to refuse. §3.9
    if (ev.needs_gender) {
      wx.showModal({
        title: t.needGenderTitle,
        content: t.genderNeeded,
        confirmText: t.setGenderNow,
        success: (r) => {
          if (r.confirm) wx.navigateTo({ url: '/pages/profile/profile' })
        },
      })
      return
    }

    // My gender's slots are gone. Say which, and how full, rather than silently
    // dropping them onto a waitlist or bouncing them off the server. §3.9
    if (ev.bucket_full) {
      const vars = {
        gender: ev.bucket_label,
        taken: ev.my_bucket.taken,
        cap: ev.my_bucket.cap,
      }
      if (ev.my_allocation !== 'WAITLIST') {
        wx.showModal({
          title: i18n.t('bucketFullTitle', vars),
          content: i18n.t('bucketFullBlocked', vars),
          showCancel: false,
        })
        return
      }
      wx.showModal({
        title: i18n.t('bucketFullTitle', vars),
        content: i18n.t('bucketFullWaitlist', vars),
        confirmText: t.joinWaitlist,
        success: (r) => {
          if (r.confirm) this.doJoin()
        },
      })
      return
    }

    this.doJoin()
  },

  doJoin() {
    const ev = this.data.ev
    api
      .callWithToast('event.join', {
        eventId: this.data.eventId,
        guests: ev.balanced ? this.data.guests : this.data.guests.map(() => ({})),
      })
      .then((res) => {
        wx.showToast({
          title: res.state === 'ROSTER' ? this.data.t.joinedToast : this.data.t.waitlistedToast,
          icon: 'success',
        })
        this.setData({ guests: [], guestSeats: 1 })
        this.load()
      })
      .catch(() => {})
  },

  // --- editing an existing party. §3.7 --------------------------------------
  startEditGuests() {
    const mine = this.data.ev.roster.find((p) => p.is_me) || {}
    this.setData({
      editingGuests: true,
      guests: (mine.guests || []).slice(),
      guestSeats: rules.seatsFor(mine.guests),
    })
  },

  cancelEditGuests() {
    this.setData({ editingGuests: false, guests: [] })
  },

  saveGuests() {
    const ev = this.data.ev
    api
      .callWithToast('event.updateGuests', {
        eventId: this.data.eventId,
        guests: ev.balanced ? this.data.guests : this.data.guests.map(() => ({})),
      })
      .then(() => {
        wx.showToast({ title: this.data.t.savedToast, icon: 'success' })
        this.setData({ editingGuests: false })
        this.load()
      })
      .catch(() => {})
  },

  withdraw() {
    const ev = this.data.ev
    const t = this.data.t

    if (!ev.can_withdraw) {
      wx.showModal({
        title: t.cannotWithdraw,
        content: i18n.t('withdrawClosedBody', {
          when: ev.withdraw_deadline_text,
          who: ev.organizer_name,
        }),
        showCancel: false,
      })
      return
    }

    // A late drop costs the organizer a paid court slot, so say so before confirming.
    wx.showModal({
      title: t.confirmWithdraw,
      content: rules.isLateWithdrawal(ev) ? t.withdrawLateWarn : t.withdrawNormal,
      success: (r) => {
        if (!r.confirm) return
        api
          .callWithToast('event.withdraw', { eventId: this.data.eventId })
          .then((res) => {
            wx.showToast({
              title:
                res.promoted && res.promoted.length ? t.withdrewPromotedToast : t.withdrewToast,
              icon: 'none',
            })
            this.load()
          })
          .catch(() => {})
      },
    })
  },

  manage() {
    wx.navigateTo({ url: `/pages/manage/manage?id=${this.data.eventId}` })
  },

  openBill() {
    wx.navigateTo({ url: `/pages/bill/bill?id=${this.data.eventId}` })
  },

  openClub() {
    if (!this.data.ev.club_id) return
    wx.navigateTo({ url: `/pages/club/club?id=${this.data.ev.club_id}` })
  },

  copyWebInvite() {
    const base = String(config.PUBLIC_WEB_BASE_URL || '').replace(/\/+$/, '')
    if (!base) return
    wx.setClipboardData({
      data: `${base}/invite/${encodeURIComponent(this.data.eventId)}`,
      success: () => wx.showToast({ title: this.data.t.inviteLinkCopied, icon: 'none' }),
    })
  },

  /**
   * Sharing into a group chat is the distribution mechanism (§7). The title is
   * arbitrary text, which is the only way court info reaches a chat at all — the
   * updatable card can't carry it (§8.3).
   */
  onShareAppMessage() {
    const ev = this.data.ev || {}
    const courts =
      ev.courts_visible && ev.court_assignments && ev.court_assignments.length
        ? ' · ' + ev.court_assignments.map((c) => c.label).join('/')
        : ''
    return {
      title: `${ev.title} · ${ev.time_text}${courts} · ${ev.count_text}`,
      path: `/pages/event/event?id=${this.data.eventId}`,
    }
  },
})
