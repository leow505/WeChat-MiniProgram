const config = require('../config')

const TOKEN_KEY = 'platform_api_token_v1'

function request(url, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: 'POST',
      data,
      header: { 'content-type': 'application/json' },
      success(res) {
        const body = res.data || {}
        if (res.statusCode >= 200 && res.statusCode < 300 && body.ok && body.token) {
          resolve(body.token)
          return
        }
        const err = new Error(body.code || 'AUTH_FAILED')
        err.code = body.code || 'AUTH_FAILED'
        reject(err)
      },
      fail(err) {
        err.code = err.code || 'NETWORK'
        reject(err)
      },
    })
  })
}

function loginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res.code) resolve(res.code)
        else reject(Object.assign(new Error('NO_LOGIN_CODE'), { code: 'NO_LOGIN_CODE' }))
      },
      fail(err) {
        err.code = err.code || 'AUTH_FAILED'
        reject(err)
      },
    })
  })
}

function getToken() {
  if (config.HTTP_DEV_ACTOR_ID) {
    return Promise.resolve(`dev:${config.HTTP_DEV_ACTOR_ID}`)
  }

  const cached = wx.getStorageSync(TOKEN_KEY)
  if (cached) return Promise.resolve(cached)

  return loginCode()
    .then((code) => request(`${config.HTTP_BASE_URL}/v1/auth/wechat`, { code }))
    .then((token) => {
      wx.setStorageSync(TOKEN_KEY, token)
      return token
    })
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY)
}

module.exports = { getToken, clearToken }
