const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/format')
const present = require('../../utils/present')
const todo = require('../../utils/todo')

Page({
  data: {
    t: {},
    mine: [],
    open: [],
    openAll: [],
    past: [],
    filters: [],
    filter: 'ALL',
    hasClubs: true,
    showPast: false,
    loading: true,
    /**
     * The two lists used to be stacked, so a busy player had to scroll past every
     * session they'd joined to reach the ones they hadn't. They're segments now:
     * neither list can push the other off screen, whatever its length.
     *
     * Defaults to MINE because that's what people open the app to check — but it is
     * one tap away from OPEN rather than a scroll of unknown length.
     */
    tab: 'MINE',
    owing: '',
  },

  /**
   * The outstanding-fees line. §9.4
   *
   * Names the amount where it can, because a nag with no number is noise. Shares
   * spanning two currencies can't be added up (§10.3), so that case reports the
   * count only and leaves the amounts to the per-session view.
   */
  owingLine(owing, t) {
    if (!owing || !owing.count) return ''
    if (owing.mixed_currency) return i18n.t('owingCount', { n: owing.count })
    return i18n.t('owingBanner', {
      n: owing.count,
      amount: fmt.money(owing.total_minor, owing.currency),
    })
  },

  onShow() {
    const t = i18n.pack()
    if (this.getTabBar) {
      const bar = this.getTabBar()
      if (bar) bar.refresh(0)
    }
    wx.setNavigationBarTitle({ title: t.tabGames })
    this.setData({ t })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    /**
     * event.hosting is read here only to size the tab-bar dot. Each tab page owns its
     * own tab-bar component instance, so whichever page is showing has to know the
     * count — and a dot that disagreed with the list explaining it on 我的 would be
     * worse than no dot. One extra parallel read buys that agreement.
     */
    return Promise.all([
      api.call('event.mine'),
      api.call('event.list'),
      api.call('club.mine').catch(() => ({ joined: [] })),
      api.call('event.hosting').catch(() => ({ upcoming: [], actions: [] })),
    ])
      .then(([mine, list, clubs, hosting]) => {
        const joinedIds = {}
        mine.upcoming.forEach((ev) => {
          joinedIds[ev._id] = true
        })
        // Anything already joined lives in the section above, not both.
        const openAll = list
          .filter((ev) => !joinedIds[ev._id])
          .map((ev) => present.eventCard(ev, t))

        const mineCards = mine.upcoming.map((ev) => present.eventCard(ev, t))
        this.setData({
          mine: mineCards,
          past: mine.past.map((ev) =>
            Object.assign(present.eventCard(ev, t), {
              owe_text: ev.my_share_status === 'UNPAID' ? fmt.money(ev.my_share_minor, ev.currency) : '',
            })
          ),
          openAll,
          filters: this.buildFilters(openAll, t),
          hasClubs: clubs.joined.some((c) => c.my_status === 'ACTIVE'),
          loading: false,
          owing: this.owingLine(mine.owing, t),
          // Nothing joined yet: land on the segment that has something in it, rather
          // than on an empty list the newcomer has to work out how to leave.
          tab: mineCards.length ? this.data.tab : 'OPEN',
        })
        // Same builder the 我的 page renders as 待处理, so the dot is exactly the
        // length of the list that explains it.
        if (this.getTabBar) {
          const bar = this.getTabBar()
          if (bar) bar.setDot(todo.build(clubs, hosting, mine, t).length)
        }
        this.applyFilter()
      })
      .catch(() => this.setData({ loading: false }))
  },

  /**
   * Chips only appear once there's something to disambiguate — a club running four
   * sessions a week would otherwise swamp the feed, but a single-source user
   * doesn't need a filter row at all.
   *
   * Each carries its own count, which is what makes the row informative rather
   * than decorative: you can see where the sessions are before tapping.
   */
  buildFilters(list, t) {
    const clubs = []
    const seen = {}

    // Every listed session belongs to a club now, so clubs are the only buckets.
    list.forEach((ev) => {
      if (!ev.club_id) return
      if (!seen[ev.club_id]) {
        seen[ev.club_id] = { value: ev.club_id, label: ev.club_name || t.club, count: 0 }
        clubs.push(seen[ev.club_id])
      }
      seen[ev.club_id].count++
    })

    // A filter with one option isn't a filter.
    if (clubs.length < 2) return []
    return [{ value: 'ALL', label: t.filterAll, count: list.length }].concat(clubs)
  },

  applyFilter() {
    const f = this.data.filter
    const all = this.data.openAll
    const open = f === 'ALL' ? all : all.filter((ev) => ev.club_id === f)
    this.setData({ open })
  },

  onFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.value }, () => this.applyFilter())
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab })
    // Back to the top: the two lists are different lengths, so a carried-over scroll
    // position lands somewhere arbitrary.
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  togglePast() {
    this.setData({ showPast: !this.data.showPast })
  },

  openEvent(e) {
    wx.navigateTo({ url: `/pages/event/event?id=${e.currentTarget.dataset.id}` })
  },

  /**
   * One outstanding share goes straight to its settlement screen. Several can't, so
   * they open the history where all of them are listed.
   */
  /**
   * Always the list, even for a single debt: it names the session, the amount and
   * whether it is late, and links on to the split. This used to switch tabs and expand
   * the history for anything other than one share, which left the reader to find the
   * sessions the notice was about.
   */
  openOwing() {
    wx.navigateTo({ url: '/pages/owing/owing' })
  },

  goClubs() {
    wx.navigateTo({ url: '/pages/clubs/clubs' })
  },
})
