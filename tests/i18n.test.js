/**
 * Checks that every label a template asks for actually exists, in both locales.
 *
 * A missing key renders as the raw key name ("tabGames") in the UI, which is the
 * kind of thing that ships unnoticed. Run with `node tests/i18n.test.js`.
 */
const fs = require('fs')
const path = require('path')

// i18n.js touches wx.* at module scope for locale detection; stub it.
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  getAppBaseInfo: () => ({ language: 'zh_CN' }),
  setTabBarItem: () => {},
}

const ROOT = path.join(__dirname, '..')
const i18n = require(path.join(ROOT, 'miniprogram/utils/i18n.js'))
const formats = require(path.join(ROOT, 'miniprogram/utils/formats.js'))

let pass = 0
let fail = 0
const bad = (msg) => {
  fail++
  console.log('  FAIL ' + msg)
}
const ok = () => pass++

function walk(dir, ext, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, ext, out)
    else if (e.name.endsWith(ext)) out.push(p)
  })
  return out
}

// --- zh / en key parity ----------------------------------------------------
i18n.set('zh')
const zhKeys = Object.keys(i18n.pack())
i18n.set('en')
const enKeys = Object.keys(i18n.pack())

const missingEn = zhKeys.filter((k) => enKeys.indexOf(k) === -1)
const missingZh = enKeys.filter((k) => zhKeys.indexOf(k) === -1)
missingEn.length ? bad(`keys present in zh but not en: ${missingEn.join(', ')}`) : ok()
missingZh.length ? bad(`keys present in en but not zh: ${missingZh.join(', ')}`) : ok()

const has = (k) => zhKeys.indexOf(k) !== -1 && enKeys.indexOf(k) !== -1

// --- keys referenced from templates ----------------------------------------
const wxmls = walk(path.join(ROOT, 'miniprogram/pages'), '.wxml', [])
const usedInWxml = {}
wxmls.forEach((file) => {
  const src = fs.readFileSync(file, 'utf8')
  const re = /\bt\.([A-Za-z_][A-Za-z0-9_]*)/g
  let m
  while ((m = re.exec(src))) {
    usedInWxml[m[1]] = usedInWxml[m[1]] || []
    usedInWxml[m[1]].push(path.relative(ROOT, file))
  }
  // t['prefix' + x] families are checked separately below.
})

Object.keys(usedInWxml).forEach((k) => {
  if (!has(k)) bad(`template key missing from dictionaries: t.${k} (${usedInWxml[k][0]})`)
  else ok()
})

// --- keys referenced from page scripts -------------------------------------
const jss = walk(path.join(ROOT, 'miniprogram/pages'), '.js', [])
const usedInJs = {}
jss.forEach((file) => {
  const src = fs.readFileSync(file, 'utf8')
  // i18n.t('key', ...) and t.key / this.data.t.key
  let m
  const reCall = /i18n\.t\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g
  while ((m = reCall.exec(src))) {
    usedInJs[m[1]] = path.relative(ROOT, file)
  }
  const reDot = /\bt\.([A-Za-z_][A-Za-z0-9_]*)/g
  while ((m = reDot.exec(src))) {
    usedInJs[m[1]] = path.relative(ROOT, file)
  }
})

Object.keys(usedInJs).forEach((k) => {
  if (!has(k)) bad(`script key missing from dictionaries: t.${k} (${usedInJs[k]})`)
  else ok()
})

