/**
 * Identity: sessions, provider mapping, recovery codes.
 *
 * The rules being pinned here are the security invariants in platform/README.md. Each
 * test names the thing that would go wrong if it regressed, because "sessions
 * work" is not the property that matters — "a revoked session stops working" is.
 */

import { describe, expect, it } from 'vitest'

import { createIdentityService, normalizeRecoveryCode, Provider } from '../src/identity/index.js'
import { identity, silentLogger, sql, testConfig } from './helpers.js'

const DEVICE = 'browser-device-key-000001'
const OTHER_DEVICE = 'browser-device-key-000002'

describe('guest sign-in', () => {
  it('creates an account on first use and returns a session', async () => {
    const { token, accountId } = await identity.exchangeGuestDevice(DEVICE)
    expect(accountId).toMatch(/^u_[0-9a-f]{20}$/)
    expect(await identity.verifySession(token)).toBe(accountId)
  })

  it('returns the same account for the same device', async () => {
    const first = await identity.exchangeGuestDevice(DEVICE)
    const second = await identity.exchangeGuestDevice(DEVICE)
    expect(second.accountId).toBe(first.accountId)
    // A second sign-in issues a new session without invalidating the old one:
    // the same person may have the app open in two tabs.
    expect(second.token).not.toBe(first.token)
    expect(await identity.verifySession(first.token)).toBe(first.accountId)
  })

  it('gives different devices different accounts', async () => {
    const a = await identity.exchangeGuestDevice(DEVICE)
    const b = await identity.exchangeGuestDevice(OTHER_DEVICE)
    expect(a.accountId).not.toBe(b.accountId)
  })

  it('converges on one account when the same device signs in concurrently', async () => {
    // Two tabs opening at once must not create two accounts, or the person's
    // signups end up split across them.
    const results = await Promise.all([
      identity.exchangeGuestDevice(DEVICE),
      identity.exchangeGuestDevice(DEVICE),
      identity.exchangeGuestDevice(DEVICE),
    ])
    const ids = new Set(results.map((r) => r.accountId))
    expect(ids.size).toBe(1)

    const [{ count }] = await sql`SELECT count(*)::int AS count FROM accounts`
    expect(count).toBe(1)
  })

  it.each(['', 'short', 'has spaces in it here', 'x'.repeat(200), 'semi;colon;injection'])(
    'rejects a malformed device id: %s',
    async (bad) => {
      await expect(identity.exchangeGuestDevice(bad)).rejects.toMatchObject({
        code: 'BAD_DEVICE_ID',
      })
    }
  )
})

describe('sessions', () => {
  it('stores only a hash of the token', async () => {
    const { token } = await identity.exchangeGuestDevice(DEVICE)
    const rows = await sql`SELECT token_hash FROM sessions`
    // A database leak must not hand out live sessions.
    expect(rows[0].token_hash).not.toBe(token)
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a token that was never issued', async () => {
    expect(await identity.verifySession('not-a-real-token')).toBeNull()
    expect(await identity.verifySession('')).toBeNull()
    expect(await identity.verifySession(undefined)).toBeNull()
  })

  it('stops accepting a revoked session', async () => {
    const { token } = await identity.exchangeGuestDevice(DEVICE)
    expect(await identity.revokeSession(token)).toEqual({ revoked: 1 })
    expect(await identity.verifySession(token)).toBeNull()
    // Revoking twice is not an error, but it revokes nothing the second time.
    expect(await identity.revokeSession(token)).toEqual({ revoked: 0 })
  })

  it('revokes every session for an account', async () => {
    const first = await identity.exchangeGuestDevice(DEVICE)
    const second = await identity.exchangeGuestDevice(DEVICE)
    const result = await identity.revokeAllSessions(first.accountId)
    expect(result.revoked).toBe(2)
    expect(await identity.verifySession(first.token)).toBeNull()
    expect(await identity.verifySession(second.token)).toBeNull()
  })

  it('rejects an expired session', async () => {
    const { token, accountId } = await identity.exchangeGuestDevice(DEVICE)
    await sql`UPDATE sessions SET expires_at = now() - interval '1 second'
              WHERE account_id = ${accountId}`
    expect(await identity.verifySession(token)).toBeNull()
  })

  it('ignores the dev-auth shortcut unless it is enabled', async () => {
    // testConfig sets ALLOW_DEV_AUTH=false, as production always does.
    expect(testConfig.allowDevAuth).toBe(false)
    expect(await identity.verifySession('dev:u_someone')).toBeNull()
  })

  it('honours the dev-auth shortcut when explicitly enabled', async () => {
    const devIdentity = createIdentityService(
      sql,
      { ...testConfig, allowDevAuth: true },
      silentLogger
    )
    expect(await devIdentity.verifySession('dev:u_someone')).toBe('u_someone')
  })
})

