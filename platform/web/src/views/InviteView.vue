<script setup lang="ts">
/**
 * The invite page: what somebody sees when they tap a link in a group chat.
 *
 * The product turns on this screen, so it has one job — show the session and let
 * the reader join — and it must work for a first-time visitor with no account.
 * Signing in is inline, by typing a name: asking a stranger to register before
 * they can say "I'm in" is how a group goes back to pasting numbered lists.
 *
 * Layout follows that job. A hero carries the three deciding facts (when, where,
 * room left), the roster answers "is my group going", and the join action is
 * pinned to the bottom of the viewport so it is reachable without scrolling back.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { call } from '@/api/client'
import type { EventDetail, Gender } from '@/api/types'
import AvatarStack from '@/components/AvatarStack.vue'
import GenderChoice from '@/components/GenderChoice.vue'
import LoadingState from '@/components/LoadingState.vue'
import PeopleList from '@/components/PeopleList.vue'
import SeatMeter from '@/components/SeatMeter.vue'
import { t, tf } from '@/shared/i18n'
import {
  advisory,
  dateChip,
  formatLabel,
  money,
  rosterAsText,
  statusLabel,
  statusTone,
  whenText,
} from '@/shared/present'
import { session } from '@/stores/session'
import { toast } from '@/shared/toast'

const route = useRoute()
const eventId = computed(() => String(route.params.id ?? ''))

const event = ref<EventDetail | null>(null)
const loading = ref(true)
const failure = ref('')
const busy = ref(false)

const name = ref(session.rememberedName())
const gender = ref<Gender>(session.rememberedGender() as Gender)
const guestCount = ref(0)

/** A balanced format cannot seat an undeclared gender, so it must be asked for. */
const needsGender = computed(
  () =>
    event.value?.roster_mode === 'GENDER_BALANCED' &&
    (!session.profile.value || session.profile.value.gender === 'UNSPECIFIED')
)

const joined = computed(
  () => event.value?.my_state === 'ROSTER' || event.value?.my_state === 'WAITLIST'
)

const joinLabel = computed(() => {
  if (!event.value) return t.value.join
  return advisory.joinGoesToWaitlist(event.value) ? t.value.joinWaitlist : t.value.join
})

const chip = computed(() => dateChip(event.value?.start_local ?? ''))
const maxGuests = computed(() => event.value?.max_guests_per_member ?? 0)
const tone = computed(() => (event.value ? statusTone(event.value) : 'plain'))
// Resolved here rather than in the template: passing the locale ref through a
// call in the template relies on unwrapping and silently fell back to Chinese.
const formatText = computed(() => formatLabel(event.value?.format_template, t.value))

const guestsChanged = computed(
  () => joined.value && guestCount.value !== (event.value?.my_guests?.length ?? 0)
)

const canJoinNow = computed(
  () => Boolean(event.value) && advisory.canJoin(event.value!) && Boolean(name.value.trim())
)

async function load(): Promise<void> {
  failure.value = ''
  try {
    event.value = await call<EventDetail>('event.detail', { eventId: eventId.value })
    guestCount.value = event.value.my_guests?.length ?? 0
    rememberVisit(eventId.value)
  } catch (error) {
    failure.value =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : 'NETWORK'
  } finally {
    loading.value = false
  }
}

/** Sessions opened from a link, so the dashboard can offer them again. */
function rememberVisit(id: string): void {
  try {
    const key = 'group_play_recent_events'
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    const previous = Array.isArray(parsed) ? (parsed as string[]) : []
    const next = [id, ...previous.filter((entry) => entry !== id)].slice(0, 12)
    window.localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // Storage unavailable; the dashboard simply will not list this one.
  }
}

