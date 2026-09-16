/**
 * Display helpers. DESIGN.md §10.2, §10.3
 *
 * Time: events carry a UTC timestamp for decisions and a wall-clock string for
 * display. Everything here renders the wall clock, parsed as plain text, so
 * "19:00" reads as 7:00 PM to everyone regardless of where they are — and no
 * `Intl` timezone support is required (it's unreliable across the mini program's
 * iOS and Android engines).
 *
 * Money: integer minor units plus an ISO 4217 code, because minor units aren't
 * universally 1/100.
 */
const i18n = require('./i18n')

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Currencies with no fractional part. Everything else here is 2 decimals. */
const ZERO_DECIMAL = { JPY: 1, KRW: 1, VND: 1, IDR: 1, TWD: 1 }

/**
 * The currencies a club can be set to, §10's audience first.
 *
 * A list rather than free text because `decimals()` has to know the precision: an
 * unlisted zero-decimal currency would silently render as hundredths. The API still
 * accepts any well-formed ISO code, so a club somewhere unanticipated isn't locked out —
 * it just falls back to two places.
 */
const CURRENCIES = [
  'CAD', 'AUD', 'SGD', 'GBP', 'USD', 'NZD', 'EUR', 'HKD',
  'MYR', 'THB', 'PHP', 'INR', 'CNY', 'TWD', 'JPY', 'KRW',
]

/*
 * Amounts carry no currency marker at all — "96.75", not "CA$96.75" and not "CAD 96.75".
 *
 * Two dead ends got us here. A symbol table was wrong on both counts a glyph is meant to
 * help with: ¥ served CNY and JPY, whose magnitudes differ by two orders of magnitude, and
 * the audience's real currencies (§10) collapse into a row of near-identical dollars —
 * CA$ A$ NZ$ S$ HK$ NT$ — which is exactly the distinction a glance has to make. Falling
 * back to the ISO code fixed the ambiguity and read like a bank statement.
 *
 * The universal money cue is the decimal itself: "96.75" and "12.00" are unmistakably
 * money in every locale, need no lookup, and can't be the wrong currency. So the fraction
 * is always shown to the currency's full precision — that trailing ".00" is doing the
 * work a symbol was there for. Zero-decimal currencies (JPY, KRW) have no fraction to
 * show, which is fine: nobody reads "2500" next to 待收 as anything but money.
 *
 * Where the currency could actually be ambiguous — a player who belongs to clubs in two
 * countries — the code is stated once as context beside the total, not repeated on every
 * figure. `currencyLabel` is for exactly that, and there is one per screen.
 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** "2026-09-14T19:00" -> { y, m, d, hh, mm }. No Date, no timezone. */
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''))
  if (!m) return null
  return {
    y: +m[1],
    m: +m[2],
    d: +m[3],
    hh: +m[4],
    mm: +m[5],
  }
}

/** Weekday from a wall-clock date, via UTC so no local offset creeps in. */
function weekdayIndex(p) {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
}

/** zh: "9月14日 周四 19:00-21:00"  ·  en: "Thu 14 Sep 19:00-21:00" */
function eventTime(startLocal, endLocal) {
  const s = parseLocal(startLocal)
  if (!s) return ''
  const e = parseLocal(endLocal)
  const clock = `${pad(s.hh)}:${pad(s.mm)}` + (e ? `-${pad(e.hh)}:${pad(e.mm)}` : '')

  if (i18n.get() === 'zh') {
    return `${s.m}月${s.d}日 周${WEEKDAY_ZH[weekdayIndex(s)]} ${clock}`
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${WEEKDAY_EN[weekdayIndex(s)]} ${s.d} ${MONTHS[s.m - 1]} ${clock}`
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Calendar-block parts for a list card: month, day, weekday. */
function dateParts(local) {
  const p = parseLocal(local)
  if (!p) return { month: '', day: '', weekday: '' }
  const wd = weekdayIndex(p)
  return i18n.get() === 'zh'
    ? { month: `${p.m}月`, day: String(p.d), weekday: `周${WEEKDAY_ZH[wd]}` }
    : { month: MONTHS_EN[p.m - 1], day: String(p.d), weekday: WEEKDAY_EN[wd] }
}

/** "19:00-21:00" — clock only, since the date is shown separately. */
function timeRange(startLocal, endLocal) {
  const s = parseLocal(startLocal)
  if (!s) return ''
  const e = parseLocal(endLocal)
  return `${pad(s.hh)}:${pad(s.mm)}` + (e ? `-${pad(e.hh)}:${pad(e.mm)}` : '')
}

/** Short form for deadlines. */
function shortLocal(local) {
  const p = parseLocal(local)
  if (!p) return ''
  const clock = `${pad(p.hh)}:${pad(p.mm)}`
  return i18n.get() === 'zh'
    ? `${p.m}月${p.d}日 ${clock}`
    : `${p.d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1]} ${clock}`
}

/** Coarse countdown from a UTC timestamp — relative, so no timezone needed. */
function relative(ts, now = Date.now()) {
  const diff = ts - now
  const zh = i18n.get() === 'zh'
  if (diff <= 0) return zh ? '已过' : 'passed'

  const mins = Math.floor(diff / 60000)
  if (mins < 60) return zh ? `${mins} 分钟后` : `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return zh ? `${hours} 小时后` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  return zh ? `${days} 天后` : `in ${days}d`
}

