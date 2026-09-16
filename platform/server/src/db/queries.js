/**
 * Server-side reads that are not part of the shared domain surface.
 *
 * The document store in store.js deliberately mirrors WeChat Cloud DB, because
 * the shared domain modules must run unchanged on both. These queries belong to
 * the HTTP server alone — health probes and the unauthenticated link preview — so
 * they live here instead of widening that shared surface.
 */

/** Fields the invite preview may reveal. Everything else stays server-side. */
const PREVIEW_FIELDS = [
  'title',
  'start_local',
  'start_at',
  'capacity',
  'roster_count',
  'lifecycle',
  'visibility',
]

export function createServerQueries(sql) {
  return {
    /** Readiness probe: cheap, and fails when the pool cannot reach Postgres. */
    async ping() {
      await sql`SELECT 1`
      return true
    },

    /**
     * The session behind an invite link, for the Open Graph preview only.
     *
     * Unauthenticated by necessity — a chat app fetching the URL carries no
     * session. So this returns a session only when it is PUBLIC and still live,
     * and only the fields a preview needs. A club-only session yields null and
     * the page renders neutral tags rather than leaking a private roster to
     * anyone who holds the link.
     */
    async publicEventForPreview(eventId) {
      const [row] = await sql`
        SELECT doc FROM events WHERE id = ${String(eventId)}
      `
      if (!row) return null
      const doc = row.doc
      if (doc.visibility !== 'PUBLIC') return null
      if (doc.lifecycle !== 'ACTIVE') return null

      const preview = {}
      for (const field of PREVIEW_FIELDS) {
        if (doc[field] !== undefined) preview[field] = doc[field]
      }
      // The venue name helps people decide; the full address does not belong in a
      // preview that anyone holding the link can fetch.
      preview.venue_snapshot = { name: doc.venue_snapshot?.name ?? '' }
      return preview
    },
  }
}
