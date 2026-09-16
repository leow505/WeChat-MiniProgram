/**
 * Identity: accounts, provider identities, sessions, recovery codes.
 *
 * The contract this implements is in platform/README.md; read it before
 * changing anything here. The invariants that matter:
 *
 *   - Every person has one canonical account id. Domain records key on it, never
 *     on a provider's id. (Domain fields still spell it `openid`; renaming that
 *     is its own migration.)
 *   - An external credential is a (provider, subject) pair resolving to one
 *     account. The unique constraint lives in the schema, not in this code.
 *   - The server chooses the acting identity. Clients never submit it.
 *   - Sessions are opaque random tokens; only a SHA-256 hash is stored, and they
 *     can be revoked. A leaked database therefore hands out no live sessions.
 *   - Recovery codes are bearer credentials: shown once, stored only as a hash,
 *     rotated on reissue, rate limited, and never logged.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const SESSION_TTL_DAYS = 30
const RECOVERY_CODE_BYTES = 12 // 96 bits
const RECOVERY_ATTEMPT_WINDOW_MINUTES = 15
const RECOVERY_ATTEMPT_LIMIT = 10

export const Provider = Object.freeze({
  GUEST: 'guest',
  RECOVERY: 'recovery',
  WECHAT: 'wechat',
  LINE: 'line',
  EMAIL: 'email',
  PHONE: 'phone',
})

/** Providers that can restore an account on a new device. */
const RECOVERABLE_PROVIDERS = new Set([
  Provider.RECOVERY,
  Provider.WECHAT,
  Provider.LINE,
  Provider.EMAIL,
  Provider.PHONE,
])

