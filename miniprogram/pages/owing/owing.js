/**
 * What you still owe, across sessions. §9.4
 *
 * The outstanding-fees notice on the games tab named a total and, with more than one
 * session behind it, had nowhere to go: it switched tabs and expanded the collapsed
 * history, leaving the reader to find the sessions themselves. This is that list —
 * every unpaid share, worst first, each one a tap from the split it came from.
 *
 * Enforcement is still deferred (§9.3, and the overdue block waits on notifications):
 * this page makes the money visible, it does not lock anyone out.
 */
const api = require('../../utils/api')
const i18n = require('../../utils/i18n')
const fmt = require('../../utils/format')
const present = require('../../utils/present')

Page({
  data: {
    t: {},
    rows: [],
    summary: '',
    loading: true,
  },

  onShow() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.owingTitle })
    this.setData({ t })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const t = i18n.pack()
    return api
      .call('event.mine')
      .then((mine) => {
        const rows = mine.past
          .concat(mine.upcoming)
          .filter((ev) => ev.my_share_status === 'UNPAID')
          /**
           * Overdue first, then oldest: the order in which they became somebody else's
           * problem. Sorted by date alone, the one that is actually late gets buried.
           */
          .sort((a, b) => {
            if (!!b.my_share_overdue !== !!a.my_share_overdue) return a.my_share_overdue ? -1 : 1
            return a.start_at - b.start_at
          })
          .map((ev) =>
            Object.assign(present.eventCard(ev, t), {
              amount_text: fmt.money(ev.my_share_minor, ev.currency),
              currency_code: fmt.currencyLabel(ev.currency),
              status_text: ev.my_share_overdue ? t.overdueTag : t.ssUNPAID,
              status_class: ev.my_share_overdue ? 'share-overdue' : 'share-unpaid',
              /**
               * When it is due, for the ones that still have time. A draft bill has no
               * clock at all (§9.3), and on a late one the deadline is behind us — the
               * tag says "overdue", and "Due passed" underneath it says nothing twice.
               */
              due_text:
                ev.my_share_due_at && !ev.my_share_overdue
                  ? i18n.t('dueBy', { when: fmt.relative(ev.my_share_due_at) })
                  : '',
            })
          )

        this.setData({ rows, summary: this.summaryLine(mine.owing, t), loading: false })
      })
      .catch((err) => {
        wx.showToast({ title: i18n.errText(err), icon: 'none' })
        this.setData({ loading: false })
      })
  },

  /**
   * The same line the games tab shows, for the same reason: a nag with no number is
   * noise. Shares in two currencies cannot be added up (§10.3), so that case reports
   * the count and leaves the amounts to the rows.
   */
  summaryLine(owing, t) {
    if (!owing || !owing.count) return ''
    if (owing.mixed_currency) return i18n.t('owingCount', { n: owing.count })
    return i18n.t('owingBanner', {
      n: owing.count,
      amount: fmt.money(owing.total_minor, owing.currency),
    })
  },

  openBill(e) {
    wx.navigateTo({ url: `/pages/bill/bill?id=${e.currentTarget.dataset.id}` })
  },
})
