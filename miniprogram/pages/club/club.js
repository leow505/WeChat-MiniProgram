const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const present = require('../../utils/present')
const fmt = require('../../utils/format')

const JP = ['APPROVAL', 'OPEN']
const MP = ['NOT_REQUIRED', 'REQUESTED', 'REQUIRED']
/** §9.1 defaults to 12h; the rest are the spans a club plausibly wants. */
const GRACE_HOURS = [6, 12, 24, 48, 72]

Page({
  data: {
    t: {},
    clubId: '',
    d: null,
    tab: 'games',
    // membership form
    mName: '',
    mNo: '',
    // venue form
    addingVenue: false,
    venueForm: { name: '', address: '', membership_required: false, max_courts_per_membership: 0 },
    jpOptions: [],
    mpOptions: [],
    // No primary venue means no card to ask for, so the demanding options are shown
    // but not selectable until one exists. §3.8
    mpLocked: false,
    /**
     * Money settings. §10.3, §9.3
     *
     * Both were accepted by club.update from the start and reachable from no screen, so
     * every club was silently CAD with a 12h settlement window.
     */
    currencies: fmt.CURRENCIES,
    currencyIdx: 0,
    graceLabels: [],
    graceIdx: 1,
  },

  onLoad(q) {
    this.setData({ clubId: q.id })
  },

  onShow() {
    const t = i18n.pack()
    this.setData({
      t,
      jpOptions: JP.map((v) => ({ value: v, label: t['jp' + v] })),
      mpOptions: MP.map((v) => ({ value: v, label: t['mp' + v] })),
      graceLabels: GRACE_HOURS.map((h) => i18n.t('hours', { n: h })),
    })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    return api
      .call('club.detail', { clubId: this.data.clubId })
      .then((d) => {
        const club = d.club
        this.setData({
          d: Object.assign({}, d, {
            policy_label: t['jp' + club.join_policy],
            membership_label: t['mp' + club.membership_policy],
            members: present.withGender(d.members).map((m) =>
              Object.assign({}, m, {
                initial: present.initial(m.name),
                role_label: t['role' + m.role],
                is_plain: m.role === 'MEMBER',
              })
            ),
            pending: present.withGender(d.pending).map((m) =>
              Object.assign({}, m, { initial: present.initial(m.name) })
            ),
            upcoming: d.upcoming.map((ev) => present.eventCard(ev, t)),
            needs_membership: club.membership_policy !== 'NOT_REQUIRED' && !d.my_membership,
          }),
          mName: d.my_membership ? d.my_membership.membership_name : '',
          mNo: d.my_membership ? d.my_membership.membership_no : '',
          mpLocked: !club.primary_venue_id,
          // A club set to something the picker doesn't list still opens; it just lands
          // on the first entry until an admin picks again.
          currencyIdx: Math.max(0, fmt.CURRENCIES.indexOf(club.currency)),
          graceIdx: Math.max(0, GRACE_HOURS.indexOf(club.settlement_grace_hours || 12)),
        })
        wx.setNavigationBarTitle({ title: club.name })
      })
      .catch((err) => wx.showToast({ title: i18n.errText(err), icon: 'none' }))
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  openEvent(e) {
    wx.navigateTo({ url: `/pages/event/event?id=${e.currentTarget.dataset.id}` })
  },

  createEvent() {
    wx.navigateTo({ url: `/pages/create/create?clubId=${this.data.clubId}` })
  },

  // --- join / leave ---------------------------------------------------------
  /**
   * A club that plays on somebody's card needs the name on that card, and joining is
   * the moment to ask: the membership form below is only open to members, so asking
   * afterwards leaves a REQUIRED club unjoinable. The name becomes how this person
   * reads inside this club (§3.8); their own display name is untouched.
   */
  join() {
    const club = this.data.d.club
    const asks = club.membership_policy !== 'NOT_REQUIRED' && club.primary_venue_id
    if (!asks || this.data.d.my_membership) return this.doJoin()

    const t = this.data.t
    wx.showModal({
      title: t.membershipName,
      content: t.membershipAskWhy,
      editable: true,
      placeholderText: t.membershipNamePlaceholder,
      success: (r) => {
        if (!r.confirm) return
        const name = String(r.content || '').trim()
        // Only a REQUIRED club insists; a REQUESTED one carries on without it.
        if (!name && club.membership_policy === 'REQUIRED') {
          wx.showToast({ title: t.vMembershipName, icon: 'none' })
          return
        }
        this.doJoin(name)
      },
    })
  },

  doJoin(membershipName) {
    const t = this.data.t
    api
      .callWithToast('club.join', {
        clubId: this.data.clubId,
        membership_name: membershipName || '',
      })
      .then((res) => {
        wx.showToast({
          title: res.status === 'ACTIVE' ? t.joinedClubToast : t.submittedToast,
          icon: 'success',
        })
        this.load()
      })
      .catch(() => {})
  },

  leave() {
    const t = this.data.t
    wx.showModal({
      title: t.leaveClub,
      content: t.confirm,
      success: (r) => {
        if (!r.confirm) return
        api
          .callWithToast('club.leave', { clubId: this.data.clubId })
          .then(() => wx.navigateBack())
          .catch(() => {})
      },
    })
  },

  // --- requests -------------------------------------------------------------
  approve(e) {
    this.decide(e.currentTarget.dataset.openid, true, '')
  },

  reject(e) {
    const openid = e.currentTarget.dataset.openid
    const t = this.data.t
    wx.showModal({
      title: t.reject,
      editable: true,
      placeholderText: t.rejectReason,
      success: (r) => {
        if (!r.confirm) return
        this.decide(openid, false, r.content || '')
      },
    })
  },

  decide(targetOpenid, approve, reason) {
    const t = this.data.t
    api
      .callWithToast('club.decide', { clubId: this.data.clubId, targetOpenid, approve, reason })
      .then(() => {
        wx.showToast({ title: approve ? t.approvedToast : t.rejectedToast, icon: 'success' })
        this.load()
      })
      .catch(() => {})
  },

  // --- member admin ---------------------------------------------------------
  memberActions(e) {
    const { openid, role, name } = e.currentTarget.dataset
    const d = this.data.d
    const t = this.data.t
    if (!d.is_admin || openid === d.club.owner_openid) return

    const items = []
    if (d.is_owner) items.push(role === 'ADMIN' ? t.removeAdmin : t.makeAdmin)
    items.push(t.removeMember)

    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const label = items[res.tapIndex]
        if (label === t.makeAdmin) this.setRole(openid, 'ADMIN')
        else if (label === t.removeAdmin) this.setRole(openid, 'MEMBER')
        else if (label === t.removeMember) this.removeMember(openid, name)
      },
    })
  },

  setRole(targetOpenid, role) {
    api
      .callWithToast('club.setRole', { clubId: this.data.clubId, targetOpenid, role })
      .then(() => this.load())
      .catch(() => {})
  },

  removeMember(targetOpenid, name) {
    const t = this.data.t
    wx.showModal({
      title: t.removeMember,
      content: name,
      success: (r) => {
        if (!r.confirm) return
        api
          .callWithToast('club.removeMember', { clubId: this.data.clubId, targetOpenid })
          .then(() => this.load())
          .catch(() => {})
      },
    })
  },

  // --- my venue membership --------------------------------------------------
  onMName(e) {
    this.setData({ mName: e.detail.value })
  },
  onMNo(e) {
    this.setData({ mNo: e.detail.value })
  },

  saveMembership() {
    const t = this.data.t
    const venueId = this.data.d.club.primary_venue_id
    if (!venueId) return
    if (!this.data.mName.trim()) {
      wx.showToast({ title: t.vMembershipName, icon: 'none' })
      return
    }
    api
      .callWithToast('venue.upsertMembership', {
        venueId,
        membership_name: this.data.mName,
        membership_no: this.data.mNo,
      })
      .then(() => {
        wx.showToast({ title: t.savedToast, icon: 'success' })
        this.load()
      })
      .catch(() => {})
  },

  // --- settings -------------------------------------------------------------
  setJoinPolicy(e) {
    this.patch({ join_policy: e.currentTarget.dataset.value })
  },

  setMembershipPolicy(e) {
    const value = e.currentTarget.dataset.value
    // Asking for a card the club has no venue to issue would leave nobody able to
    // join at all, so the demanding options wait for a primary venue. §3.8
    if (this.data.mpLocked && value !== 'NOT_REQUIRED') {
      wx.showToast({ title: this.data.t.membershipNeedsVenue, icon: 'none' })
      return
    }
    this.patch({ membership_policy: value })
  },

  rotateCode() {
    this.patch({ rotate_invite_code: true })
  },

  setPrimaryVenue(e) {
    this.patch({ primary_venue_id: e.currentTarget.dataset.id })
  },

  onCurrency(e) {
    const idx = Number(e.detail.value)
    this.setData({ currencyIdx: idx })
    this.patch({ currency: fmt.CURRENCIES[idx] })
  },

  onGrace(e) {
    const idx = Number(e.detail.value)
    this.setData({ graceIdx: idx })
    this.patch({ settlement_grace_hours: GRACE_HOURS[idx] })
  },

  patch(patch) {
    api
      .callWithToast('club.update', { clubId: this.data.clubId, patch })
      .then(() => this.load())
      .catch(() => {})
  },

  copyCode() {
    const t = this.data.t
    wx.setClipboardData({
      data: this.data.d.club.invite_code,
      success: () => wx.showToast({ title: t.copied, icon: 'success' }),
    })
  },

  // --- venues ---------------------------------------------------------------
  toggleAddVenue() {
    this.setData({ addingVenue: !this.data.addingVenue })
  },

  onVenueInput(e) {
    this.setData({ [`venueForm.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  onVenueSwitch(e) {
    this.setData({ 'venueForm.membership_required': e.detail.value })
  },

  stepCourts(e) {
    const d = Number(e.currentTarget.dataset.d)
    const next = Math.max(0, Math.min(12, this.data.venueForm.max_courts_per_membership + d))
    this.setData({ 'venueForm.max_courts_per_membership': next })
  },

  submitVenue() {
    const t = this.data.t
    if (!this.data.venueForm.name.trim()) {
      wx.showToast({ title: t.vVenue, icon: 'none' })
      return
    }
    api
      .callWithToast('venue.create', { clubId: this.data.clubId, venue: this.data.venueForm })
      .then(() => {
        this.setData({
          addingVenue: false,
          venueForm: { name: '', address: '', membership_required: false, max_courts_per_membership: 0 },
        })
        this.load()
      })
      .catch(() => {})
  },
})
