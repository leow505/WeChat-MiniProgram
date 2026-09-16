/**
 * What is actually waiting on this person, as rows.
 *
 * This exists so the tab-bar dot cannot disagree with the list that explains it. Both
 * tab pages set the dot — each tab has its own tab-bar component instance, so whichever
 * page is showing has to know the number — and the 我的 page renders these same rows as
 * 待处理. One builder, so the count is always the length of the list a tap away.
 *
 * Ordered by who is blocked: someone waiting to be let into a club, then players
 * waiting to be told what they owe, then players waiting to be marked paid, then money
 * you owe somebody else. Every row carries its own destination, so none is a dead end.
 */
const i18n = require('./i18n')
const fmt = require('./format')

/**
 * @param clubs   `club.mine` response  — per-club pending join requests
 * @param hosting `event.hosting` response — sessions of yours needing a bill or a tick
 * @param mine    `event.mine` response — your own unpaid shares
 */
function build(clubs, hosting, mine, t) {
  const rows = []

  ;((clubs && clubs.joined) || []).forEach((c) => {
    if (!c.pending_count) return
    rows.push({
      key: 'club-' + c._id,
      kind: 'CLUB',
      text: i18n.t('joinRequestRow', { n: c.pending_count, club: c.name }),
      detail: '',
      action: t.reviewRequests,
      url: `/pages/club/club?id=${c._id}`,
    })
  })

  ;((hosting && hosting.actions) || []).forEach((a) => {
    rows.push({
      key: 'bill-' + a._id,
      kind: a.kind,
      text: a.title + ' · ' + fmt.shortLocal(a.start_local),
      detail:
        a.kind === 'COLLECTING'
          ? i18n.t('haCOLLECTING', { amount: fmt.money(a.unpaid_minor, a.currency) })
          : t.haNEEDS_SPLIT,
      action: t.costSplit,
      url: `/pages/bill/bill?id=${a._id}`,
    })
  })

  const owing = (mine && mine.owing) || {}
  if (owing.count) {
    rows.push({
      key: 'owing',
      kind: 'OWING',
      text: owing.mixed_currency
        ? i18n.t('owingCount', { n: owing.count })
        : i18n.t('owingBanner', {
            n: owing.count,
            amount: fmt.money(owing.total_minor, owing.currency),
          }),
      detail: '',
      action: t.viewBill,
      // Several unpaid shares have no single destination; the games tab lists them.
      url: owing.event_id ? `/pages/bill/bill?id=${owing.event_id}` : '',
    })
  }

  return rows
}

module.exports = { build }
