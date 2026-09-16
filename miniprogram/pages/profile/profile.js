const api = require('../../utils/api')
const i18n = require('../../utils/i18n')

Page({
  data: {
    t: {},
    locale: 'zh',
    localeOptions: [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
    ],
    genderOptions: [],
    profile: {},
    memberships: [],
  },

  onShow() {
    this.refreshStrings()
    this.load()
  },

  refreshStrings() {
    const t = i18n.pack()
    wx.setNavigationBarTitle({ title: t.editProfile })
    this.setData({
      t,
      locale: i18n.get(),
      genderOptions: [
        { value: 'MALE', label: t.male },
        { value: 'FEMALE', label: t.female },
        { value: 'UNSPECIFIED', label: t.unspecified },
      ],
    })
  },

  load() {
    return Promise.all([api.call('profile.get'), api.call('venue.myMemberships')])
      .then(([profile, m]) => {
        this.setData({
          profile,
          memberships: m.memberships.map((row) =>
            Object.assign({}, row, {
              venue_name: (m.venues[row.venue_id] || {}).name || '',
            })
          ),
        })
      })
      .catch(() => {})
  },

  /**
   * `chooseAvatar` returns a local temp path. The mock keeps it as-is; against
   * cloud it needs wx.cloud.uploadFile first, since the temp path dies with the
   * session.
   */
  onChooseAvatar(e) {
    api
      .call('profile.upsert', { avatar_url: e.detail.avatarUrl })
      .then((profile) => this.setData({ profile }))
      .catch(() => {})
  },

  onNickname(e) {
    const nickname = (e.detail.value || '').trim()
    if (!nickname || nickname === this.data.profile.nickname) return
    api
      .call('profile.upsert', { nickname })
      .then((profile) => this.setData({ profile }))
      .catch(() => {})
  },

  onGender(e) {
    const gender = e.currentTarget.dataset.value
    if (gender === this.data.profile.gender) return
    api
      .call('profile.upsert', { gender })
      .then((profile) => this.setData({ profile }))
      .catch(() => {})
  },

  onLocale(e) {
    const next = e.currentTarget.dataset.value
    if (next === i18n.get()) return
    i18n.set(next)
    this.refreshStrings()
  },
})
