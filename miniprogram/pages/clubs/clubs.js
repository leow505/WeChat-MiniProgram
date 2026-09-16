const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const config = require('../../config')

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
    // Revealed when a club turns out to ask for a venue membership name. §3.8
    askingMembership: false,
    joinName: '',
    policyOptions: [],
    /**
     * Tourist mode only: what the demo data can be joined with. A club you are not in
     * cannot be listed (discovery is deferred, §13), so without this the join flow is
     * only reachable by someone who has read the README.
     */
    demoCodes: [],
  },

  onShow() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.tabClubs })
    if (config.API_MODE === 'mock') this.loadDemoCodes(t)
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

  /**
   * A club page is for members (§3.10), so a request still waiting has nothing to
   * open — the card says 审核中 and tapping it repeats that rather than bouncing off
   * a server refusal.
   */
  openClub(e) {
    const { id, pending } = e.currentTarget.dataset
    if (pending) {
      wx.showToast({ title: this.data.t.pendingApproval, icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/club/club?id=${id}` })
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
    this.setData({
      joiningByCode: !this.data.joiningByCode,
      creating: false,
      askingMembership: false,
      joinName: '',
    })
  },

  /** The mock backend only; any other transport rejects with NO_ACTION and shows nothing. */
  loadDemoCodes(t) {
    api
      .call('dev.inviteCodes', {})
      .then((res) =>
        this.setData({
          demoCodes: (res.codes || []).map((c) =>
            Object.assign({}, c, { policy_label: t['mp' + c.membership_policy] || '' })
          ),
        })
      )
      .catch(() => this.setData({ demoCodes: [] }))
  },

  useDemoCode(e) {
    this.setData({ code: e.currentTarget.dataset.code, joiningByCode: true })
  },

  onCode(e) {
    this.setData({ code: (e.detail.value || '').toUpperCase() })
  },

  onJoinName(e) {
    this.setData({ joinName: e.detail.value })
  },

  cancelMembership() {
    this.setData({ askingMembership: false, joinName: '' })
  },

  /** The mask closes the dialog; a tap inside it must not. */
  noop() {},

  /**
   * An invite code identifies the club on its own, so it's matched client-side
   * against nothing — the server resolves it. We only have the code, so we ask the
   * server to find the club by code via club.join with a clubId of the code.
   *
   * A code carries no club with it, so whether this club plays on a venue card is only
   * knowable from the answer: MEMBERSHIP_REQUIRED reveals the field, in the panel next
   * to the code, and the next tap tries again with it. (It used to open an editable
   * wx.showModal, whose `content` is the input's value rather than a description — so
   * the explanation was being prefilled into the one-line box.)
   */
  submitCode() {
    const t = this.data.t
    const code = this.data.code.trim()
    if (!code) {
      wx.showToast({ title: t.vInviteCode, icon: 'none' })
      return
    }
    const name = String(this.data.joinName || '').trim()
    // Asked already and still blank: say what is missing rather than letting the server
    // refuse again in silence.
    if (this.data.askingMembership && !name) {
      wx.showToast({ title: t.vMembershipName, icon: 'none' })
      return
    }

    this.tryCode(code, name).catch((err) => {
      if (err && err.code === 'MEMBERSHIP_REQUIRED') {
        this.setData({ askingMembership: true })
        return
      }
      wx.showToast({ title: i18n.errText(err), icon: 'none' })
    })
  },

  tryCode(code, membershipName) {
    const t = this.data.t
    return api.call('club.joinByCode', { code, membership_name: membershipName }).then((res) => {
      wx.showToast({
        title: res.status === 'ACTIVE' ? t.joinedClubToast : t.submittedToast,
        icon: 'success',
      })
      this.setData({ joiningByCode: false, code: '', askingMembership: false, joinName: '' })
      this.load()
      // A club you have just joined is no longer one you can join.
      if (config.API_MODE === 'mock') this.loadDemoCodes(t)
    })
  },

})
