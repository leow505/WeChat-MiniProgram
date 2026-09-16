/**
 * Sessions this person runs. DESIGN.md §7
 *
 * Split off the 我的 tab, which lists a count and a chevron rather than the sessions
 * themselves — the same shape as 我的俱乐部, so the tab stays a menu instead of growing
 * an unbounded list inside it.
 *
 * Whatever is *waiting* on the organizer is on 我的 under 待处理; this is the full
 * inventory, so it includes finished sessions whose money is already settled.
 */
const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/format')

Page({
  data: {
    t: {},
    upcoming: [],
    done: [],
  },

  onShow() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.hostingTitle })
    this.setData({ t })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    return api
      .call('event.hosting')
      .then((res) => {
        this.setData({
          upcoming: (res.upcoming || []).map((ev) => this.row(ev, t)),
          // Finished sessions keep an entry so a settled bill is still reachable —
          // the 待处理 list drops them the moment nothing is owed.
          done: (res.actions || []).map((ev) =>
            Object.assign(this.row(ev, t), {
              note:
                ev.kind === 'COLLECTING'
                  ? i18n.t('haCOLLECTING', { amount: fmt.money(ev.unpaid_minor, ev.currency) })
                  : t.haNEEDS_SPLIT,
              needs: true,
            })
          ),
        })
      })
      .catch((err) => wx.showToast({ title: i18n.errText(err), icon: 'none' }))
  },

  row(ev, t) {
    return {
      _id: ev._id,
      title: ev.title,
      when: fmt.shortLocal(ev.start_local),
      seats: `${ev.roster_count}/${ev.capacity}`,
      status_label: t['status' + ev.status] || '',
      status_class: String(ev.status).toLowerCase().replace(/_/g, '-'),
      // Unbooked courts on something coming up is the organizer's next job.
      note: ev.court_status === 'NOT_BOOKED' ? t.courtsNotBooked : '',
      needs: false,
    }
  },

  /** Upcoming goes to the controls; finished goes to the money. */
  openManage(e) {
    wx.navigateTo({ url: `/pages/manage/manage?id=${e.currentTarget.dataset.id}` })
  },

  openBill(e) {
    wx.navigateTo({ url: `/pages/bill/bill?id=${e.currentTarget.dataset.id}` })
  },
})
