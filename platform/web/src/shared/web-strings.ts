/**
 * Strings for things that exist only on the web.
 *
 * The mini program's dictionary is reused for everything the two clients share.
 * These are the concepts it has no words for, because WeChat supplies them: a
 * guest account whose only credential is this browser, recovery codes, signing
 * out, and pasting a roster back into a group chat.
 *
 * They are kept here rather than added to `miniprogram/utils/i18n.js` for a
 * concrete reason: `tests/i18n.test.js` asserts that every key defined there is
 * actually rendered by a mini-program template. Adding web-only keys would fail
 * that check, and rightly so.
 */

type Dictionary = Record<string, string>

const zh: Dictionary = {
  // Sign-in
  welcomeTitle: '约球',
  welcomeBody: '填个名字就能报名，不用注册账号。',
  yourName: '你的名字',
  namePlaceholder: '球友看到的名字',
  continueAsName: '继续以 {name} 进入',
  notYou: '不是你？',
  startFresh: '换一个名字',
  enterCta: '进入',
  haveRecoveryCode: '在别的设备用过？输入恢复码',

  // Dashboard
  dashboardTitle: '我的球局',
  myGamesLabel: '已报名',
  recentlyOpened: '最近打开过',
  emptyDashboard: '还没有球局。有人分享链接给你时，从链接进入即可报名。',
  goHosting: '我组织的',
  newSession: '发起球局',

  // Account
  accountTab: '账号',
  gamesTab: '球局',
  accountGuestTitle: '访客账号尚未绑定',
  accountGuestBody:
    '资料保存在服务器，但目前只有这个浏览器能进入。清除浏览器数据或换设备后，将无法证明账号是你的。',
  accountRecoverableTitle: '此账号可以找回',
  accountRecoverableBody: '已建立恢复方式。可以生成新的恢复码，旧码会立即失效。',
  protectAccount: '保护账号',
  statusProtected: '已保护',
  statusUnprotected: '未保护',
  createRecoveryCode: '生成恢复码',
  rotateRecoveryCode: '更换恢复码',
  recoveryCodeOnce: '只显示这一次，请立即保存。换新码后旧码立刻失效。',
  copyCode: '复制恢复码',
  restoreTitle: '用恢复码找回账号',
  restoreBody: '在原设备生成的恢复码，可以把这个浏览器绑定到同一个账号。',
  recoveryPlaceholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
  restoreCta: '找回账号',
  restored: '账号已绑定到这个浏览器',
  signOutCta: '退出登录',
  signOutBody: '退出后这台设备的登录状态会失效。没有恢复码将无法再次进入。',
  revokeSessions: '退出所有设备',
  revokedSessions: '已退出 {n} 个登录',

  // Invite / roster
  copyRosterToChat: '复制名单到群',
  rosterCopied: '名单已复制，可直接粘贴到群里',
  shareLink: '分享链接',
  seatsLeftN: '还剩 {n} 位',
  noSeatsLeft: '已满员',
  inviteOnly: '凭链接报名',
  clubOnlyNotice: '这个球局只对俱乐部成员开放。',
  organizerLabel: '组织者',
  bringGuests: '带朋友',
  guestCount: '带 {n} 人',
  guestNone: '不带人',
  manageSession: '管理球局',
  viewBillCta: '查看分摊',

  // Create
  createTitle: '发起球局',
  createSub: '填好后会得到一个链接，发到群里即可报名。',
  whenLabel: '开始时间',
  durationLabel: '时长（小时）',
  venueNameLabel: '场馆名称',
  venueAddressLabel: '地址（可选）',
  costEstimateLabel: '预估人均（可选）',
  createdToast: '球局已创建',
  copyLinkNow: '复制邀请链接',

  // Manage
  manageTitle: '管理球局',
  removePlayer: '移出名单',
  removed: '已移出名单',
  promotedCount: '{n} 人已从候补进入名单',
  capacityEven: '男女配比的玩法，人数上限要是偶数',
  owingMixed: '{n} 场球的费用待结清',
  courtsLabel: '场地数量',
  courtsSaved: '场地已更新',

  // Bill
  billPublishCta: '发布分摊',
  billRepublishCta: '更新分摊',
  billTotalLabel: '实付总额',
  billNoteLabel: '备注（可选）',
  billPublished: '分摊已发布',
  markedPaid: '已标记为已付',
  waived: '已免除',
  billVoided: '分摊已作废',
  iPaidCta: '我已付款',
  claimedPaidNote: '已告知组织者，等待确认',

  // Appearance
  appearanceLabel: '外观',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',

  // Gender, spelled out: the mini program's 男/女 sit next to other context,
  // these stand alone.
  genderMale: '男生',
  genderFemale: '女生',

  // Money
  estimatedPerPerson: '预估人均',
  toCollectLabel: '待收款',
  perShareLabel: '人均',

  // Generic
  loadingText: '加载中…',
  retryCta: '重试',
  saveCta: '保存',
  backCta: '返回',
  cancelCta: '取消',
  confirmCta: '确定',
  closeCta: '关闭',
  languageLabel: '语言',
  offlineError: '网络连接失败，请重试',
  notFoundTitle: '页面不存在',
  notFoundBody: '链接可能已经失效。',
  goHome: '回到首页',
}

