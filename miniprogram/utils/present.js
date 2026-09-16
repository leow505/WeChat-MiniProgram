/**
 * Display decoration shared by every surface that renders a session card.
 *
 * WXML can't call functions, so all display strings are precomputed. Keeping this
 * in one module — paired with templates/session-card.wxml — is what stops the games
 * list, the club page, and the detail header from drifting apart.
 */
const rules = require('./rules')
const fmt = require('./format')
const i18n = require('./i18n')

/** Anything closing sooner than this reads better as a countdown than a date. */
const RELATIVE_WINDOW_HOURS = 12

/** Roster counts, phrased so a balanced format shows which side is short. §3.9 */
function countText(ev, t) {
  if (ev.roster_mode !== 'GENDER_BALANCED') {
    return `${ev.roster_count}/${ev.capacity} ${t.people}`
  }
  const cap = ev.capacity_by_gender || { male: 0, female: 0 }
  const cur = ev.roster_by_gender || { male: 0, female: 0 }
  return `${t.male} ${cur.male}/${cap.male} · ${t.female} ${cur.female}/${cap.female}`
}

/**
 * Signup deadline, phrased for how soon it is: a countdown inside 12 hours,
 * an absolute date and time beyond that. "6 小时后截止" answers "do I decide now?";
 * "9月12日 13:00 截止" answers "when do I have until?".
 *
 * Rendered from the stored wall clock, never from the timestamp (§10.2). Sessions
 * closing at start time have no deadline of their own, so they borrow start_local.
 */
function deadlineText(ev, t) {
  const at = rules.joinDeadlineAt(ev)
  if (!at) return ''

  const now = Date.now()
  if (now >= at) return t.closedAlready
  if (at - now <= RELATIVE_WINDOW_HOURS * rules.HOUR) {
    return i18n.t('closesIn', { when: fmt.relative(at, now) })
  }
  const local = ev.join_deadline_local || ev.start_local
  return i18n.t('closesAt', { when: fmt.shortLocal(local) })
}