function decimals(currency) {
  return ZERO_DECIMAL[currency] ? 0 : 2
}

/**
 * 2500, 'CAD' -> "25.00"   ·   2550, 'CAD' -> "25.50"   ·   2500, 'JPY' -> "2500"
 *
 * Always to the currency's full precision, including a whole amount's ".00". Dropping it
 * saved two characters and cost the two things it was there for: a ledger column that
 * lines up, and the decimal that tells a reader this is money at all.
 */
function money(minor, currency = 'CNY') {
  const n = Number(minor) || 0
  if (decimals(currency) === 0) return String(Math.round(n))
  return (n / 100).toFixed(2)
}

/**
 * The currency, for stating once beside a total. §10.3
 *
 * The ISO code rather than a symbol, for the reasons above — and shown once per screen,
 * so it is context rather than noise on every figure.
 */
function currencyLabel(currency) {
  return String(currency || '').toUpperCase()
}

/**
 * "25" / "25.5" / "¥25" -> minor units for the given currency.
 *
 * Rounds to the smallest unit the currency has, so a court fee of 96.756 becomes 9676
 * rather than carrying a third decimal the money can't represent.
 */
function toMinor(input, currency = 'CNY') {
  const n = parseFloat(String(input).replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n)) return 0
  return decimals(currency) === 0 ? Math.round(n) : Math.round(n * 100)
}

/**
 * Minor units back to the plain string an editable money field should show. §10.3
 *
 * The inverse of toMinor, and deliberately not `minor / 100`: JPY and KRW have no
 * fractional part, so dividing would show ¥2500 as "0.25". Four screens had each
 * hand-rolled that division and all four were wrong for those currencies — exactly the
 * bug that storing integer minor units is supposed to make impossible.
 *
 * Empty for zero, so an unset total leaves the box empty rather than showing "0".
 */
function toMajorInput(minor, currency = 'CNY') {
  const n = Number(minor) || 0
  if (!n) return ''
  return decimals(currency) === 0 ? String(Math.round(n)) : String(n / 100)
}

// --- create-form plumbing --------------------------------------------------

/** Device-local now, as the wall-clock parts the pickers use. */
function nowParts() {
  const d = new Date()
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/**
 * Build both representations from picker values.
 *
 * The organizer is virtually always in the venue's timezone, so interpreting the
 * picker in device-local time is right; the wall-clock string then pins what they
 * meant so it reads identically to a member who happens to be travelling.
 */
function fromPickers(date, time) {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return {
    utc: new Date(y, m - 1, d, hh, mm, 0, 0).getTime(),
    local: `${date}T${time}`,
  }
}

/** Shift a wall-clock string by whole hours, for deriving end from start. */
function addHoursLocal(local, hours) {
  const p = parseLocal(local)
  if (!p) return local
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm))
  const shifted = new Date(base.getTime() + hours * 3600 * 1000)
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  )
}

function splitLocal(local) {
  const p = parseLocal(local)
  if (!p) return nowParts()
  return {
    date: `${p.y}-${pad(p.m)}-${pad(p.d)}`,
    time: `${pad(p.hh)}:${pad(p.mm)}`,
  }
}

module.exports = {
  parseLocal,
  eventTime,
  dateParts,
  timeRange,
  shortLocal,
  relative,
  money,
  currencyLabel,
  CURRENCIES,
  toMinor,
  toMajorInput,
  decimals,
  nowParts,
  fromPickers,
  addHoursLocal,
  splitLocal,
}
