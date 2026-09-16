/**
 * Server-rendered invite page shell.
 *
 * The whole point of an invite link is that it gets pasted into a group chat, and
 * WhatsApp, LINE, Telegram and iMessage all build their preview by fetching the
 * URL and reading its meta tags. They do not run JavaScript. So the session's
 * title, time, venue and remaining seats are rendered here, server-side, into
 * Open Graph tags; the Vue app then takes over for the interactive part.
 *
 * Everything interpolated goes through escapeHtml, including values that came
 * from an organizer's free-text input.
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])
}

/** "2026-09-19T19:00" -> "2026-09-19 19:00". Rendered from the wall clock, never
 * from the timestamp: 7pm must read as 7pm for everyone (DESIGN.md §10.2). */
function readableLocal(startLocal) {
  if (!startLocal) return ''
  const [date, time] = String(startLocal).split('T')
  return time ? `${date} ${time}` : date
}

function seatsPhrase(event) {
  const left = Math.max(0, (event.capacity ?? 0) - (event.roster_count ?? 0))
  if (event.lifecycle === 'CANCELLED') return '已取消 / Cancelled'
  if (left === 0) return `满员 / Full · ${event.roster_count}/${event.capacity}`
  return `还剩 ${left} 位 / ${left} seat${left === 1 ? '' : 's'} left · ${event.roster_count}/${event.capacity}`
}

/**
 * Build the preview description: when, where, and how many seats remain — the
 * three things somebody decides on before tapping.
 */
export function inviteDescription(event) {
  return [readableLocal(event.start_local), event.venue_snapshot?.name, seatsPhrase(event)]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The HTML shell for /invite/:id.
 *
 * `event` may be null when the session is missing or not visible to an anonymous
 * fetcher; the page still renders, with neutral tags, because a preview must not
 * leak the details of a club-only session.
 */
export function renderInvitePage({ event, eventId, baseUrl, assets }) {
  const title = event ? `${event.title} · 约球` : '约球 / Badminton group play'
  const description = event
    ? inviteDescription(event)
    : '打开链接查看球局详情并报名 / Open to see the session and sign up'
  const canonical = `${baseUrl.replace(/\/$/, '')}/invite/${encodeURIComponent(eventId)}`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="约球">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex">
${assets}
</head>
<body>
<div id="app"></div>
<noscript>请启用 JavaScript 查看球局详情 / Enable JavaScript to view this session.</noscript>
</body>
</html>
`
}
