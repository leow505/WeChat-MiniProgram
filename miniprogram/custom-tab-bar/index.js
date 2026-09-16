/**
 * Custom tab bar with a raised centre action.
 *
 * The native bar can't size its labels, only takes image icons, and has no notion
 * of a non-tab action button. A component gives all three, keeps the tap target
 * explicit, and draws its icons in CSS — no binary assets.
 *
 * Why two tabs rather than three: a single button cannot be centred among an odd
 * number of tabs. Creating a session is the action people hunted for, so it took
 * the centre and Clubs moved into 我的 — with the count of things waiting on you
 * carried out here as a dot, so you learn without going to look.
 *
 * Each tab page calls `this.getTabBar().refresh(index)` in onShow, which is also how
 * labels pick up a locale change and how the dot gets set.
 */
const i18n = require('../utils/i18n')

const PATHS = ['/pages/games/games', '/pages/me/me']

Component({
  data: {
    selected: 0,
    labels: ['', ''],
    dot: 0,
  },

  attached() {
    this.refresh(this.data.selected)
  },

  methods: {
    refresh(selected) {
      const t = i18n.pack()
      this.setData({
        selected: typeof selected === 'number' ? selected : this.data.selected,
        labels: [t.tabGames, t.tabMe],
      })
    },

    /**
     * How many things are waiting on this person — club join requests to approve,
     * splits to publish, fees to collect, fees to pay. Always the length of the 待处理
     * list on 我的, which is built by utils/todo.js: the dot used to be a bare number
     * with nothing on the page it marked explaining where it came from.
     */
    setDot(count) {
      const n = Number(count) || 0
      if (n !== this.data.dot) this.setData({ dot: n })
    },

    onTap(e) {
      const index = Number(e.currentTarget.dataset.index)
      if (index === this.data.selected) return
      wx.switchTab({ url: PATHS[index] })
    },

    onCreate() {
      wx.navigateTo({ url: '/pages/create/create' })
    },
  },
})
