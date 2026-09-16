/**
 * Settlement flow. Run with `node tests/bills.test.js` — no framework, no install.
 *
 * rules.test.js covers the money arithmetic; this covers the things the arithmetic
 * can't express — what publication does to existing shares, who is allowed to move
 * them, and the guards around when a bill may exist at all (DESIGN.md §9).
 *
 * It drives the mock backend, because that one runs outside the cloud. The cloud
 * copy in cloudfunctions/api/lib/bills.js is written line-for-line parallel to it
 * and both call the same rules.computeShares, so this is the closest a local suite
 * gets to covering both. Keeping them in step is still a manual read.
 */
const path = require('path')

// mock-store persists through wx storage; back it with a plain object.
const storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    storage[k] = JSON.parse(JSON.stringify(v))
  },
  removeStorageSync: (k) => {
    delete storage[k]
  },
  getAppBaseInfo: () => ({ language: 'zh_CN' }),
}

const UTILS = path.join(__dirname, '../miniprogram/utils')
const mock = require(path.join(UTILS, 'mock.js'))
const rules = require(path.join(UTILS, 'rules.js'))

let pass = 0
let fail = 0

function is(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    return
  }
  fail++
  console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)
}

const call = (action, payload) => mock.dispatch(action, payload)

/** Refusals arrive as codes, never sentences, so assert on the code. §10.1 */
function refuses(label, code, promise) {
  return promise.then(
    () => {
      fail++
      console.log(`  FAIL ${label}\n    expected ${code}, but it succeeded`)
    },
    (err) => is(label, err.code || err.message, code)
  )
}

