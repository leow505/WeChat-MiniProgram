/**
 * Cost split and settlement. DESIGN.md §9.
 *
 * One page, two audiences — which is deliberate rather than lazy: the organizer's
 * "who still owes me" and the player's "what do I owe" are the same ledger read from
 * opposite ends, and splitting them would mean two screens drifting apart. The
 * server decides which side you get (`is_manager`), so the page only renders.
 *
 * The manage screen stays about getting the session on: courts, capacity, roster.
 * Everything here happens after play.
 */
const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/format')
const present = require('../../utils/present')

/** Status → the tag class that carries its colour. See bill.wxss. */
const SHARE_CLASS = { UNPAID: 'unpaid', PAID: 'paid', WAIVED: 'waived' }

Page({
  data: {
    t: {},
    eventId: '',
    v: null,
    rows: [],
    totalCost: '',
    paymentNote: '',
    published: false,
    // A draft's total is editable here as well as on the manage screen, because an
    // organizer settling up shouldn't have to go back a page to fix a typo.
    editingTotal: false,
  },

  onLoad(q) {
    this.setData({ eventId: q.id })
  },

  onShow() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.billTitle })
    this.setData({ t })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    return api
      .call('bill.get', { eventId: this.data.eventId })
      .then((raw) => {
        const cur = raw.event.currency
        const bill = raw.bill
        const published = !!bill && bill.status !== 'DRAFT'
        const voided = !!bill && bill.status === 'VOID'

        this.setData({
          v: this.decorate(raw, t, cur, published, voided),
          rows: this.decorateRows(raw, t, cur, published),
          published,
          // Don't clobber an edit in progress.
          totalCost: this.data.editingTotal
            ? this.data.totalCost
            : fmt.toMajorInput(bill && bill.total_minor, cur),
          paymentNote: this.data.editingTotal
            ? this.data.paymentNote
            : (bill && bill.payment_note) || '',
        })
      })
      .catch((err) => {
        wx.showToast({ title: i18n.errText(err), icon: 'none' })
        setTimeout(() => wx.navigateBack(), 900)
      })
  },

  decorate(raw, t, cur, published, voided) {
    const bill = raw.bill
    const p = raw.preview
    const totals = raw.totals
    const mine = raw.my_share

    return Object.assign({}, raw, {
      voided,
      // Stated once per screen rather than on every figure: amounts are bare numbers,
      // and this is the context for anyone in clubs across two countries. §10.3
      currency_code: fmt.currencyLabel(cur),
      time_text: fmt.eventTime(raw.event.start_local, raw.event.end_local),
      status_label: bill ? t['bl' + bill.status] : '',
      status_class: bill ? String(bill.status).toLowerCase() : '',

      // --- the split, as it would be published ------------------------------
      total_text: fmt.money(bill ? bill.total_minor : 0, cur),
      units_line: i18n.t('unitsLine', { units: p.units, n: p.payer_count }),
      /**
       * A court fee rarely divides evenly in whole cents, so somebody pays one more
       * than somebody else — that is what keeps Σ shares === total exactly (§9.2).
       * The headline used to show both figures as a range, which gave a one-cent
       * difference the same weight as the amount itself. It now shows the higher one:
       * a number nobody is asked to beat, and what anyone reads it as anyway. The
       * rows below still carry each person's exact share, to the cent.
       */
      per_share_text: i18n.t('perShare', {
        amount: fmt.money(p.base_minor + (p.remainder_minor ? 1 : 0), cur),
      }),
      remainder_note: p.remainder_minor
        ? i18n.t('remainderNote', { n: p.remainder_minor })
        : '',
      // Only worth a line when the venue actually charges for guests. §3.7
      surcharge_line: p.surcharge_total
        ? i18n.t('guestSurchargeLine', {
            n: p.guest_units,
            amount: fmt.money(p.surcharge_total, cur),
          })
        : '',
      publish_hint: i18n.t('publishHint', { hours: raw.grace_hours }),
      // The list is the same rows before and after publication; only its heading and
      // its buttons change.
      list_title: published ? t.sharesTitle : t.splitList,
      publish_label: published ? t.updateBill : t.publishBill,
      can_publish: raw.is_manager && raw.ended && !voided,

      // --- settlement progress ---------------------------------------------
      settled_line: totals.share_count
        ? i18n.t('settledCount', { n: totals.settled_count, total: totals.share_count })
        : '',
      outstanding_line: totals.unpaid_minor
        ? i18n.t('outstanding', { amount: fmt.money(totals.unpaid_minor, cur) })
        : t.allSettled,
      all_settled: published && !totals.unpaid_minor,
      due_text: bill && bill.due_at ? i18n.t('dueBy', { when: fmt.relative(bill.due_at) }) : '',
      payment_note: (bill && bill.payment_note) || '',

      // --- my own share -----------------------------------------------------
      my_share_text: mine ? fmt.money(mine.share_minor, cur) : '',
      my_share_label: mine ? t['ss' + mine.status] : '',
      my_share_class: mine ? SHARE_CLASS[mine.status] : '',
      my_share_unpaid: !!mine && mine.status === 'UNPAID',
      my_share_overdue: !!mine && mine.overdue,
      my_share_claimed: !!mine && !!mine.claimed_paid_at,
    })
  },

  /**
   * One row shape for both phases of the screen: before publication the amount is
   * the preview, after it the recorded share. Same list, so the organizer sees the
   * numbers move rather than meeting a different table.
   */
  decorateRows(raw, t, cur, published) {
    return present.withGender(raw.rows).map((r) =>
      Object.assign({}, r, {
        initial: present.initial(r.name),
        guest_mark: r.guest_count > 0 ? '+' + r.guest_count : '',
        amount_text: fmt.money(published ? r.share_minor : r.preview_minor, cur),
        status_label: r.status ? t['ss' + r.status] : '',
        status_class: SHARE_CLASS[r.status] || '',
        // A settled share is not up for re-marking without an explicit undo.
        can_mark: published && r.status === 'UNPAID',
        can_undo: published && r.status !== 'UNPAID',
      })
    )
  },

  // --- the total and the note -----------------------------------------------
  onTotalCost(e) {
    this.setData({ totalCost: e.detail.value, editingTotal: true })
  },

  onPaymentNote(e) {
    this.setData({ paymentNote: e.detail.value, editingTotal: true })
  },

  /**
   * Publish, or revise. §9.1, §9.4
   *
   * The confirm exists because publication is the moment a recorded number becomes
   * an obligation with a clock on it — worth one tap of friction. A revision says so
   * plainly instead: already-paid shares stand.
   */
  publish() {
    const t = this.data.t
    const v = this.data.v
    const cur = v.event.currency
    const minor = this.data.totalCost === '' ? null : fmt.toMinor(this.data.totalCost, cur)

    if (!minor && !(v.bill && v.bill.total_minor)) {
      wx.showToast({ title: i18n.errText({ code: 'NO_TOTAL' }), icon: 'none' })
      return
    }

    const go = () =>
      api
        .callWithToast('bill.publish', {
          eventId: this.data.eventId,
          total_minor: minor,
          payment_note: this.data.paymentNote,
        })
        .then((res) => {
          wx.showToast({
            title: res.revised ? t.updatedToast : t.publishedToast,
            icon: 'success',
          })
          this.setData({ editingTotal: false })
          this.load()
        })
        .catch(() => {})

    wx.showModal({
      title: t.confirmPublishTitle,
      content: t.confirmPublishBody,
      confirmText: this.data.published ? t.updateBill : t.publishBill,
      success: (r) => {
        if (r.confirm) go()
      },
    })
  },

  // --- settlement (§9.3) ----------------------------------------------------
  markPaid(e) {
    this.moveShare('bill.markPaid', { paid: true }, e)
  },

  markUnpaid(e) {
    // Serves both "that payment didn't land after all" and un-waiving.
    this.moveShare('bill.markPaid', { paid: false }, e)
  },

  waive(e) {
    this.moveShare('bill.waive', { waived: true }, e)
  },

  moveShare(action, extra, e) {
    api
      .callWithToast(
        action,
        Object.assign(
          { eventId: this.data.eventId, targetOpenid: e.currentTarget.dataset.openid },
          extra
        )
      )
      .then(() => this.load())
      .catch(() => {})
  },

  /**
   * "I've paid". §9.4 — deliberately doesn't settle anything; it raises the
   * discrepancy so a lockout can't fire on someone who already transferred.
   */
  claimPaid() {
    const t = this.data.t
    api
      .callWithToast('bill.claimPaid', { eventId: this.data.eventId })
      .then(() => {
        wx.showToast({ title: t.claimedToast, icon: 'success' })
        this.load()
      })
      .catch(() => {})
  },

  copyPaymentNote() {
    const t = this.data.t
    wx.setClipboardData({
      data: this.data.v.payment_note,
      success: () => wx.showToast({ title: t.copied, icon: 'success' }),
    })
  },

  voidBill() {
    const t = this.data.t
    wx.showModal({
      title: t.confirmVoidBillTitle,
      content: t.confirmVoidBillBody,
      confirmText: t.voidBill,
      success: (r) => {
        if (!r.confirm) return
        api
          .callWithToast('bill.void', { eventId: this.data.eventId })
          .then(() => {
            wx.showToast({ title: t.voidedToast, icon: 'none' })
            this.load()
          })
          .catch(() => {})
      },
    })
  },

  goManage() {
    wx.navigateTo({ url: `/pages/manage/manage?id=${this.data.eventId}` })
  },
})
