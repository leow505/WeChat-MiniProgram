/**
 * API client.
 *
 * One `call(action, payload)` entry point, mirroring `miniprogram/utils/api.js`,
 * because the browser, the WeChat client and any future bot all speak the same
 * named-action contract. Adding a feature means adding an action, not a route.
 *
 * The session token lives in memory and in localStorage; the acting identity is
 * resolved from it server-side and is never sent in a payload.
 */

const TOKEN_KEY = 'group_play_token'
const DEVICE_KEY = 'group_play_device_id'

/** A business failure. `code` is stable and localized by the client. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

function safeRead(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function safeWrite(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    // Private mode: the session simply will not survive a reload.
  }
}

let token = safeRead(TOKEN_KEY)

export function currentToken(): string {
  return token
}

export function setToken(next: string): void {
  token = next
  safeWrite(TOKEN_KEY, next)
}

export function clearToken(): void {
  setToken('')
}

/**
 * This browser's device key: the first, and initially only, credential for a
 * guest account. Generated once and kept in localStorage.
 *
 * Clearing storage does not delete the account's data — it removes the only proof
 * that the account is yours, which is why the UI offers a recovery code.
 */
export function deviceId(): string {
  const existing = safeRead(DEVICE_KEY)
  if (existing) return existing
  const generated = crypto.randomUUID().replace(/-/g, '')
  safeWrite(DEVICE_KEY, generated)
  return generated
}

interface ApiEnvelope<T> {
  ok: boolean
  code?: string
  data?: T
  [key: string]: unknown
}

async function request<T>(path: string, body: unknown, authenticated: boolean): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    // Offline, DNS failure, connection reset: not a business failure.
    throw new ApiError('NETWORK', 0)
  }

  let payload: ApiEnvelope<T>
  try {
    payload = (await response.json()) as ApiEnvelope<T>
  } catch {
    throw new ApiError('NETWORK', response.status)
  }

  if (!response.ok || !payload.ok) {
    throw new ApiError(payload.code ?? 'NETWORK', response.status)
  }
  return payload as T
}

/** Run a named domain action. */
export async function call<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const result = await request<{ data: T }>('/v1/actions', { action, payload }, true)
  return result.data
}

export interface Profile {
  _id: string
  nickname: string
  gender: 'MALE' | 'FEMALE' | 'UNSPECIFIED'
  avatar_url?: string
  locale?: string
  needs_setup?: boolean
}

export interface AccountStatus {
  providers: string[]
  recoverable: boolean
}

export const auth = {
  /** Sign in (or register) this browser as a guest. */
  async guest(nickname: string, gender: string): Promise<{ token: string; profile: Profile }> {
    const result = await request<{ token: string; profile: Profile }>(
      '/v1/auth/guest',
      {
        device_id: deviceId(),
        nickname,
        gender,
        locale: navigator.language || '',
      },
      false
    )
    setToken(result.token)
    return result
  },

  /** Restore an account onto this browser with a recovery code. */
  async recovery(code: string): Promise<{ token: string; profile: Profile }> {
    const result = await request<{ token: string; profile: Profile }>(
      '/v1/auth/recovery',
      { code, device_id: deviceId() },
      false
    )
    setToken(result.token)
    return result
  },

  /** Revoke this session server-side, not merely forget it locally. */
  async signOut(): Promise<void> {
    try {
      await request('/v1/auth/signout', {}, true)
    } finally {
      clearToken()
    }
  },
}

export const account = {
  status(): Promise<{ status: AccountStatus }> {
    return request<{ status: AccountStatus }>('/v1/account/status', {}, true)
  },

  /** Issue a recovery code. Shown once; issuing a new one revokes the old. */
  recoveryCode(): Promise<{ code: string; status: AccountStatus }> {
    return request<{ code: string; status: AccountStatus }>('/v1/account/recovery-code', {}, true)
  },

  revokeSessions(): Promise<{ revoked: number }> {
    return request<{ revoked: number }>('/v1/account/revoke-sessions', {}, true)
  },
}
