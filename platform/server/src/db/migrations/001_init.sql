-- Domain collections and identity tables. See platform/README.md for the
-- identity contract and platform/server/src/db/store.js for how the domain
-- collections are addressed.
--
-- Two storage styles on purpose:
--
--   * Domain collections are `id` + `doc jsonb`. The same domain logic runs on
--     WeChat Cloud DB (a document store) and here; keeping documents intact is
--     what lets one implementation serve both. Indexes are declared for the
--     fields the code actually filters on.
--
--   * Identity tables are ordinary columns, because they need real constraints:
--     one provider identity maps to at most one account, sessions must be
--     revocable, recovery secrets must be unique.

-- ---------------------------------------------------------------------------
-- Domain collections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- events are filtered by lifecycle + end_at + club_id, and ordered by start_at.
CREATE INDEX IF NOT EXISTS events_doc_gin ON events USING gin (doc jsonb_path_ops);
CREATE INDEX IF NOT EXISTS events_club_id ON events ((doc ->> 'club_id'));
CREATE INDEX IF NOT EXISTS events_creator ON events ((doc ->> 'creator_openid'));
CREATE INDEX IF NOT EXISTS events_end_at ON events (((doc ->> 'end_at')::numeric));

CREATE TABLE IF NOT EXISTS signups (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- signups are filtered by event_id, by openid, and by state.
CREATE INDEX IF NOT EXISTS signups_doc_gin ON signups USING gin (doc jsonb_path_ops);
CREATE INDEX IF NOT EXISTS signups_event_id ON signups ((doc ->> 'event_id'));
CREATE INDEX IF NOT EXISTS signups_openid ON signups ((doc ->> 'openid'));

CREATE TABLE IF NOT EXISTS clubs (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clubs_doc_gin ON clubs USING gin (doc jsonb_path_ops);
-- Join-by-code looks a club up by its invite code.
CREATE INDEX IF NOT EXISTS clubs_invite_code ON clubs ((doc ->> 'invite_code'));

CREATE TABLE IF NOT EXISTS club_members (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS club_members_doc_gin ON club_members USING gin (doc jsonb_path_ops);
CREATE INDEX IF NOT EXISTS club_members_openid ON club_members ((doc ->> 'openid'));
CREATE INDEX IF NOT EXISTS club_members_club_id ON club_members ((doc ->> 'club_id'));

CREATE TABLE IF NOT EXISTS venues (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS venues_doc_gin ON venues USING gin (doc jsonb_path_ops);

CREATE TABLE IF NOT EXISTS venue_memberships (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS venue_memberships_doc_gin
  ON venue_memberships USING gin (doc jsonb_path_ops);
CREATE INDEX IF NOT EXISTS venue_memberships_openid
  ON venue_memberships ((doc ->> 'openid'));

CREATE TABLE IF NOT EXISTS event_bills (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_bills_doc_gin ON event_bills USING gin (doc jsonb_path_ops);

CREATE TABLE IF NOT EXISTS bill_shares (
  id text PRIMARY KEY,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bill_shares_doc_gin ON bill_shares USING gin (doc jsonb_path_ops);
CREATE INDEX IF NOT EXISTS bill_shares_event_id ON bill_shares ((doc ->> 'event_id'));
CREATE INDEX IF NOT EXISTS bill_shares_openid ON bill_shares ((doc ->> 'openid'));

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- One row per person. `id` is the canonical actor id the domain tables key on
-- (currently under the legacy name `openid`; see platform/README.md).
CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- An external credential resolving to an account: a browser device, a verified
-- WeChat openid, a LINE subject, a hashed recovery code. A given
-- (provider, subject) belongs to at most one account — enforced here, not in code.
CREATE TABLE IF NOT EXISTS provider_identities (
  id bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (provider, subject)
);

CREATE INDEX IF NOT EXISTS provider_identities_account
  ON provider_identities (account_id);

-- Revocable sessions. Only a hash of the token is stored, so a database leak
-- does not hand out live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);

-- Failed-attempt log, so recovery-code guessing can be rate limited.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  fingerprint text NOT NULL,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_attempts_lookup
  ON auth_attempts (kind, fingerprint, created_at DESC);