const en: Dictionary = {
  // Sign-in
  welcomeTitle: 'Badminton group play',
  welcomeBody: 'Add your name to join. No account to create.',
  yourName: 'Your name',
  namePlaceholder: 'The name others will see',
  continueAsName: 'Continue as {name}',
  notYou: 'Not you?',
  startFresh: 'Use a different name',
  enterCta: 'Continue',
  haveRecoveryCode: 'Used another device? Enter a recovery code',

  // Dashboard
  dashboardTitle: 'My sessions',
  myGamesLabel: 'Joined',
  recentlyOpened: 'Recently opened',
  emptyDashboard: 'No sessions yet. When somebody shares a link, open it to join.',
  goHosting: 'Hosting',
  newSession: 'New session',

  // Account
  accountTab: 'Account',
  gamesTab: 'Sessions',
  accountGuestTitle: 'Guest account, not yet protected',
  accountGuestBody:
    'Your details are stored on the server, but right now only this browser can reach them. Clear your browser data or change device and you will not be able to prove the account is yours.',
  accountRecoverableTitle: 'This account can be recovered',
  accountRecoverableBody:
    'A recovery method exists. You can issue a new code; the old one stops working immediately.',
  protectAccount: 'Protect this account',
  statusProtected: 'Protected',
  statusUnprotected: 'At risk',
  createRecoveryCode: 'Create a recovery code',
  rotateRecoveryCode: 'Replace recovery code',
  recoveryCodeOnce: 'Shown once. Save it now. Issuing a new code revokes this one.',
  copyCode: 'Copy code',
  restoreTitle: 'Recover an account',
  restoreBody: 'A recovery code from your other device links this browser to the same account.',
  recoveryPlaceholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
  restoreCta: 'Recover account',
  restored: 'Account linked to this browser',
  signOutCta: 'Sign out',
  signOutBody:
    'Signing out ends this device’s session. Without a recovery code you will not get back in.',
  revokeSessions: 'Sign out everywhere',
  revokedSessions: 'Signed out of {n} session(s)',

  // Invite / roster
  copyRosterToChat: 'Copy list for chat',
  rosterCopied: 'List copied — paste it into the group',
  shareLink: 'Share link',
  seatsLeftN: '{n} left',
  noSeatsLeft: 'Full',
  inviteOnly: 'Anyone with the link can join',
  clubOnlyNotice: 'This session is open to club members only.',
  organizerLabel: 'Organizer',
  bringGuests: 'Bringing friends',
  guestCount: '+{n} friend(s)',
  guestNone: 'Just me',
  manageSession: 'Manage session',
  viewBillCta: 'View the split',

  // Create
  createTitle: 'New session',
  createSub: 'You will get a link to post in your group chat.',
  whenLabel: 'Start time',
  durationLabel: 'Hours',
  venueNameLabel: 'Venue',
  venueAddressLabel: 'Address (optional)',
  costEstimateLabel: 'Estimated per person (optional)',
  createdToast: 'Session created',
  copyLinkNow: 'Copy invite link',

  // Manage
  manageTitle: 'Manage session',
  removePlayer: 'Remove',
  removed: 'Removed from the list',
  promotedCount: '{n} moved off the waitlist',
  capacityEven: 'A gender-balanced format needs an even capacity',
  owingMixed: '{n} session(s) unpaid',
  courtsLabel: 'Courts',
  courtsSaved: 'Courts updated',

  // Bill
  billPublishCta: 'Publish the split',
  billRepublishCta: 'Update the split',
  billTotalLabel: 'Amount paid',
  billNoteLabel: 'Note (optional)',
  billPublished: 'Split published',
  markedPaid: 'Marked as paid',
  waived: 'Waived',
  billVoided: 'Split voided',
  iPaidCta: 'I have paid',
  claimedPaidNote: 'The organizer has been told; awaiting confirmation',

  // Appearance
  appearanceLabel: 'Appearance',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',

  // Gender, spelled out: the mini program's terse M/F sit beside other context,
  // these stand alone.
  genderMale: 'Male',
  genderFemale: 'Female',

  // Money
  estimatedPerPerson: 'Est. per person',
  toCollectLabel: 'To collect',
  perShareLabel: 'Per person',

  // Generic
  loadingText: 'Loading…',
  retryCta: 'Try again',
  saveCta: 'Save',
  backCta: 'Back',
  cancelCta: 'Cancel',
  confirmCta: 'Confirm',
  closeCta: 'Close',
  languageLabel: 'Language',
  offlineError: 'Could not reach the server. Try again.',
  notFoundTitle: 'Page not found',
  notFoundBody: 'This link may have expired.',
  goHome: 'Go to the start',
}

export const webStrings: Record<string, Dictionary> = { zh, en }

/** Fill `{name}` style placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match
  )
}