describe('recovery codes', () => {
  it('normalises formatting, case and separators', () => {
    expect(normalizeRecoveryCode('abcd-ef01 2345')).toBe('ABCDEF012345')
  })

  it('restores the account on another browser', async () => {
    const original = await identity.exchangeGuestDevice(DEVICE)
    const code = await identity.createRecoveryCode(original.accountId)

    const restored = await identity.exchangeRecoveryCode(code, OTHER_DEVICE)
    expect(restored.accountId).toBe(original.accountId)
    expect(await identity.verifySession(restored.token)).toBe(original.accountId)
  })

  it('accepts the code however the user retypes it', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    const code = await identity.createRecoveryCode(accountId)
    const messy = code.toLowerCase().replace(/-/g, ' ')
    const restored = await identity.exchangeRecoveryCode(messy, OTHER_DEVICE)
    expect(restored.accountId).toBe(accountId)
  })

  it('stores only a hash, never the code itself', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    const code = await identity.createRecoveryCode(accountId)
    const rows = await sql`SELECT subject FROM provider_identities
                           WHERE provider = ${Provider.RECOVERY}`
    expect(rows[0].subject).not.toContain(code.replace(/-/g, ''))
    expect(rows[0].subject).toMatch(/^[0-9a-f]{64}$/)
  })

  it('invalidates the previous code when a new one is issued', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    const first = await identity.createRecoveryCode(accountId)
    const second = await identity.createRecoveryCode(accountId)

    await expect(identity.exchangeRecoveryCode(first, OTHER_DEVICE)).rejects.toMatchObject({
      code: 'BAD_RECOVERY_CODE',
    })
    await expect(identity.exchangeRecoveryCode(second, OTHER_DEVICE)).resolves.toMatchObject({
      accountId,
    })
  })

  it('rejects a wrong or malformed code', async () => {
    await expect(identity.exchangeRecoveryCode('NOPE', OTHER_DEVICE)).rejects.toMatchObject({
      code: 'BAD_RECOVERY_CODE',
    })
    await expect(
      identity.exchangeRecoveryCode('AAAABBBBCCCCDDDDEEEEFFFF', OTHER_DEVICE)
    ).rejects.toMatchObject({ code: 'BAD_RECOVERY_CODE' })
  })

  it('rate limits guessing', async () => {
    // A bearer credential that can be guessed without limit is not a credential.
    const attempts = []
    for (let i = 0; i < 10; i += 1) {
      attempts.push(
        identity
          .exchangeRecoveryCode('AAAABBBBCCCCDDDDEEEEFFFF', OTHER_DEVICE, 'attacker')
          .catch((error) => error.code)
      )
    }
    expect(await Promise.all(attempts)).toEqual(Array(10).fill('BAD_RECOVERY_CODE'))

    await expect(
      identity.exchangeRecoveryCode('AAAABBBBCCCCDDDDEEEEFFFF', OTHER_DEVICE, 'attacker')
    ).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' })

    // The limit is per fingerprint, so one attacker cannot lock everybody out.
    await expect(
      identity.exchangeRecoveryCode('AAAABBBBCCCCDDDDEEEEFFFF', OTHER_DEVICE, 'someone-else')
    ).rejects.toMatchObject({ code: 'BAD_RECOVERY_CODE' })
  })

  it('keeps the original device working after a restore', async () => {
    const original = await identity.exchangeGuestDevice(DEVICE)
    const code = await identity.createRecoveryCode(original.accountId)
    await identity.exchangeRecoveryCode(code, OTHER_DEVICE)
    // Restoring adds a credential; it does not evict the old browser.
    const again = await identity.exchangeGuestDevice(DEVICE)
    expect(again.accountId).toBe(original.accountId)
  })
})

describe('account status', () => {
  it('reports a guest-only account as not recoverable', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    expect(await identity.accountStatus(accountId)).toEqual({
      providers: [Provider.GUEST],
      recoverable: false,
    })
  })

  it('reports recoverable once a recovery code exists', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    await identity.createRecoveryCode(accountId)
    const status = await identity.accountStatus(accountId)
    expect(status.recoverable).toBe(true)
    expect(status.providers.sort()).toEqual([Provider.GUEST, Provider.RECOVERY])
  })
})

describe('provider binding', () => {
  it('links a verified provider identity to an existing account', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    await identity.linkIdentity(accountId, Provider.LINE, 'line-subject-1')
    expect((await identity.accountStatus(accountId)).providers).toContain(Provider.LINE)
  })

  it('is idempotent when the identity is already linked to this account', async () => {
    const { accountId } = await identity.exchangeGuestDevice(DEVICE)
    await identity.linkIdentity(accountId, Provider.LINE, 'line-subject-1')
    await expect(
      identity.linkIdentity(accountId, Provider.LINE, 'line-subject-1')
    ).resolves.toBeUndefined()
  })

  it('refuses to move an identity that belongs to somebody else', async () => {
    // Silently merging would move one person's signups and debts onto another
    // account. platform/README.md requires refusing and preserving both.
    const first = await identity.exchangeGuestDevice(DEVICE)
    const second = await identity.exchangeGuestDevice(OTHER_DEVICE)
    await identity.linkIdentity(first.accountId, Provider.LINE, 'shared-subject')

    await expect(
      identity.linkIdentity(second.accountId, Provider.LINE, 'shared-subject')
    ).rejects.toMatchObject({ code: 'IDENTITY_ALREADY_LINKED' })

    expect((await identity.accountStatus(first.accountId)).providers).toContain(Provider.LINE)
    expect((await identity.accountStatus(second.accountId)).providers).not.toContain(Provider.LINE)
  })

  it('enforces one account per provider identity in the schema, not just in code', async () => {
    const first = await identity.exchangeGuestDevice(DEVICE)
    const second = await identity.exchangeGuestDevice(OTHER_DEVICE)
    await expect(
      sql`INSERT INTO provider_identities (account_id, provider, subject)
          VALUES (${second.accountId}, ${Provider.GUEST}, ${DEVICE})`
    ).rejects.toMatchObject({ code: '23505' }) // unique_violation
    expect(first.accountId).not.toBe(second.accountId)
  })
})

describe('wechat sign-in', () => {
  it('reports a clear code when WeChat credentials are not configured', async () => {
    await expect(identity.exchangeWechatCode('some-code')).rejects.toMatchObject({
      code: 'AUTH_NOT_CONFIGURED',
    })
  })
})