export class AuthError extends Error {
  constructor(code, status = 400) {
    super(code)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function newAccountId() {
  return `u_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** Device ids come from the browser, so they are validated, never trusted. */
function assertDeviceId(deviceId) {
  const value = String(deviceId ?? '').trim()
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(value)) throw new AuthError('BAD_DEVICE_ID')
  return value
}

export function normalizeRecoveryCode(code) {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

export function createIdentityService(sql, config, logger) {
  /**
   * Resolve a (provider, subject) to an account, creating one when the pair is
   * new. Atomic: two simultaneous first requests from the same device converge on
   * one account instead of creating two.
   */
  async function resolveOrCreateAccount(provider, subject, { verified = false } = {}) {
    return sql.begin(async (tx) => {
      const [existing] = await tx`
        SELECT account_id FROM provider_identities
        WHERE provider = ${provider} AND subject = ${subject} AND revoked_at IS NULL
      `
      if (existing) return existing.account_id

      const accountId = newAccountId()
      await tx`INSERT INTO accounts (id) VALUES (${accountId})`
      // ON CONFLICT covers the race where another request inserted the identity
      // between the SELECT and here; the loser reads the winner's row.
      const inserted = await tx`
        INSERT INTO provider_identities (account_id, provider, subject, verified_at)
        VALUES (${accountId}, ${provider}, ${subject}, ${verified ? new Date() : null})
        ON CONFLICT (provider, subject) DO NOTHING
        RETURNING account_id
      `
      if (inserted.length) return accountId

      await tx`DELETE FROM accounts WHERE id = ${accountId}`
      const [winner] = await tx`
        SELECT account_id FROM provider_identities
        WHERE provider = ${provider} AND subject = ${subject}
      `
      return winner.account_id
    })
  }

  /**
   * Attach a provider identity to an existing account. Refuses when the identity
   * already belongs to someone else: silent merging would move one person's
   * signups and debts onto another account (platform/README.md).
   */
  async function linkIdentity(accountId, provider, subject, { verified = true } = {}) {
    const [existing] = await sql`
      SELECT account_id FROM provider_identities
      WHERE provider = ${provider} AND subject = ${subject} AND revoked_at IS NULL
    `
    if (existing && existing.account_id !== accountId) {
      throw new AuthError('IDENTITY_ALREADY_LINKED', 409)
    }
    if (existing) return
    await sql`
      INSERT INTO provider_identities (account_id, provider, subject, verified_at)
      VALUES (${accountId}, ${provider}, ${subject}, ${verified ? new Date() : null})
    `
  }

  /**
   * Mint a session. The raw token is returned once and never stored; the row
   * keeps its hash so a session can be revoked and a leak reveals nothing usable.
   */
  async function issueSession(accountId, provider) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    await sql`
      INSERT INTO sessions (token_hash, account_id, provider, expires_at)
      VALUES (${sha256(token)}, ${accountId}, ${provider}, ${expiresAt})
    `
    return { token, expiresAt }
  }

  /**
   * Resolve a bearer token to an account id, or null. Expired and revoked
   * sessions resolve to null.
   */
  async function verifySession(token) {
    if (!token) return null

    // Development shortcut, refused outright in production by config.js.
    if (config.allowDevAuth && token.startsWith('dev:')) {
      const actorId = token.slice(4).trim()
      return actorId || null
    }

    const [row] = await sql`
      UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = ${sha256(token)}
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING account_id
    `
    return row ? row.account_id : null
  }

  async function revokeSession(token) {
    if (!token) return { revoked: 0 }
    const rows = await sql`
      UPDATE sessions SET revoked_at = now()
      WHERE token_hash = ${sha256(token)} AND revoked_at IS NULL
      RETURNING token_hash
    `
    return { revoked: rows.length }
  }

  /** Sign out everywhere. Used by account deletion and by "lost my device". */
  async function revokeAllSessions(accountId) {
    const rows = await sql`
      UPDATE sessions SET revoked_at = now()
      WHERE account_id = ${accountId} AND revoked_at IS NULL
      RETURNING token_hash
    `
    return { revoked: rows.length }
  }

  /** A browser's device key is its first (and initially only) credential. */
  async function exchangeGuestDevice(deviceId) {
    const subject = assertDeviceId(deviceId)
    const accountId = await resolveOrCreateAccount(Provider.GUEST, subject)
    const { token } = await issueSession(accountId, Provider.GUEST)
    return { token, accountId }
  }

  async function listProviders(accountId) {
    const rows = await sql`
      SELECT DISTINCT provider FROM provider_identities
      WHERE account_id = ${accountId} AND revoked_at IS NULL
    `
    return rows.map((row) => row.provider)
  }

  /**
   * What the account can still be reached by. `recoverable` false means the only
   * credential is this browser — the UI has to say so plainly, because the data
   * is on the server but nobody else can prove it is theirs (platform/README.md).
   */
  async function accountStatus(accountId) {
    const providers = await listProviders(accountId)
    return {
      providers,
      recoverable: providers.some((provider) => RECOVERABLE_PROVIDERS.has(provider)),
    }
  }

  /**
   * Issue a recovery code, revoking any previous one. Returned once; only the
   * hash is stored. Formatted in groups for legibility when read aloud or copied.
   */
  async function createRecoveryCode(accountId) {
    const raw = randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase()
    const code = raw.match(/.{1,4}/g).join('-')
    await sql.begin(async (tx) => {
      await tx`
        UPDATE provider_identities SET revoked_at = now()
        WHERE account_id = ${accountId}
          AND provider = ${Provider.RECOVERY}
          AND revoked_at IS NULL
      `
      await tx`
        INSERT INTO provider_identities (account_id, provider, subject, verified_at)
        VALUES (${accountId}, ${Provider.RECOVERY}, ${sha256(normalizeRecoveryCode(code))}, now())
      `
    })
    logger?.info({ account_id: accountId }, 'recovery code issued')
    return code
  }

  async function recordAttempt(kind, fingerprint, succeeded) {
    await sql`
      INSERT INTO auth_attempts (kind, fingerprint, succeeded)
      VALUES (${kind}, ${fingerprint}, ${succeeded})
    `
  }

  async function tooManyAttempts(kind, fingerprint) {
    const [row] = await sql`
      SELECT count(*)::int AS failures FROM auth_attempts
      WHERE kind = ${kind}
        AND fingerprint = ${fingerprint}
        AND succeeded = false
        AND created_at > now() - ${`${RECOVERY_ATTEMPT_WINDOW_MINUTES} minutes`}::interval
    `
    return row.failures >= RECOVERY_ATTEMPT_LIMIT
  }

  /**
   * Redeem a recovery code on a new browser: the new device identity is attached
   * to the account the code belongs to. Rate limited per fingerprint, because a
   * bearer credential that can be guessed without limit is not a credential.
   */
  async function exchangeRecoveryCode(code, deviceId, fingerprint = 'unknown') {
    if (await tooManyAttempts('recovery', fingerprint)) {
      throw new AuthError('TOO_MANY_ATTEMPTS', 429)
    }

    const normalized = normalizeRecoveryCode(code)
    const device = assertDeviceId(deviceId)
    if (normalized.length !== RECOVERY_CODE_BYTES * 2) {
      await recordAttempt('recovery', fingerprint, false)
      throw new AuthError('BAD_RECOVERY_CODE')
    }

    const [row] = await sql`
      SELECT account_id FROM provider_identities
      WHERE provider = ${Provider.RECOVERY}
        AND subject = ${sha256(normalized)}
        AND revoked_at IS NULL
    `
    if (!row) {
      await recordAttempt('recovery', fingerprint, false)
      throw new AuthError('BAD_RECOVERY_CODE')
    }

    await recordAttempt('recovery', fingerprint, true)
    // The code proves ownership; the new browser becomes another credential for
    // the same account rather than replacing the old one.
    await linkIdentity(row.account_id, Provider.GUEST, device, { verified: true })
    const { token } = await issueSession(row.account_id, Provider.RECOVERY)
    logger?.info({ account_id: row.account_id }, 'account restored from recovery code')
    return { token, accountId: row.account_id }
  }

  /**
   * Exchange a WeChat `wx.login()` code for a session. The openid is obtained
   * from WeChat's server, never accepted from the client.
   */
  async function exchangeWechatCode(code) {
    const appId = config.WECHAT_APP_ID
    const appSecret = config.WECHAT_APP_SECRET
    if (!appId || !appSecret) throw new AuthError('AUTH_NOT_CONFIGURED', 501)

    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.searchParams.set('appid', appId)
    url.searchParams.set('secret', appSecret)
    url.searchParams.set('js_code', String(code ?? ''))
    url.searchParams.set('grant_type', 'authorization_code')

    let body
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      body = await response.json()
    } catch (error) {
      logger?.error({ err: error }, 'wechat code exchange failed')
      throw new AuthError('AUTH_UPSTREAM', 502)
    }
    if (!body?.openid) {
      logger?.warn({ wechat_errcode: body?.errcode }, 'wechat rejected the code')
      throw new AuthError('AUTH_FAILED', 401)
    }

    const accountId = await resolveOrCreateAccount(Provider.WECHAT, body.openid, {
      verified: true,
    })
    const { token } = await issueSession(accountId, Provider.WECHAT)
    return { token, accountId }
  }

  /** Constant-time compare, for callers verifying their own opaque values. */
  function safeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    return left.length === right.length && timingSafeEqual(left, right)
  }

  return {
    accountStatus,
    createRecoveryCode,
    exchangeGuestDevice,
    exchangeRecoveryCode,
    exchangeWechatCode,
    issueSession,
    linkIdentity,
    listProviders,
    resolveOrCreateAccount,
    revokeAllSessions,
    revokeSession,
    safeEqual,
    verifySession,
  }
}
