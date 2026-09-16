<script setup lang="ts">
/**
 * The dashboard, and the sign-in gate in front of it.
 *
 * Two states in one view because they answer the same question — "who is this?" —
 * and splitting them across routes would put a redirect between tapping a link
 * and seeing anything.
 *
 * The account panel exists to be honest about a guest account: the data is on the
 * server, but this browser is the only thing that can prove it is yours. That is
 * stated plainly rather than buried, and a recovery code is one tap away.
 */
import { computed, onMounted, ref } from 'vue'

import { account, call } from '@/api/client'
import type { Profile } from '@/api/client'
import type { EventCard, Gender, MyEvents } from '@/api/types'
import EventCardRow from '@/components/EventCardRow.vue'
import GenderChoice from '@/components/GenderChoice.vue'
import LoadingState from '@/components/LoadingState.vue'
import { availableLocales, locale, setLocale, t, tf } from '@/shared/i18n'
import { initial, money } from '@/shared/present'
import { setTheme, themeChoice, themeChoices } from '@/shared/theme'
import { toast } from '@/shared/toast'
import { session } from '@/stores/session'

const loading = ref(true)
const busy = ref(false)
const tab = ref<'games' | 'account'>('games')

// Sign-in
const name = ref(session.rememberedName())
const gender = ref<Gender>(session.rememberedGender() as Gender)
const showRestore = ref(false)
const recoveryInput = ref('')

// Dashboard
const mine = ref<MyEvents | null>(null)
const recent = ref<EventCard[]>([])
const revealedCode = ref('')

const returning = computed(() => Boolean(session.rememberedName()) && session.hasStoredToken())
const profile = session.profile
const status = session.status

const upcoming = computed(() => mine.value?.upcoming ?? [])
const past = computed(() => mine.value?.past ?? [])
const owing = computed(() => mine.value?.owing)

const nextUp = computed(() => upcoming.value[0])

/**
 * What is owed, as one sentence. The shared string carries both the amount and the
 * count; across two currencies there is no single total to state, so the count
 * stands alone rather than summing money that cannot be summed (DESIGN.md §10.3).
 */
const owingText = computed(() => {
  const value = owing.value
  if (!value || value.count === 0) return ''
  if (value.mixed_currency || !value.total_minor) return tf('owingMixed', { n: value.count })
  return tf('owingBanner', { n: value.count, amount: money(value.total_minor, value.currency) })
})

async function loadDashboard(): Promise<void> {
  busy.value = true
  try {
    mine.value = await call<MyEvents>('event.mine')
    recent.value = await loadRecentlyOpened()
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

/**
 * Sessions this browser opened from a link but did not join. Without this, an
 * invite you read and meant to think about is only reachable by finding the chat
 * message again.
 */
async function loadRecentlyOpened(): Promise<EventCard[]> {
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem('group_play_recent_events') ?? '[]'
    )
    ids = Array.isArray(parsed) ? (parsed as string[]).slice(0, 12) : []
  } catch {
    return []
  }

  const joined = new Set([...upcoming.value, ...past.value].map((event) => event._id))
  const wanted = ids.filter((id) => !joined.has(id))
  const settled = await Promise.allSettled(
    wanted.map((eventId) => call<EventCard>('event.detail', { eventId }))
  )
  return settled
    .filter((result): result is PromiseFulfilledResult<EventCard> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((event) => event.status !== 'COMPLETED' && event.status !== 'CANCELLED')
}

async function enter(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) {
    toast.show(t.value.yourName)
    return
  }
  busy.value = true
  try {
    await session.signInAsGuest(trimmed, gender.value)
    await loadDashboard()
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function restore(): Promise<void> {
  busy.value = true
  try {
    await session.restore(recoveryInput.value)
    recoveryInput.value = ''
    showRestore.value = false
    toast.show(t.value.restored)
    await loadDashboard()
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function saveProfile(): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) return
  try {
    const next = await call<Profile>('profile.upsert', {
      nickname: trimmed,
      gender: gender.value,
      locale: locale.value,
    })
    session.setProfile(next)
    toast.show(t.value.savedToast)
  } catch (error) {
    toast.showError(error)
  }
}

async function createRecoveryCode(): Promise<void> {
  try {
    const result = await account.recoveryCode()
    revealedCode.value = result.code
    await session.refreshStatus()
  } catch (error) {
    toast.showError(error)
  }
}

async function copyCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(revealedCode.value)
    toast.show(t.value.copied)
  } catch {
    toast.show(revealedCode.value)
  }
}

