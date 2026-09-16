/**
 * Session state: who is signed in on this browser.
 *
 * A plain reactive module rather than a store library. There is one session and a
 * handful of fields; Pinia would be ceremony.
 */

import { computed, ref } from 'vue'

import {
  account,
  auth,
  call,
  clearToken,
  currentToken,
  type AccountStatus,
  type Profile,
} from '@/api/client'

const NAME_KEY = 'group_play_name'
const GENDER_KEY = 'group_play_gender'

function remembered(key: string, fallback = ''): string {
  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode; nothing to do.
  }
}

const profile = ref<Profile | null>(null)
const status = ref<AccountStatus | null>(null)
const ready = ref(false)

export const session = {
  profile: computed(() => profile.value),
  status: computed(() => status.value),
  ready: computed(() => ready.value),
  signedIn: computed(() => Boolean(profile.value)),

  /** The name and gender last used on this browser, for a returning visitor. */
  rememberedName: () => remembered(NAME_KEY),
  rememberedGender: () => remembered(GENDER_KEY, 'UNSPECIFIED'),

  /** True when this browser holds a token but we have not yet used it. */
  hasStoredToken: () => Boolean(currentToken()),

  /**
   * Resume an existing session. Returns false when there is nothing to resume or
   * the stored token has been revoked or expired.
   */
  async resume(): Promise<boolean> {
    if (!currentToken()) {
      ready.value = true
      return false
    }
    try {
      profile.value = await call<Profile>('profile.get')
      status.value = (await account.status()).status
      return true
    } catch {
      // Revoked, expired, or the server was rebuilt: start clean.
      clearToken()
      profile.value = null
      status.value = null
      return false
    } finally {
      ready.value = true
    }
  },

  async signInAsGuest(nickname: string, gender: string): Promise<void> {
    const result = await auth.guest(nickname, gender)
    profile.value = result.profile
    remember(NAME_KEY, result.profile.nickname)
    remember(GENDER_KEY, result.profile.gender)
    status.value = (await account.status()).status
    ready.value = true
  },

  async restore(code: string): Promise<void> {
    const result = await auth.recovery(code)
    profile.value = result.profile
    remember(NAME_KEY, result.profile.nickname)
    remember(GENDER_KEY, result.profile.gender)
    status.value = (await account.status()).status
    ready.value = true
  },

  async signOut(): Promise<void> {
    await auth.signOut()
    profile.value = null
    status.value = null
  },

  setProfile(next: Profile): void {
    profile.value = next
    remember(NAME_KEY, next.nickname)
    remember(GENDER_KEY, next.gender)
  },

  async refreshStatus(): Promise<void> {
    status.value = (await account.status()).status
  },
}
