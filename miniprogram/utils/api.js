/**
 * Single entry point for all data access.
 *
 * Every call is `api.call('<domain>.<action>', payload)`. Both backends implement
 * the same action names, so flipping config.USE_MOCK swaps the whole data layer
 * without touching a page. The cloud path targets one router cloud function
 * (`api`) rather than a function per action — shared logic stays shared, one
 * deploy, one warm pool.
 *
 * Failures carry a stable `code`; the wording comes from i18n on this side, so the
 * backend never has to know which language the caller reads (§10.1).
 */
const config = require('../config')
const i18n = require('./i18n')
const mock = require('./mock')
const auth = require('./auth')

function httpCall(action, payload) {
  return auth.getToken().then(
    (token) =>
      new Promise((resolve, reject) => {
        wx.request({
          url: `${config.HTTP_BASE_URL}/v1/actions`,
          method: 'POST',
          data: { action, payload },
          header: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          success(res) {
            const body = res.data || {}
            if (res.statusCode >= 200 && res.statusCode < 300 && body.ok) {
              resolve(body.data)
              return
            }

            if (res.statusCode === 401) auth.clearToken()
            const err = new Error(body.code || 'DEFAULT')
            err.code = body.code || 'DEFAULT'
            reject(err)
          },
          fail(err) {
            err.code = err.code || 'NETWORK'
            reject(err)
          },
        })
      })
  )
}

function call(action, payload = {}) {
  if (config.API_MODE === 'mock') return mock.dispatch(action, payload)
  if (config.API_MODE === 'http') return httpCall(action, payload)

  return wx.cloud
    .callFunction({ name: 'api', data: { action, payload } })
    .then((res) => {
      const r = res.result || {}
      if (!r.ok) {
        const err = new Error(r.code || 'DEFAULT')
        err.code = r.code
        throw err
      }
      return r.data
    })
}

/** Surfaces a failure as a localized toast; rethrows so callers can still branch. */
function callWithToast(action, payload) {
  return call(action, payload).catch((err) => {
    wx.showToast({ title: i18n.errText(err), icon: 'none' })
    throw err
  })
}

module.exports = { call, callWithToast }
