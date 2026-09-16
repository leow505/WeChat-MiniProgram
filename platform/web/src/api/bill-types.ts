/**
 * Shapes returned by the bill actions.
 *
 * Split out because `bill.get` returns a genuinely different structure depending
 * on whether the caller manages the session, and conflating the two produced
 * optional fields everywhere.
 */

export interface BillRow {
  openid: string
  name: string
  avatar_url?: string
  gender?: string
  guest_count: number
  is_me: boolean
  off_roster: boolean
  /** What publishing now would charge this person. */
  preview_minor: number
  units: number
  /** What they were actually charged, once published. */
  share_minor: number
  status: '' | 'UNPAID' | 'PAID' | 'WAIVED'
  claimed_paid_at: number
  overdue: boolean
}

export interface MyShare {
  share_minor: number
  status: 'UNPAID' | 'PAID' | 'WAIVED'
  claimed_paid_at: number
  overdue: boolean
}

export interface BillView {
  event: {
    _id: string
    title: string
    start_local: string
    end_local?: string
    currency: string
    roster_count: number
    capacity: number
    status: string
    [key: string]: unknown
  }
  bill: {
    status: string
    total_minor: number
    payment_note?: string
    published_at?: number
    due_at?: number
    [key: string]: unknown
  } | null
  is_manager: boolean
  grace_hours: number
  preview: {
    per_unit_minor: number
    units: number
    remainder_minor: number
    surcharge_total: number
    allocated_minor: number
  }
  rows: BillRow[]
  my_share: MyShare | null
  totals: {
    total_minor: number
    paid_minor: number
    unpaid_minor: number
    share_count: number
    settled_count: number
  }
}
