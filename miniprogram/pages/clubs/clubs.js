const api = require('../../utils/api')
const i18n = require('../../utils/i18n')

const POLICY_KEY = { OPEN: 'jpOPEN', APPROVAL: 'jpAPPROVAL' }

function decorate(c, t) {
  return Object.assign({}, c, {
    policy_label: t[POLICY_KEY[c.join_policy]] || '',
    // 'member' is the default, so badging it adds noise; only a role worth knowing
    // earns a badge.
    role_label: c.my_role && c.my_role !== 'MEMBER' ? t['role' + c.my_role] : '',
    pending: c.my_status === 'PENDING',
    pending_text: c.pending_count ? i18n.t('pendingCount', { n: c.pending_count }) : '',
  })
}

Page({
  data: {
    t: {},
    joined: [],
    loading: true,
    creating: false,
    joiningByCode: false,
    form: { name: '', description: '', join_policy: 'APPROVAL' },
    code: '',
    policyOptions: [],
  },

  onShow() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.tabClubs })
    this.setData({
      t,
      policyOptions: [
        { value: 'APPROVAL', label: t.jpAPPROVAL },
        { value: 'OPEN', label: t.jpOPEN },
      ],
    })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    return api
      .call('club.mine')
      .then((res) =>
        this.setData({
          joined: res.joined.map((c) => decorate(c, t)),
          loading: false,
        })
      )
      .catch(() => this.setData({ loading: false }))
  },

  openClub(e) {
    wx.navigateTo({ url: `/pages/club/club?id=${e.currentTarget.dataset.id}` })
  },

  // --- create ---------------------------------------------------------------
  toggleCreate() {
    this.setData({ creating: !this.data.creating, joiningByCode: false })
  },

  onFormInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value })
  },

  onPolicy(e) {
    this.setData({ 'form.join_policy': e.currentTarget.dataset.value })
  },

  submitCreate() {
    const t = this.data.t
    if (!this.data.form.name.trim()) {
      wx.showToast({ title: t.vClubName, icon: 'none' })
      return
    }
    api
      .callWithToast('club.create', { club: this.data.form })
      .then((res) => {
        this.setData({ creating: false, form: { name: '', description: '', join_policy: 'APPROVAL' } })
        wx.navigateTo({ url: `/pages/club/club?id=${res.clubId}` })
      })
      .catch(() => {})
  },

  // --- join by code ---------------------------------------------------------
  toggleJoinByCode() {
    this.setData({ joiningByCode: !this.data.joiningByCode, creating: false })
  },

  onCode(e) {
    this.setData({ code: (e.detail.value || '').toUpperCase() })
  },

  /**
   * An invite code identifies the club on its own, so it's matched client-side
   * against nothing — the server resolves it. We only have the code, so we ask the
   * server to find the club by code via club.join with a clubId of the code.
   */
  submitCode() {
    const code = this.data.code.trim()
    if (!code) {
      wx.showToast({ title: this.data.t.vInviteCode, icon: 'none' })
      return
    }
    // A code carries no club with it, so whether this club plays on a venue card is
    // only knowable from the answer: ask for the name and try once more. §3.8
    this.tryCode(code, '').catch((err) => {
      if (err && err.code === 'MEMBERSHIP_REQUIRED') return this.askMembership(code)
      wx.showToast({ title: i18n.errText(err), icon: 'none' })
    })
  },

  askMembership(code) {
    const t = this.data.t
    wx.showModal({
      title: t.membershipName,
      content: t.membershipAskWhy,
      editable: true,
      placeholderText: t.membershipNamePlaceholder,
      success: (r) => {
        if (!r.confirm) return
        const name = String(r.content || '').trim()
        if (!name) {
          wx.showToast({ title: t.vMembershipName, icon: 'none' })
          return
        }
        this.tryCode(code, name).catch((err) =>
          wx.showToast({ title: i18n.errText(err), icon: 'none' })
        )
      },
    })
  },

  tryCode(code, membershipName) {
    const t = this.data.t
    return api.call('club.joinByCode', { code, membership_name: membershipName }).then((res) => {
      wx.showToast({
        title: res.status === 'ACTIVE' ? t.joinedClubToast : t.submittedToast,
        icon: 'success',
      })
      this.setData({ joiningByCode: false, code: '' })
      this.load()
    })
  },

})
