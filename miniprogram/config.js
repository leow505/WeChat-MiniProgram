/**
 * Build configuration.
 *
 * API_MODE keeps the WeChat UI independent from its backend:
 *   mock  — local wx storage, for tourist mode
 *   cloud — the existing WeChat Cloud function
 *   http  — the platform API under platform/, shared with the web client and bots
 *
 * To use WeChat Cloud:
 *   1. put your AppID in project.config.json
 *   2. create a cloud environment in the WeChat console
 *   3. set CLOUD_ENV below (or leave DYNAMIC_CURRENT_ENV if there's only one)
 *   4. set API_MODE to 'cloud' and upload cloudfunctions/api
 *
 * To use the HTTP API, set API_MODE to 'http' and run the server in platform/
 * (see platform/README.md). HTTP_DEV_ACTOR_ID sends `Bearer dev:<id>`, which the
 * server honours only when ALLOW_DEV_AUTH is on and refuses outright in
 * production; clear it and set WECHAT_APP_ID / WECHAT_APP_SECRET so auth.js
 * exchanges wx.login() for a real session.
 */
module.exports = {
  API_MODE: 'mock',
  CLOUD_ENV: 'DYNAMIC_CURRENT_ENV',
  HTTP_BASE_URL: 'http://127.0.0.1:4174',
  PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:4174',
  HTTP_DEV_ACTOR_ID: 'mock_openid_self',
  RETENTION_DAYS: 30,
}
