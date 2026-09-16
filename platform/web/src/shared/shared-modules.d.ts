/**
 * Types for the shared mini-program modules.
 *
 * These describe files in `miniprogram/utils/`, loaded as-is by the Vite plugin
 * in vite.config.ts. That plugin exposes each CommonJS module as a default
 * export, so these declarations do the same.
 *
 * Only the members the web client actually uses are declared. A narrow surface
 * that has been checked against the real exports is more useful than a broad one
 * that guesses.
 */

declare module '@shared/rules' {
  export type Gender = 'MALE' | 'FEMALE' | 'UNSPECIFIED'

  export type EventStatus =
    | 'DRAFT'
    | 'SCHEDULED'
    | 'OPEN'
    | 'WAITLIST_ONLY'
    | 'FULL_CLOSED'
    | 'SIGNUP_CLOSED'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLED'

  export interface EventLike {
    capacity: number
    roster_count: number
    waitlist_count?: number
    roster_mode?: string
    capacity_by_gender?: { male: number; female: number } | null
    roster_by_gender?: { male: number; female: number }
    start_at: number
    end_at: number
    lifecycle?: string
    [key: string]: unknown
  }

  interface Rules {
    HOUR: number
    Status: Record<string, EventStatus>
    Gender: Record<'MALE' | 'FEMALE' | 'UNSPECIFIED', Gender>
    BillStatus: Record<string, string>
    ShareStatus: Record<string, string>

    statusOf(event: EventLike, now?: number): EventStatus
    isJoinable(event: EventLike, now?: number): boolean
    canWithdraw(event: EventLike, now?: number): boolean
    isLateWithdrawal(event: EventLike, now?: number): boolean
    isBalanced(event: EventLike): boolean
    isRosterFull(event: EventLike): boolean
    totalSeatsLeft(event: EventLike): number
    seatsLeft(event: EventLike, gender?: Gender): number
    seatsFor(guests: unknown[]): number
    joinDeadlineAt(event: EventLike): number
    withdrawDeadlineAt(event: EventLike): number
    /** Even split of minor units: `{ base, remainder, units }`. */
    splitEvenly(
      totalMinor: number,
      units: number
    ): {
      base: number
      remainder: number
      units: number
    }
    /** The `base` of an even split — what each head sees before the remainder. */
    perPersonPreview(totalMinor: number, seatsTaken: number): number
    planCapacityBump(
      event: EventLike,
      rosterSignups: unknown[],
      nextCapacity: number,
      nextByGender?: { male: number; female: number } | null
    ): { kept: unknown[]; bumped: unknown[]; [key: string]: unknown }
  }

  const rules: Rules
  export default rules
}

declare module '@shared/formats' {
  export interface FormatSpec {
    /** Players per court for this format. */
    per_court: number
    mode: 'OPEN' | 'GENDER_BALANCED'
    /** Only present when mode is GENDER_BALANCED. */
    ratio?: { male: number; female: number }
  }

  const formats: {
    FORMATS: Record<string, FormatSpec>
    /** Display order for the picker: most common first. */
    ORDER: string[]
    spec(key: string): FormatSpec
    /** Capacity implied by a format across N courts, with the gender split. */
    capacityFor(
      key: string,
      courtCount: number
    ): { capacity: number; by_gender: { male: number; female: number } | null }
    isBalanced(key: string): boolean
  }
  export default formats
}

declare module '@shared/naming' {
  const naming: {
    Role: Record<string, string>
    MemberStatus: Record<string, string>
    JoinPolicy: Record<string, string>
    MembershipPolicy: Record<string, string>
    isActiveMember(member: unknown): boolean
    canAdminClub(member: unknown): boolean
    displayName(user: unknown, membership?: unknown): string
    generateInviteCode(): string
  }
  export default naming
}

declare module '@shared/i18n' {
  const i18n: {
    /** The full label dictionary for the active locale. */
    pack(): Record<string, string>
    t(key: string, fallback?: string): string
    get(): string
    set(locale: string): string
    init(): string
    errText(error: { code?: string } | null | undefined): string
    locales: string[]
  }
  export default i18n
}

declare module '@shared/format' {
  const format: {
    /** Renders minor units, always showing the fraction the currency has. */
    money(minor: number, currency?: string): string
    /** Minor units back into an input. Never use minor/100 — JPY has no decimals. */
    toMajorInput(minor: number, currency?: string): string
    toMinor(input: string | number, currency?: string): number
    decimals(currency?: string): number
    currencyLabel(currency: string): string
    eventTime(startLocal: string, endLocal?: string): string
    timeRange(startLocal: string, endLocal: string): string
    shortLocal(local: string): string
    relative(timestamp: number, now?: number): string
    dateParts(local: string): { date: string; time: string }
    splitLocal(local: string): { date: string; time: string }
    addHoursLocal(local: string, hours: number): string
    CURRENCIES: string[]
  }
  export default format
}