function eventCard(ev, t) {
  const full = rules.isRosterFull(ev)
  const left = ev.total_seats_left
  const balanced = ev.roster_mode === 'GENDER_BALANCED'
  const d = fmt.dateParts(ev.start_local)

  const costText = ev.cost_estimate_per_person
    ? fmt.money(ev.cost_estimate_per_person, ev.currency) + t.perPerson
    : ''
  const mineLabel =
    ev.my_state === 'ROSTER' ? t.joined : ev.my_state === 'WAITLIST' ? t.waiting : ''

  return Object.assign({}, ev, {
    // full sentence form, used by the detail page and by "my sessions" rows
    time_text: fmt.eventTime(ev.start_local, ev.end_local),

    // calendar-block form, used by list cards
    date_month: d.month,
    date_day: d.day,
    date_weekday: d.weekday,
    time_range: fmt.timeRange(ev.start_local, ev.end_local),

    status_label: t['status' + ev.status] || ev.status,
    status_class: String(ev.status).toLowerCase().replace(/_/g, '-'),
    format_label: t['fmt' + ev.format_template] || '',

    /**
     * One badge, not two competing signals: your own state wins when you have one.
     * Colour carries meaning — green you can join, amber partly, red you can't,
     * blue is your own state. See app.wxss.
     */
    badge_text: mineLabel || t['status' + ev.status] || '',
    badge_class: mineLabel
      ? ev.my_state === 'ROSTER'
        ? 'mine'
        : 'waiting'
      : String(ev.status).toLowerCase().replace(/_/g, '-'),

    /**
     * Nothing to do here: full with no waitlist, closed, finished or cancelled, and
     * you're not on the list. The whole card dims so it reads as unavailable at a
     * glance rather than needing the badge read.
     */
    unavailable:
      !ev.my_state && ['FULL_CLOSED', 'SIGNUP_CLOSED', 'COMPLETED', 'CANCELLED'].indexOf(ev.status) !== -1,

    /**
     * The card should answer most questions without a tap. These used to be one
     * run-on grey line — venue · format · level · cost — which was dense enough
     * that nothing in it stood out. Venue leads on its own line because it's the
     * thing people filter on mentally, and the rest become chips: discrete tokens
     * the eye can land on one at a time.
     *
     * Built here as an array rather than in the template, so a session with no
     * level hint or no cost estimate simply has fewer chips instead of needing
     * conditional markup per slot.
     */
    venue_name: ev.venue_snapshot.name,
    /**
     * Clock and venue on one line. They were two, at two sizes, two greys — and they
     * answer the same question ("when and where"), so splitting them spent a whole
     * step of the type scale on a distinction the reader doesn't make.
     */
    when_where: [fmt.timeRange(ev.start_local, ev.end_local), ev.venue_snapshot.name]
      .filter(Boolean)
      .join('  ·  '),
    /**
     * Which court, for somebody holding a seat. §3.5
     *
     * "Where do I go" is the question on the way to the venue, and it used to need a
     * tap into the session to answer. Only shown to a seat holder, which is the same
     * gate the detail page uses — a waitlisted player has nowhere to go yet, and a
     * stranger scrolling a club's list has no business knowing the court.
     */
    courts_text: (function () {
      const labels = rules.courtLabelsFor(ev, ev.my_state, false)
      return labels.length ? labels.join(' · ') : ''
    })(),
    // A template only sees the data passed to it, so the label travels with the value.
    courts_label: t.courts,
    chips: [
      { key: 'fmt', label: t['fmt' + ev.format_template] || '' },
      {
        key: 'lv',
        label: ev.level_hint && ev.level_hint !== 'ANY' ? t['lv' + ev.level_hint] : '',
      },
      { key: 'cost', label: costText },
    ].filter((c) => !!c.label),

    count_text: countText(ev, t),
    cap_figure: `${ev.roster_count}/${ev.capacity}`,
    /**
     * The count leads the capacity row, because "can I get in" is the question the
     * card exists to answer. A balanced format substitutes its per-bucket reading —
     * a single fraction would hide which side is short (§3.9).
     */
    cap_lead: balanced ? countText(ev, t) : `${ev.roster_count}/${ev.capacity}`,
    /**
     * State on the capacity block rather than on its text. Tinting the whole inset
     * distinguishes "full" from "room left" by shape and colour, which reads at a
     * glance — where another font weight would just add a tenth text style to a card
     * that already had too many.
     */
    cap_state: full ? 'is-full' : '',
    // A bucket reading ("男 4/4 · 女 3/4") needs more room than a bare fraction.
    cap_wide: balanced,
    balance_text: balanced ? countText(ev, t) : '',
    meter_pct: Math.min(100, Math.round((ev.roster_count / Math.max(1, ev.capacity)) * 100)),
    is_full: full,
    seats_left_text: full ? t.full : i18n.t('short', { n: left }),

    /**
     * Who can join, spelled out. An earlier version used a coloured stripe for
     * club-only sessions and a bare club name — both needed a legend nobody has.
     * The club name says which group; the phrase after it says who may sign up.
     */
    footer_left: ev.club_name
      ? `${ev.club_name} · ${ev.visibility === 'CLUB_ONLY' ? t.accessClubOnly : t.accessPublic}`
      : t.accessPublic,
    // The footer's right slot is the deadline; capacity has its own row above.
    footer_right: deadlineText(ev, t),
    club_only: ev.visibility === 'CLUB_ONLY',

    cost_text: costText,
    mine_label: mineLabel,
  })
}

function initial(name) {
  return (name || '?').trim().charAt(0)
}

/**
 * Gender as a monochrome unicode glyph plus a tint class. Glyphs need no image
 * assets and tint like text, and ♂ / ♀ read the same in every locale.
 * Returns empty strings for UNSPECIFIED so callers can render nothing.
 */
function genderMark(gender) {
  if (gender === 'MALE') return { glyph: '♂', cls: 'male' }
  if (gender === 'FEMALE') return { glyph: '♀', cls: 'female' }
  return { glyph: '', cls: '' }
}

/** Attaches gender_glyph / gender_class to a list of people. */
function withGender(list) {
  return (list || []).map((p) => {
    const g = genderMark(p.gender)
    return Object.assign({}, p, { gender_glyph: g.glyph, gender_class: g.cls })
  })
}

module.exports = { eventCard, countText, initial, genderMark, withGender }
