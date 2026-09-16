/**
 * Shapes returned by the domain actions.
 *
 * These mirror what `cloudfunctions/api/lib/` returns. They are written by hand
 * because the server is JavaScript; where a field's presence depends on the
 * caller's relationship to the session, that is marked optional here rather than
 * asserted away at the point of use.
 */

import type { EventStatus, Gender } from '@shared/rules'

export type { EventStatus, Gender }

export type SignupState = 'ROSTER' | 'WAITLIST' | 'WITHDRAWN' | 'REMOVED'

export interface VenueSnapshot {
  name: string
  address?: string
  tz_label?: string
}

export interface Person {
  openid: string
  name: string
  gender?: Gender
  guest_count?: number
  is_me?: boolean
  is_organizer?: boolean
  state?: SignupState
}

/**
 * A session as shown on a card in a list.
 *
 * The index signature is what lets these objects be passed straight to the shared
 * rule functions, which accept the whole document and read fields this client does
 * not model.
 */
export interface EventCard {
  _id: string
  title: string
  start_at: number
  end_at: number
  start_local: string
  end_local?: string
  capacity: number
  roster_count: number
  waitlist_count?: number
  status: EventStatus
  my_state: SignupState | null
  venue_snapshot?: VenueSnapshot
  currency?: string
  format_template?: string
  my_share_minor?: number
  my_share_status?: string
  [key: string]: unknown
}

/** The full session view, from `event.detail`. */
export interface EventDetail extends EventCard {
  club_id: string | null
  creator_openid: string
  organizer_name?: string
  visibility: 'PUBLIC' | 'CLUB_ONLY'
  lifecycle: 'DRAFT' | 'ACTIVE' | 'CANCELLED'
  roster: Person[]
  waitlist: Person[]
  roster_mode: string
  capacity_by_gender?: { male: number; female: number } | null
  roster_by_gender?: { male: number; female: number }
  max_guests_per_member: number
  my_guests?: { name?: string; gender?: Gender }[]
  my_allocation?: SignupState
  can_withdraw: boolean
  can_manage?: boolean
  join_deadline_local?: string
  join_deadline_at?: number | null
  join_deadline_rule?: string
  withdraw_rule?: string
  withdraw_hours_before?: number
  court_count?: number | null
  court_status?: string
  court_assignments?: { label: string; players?: string[] }[]
  courts_visible_to?: string
  cost_estimate_per_person?: number
  cost_note?: string
  min_players?: number
  on_full?: string
  waitlist_capacity?: number
  level_hint?: string
}

export interface MyEvents {
  upcoming: EventCard[]
  past: EventCard[]
  owing: {
    count: number
    mixed_currency: boolean
    total_minor: number
    currency: string
    event_id: string
  }
}

export interface HostingSummary {
  upcoming: {
    _id: string
    title: string
    start_local: string
    end_local?: string
    currency: string
    roster_count: number
    capacity: number
    court_status?: string
    status: EventStatus
  }[]
  actions: {
    _id: string
    title: string
    start_local: string
    currency: string
    need: string
    unpaid_count?: number
    unpaid_minor?: number
  }[]
  action_count: number
  to_collect: {
    count: number
    total_minor: number
    currency: string
    mixed_currency: boolean
  }
}

export interface BillShare {
  _id: string
  openid: string
  name?: string
  share_minor: number
  status: 'UNPAID' | 'PAID' | 'WAIVED'
  claimed_paid?: boolean
  seats?: number
}

export interface BillView {
  bill: {
    _id: string
    event_id: string
    status: string
    total_minor: number
    currency: string
    note?: string
    published_at?: number
    head_count?: number
  } | null
  shares: BillShare[]
  my_share?: BillShare | null
  can_manage: boolean
  event?: EventCard
  heads?: Person[]
}

export interface ClubSummary {
  _id: string
  name: string
  description?: string
  invite_code?: string
  member_count: number
  currency: string
  my_role?: string
  venue_ids?: string[]
  primary_venue_id?: string | null
}
