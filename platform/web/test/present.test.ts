import { describe, expect, it } from 'vitest'

import type { EventCard, EventDetail } from '@/api/types'
import {
  dateChip,
  initial,
  perPersonMinor,
  rosterAsText,
  seatsLeft,
  statusTone,
  whenText,
} from '@/shared/present'
import { fill } from '@/shared/web-strings'

/** A minimal session, with only the fields the helper under test reads. */
function detail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    _id: 'e1',
    title: 'Saturday social',
    start_at: 0,
    end_at: 0,
    start_local: '2026-09-19T19:00',
    end_local: '2026-09-19T21:00',
    capacity: 6,
    roster_count: 3,
    status: 'OPEN',
    my_state: null,
    club_id: null,
    creator_openid: 'u_org',
    visibility: 'PUBLIC',
    lifecycle: 'ACTIVE',
    roster: [],
    waitlist: [],
    roster_mode: 'OPEN',
    max_guests_per_member: 2,
    can_withdraw: true,
    venue_snapshot: { name: 'Sports Hub' },
    ...overrides,
  } as EventDetail
}

describe('dates and times', () => {
  it('renders from the wall clock, not a timestamp', () => {
    // 7pm must read as 7pm for everybody, whatever their device timezone.
    expect(whenText('2026-09-19T19:00', '2026-09-19T21:00')).toBe('2026-09-19 19:00 – 21:00')
  })

  it('renders a start time alone when there is no end', () => {
    expect(whenText('2026-09-19T19:00')).toBe('2026-09-19 19:00')
  })

  it('is empty for a missing value rather than showing NaN', () => {
    expect(whenText('')).toBe('')
  })

  it('builds a date chip', () => {
    expect(dateChip('2026-09-19T19:00')).toEqual({ day: '19', month: '9月' })
  })
})

describe('seats', () => {
  it('counts what is left', () => {
    expect(seatsLeft(detail({ capacity: 6, roster_count: 4 }))).toBe(2)
  })

  it('never reports a negative number of seats', () => {
    // An over-filled roster is possible after a capacity reduction; "-2 left"
    // would be nonsense on screen.
    expect(seatsLeft(detail({ capacity: 4, roster_count: 6 }))).toBe(0)
  })
})

describe('tone', () => {
  it('reassures somebody who holds a seat', () => {
    expect(statusTone(detail({ my_state: 'ROSTER' }) as EventCard)).toBe('good')
  })

  it('flags a waitlisted signup, which is not the same as being in', () => {
    expect(statusTone(detail({ my_state: 'WAITLIST' }) as EventCard)).toBe('warn')
  })

  it('mutes a finished or cancelled session', () => {
    expect(statusTone(detail({ status: 'CANCELLED' }) as EventCard)).toBe('quiet')
    expect(statusTone(detail({ status: 'COMPLETED' }) as EventCard)).toBe('quiet')
  })
})

describe('initials', () => {
  it('uses the first character', () => {
    expect(initial('Wei')).toBe('W')
    expect(initial('林昊')).toBe('林')
  })

  it('falls back rather than rendering an empty circle', () => {
    expect(initial('')).toBe('?')
    expect(initial('   ')).toBe('?')
  })
})

describe('the roster as chat text', () => {
  // This is the bridge to how these groups already work: a numbered list they can
  // paste back into WhatsApp or LINE for anybody who will not tap a link.
  const dict = { waitlist: 'Waitlist' }

  it('numbers the players and leaves the empty seats numbered', () => {
    const text = rosterAsText(
      detail({
        capacity: 4,
        roster_count: 2,
        roster: [
          { openid: 'u1', name: 'Wei' },
          { openid: 'u2', name: '林昊' },
        ],
      }),
      dict
    )

    expect(text).toContain('1. Wei')
    expect(text).toContain('2. 林昊')
    // Blank slots are what make a pasted list legible at a glance.
    expect(text).toContain('3.')
    expect(text).toContain('4.')
  })

  it('leads with the details somebody needs to decide', () => {
    const text = rosterAsText(detail(), dict)
    const lines = text.split('\n')
    expect(lines[0]).toBe('Saturday social')
    expect(lines[1]).toBe('2026-09-19 19:00 – 21:00')
    expect(lines[2]).toBe('Sports Hub')
  })

  it('marks guests the way these lists already do', () => {
    const text = rosterAsText(
      detail({
        capacity: 4,
        roster_count: 3,
        roster: [{ openid: 'u1', name: 'Wei', guest_count: 2 }],
      }),
      dict
    )
    expect(text).toContain('1. Wei +2')
  })

  it('lists the waitlist separately, numbered from one', () => {
    const text = rosterAsText(
      detail({
        capacity: 1,
        roster_count: 1,
        roster: [{ openid: 'u1', name: 'Wei' }],
        waitlist: [
          { openid: 'u2', name: 'Chen' },
          { openid: 'u3', name: 'Li' },
        ],
      }),
      dict
    )
    expect(text).toContain('Waitlist:')
    expect(text.indexOf('1. Wei')).toBeLessThan(text.indexOf('Waitlist:'))
    expect(text).toMatch(/Waitlist:\n1\. Chen\n2\. Li/)
  })

  it('omits the waitlist heading when nobody is waiting', () => {
    expect(rosterAsText(detail(), dict)).not.toContain('Waitlist')
  })
})

describe('string interpolation', () => {
  it('fills named placeholders', () => {
    expect(fill('{n} left', { n: 3 })).toBe('3 left')
    expect(fill('Continue as {name}', { name: 'Wei' })).toBe('Continue as Wei')
  })

  it('leaves an unknown placeholder visible rather than printing undefined', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })
})

describe('what one person pays', () => {
  it('is the plain share when the total divides evenly', () => {
    expect(perPersonMinor(4800, 4)).toBe(1200)
  })

  it('is the higher of the two when it does not, so nobody is asked to beat it', () => {
    // 50.00 across 3: two pay 16.67, one pays 16.66, and Σ is exactly 50.00.
    expect(perPersonMinor(5000, 3)).toBe(1667)
  })

  it('divides by heads on court, not by people paying', () => {
    // Four heads, one of them a guest somebody else covers.
    expect(perPersonMinor(4000, 4)).toBe(1000)
  })

  it('peels the guest surcharge off before dividing', () => {
    // 45.00 with a 5.00 surcharge leaves 40.00 across 4.
    expect(perPersonMinor(4500, 4, 500)).toBe(1000)
  })

  it('ignores a surcharge larger than the total, which means it was never charged', () => {
    expect(perPersonMinor(1000, 4, 4000)).toBe(250)
  })

  it('is nothing when nobody is paying', () => {
    expect(perPersonMinor(5000, 0)).toBe(0)
  })
})
