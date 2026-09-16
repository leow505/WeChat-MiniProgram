/**
 * The 我的 tab. A menu, plus the one thing a menu can't be: an answer to "what is
 * that red dot for". DESIGN.md §7
 *
 * The dot on this tab used to count club join requests and say so nowhere, so the
 * only way to find its cause was to open 我的俱乐部 and hunt for a club with a badge.
 * The 待处理 list is now the dot's contents, itemised, each row linking to the place
 * that clears it — and the dot counts exactly what that list holds.
 *
 * It also carries the organizer's jobs, which courts and money made necessary: those
 * used to be reachable only by remembering which session they hung off and navigating
 * in from the feed.
 */
const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const todo = require('../../utils/todo')
const config = require('../../config')

Page({
  data: {
    t: {},
    profile: {},
    genderLabel: '',
    clubCount: 0,
    todo: [],
    hostingCount: 0,
    // config.USE_MOCK became config.API_MODE when the http transport landed, and this
    // read was left behind — so the whole dev-tools card, reset button included, never
    // rendered again. The docs have been telling people to use a button they cannot see.
    isMock: config.API_MODE === 'mock',
  },

  onShow() {
    const t = i18n.pack()
    if (this.getTabBar) {
      const bar = this.getTabBar()
      if (bar) bar.refresh(1)
    }
    wx.setNavigationBarTitle({ title: t.tabMe })
    this.setData({ t })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    return Promise.all([
      api.call('profile.get'),
      api.call('club.mine'),
      api.call('event.hosting').catch(() => ({ upcoming: [], actions: [] })),
      api.call('event.mine').catch(() => ({ owing: { count: 0 } })),
    ])
      .then(([profile, clubs, hosting, mine]) => {
        const active = clubs.joined.filter((c) => c.my_status === 'ACTIVE')
        const rows = todo.build(clubs, hosting, mine, t)

        this.setData({
          profile,
          genderLabel:
            profile.gender === 'UNSPECIFIED' ? '' : t[String(profile.gender).toLowerCase()],
          clubCount: active.length,
          todo: rows,
          // A count and a chevron, like 我的俱乐部 — the sessions themselves live on
          // their own page, so this tab can't grow an unbounded list.
          hostingCount: (hosting.upcoming || []).length + (hosting.actions || []).length,
        })

        // The dot is the length of the list above — no more, no less.
        if (this.getTabBar) {
          const bar = this.getTabBar()
          if (bar) bar.setDot(rows.length)
        }
      })
      .catch(() => {})
  },

  openTodo(e) {
    const url = e.currentTarget.dataset.url
    if (!url) {
      wx.switchTab({ url: '/pages/games/games' })
      return
    }
    wx.navigateTo({ url })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  },

  goClubs() {
    wx.navigateTo({ url: '/pages/clubs/clubs' })
  },

  goHosting() {
    wx.navigateTo({ url: '/pages/hosting/hosting' })
  },

  resetMock() {
    wx.showModal({
      title: this.data.t.resetMock,
      content: this.data.t.resetConfirmBody,
      success: (r) => {
        if (!r.confirm) return
        api.call('dev.reset').then(() => {
          wx.showToast({ title: this.data.t.resetDone, icon: 'success' })
          this.load()
        })
      },
    })
  },
})