// --- dynamic key families --------------------------------------------------
// Built as `t['prefix' + value]`, so every enum value needs a label.
const FAMILIES = [
  ['status', ['DRAFT', 'CANCELLED', 'COMPLETED', 'IN_PROGRESS', 'SCHEDULED', 'SIGNUP_CLOSED', 'FULL_CLOSED', 'WAITLIST_ONLY', 'OPEN']],
  ['fmt', Object.keys(formats.FORMATS)],
  ['role', ['OWNER', 'ADMIN', 'MEMBER']],
  ['jp', ['OPEN', 'APPROVAL']],
  ['mp', ['NOT_REQUIRED', 'REQUESTED', 'REQUIRED']],
  ['cs', ['NOT_BOOKED', 'PENDING', 'CONFIRMED']],
  ['lv', ['ANY', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED']],
  // Bill and share states, §9.1 — looked up as t['bl' + status] / t['ss' + status].
  ['bl', ['DRAFT', 'PUBLISHED', 'SETTLED', 'VOID']],
  ['ss', ['UNPAID', 'PAID', 'WAIVED']],
  // What is waiting on an organizer — t['ha' + kind] on the Me tab.
  ['ha', ['NEEDS_SPLIT', 'COLLECTING']],
]
FAMILIES.forEach(([prefix, values]) => {
  values.forEach((v) => {
    if (!has(prefix + v)) bad(`dynamic key missing: t.${prefix}${v}`)
    else ok()
  })
})

// Gender labels are looked up as t[gender.toLowerCase()].
;['male', 'female', 'unspecified'].forEach((k) => {
  if (!has(k)) bad(`gender key missing: t.${k}`)
  else ok()
})

/*
 * --- the reverse check: a key defined but never rendered --------------------
 *
 * `minPlayersHint`, `guestsHint`, `costHint` and `courtHint` all existed, all read
 * well, and none of them ever reached the screen — which is a large part of why the
 * create form was hard to follow. A dictionary is where you go to write UI copy, so
 * stale entries in it actively mislead.
 *
 * The match is deliberately permissive — `t.key` or the quoted name anywhere in a page
 * script or template — so a dynamic lookup like `i18n.t(cond ? 'a' : 'b')` still counts
 * as a reference. Anything this doesn't find really is unreachable.
 */
const dictSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/i18n.js'), 'utf8')
const zhBlock = dictSrc.slice(dictSrc.indexOf('const zh = {'), dictSrc.indexOf('const en = {'))
const definedKeys = Array.from(
  new Set((zhBlock.match(/^ {2}[A-Za-z_][A-Za-z0-9_]*:/gm) || []).map((m) => m.trim().slice(0, -1)))
)

// Everything that can render a label: pages, the shared card template, the tab bar,
// and utils/ — present.js and todo.js precompute display strings, so they hold real
// references that a pages-only scan would report as dead.
const pageSrc = walk(path.join(ROOT, 'miniprogram/pages'), '.wxml', [])
  .concat(walk(path.join(ROOT, 'miniprogram/pages'), '.js', []))
  .concat(walk(path.join(ROOT, 'miniprogram/templates'), '.wxml', []))
  .concat(walk(path.join(ROOT, 'miniprogram/utils'), '.js', []).filter((f) => !f.endsWith('i18n.js')))
  .concat([path.join(ROOT, 'miniprogram/custom-tab-bar/index.js')])
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n')

// Members of a t['prefix' + enumValue] family are covered by FAMILIES above.
const FAMILY_PREFIXES = FAMILIES.map(([p]) => p)
const GENDER_KEYS = ['male', 'female', 'unspecified']

const unrendered = definedKeys.filter((k) => {
  if (GENDER_KEYS.indexOf(k) !== -1) return false
  if (FAMILY_PREFIXES.some((p) => k.indexOf(p) === 0 && k.length > p.length)) return false
  return !new RegExp(`\\bt\\.${k}\\b|['"]${k}['"]`).test(pageSrc)
})
unrendered.length
  ? bad(`keys defined but never rendered: ${unrendered.join(', ')}`)
  : ok()

// --- every error code the backends can throw needs text --------------------
const backendFiles = walk(path.join(ROOT, 'cloudfunctions/api/lib'), '.js', []).concat([
  path.join(ROOT, 'miniprogram/utils/mock.js'),
  path.join(ROOT, 'cloudfunctions/api/index.js'),
])
const codes = {}
backendFiles.forEach((file) => {
  const src = fs.readFileSync(file, 'utf8')
  const re = /fail\(\s*'([A-Z_]+)'/g
  let m
  while ((m = re.exec(src))) codes[m[1]] = path.relative(ROOT, file)
  const re2 = /code:\s*'([A-Z_]+)'/g
  while ((m = re2.exec(src))) codes[m[1]] = path.relative(ROOT, file)
})

// errText falls back to DEFAULT, so an unmapped code is a bad message, not a crash.
const unmapped = []
Object.keys(codes).forEach((code) => {
  i18n.set('zh')
  const zhText = i18n.errText({ code })
  i18n.set('en')
  const enText = i18n.errText({ code })
  const zhDefault = (function () {
    i18n.set('zh')
    return i18n.errText({ code: '__nope__' })
  })()
  const enDefault = (function () {
    i18n.set('en')
    return i18n.errText({ code: '__nope__' })
  })()
  if (zhText === zhDefault || enText === enDefault) unmapped.push(code)
  else ok()
})
if (unmapped.length) bad(`error codes with no localized text: ${unmapped.join(', ')}`)

i18n.set('zh')
console.log(`\n${pass} checks passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