;(async () => {
  // --- money in and out of an editable field (§10.3) ------------------------
  // A court fee is rarely a round number, so the whole path has to survive decimals:
  // typed string -> integer minor units -> exact split -> back into the box.
  const fmt = require(path.join(UTILS, 'format.js'))
  ;[
    ['96', 'CAD', 9600],
    ['96.5', 'CAD', 9650],
    ['96.75', 'CAD', 9675],
    ['13.45', 'CAD', 1345], // 13.45*100 is 1344.9999... in binary; rounding saves it
    ['0.99', 'CAD', 99],
    ['96.756', 'CAD', 9676], // a third decimal the currency can't hold, rounded
    ['CAD 96.75', 'CAD', 9675], // a pasted code or symbol is stripped
    ['CA$96.75', 'CAD', 9675],
    ['96.75', 'CAD', 9675], // the form we now render, pasted straight back
    ['2500', 'JPY', 2500], // no fractional part, so no ×100
    ['2500.6', 'JPY', 2501],
  ].forEach(([typed, cur, minor]) => {
    is(`"${typed}" ${cur} reads as ${minor} minor`, fmt.toMinor(typed, cur), minor)
    // Round-tripping has to give back something that re-reads as the same amount.
    is(`and ${minor} ${cur} goes back into the box`, fmt.toMinor(fmt.toMajorInput(minor, cur), cur), minor)
  })
  // Amounts carry no currency marker: the decimal is the money cue, it needs no lookup,
  // and it can't be the wrong currency. The code is stated once per screen instead.
  is('an amount is a bare number', fmt.money(9675, 'CAD'), '96.75')
  is('and always shows the fraction', fmt.money(9600, 'CAD'), '96.00')
  is('a zero-decimal currency has none to show', fmt.money(2500, 'JPY'), '2500')
  is('an unknown currency assumes two places', fmt.money(1234, 'XYZ'), '12.34')
  is('zero is still money-shaped', fmt.money(0, 'CAD'), '0.00')
  is('the code is available for the one place that shows it', fmt.currencyLabel('cad'), 'CAD')
  is('an unset total leaves the field empty', fmt.toMajorInput(0, 'CAD'), '')
  // Not minor/100: dividing would have shown ¥2500 as "0.25".
  is('a zero-decimal currency is not divided', fmt.toMajorInput(2500, 'JPY'), '2500')
  is('and a two-decimal one is', fmt.toMajorInput(9675, 'CAD'), '96.75')

  // Awkward totals still allocate to the cent across a party-bearing roster.
  const sixHeads = [1, 2, 3, 4, 5, 6].map((n) => ({
    openid: 'p' + n, joined_at: n, state: 'ROSTER', guests: n === 4 ? [{}] : [],
  }))
  ;['96.75', '100', '13.45', '0.03', '85.71', '0.01'].forEach((typed) => {
    const total = fmt.toMinor(typed, 'CAD')
    const out = rules.computeShares({ total_minor: total, signups: sixHeads })
    is(`${typed} over 7 units allocates exactly`, out.allocated_minor, total)
    is(`${typed} bills nobody a negative`, out.rows.every((r) => r.share_minor >= 0), true)
  })


  // --- e_played: manager path, DRAFT -> publish -----------------------------
  let v = await call('bill.get', { eventId: 'e_played' })
  is('manager sees the roster', v.is_manager, true)
  is('event has ended', v.ended, true)
  is('draft bill total', v.bill.total_minor, 9600)
  is('surcharge comes from the venue', v.surcharge_minor, 500)
  is('7 units over 6 payers', [v.preview.units, v.preview.payer_count], [7, 6])
  is('preview allocates the whole total', v.preview.allocated_minor, 9600)
  is('the guest host owes their party', v.rows.find((r) => r.openid === 'u_zhao').preview_minor, 3100)
  is('solo players owe the base', v.rows.find((r) => r.openid === 'u_lin').preview_minor, 1300)
  is('no shares before publication', v.totals.share_count, 0)

  await refuses('cannot mark paid before publishing', 'BILL_NOT_PUBLISHED',
    call('bill.markPaid', { eventId: 'e_played', targetOpenid: 'u_lin', paid: true }))

  let p = await call('bill.publish', { eventId: 'e_played', payment_note: 'e-transfer 给 林昊' })
  is('publishes 6 shares', p.share_count, 6)
  is('publication conserves the total', p.allocated_minor, 9600)
  is('a first publication is not a revision', p.revised, false)
  is('status is published', p.status, 'PUBLISHED')

  v = await call('bill.get', { eventId: 'e_played' })
  is('due 12h after publication', v.bill.due_at - v.bill.billed_at, 12 * rules.HOUR)
  is('everything starts unpaid', v.totals.unpaid_minor, 9600)
  is('payment note stored', v.bill.payment_note, 'e-transfer 给 林昊')

  // --- tick payments off ----------------------------------------------------
  await call('bill.markPaid', { eventId: 'e_played', targetOpenid: 'u_lin', paid: true })
  await call('bill.waive', { eventId: 'e_played', targetOpenid: 'u_li', waived: true })
  v = await call('bill.get', { eventId: 'e_played' })
  is('paid + waived counted as settled', v.totals.settled_count, 2)
  is('unpaid drops by both', v.totals.unpaid_minor, 9600 - 1300 - 1300)
  is('bill still open', v.bill.status, 'PUBLISHED')

  // --- revise: drop a payer, correct the total ------------------------------
  // The payer set changes only when somebody leaves the roster. There is no attendance
  // step: every head that held a seat pays, whether or not they turned up (§14).
  await call('event.removeSignup', { eventId: 'e_played', targetOpenid: 'u_sun' })
  const before = await call('bill.get', { eventId: 'e_played' })
  is('someone off the roster drops out of the preview', before.preview.payer_count, 5)

  p = await call('bill.publish', { eventId: 'e_played', total_minor: 9000 })
  is('a republish is flagged as a revision', p.revised, true)
  v = await call('bill.get', { eventId: 'e_played' })
  is('settled shares stand', v.rows.find((r) => r.openid === 'u_lin').status, 'PAID')
  is('a paid share keeps its old amount', v.rows.find((r) => r.openid === 'u_lin').share_minor, 1300)
  // No seat and no share left, so they drop off the screen entirely. Had the share
  // already been PAID it would have stood, flagged off_roster, since money that has
  // arrived is not the app's to un-arrive (§9.4).
  is('their unpaid share is gone', !v.rows.find((r) => r.openid === 'u_sun'), true)
  is('due date does not move on revision', v.bill.due_at - v.bill.billed_at, 12 * rules.HOUR)
  is('revised total recorded', v.bill.total_minor, 9000)

  // --- a marked no-show is still billed (§14) -------------------------------
  // The field survives for §13's reliability signal, but it buys nobody a discount.
  const marked = await call('bill.get', { eventId: 'e_collect' })
  is('every head on the roster has a share', marked.rows.length, 6)
  is('and the total is fully allocated', marked.totals.total_minor, 8400)

  // --- e_owed: player path --------------------------------------------------
  v = await call('bill.get', { eventId: 'e_owed' })
  is('a plain member is not a manager', v.is_manager, false)
  is('a player gets no per-person list', v.rows.length, 0)
  is('my own share is visible', v.my_share.share_minor, 1200)
  is('my share is unpaid', v.my_share.status, 'UNPAID')
  is('past the 24h grace it is overdue', v.my_share.overdue, true)
  is('aggregate is visible', [v.totals.settled_count, v.totals.share_count], [3, 4])

  await refuses('a player cannot mark themselves paid', 'NOT_ADMIN',
    call('bill.markPaid', { eventId: 'e_owed', targetOpenid: mock.ME, paid: true }))

  const c = await call('bill.claimPaid', { eventId: 'e_owed' })
  is('claim recorded', c.claimed_paid_at > 0, true)
  v = await call('bill.get', { eventId: 'e_owed' })
  is('claiming does not settle the share', v.my_share.status, 'UNPAID')
  is('claim surfaces on my share', v.my_share.claimed_paid_at > 0, true)

  const det = await call('event.detail', { eventId: 'e_owed' })
  is('detail carries my share', det.my_share_minor, 1200)
  is('detail flags it overdue', det.my_share_overdue, true)
  is('detail carries the claim flag', det.my_share_claimed, true)

  // --- guards ---------------------------------------------------------------
  await refuses('cannot publish a future session', 'EVENT_NOT_OVER',
    call('bill.publish', { eventId: 'e_thu', total_minor: 5000 }))
  await refuses('cannot see a bill for a session you were not on', 'NOT_VISIBLE',
    call('bill.get', { eventId: 'e_closed' }))

  // --- void -----------------------------------------------------------------
  await call('bill.void', { eventId: 'e_played' })
  v = await call('bill.get', { eventId: 'e_played' })
  is('voided bill', v.bill.status, 'VOID')
  is('no unpaid rows survive a void', v.totals.unpaid_minor, 0)
  await refuses('cannot publish over a void bill', 'BILL_VOID',
    call('bill.publish', { eventId: 'e_played', total_minor: 100 }))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch((err) => {
  console.log('  FAIL suite threw', err)
  process.exit(1)
})