async function revokeEverywhere(): Promise<void> {
  try {
    const result = await account.revokeSessions()
    toast.show(tf('revokedSessions', { n: result.revoked }))
    await session.signOut()
  } catch (error) {
    toast.showError(error)
  }
}

async function signOut(): Promise<void> {
  await session.signOut()
  mine.value = null
  revealedCode.value = ''
}

onMounted(async () => {
  const resumed = await session.resume()
  if (resumed) {
    name.value = profile.value?.nickname ?? name.value
    gender.value = (profile.value?.gender ?? gender.value) as Gender
    await loadDashboard()
  }
  loading.value = false
})
</script>

<template>
  <div class="app" :class="{ 'app--with-bar': session.signedIn.value && tab === 'games' }">
    <LoadingState v-if="loading" :rows="2" />

    <!-- Sign-in ------------------------------------------------------------ -->
    <template v-else-if="!session.signedIn.value">
      <header class="page-head">
        <div>
          <span class="page-head__eyebrow">{{ t.welcomeTitle }}</span>
          <h1 class="page-head__title">{{ t.welcomeBody }}</h1>
        </div>
      </header>

      <div class="card stack">
        <label class="field">
          <span class="field__label">{{ t.yourName }}</span>
          <input
            v-model="name"
            class="input"
            type="text"
            :placeholder="t.namePlaceholder"
            maxlength="32"
            autocomplete="name"
            @keyup.enter="enter"
          />
        </label>

        <GenderChoice v-model="gender" />

        <button
          class="btn btn--block"
          type="button"
          :disabled="busy || !name.trim()"
          @click="enter"
        >
          {{ returning ? tf('continueAsName', { name: name.trim() }) : t.enterCta }}
        </button>
      </div>

      <div class="section" />
      <div class="card card--quiet stack--tight">
        <button class="btn btn--link" type="button" @click="showRestore = !showRestore">
          {{ t.haveRecoveryCode }}
        </button>

        <template v-if="showRestore">
          <p class="hint">{{ t.restoreBody }}</p>
          <input
            v-model="recoveryInput"
            class="input"
            type="text"
            :placeholder="t.recoveryPlaceholder"
            autocomplete="one-time-code"
            spellcheck="false"
          />
          <button
            class="btn btn--ghost"
            type="button"
            :disabled="busy || !recoveryInput.trim()"
            @click="restore"
          >
            {{ t.restoreCta }}
          </button>
        </template>
      </div>
    </template>

    <!-- Dashboard --------------------------------------------------------- -->
    <template v-else>
      <header class="page-head">
        <div>
          <span class="page-head__eyebrow">{{ t.dashboardTitle }}</span>
          <h1 class="page-head__title">{{ profile?.nickname || t.welcomeTitle }}</h1>
          <p v-if="nextUp" class="page-head__sub">{{ t.hostingUpcoming }} · {{ nextUp.title }}</p>
        </div>
        <span
          class="avatar avatar--lg avatar--me"
          role="button"
          tabindex="0"
          :aria-label="t.accountTab"
          @click="tab = 'account'"
          @keyup.enter="tab = 'account'"
        >
          {{ initial(profile?.nickname ?? '') }}
        </span>
      </header>

      <div class="seg" role="tablist">
        <button
          class="seg__item"
          role="tab"
          type="button"
          :aria-selected="tab === 'games'"
          @click="tab = 'games'"
        >
          {{ t.gamesTab }}
        </button>
        <button
          class="seg__item"
          role="tab"
          type="button"
          :aria-selected="tab === 'account'"
          @click="tab = 'account'"
        >
          {{ t.accountTab }}
        </button>
      </div>

      <!-- Sessions -->
      <template v-if="tab === 'games'">
        <RouterLink
          v-if="owing && owing.count > 0"
          class="notice"
          :to="owing.event_id ? `/bill/${owing.event_id}` : '/'"
          style="margin-top: var(--s-4)"
        >
          <span class="notice__body">{{ owingText }}</span>
        </RouterLink>

        <div v-if="status && !status.recoverable" class="notice" style="margin-top: var(--s-4)">
          <span class="notice__body">
            {{ t.accountGuestBody }}
            <button class="btn btn--link" type="button" @click="tab = 'account'">
              {{ t.protectAccount }}
            </button>
          </span>
        </div>

        <template v-if="upcoming.length">
          <div class="section">
            <span class="section__title">{{ t.myGamesLabel }}</span>
            <span class="section__meta numeric">{{ upcoming.length }}</span>
          </div>
          <div class="stack">
            <EventCardRow v-for="event in upcoming" :key="event._id" :event="event" />
          </div>
        </template>

        <template v-if="recent.length">
          <div class="section">
            <span class="section__title">{{ t.recentlyOpened }}</span>
          </div>
          <div class="stack">
            <EventCardRow v-for="event in recent" :key="event._id" :event="event" />
          </div>
        </template>

        <template v-if="past.length">
          <div class="section">
            <span class="section__title">{{ t.hostingUpcoming }}</span>
          </div>
          <div class="stack">
            <EventCardRow v-for="event in past" :key="event._id" :event="event" />
          </div>
        </template>

        <div v-if="!upcoming.length && !recent.length && !past.length" class="empty">
          <div class="empty__mark" aria-hidden="true" />
          {{ t.emptyDashboard }}
        </div>
      </template>

      <!-- Account -->
      <template v-else>
        <div class="section">
          <span class="section__title">{{ t.editProfile }}</span>
        </div>
        <div class="card stack">
          <label class="field">
            <span class="field__label">{{ t.nickname }}</span>
            <input v-model="name" class="input" type="text" maxlength="32" />
          </label>
          <GenderChoice v-model="gender" />
          <div class="field">
            <span class="field__label">{{ t.languageLabel }}</span>
            <div class="choice" role="group">
              <button
                v-for="code in availableLocales"
                :key="code"
                type="button"
                class="chip"
                :aria-pressed="locale === code"
                @click="setLocale(code)"
              >
                {{ code === 'zh' ? '中文' : 'English' }}
              </button>
            </div>
          </div>
          <div class="field">
            <span class="field__label">{{ t.appearanceLabel }}</span>
            <div class="choice" role="group" :aria-label="t.appearanceLabel">
              <button
                v-for="option in themeChoices"
                :key="option"
                type="button"
                class="chip"
                :aria-pressed="themeChoice === option"
                @click="setTheme(option)"
              >
                {{
                  option === 'system'
                    ? t.themeSystem
                    : option === 'light'
                      ? t.themeLight
                      : t.themeDark
                }}
              </button>
            </div>
          </div>
          <button class="btn" type="button" @click="saveProfile">{{ t.saveCta }}</button>
        </div>

        <div class="section">
          <span class="section__title">{{ t.accountTab }}</span>
        </div>
        <div class="card stack">
          <div class="row--between">
            <h3>{{ status?.recoverable ? t.accountRecoverableTitle : t.accountGuestTitle }}</h3>
            <span class="pill" :class="status?.recoverable ? 'pill--good' : 'pill--warn'">
              {{ status?.recoverable ? t.statusProtected : t.statusUnprotected }}
            </span>
          </div>
          <p class="small muted">
            {{ status?.recoverable ? t.accountRecoverableBody : t.accountGuestBody }}
          </p>

          <button class="btn" type="button" @click="createRecoveryCode">
            {{ status?.recoverable ? t.rotateRecoveryCode : t.createRecoveryCode }}
          </button>

          <template v-if="revealedCode">
            <div class="code">{{ revealedCode }}</div>
            <p class="hint">{{ t.recoveryCodeOnce }}</p>
            <button class="btn btn--soft" type="button" @click="copyCode">{{ t.copyCode }}</button>
          </template>
        </div>

        <div class="section" />
        <div class="card card--quiet stack">
          <p class="small muted">{{ t.signOutBody }}</p>
          <button class="btn btn--ghost" type="button" @click="signOut">{{ t.signOutCta }}</button>
          <button class="btn btn--danger" type="button" @click="revokeEverywhere">
            {{ t.revokeSessions }}
          </button>
        </div>
      </template>
    </template>
  </div>

  <nav v-if="!loading && session.signedIn.value && tab === 'games'" class="action-bar">
    <div class="action-bar__inner">
      <RouterLink class="btn btn--ghost center" to="/hosting">{{ t.goHosting }}</RouterLink>
      <RouterLink class="btn action-bar__grow center" to="/create">{{ t.newSession }}</RouterLink>
    </div>
  </nav>
</template>
