const config = require('./config')
const i18n = require('./utils/i18n')

App({
  globalData: {
    profile: null,
  },

  onLaunch() {
    // Resolve the locale before any page renders, so no page flashes the wrong
    // language on first paint. §10.1
    i18n.init()

    if (config.API_MODE === 'mock') {
      console.info('[badminton] mock data mode — see config.js')
      return
    }
    if (config.API_MODE === 'http') {
      console.info('[badminton] platform HTTP mode — see config.js')
      return
    }
    if (!wx.cloud) {
      console.error('[badminton] base library too old for Cloud Development')
      return
    }
    wx.cloud.init({
      env:
        config.CLOUD_ENV === 'DYNAMIC_CURRENT_ENV'
          ? wx.cloud.DYNAMIC_CURRENT_ENV
          : config.CLOUD_ENV,
      traceUser: true,
    })
  },
})
