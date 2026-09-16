const rules = require('./rules')
const { db, getOrNull } = require('./db')

const GENDERS = [rules.Gender.MALE, rules.Gender.FEMALE, rules.Gender.UNSPECIFIED]

async function get(_payload, openid) {
  const u = await getOrNull('users', openid)
  if (u) return Object.assign({}, u, { needs_setup: !u.nickname })

  // First call for this openid — create the row so later writes are plain updates.
  const now = Date.now()
  const doc = {
    _id: openid,
    nickname: '',
    avatar_url: '',
    gender: rules.Gender.UNSPECIFIED,
    locale: '',
    events_played: 0,
    no_shows: 0,
    late_withdrawals: 0,
    total_paid_minor: 0,
    created_at: now,
    updated_at: now,
  }
  await db.collection('users').doc(openid).set({ data: doc })
  return Object.assign({}, doc, { needs_setup: true })
}

async function upsert(patch, openid) {
  await get({}, openid) // ensure the row exists

  const data = { updated_at: Date.now() }
  if (patch.nickname !== undefined) data.nickname = String(patch.nickname).slice(0, 32)
  if (patch.avatar_url !== undefined) data.avatar_url = String(patch.avatar_url)
  if (patch.gender !== undefined && GENDERS.indexOf(patch.gender) !== -1) {
    data.gender = patch.gender
  }
  if (patch.locale !== undefined) data.locale = String(patch.locale).slice(0, 8)

  await db.collection('users').doc(openid).update({ data })

  const u = await getOrNull('users', openid)
  return Object.assign({}, u, { needs_setup: !u.nickname })
}

module.exports = { get, upsert }
