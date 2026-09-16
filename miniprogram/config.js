/**
 * Build configuration.
 *
 * API_MODE keeps the WeChat UI independent from its backend:
 *   http  — the platform API under platform/, shared with the web client and bots
 *   cloud — the WeChat Cloud function in cloudfunctions/api
 *   mock  — local wx storage and seeded demo data, for tourist mode
 *
 * `http` is the default: the data belongs in a database somebody else can read, and
 * the same API already serves the browser and the bots. The mock is still here and
 * still enforces the same rules — set API_MODE to 'mock' to open the whole app in
 * DevTools with no backend at all, which is what the tests drive and how the demo
 * data is exercised.
 *
 * Running `http` in DevTools against a local server needs 不校验合法域名 ticked under
 * 详情 → 本地设置; a real deployment needs the domain on the request allowlist in the
 * WeChat console instead.
 *
 * To use WeChat Cloud:
 *   1. put your AppID in project.config.json
 *   2. create a cloud environment in the WeChat console
 *   3. set CLOUD_ENV below (or leave DYNAMIC_CURRENT_ENV if there's only one)
 *   4. set API_MODE to 'cloud' and upload cloudfunctions/api
 *
 * HTTP_DEV_ACTOR_ID sends `Bearer dev:<id>`, which the server honours only when
 * ALLOW_DEV_AUTH is on and refuses outright in production. It is how the client runs
 * against a local server before WeChat sign-in is wired up; clear it and set
 * WECHAT_APP_ID / WECHAT_APP_SECRET on the server so auth.js exchanges wx.login() for
 * a real session. Leaving it set against anything but your own machine means every
 * caller is that one account.
 */
module.exports = {
  API_MODE: 'http',
  CLOUD_ENV: 'DYNAMIC_CURRENT_ENV',
  HTTP_BASE_URL: 'http://127.0.0.1:4174',
  PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:4174',
  HTTP_DEV_ACTOR_ID: 'mock_openid_self',
  RETENTION_DAYS: 30,
}