/** Sign in or update the profile if needed, then run `action`. */
async function withIdentity(run: () => Promise<void>): Promise<void> {
  const trimmed = name.value.trim()
  if (!trimmed) {
    toast.show(t.value.yourName)
    return
  }
  busy.value = true
  try {
    if (!session.signedIn.value) {
      await session.signInAsGuest(trimmed, gender.value)
    } else if (session.profile.value?.nickname !== trimmed || needsGender.value) {
      const profile = await call<typeof session.profile.value>('profile.upsert', {
        nickname: trimmed,
        gender: gender.value,
      })
      if (profile) session.setProfile(profile)
    }
    await run()
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

function guests(): { name: string; gender: Gender }[] {
  return Array.from({ length: guestCount.value }, () => ({
    name: '',
    gender: 'UNSPECIFIED' as Gender,
  }))
}

function join(): Promise<void> {
  return withIdentity(async () => {
    const result = await call<{ state: string }>('event.join', {
      eventId: eventId.value,
      guests: guests(),
    })
    await load()
    toast.show(result.state === 'WAITLIST' ? t.value.waitlistedToast : t.value.joined)
  })
}

function withdraw(): Promise<void> {
  return withIdentity(async () => {
    await call('event.withdraw', { eventId: eventId.value })
    await load()
    toast.show(t.value.withdraw)
  })
}

function updateGuests(): Promise<void> {
  return withIdentity(async () => {
    await call('event.updateGuests', { eventId: eventId.value, guests: guests() })
    await load()
    toast.show(t.value.savedToast)
  })
}

async function share(): Promise<void> {
  const url = window.location.href
  const payload = {
    title: event.value?.title ?? '',
    text: `${event.value?.title ?? ''} · ${whenText(event.value?.start_local ?? '')}`,
    url,
  }
  // The native sheet is the right thing on a phone: it offers the very chat apps
  // this link is meant to travel through.
  if (navigator.share) {
    try {
      await navigator.share(payload)
      return
    } catch {
      return // Dismissed.
    }
  }
  await copy(url, t.value.inviteLinkCopied)
}

async function copy(text: string, confirmation: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.show(confirmation)
  } catch {
    toast.show(text)
  }
}

/** The plain-text roster, for pasting back into the group chat. */
function copyRoster(): void {
  if (!event.value) return
  void copy(rosterAsText(event.value, t.value), t.value.rosterCopied)
}

onMounted(async () => {
  await session.resume()
  if (!session.signedIn.value) {
    // An anonymous reader still needs to see the session, so sign in as a guest
    // with whatever name this browser used before (possibly none).
    try {
      await session.signInAsGuest(session.rememberedName() || ' ', gender.value)
    } catch {
      // Fall through: load() reports why nothing is visible.
    }
  }
  name.value = session.profile.value?.nickname?.trim() || session.rememberedName()
  gender.value = (session.profile.value?.gender ?? gender.value) as Gender
  await load()
})

watch(eventId, load)
</script>

<template>
  <div class="app app--with-bar">
    <LoadingState v-if="loading" />

    <div v-else-if="failure" class="stack" style="padding-top: var(--s-8)">
      <div class="notice">
        <span class="notice__body">
          {{ failure === 'NOT_VISIBLE' ? t.clubOnlyNotice : t.offlineError }}
        </span>
      </div>
      <button class="btn btn--ghost" type="button" @click="load">{{ t.retryCta }}</button>
      <RouterLink class="btn btn--link center" to="/">{{ t.goHome }}</RouterLink>
    </div>

    <template v-else-if="event">
      <!-- Hero: when, where, and whether there is room. -->
      <section class="hero" style="margin-top: var(--s-6)">
        <div class="row--between" style="margin-bottom: var(--s-4)">
          <span
            class="pill"
            :class="{
              'pill--good': tone === 'good' || event.status === 'OPEN',
              'pill--warn': tone === 'warn' || event.status === 'WAITLIST_ONLY',
              'pill--quiet': tone === 'quiet',
              'pill--live': event.status === 'IN_PROGRESS',
            }"
          >
            {{ event.my_state === 'ROSTER' ? t.joined : statusLabel(event.status, t) }}
          </span>
          <span class="tiny faint">
            {{ event.visibility === 'CLUB_ONLY' ? t.clubOnlyNotice : t.inviteOnly }}
          </span>
        </div>

        <div class="hero__top">
          <div class="hero__date" aria-hidden="true">
            <span class="hero__day">{{ chip.day }}</span>
            <span class="hero__month">{{ chip.month }}</span>
          </div>
          <div class="hero__headline">
            <h1 class="hero__title">{{ event.title }}</h1>
            <p class="hero__when">{{ whenText(event.start_local, event.end_local) }}</p>
            <p v-if="event.venue_snapshot?.name" class="hero__where">
              {{ event.venue_snapshot.name }}
              <template v-if="event.venue_snapshot.address">
                · {{ event.venue_snapshot.address }}
              </template>
            </p>
          </div>
        </div>

        <SeatMeter
          :roster-count="event.roster_count"
          :capacity="event.capacity"
          :waitlist-count="event.waitlist.length"
        />

        <div class="hero__facts">
          <div v-if="event.format_template" class="fact">
            <span class="fact__label">{{ t.format }}</span>
            <span class="fact__value">{{ formatText }}</span>
          </div>
          <div v-if="event.organizer_name" class="fact">
            <span class="fact__label">{{ t.organizerLabel }}</span>
            <span class="fact__value">{{ event.organizer_name }}</span>
          </div>
          <div v-if="event.cost_estimate_per_person" class="fact">
            <span class="fact__label">{{ t.estimatedPerPerson }}</span>
            <span class="fact__value numeric">
              {{ money(event.cost_estimate_per_person, event.currency) }}
            </span>
          </div>
        </div>
      </section>

      <!-- Who is coming. The reason a link beats a chat thread: one place that is
           always current. -->
      <div class="section">
        <span class="section__title">{{ t.rosterTitle }}</span>
        <button class="btn btn--link" type="button" @click="copyRoster">
          {{ t.copyRosterToChat }}
        </button>
      </div>

      <div class="card card--flush">
        <div v-if="event.roster.length" class="card__pad" style="padding-bottom: 0">
          <AvatarStack :people="event.roster" />
        </div>
        <PeopleList :people="event.roster" />
      </div>

      <template v-if="event.waitlist.length">
        <div class="section">
          <span class="section__title">{{ t.waitlistTitle }}</span>
          <span class="section__meta">{{ event.waitlist.length }}</span>
        </div>
        <div class="card card--flush">
          <PeopleList :people="event.waitlist" numbered />
        </div>
      </template>

      <!-- Signing up. Name first for a newcomer; a returning visitor sees it filled. -->
      <div class="section">
        <span class="section__title">{{ joined ? t.joined : t.join }}</span>
      </div>

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
            data-testid="name"
          />
        </label>

        <GenderChoice v-if="needsGender" v-model="gender" />

        <div v-if="maxGuests > 0" class="field">
          <span class="field__label">
            {{ t.bringGuests }} · {{ tf('upToGuests', { n: maxGuests }) }}
          </span>
          <div class="choice" role="group">
            <button
              v-for="count in maxGuests + 1"
              :key="count"
              type="button"
              class="chip"
              :aria-pressed="guestCount === count - 1"
              @click="guestCount = count - 1"
            >
              {{ count - 1 === 0 ? t.guestNone : tf('guestCount', { n: count - 1 }) }}
            </button>
          </div>
          <span v-if="guestCount" class="hint">
            {{ tf('guestSeatNote', { n: guestCount + 1 }) }}
          </span>
        </div>

        <button
          v-if="guestsChanged"
          class="btn btn--soft"
          type="button"
          :disabled="busy"
          @click="updateGuests"
        >
          {{ t.saveCta }}
        </button>

        <p v-if="joined && !event.can_withdraw" class="hint">{{ t.cannotWithdraw }}</p>
        <p v-else-if="!joined && !advisory.canJoin(event)" class="hint">{{ t.closedAlready }}</p>
      </div>

      <div class="section" />
      <div class="stack stack--tight">
        <RouterLink
          v-if="event.can_manage"
          class="btn btn--ghost center"
          :to="`/manage/${event._id}`"
        >
          {{ t.manageSession }}
        </RouterLink>
        <RouterLink
          v-if="event.status === 'COMPLETED'"
          class="btn btn--ghost center"
          :to="`/bill/${event._id}`"
        >
          {{ t.viewBillCta }}
        </RouterLink>
        <RouterLink class="btn btn--link center" to="/">{{ t.dashboardTitle }}</RouterLink>
      </div>
    </template>
  </div>

  <!-- The action, always reachable. -->
  <nav v-if="event && !loading" class="action-bar">
    <div class="action-bar__inner">
      <button class="btn btn--ghost" type="button" @click="share">{{ t.shareLink }}</button>
      <button
        v-if="!joined"
        class="btn action-bar__grow"
        type="button"
        :disabled="busy || !canJoinNow"
        data-testid="join"
        @click="join"
      >
        {{ joinLabel }}
      </button>
      <button
        v-else
        class="btn btn--ghost action-bar__grow"
        type="button"
        :disabled="busy || !event.can_withdraw"
        data-testid="withdraw"
        @click="withdraw"
      >
        {{ t.withdraw }}
      </button>
    </div>
  </nav>
</template>
