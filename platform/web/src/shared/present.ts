/**
 * Presentation helpers.
 *
 * The mini program precomputes every display string because WXML cannot call
 * functions. Vue can, but the same decoration logic is useful here and keeping it
 * in one module means the two clients describe a session the same way.
 *
 * Everything that renders a time renders it from the wall-clock string, never
 * from the timestamp: 7pm must read as 7pm for everybody (DESIGN.md §10.2).
 */

import fmt from '@shared/format'
import rules from '@shared/rules'

import type { EventCard, EventDetail, EventStatus, Person } from '@/api/types'

/** "2026-09-19T19:00" -> { day: "19", month: "9月" } for a date chip. */
export function dateChip(startLocal: string): { day: string; month: string } {
  const [date] = String(startLocal ?? '').split('T')
  const parts = (date ?? '').split('-')
  return { day: parts[2] ?? '', month: parts[1] ? `${Number(parts[1])}月` : '' }
}

/** "2026-09-19 19:00 – 21:00" */
export function whenText(startLocal: string, endLocal?: string): string {
  if (!startLocal) return ''
  const [date, time] = startLocal.split('T')
  const end = endLocal ? endLocal.split('T')[1] : ''
  return end ? `${date} ${time} – ${end}` : `${date} ${time}`
}

/**
 * The name of a play format, from the shared dictionary.
 *
 * The format table itself carries only mechanics (players per court, whether the
 * roster is gender-balanced); the wording lives in i18n under `fmt<KEY>`, so both
 * clients name a format identically.
 */
export function formatLabel(template: string | undefined, dict: Record<string, string>): string {
  if (!template) return ''
  return dict[`fmt${template}`] ?? template
}

/**
 * The status label, taken from the shared dictionary so both clients agree.
 * Keys are `statusOPEN`, `statusFULL_CLOSED` and so on.
 */
export function statusLabel(status: EventStatus, dict: Record<string, string>): string {
  return dict[`status${status}`] ?? status
}

export type Tone = 'good' | 'warn' | 'quiet' | 'plain'

/** How a session's state should look: seated is reassuring, full is a warning. */
export function statusTone(event: EventCard): Tone {
  if (event.my_state === 'ROSTER') return 'good'
  if (event.my_state === 'WAITLIST') return 'warn'
  if (event.status === 'CANCELLED' || event.status === 'COMPLETED') return 'quiet'
  if (event.status === 'OPEN') return 'plain'
  return 'quiet'
}

/** Seats remaining, or 0 once full. Never negative. */
export function seatsLeft(event: EventCard): number {
  return Math.max(0, (event.capacity ?? 0) - (event.roster_count ?? 0))
}

export function fillPercent(event: EventCard): number {
  if (!event.capacity) return 0
  return Math.min(100, Math.round((event.roster_count / event.capacity) * 100))
}

export function money(minor: number, currency?: string): string {
  return fmt.money(minor, currency)
}

/**
 * The headline "what one person pays" above a split, in minor units.
 *
 * A court fee rarely divides evenly in whole cents, so the exact split hands the
 * odd change to the earliest signups and everybody else pays one less — that is
 * what keeps Σ shares === total (§9.2). The headline shows the higher of the two,
 * matching the mini program: one figure nobody is asked to beat, rather than a
 * range that gives a single cent the weight of the amount itself.
 *
 * The division itself is `rules.splitEvenly`, not a second implementation. Only the
 * guest surcharge is peeled off here, because this figure is wanted for a total the
 * organizer is still typing; the authoritative split is computed server-side when
 * the bill is published. A surcharge larger than the whole total means the total
 * does not include it, and it is ignored rather than billed out — the same fallback
 * `computeShares` makes.
 */
export function perPersonMinor(totalMinor: number, units: number, surchargeTotal = 0): number {
  if (!(units > 0)) return 0
  const total = Math.max(0, Math.round(totalMinor))
  const surcharge = surchargeTotal > total ? 0 : Math.max(0, Math.round(surchargeTotal))
  const { base, remainder } = rules.splitEvenly(total - surcharge, units)
  return base + (remainder ? 1 : 0)
}

/** The initial shown in an avatar circle. */
export function initial(name: string): string {
  const trimmed = String(name ?? '').trim()
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?'
}

/**
 * The roster as the plain-text list group chats already use, so an organizer can
 * paste a snapshot back into the chat for anybody who will not tap a link.
 *
 * Mirrors the convention those groups settled on by themselves: a numbered list,
 * guests as "+1", the waitlist below a divider.
 */
export function rosterAsText(event: EventDetail, dict: Record<string, string>): string {
  const lines: string[] = []
  lines.push(event.title)
  lines.push(whenText(event.start_local, event.end_local))
  if (event.venue_snapshot?.name) lines.push(event.venue_snapshot.name)
  lines.push('')

  const label = (person: Person) =>
    person.guest_count ? `${person.name} +${person.guest_count}` : person.name

  event.roster.forEach((person, index) => {
    lines.push(`${index + 1}. ${label(person)}`)
  })

  // Show the empty seats as numbered blanks: that is what makes a pasted list
  // legible at a glance, and it is how these lists are written by hand.
  const remaining = seatsLeft(event)
  for (let i = 0; i < remaining; i += 1) {
    lines.push(`${event.roster.length + i + 1}.`)
  }

  if (event.waitlist.length) {
    lines.push('')
    lines.push(`${dict.waitlist ?? 'Waitlist'}:`)
    event.waitlist.forEach((person, index) => {
      lines.push(`${index + 1}. ${label(person)}`)
    })
  }

  return lines.join('\n')
}

/** Client-side advisory checks. The server re-checks everything (DESIGN.md §5). */
export const advisory = {
  canJoin(event: EventDetail): boolean {
    return rules.isJoinable(event) && event.my_state !== 'ROSTER' && event.my_state !== 'WAITLIST'
  },
  joinGoesToWaitlist(event: EventDetail): boolean {
    return rules.totalSeatsLeft(event) <= 0 || event.status === 'WAITLIST_ONLY'
  },
}
