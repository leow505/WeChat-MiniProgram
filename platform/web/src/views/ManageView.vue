<script setup lang="ts">
/**
 * Organizer tools for a live session: capacity and rules, courts, the roster, and
 * cancelling.
 *
 * Raising the capacity drains the waitlist automatically — the server promotes and
 * reports who moved, and that is worth telling the organizer, because those people
 * now expect a court.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { call } from '@/api/client'
import type { EventDetail, Person } from '@/api/types'
import LoadingState from '@/components/LoadingState.vue'
import PeopleList from '@/components/PeopleList.vue'
import SeatMeter from '@/components/SeatMeter.vue'
import { t, tf } from '@/shared/i18n'
import { initial, whenText } from '@/shared/present'
import { toast } from '@/shared/toast'
import { session } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const eventId = computed(() => String(route.params.id ?? ''))

const event = ref<EventDetail | null>(null)
const loading = ref(true)
const busy = ref(false)

// Editable rules
const capacity = ref(0)
const maxGuests = ref(0)
const minPlayers = ref(0)
const withdrawHours = ref(6)
const courtCount = ref(0)
/**
 * The court labels, comma-separated as they are typed on the mini program. Writing
 * them down is what books the courts (§3.5) — the server derives the status from
 * them — so without this field a web organizer could never clear "not booked".
 */
const courtLabels = ref('')

const removable = computed(() =>
  (event.value?.roster ?? []).filter((person) => person.openid !== event.value?.creator_openid)
)

const rulesChanged = computed(
  () =>
    Boolean(event.value) &&
    (capacity.value !== event.value?.capacity ||
      maxGuests.value !== event.value?.max_guests_per_member ||
      minPlayers.value !== (event.value?.min_players ?? 0) ||
      withdrawHours.value !== (event.value?.withdraw_hours_before ?? 6))
)

const shrinking = computed(
  () => Boolean(event.value) && capacity.value < (event.value?.roster_count ?? 0)
)

async function load(): Promise<void> {
  try {
    const detail = await call<EventDetail>('event.detail', { eventId: eventId.value })
    event.value = detail
    capacity.value = detail.capacity
    maxGuests.value = detail.max_guests_per_member
    minPlayers.value = detail.min_players ?? 0
    withdrawHours.value = detail.withdraw_hours_before ?? 6
    courtCount.value = detail.court_count ?? 0
    courtLabels.value = (detail.court_assignments ?? [])
      .map((court) => court.label)
      .filter(Boolean)
      .join(', ')
    if (!detail.can_manage) {
      // Not the organizer: the server would refuse anyway, but do not present
      // controls that cannot work.
      router.replace(`/invite/${eventId.value}`)
    }
  } catch (error) {
    toast.showError(error)
    router.replace('/')
  } finally {
    loading.value = false
  }
}

async function saveRules(): Promise<void> {
  busy.value = true
  try {
    const result = await call<{ promoted: Person[] }>('event.updateRules', {
      eventId: eventId.value,
      capacity: capacity.value,
      max_guests_per_member: maxGuests.value,
      min_players: minPlayers.value,
      withdraw_hours_before: withdrawHours.value,
    })
    await load()
    // Somebody moved off the waitlist because of this change; say so.
    toast.show(
      result.promoted?.length
        ? tf('promotedCount', { n: result.promoted.length })
        : t.value.rulesSavedToast
    )
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function saveCourts(): Promise<void> {
  busy.value = true
  try {
    await call('event.setCourts', {
      eventId: eventId.value,
      court_count: courtCount.value,
      court_assignments: courtLabels.value
        .split(/[,，]/)
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label) => ({ label })),
    })
    await load()
    toast.show(t.value.courtsSaved)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function remove(person: Person): Promise<void> {
  if (!window.confirm(tf('confirmRemove', { who: person.name }))) return
  busy.value = true
  try {
    await call('event.removeSignup', { eventId: eventId.value, targetOpenid: person.openid })
    await load()
    toast.show(t.value.removed)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function cancelSession(): Promise<void> {
  if (!window.confirm(t.value.confirmCancelGame)) return
  busy.value = true
  try {
    await call('event.cancel', { eventId: eventId.value })
    toast.show(t.value.cancelledToast)
    router.replace(`/invite/${eventId.value}`)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await session.resume()
  if (!session.signedIn.value) {
    router.replace('/')
    return
  }
  await load()
})
</script>

<template>
  <div class="app" :class="{ 'app--with-bar': rulesChanged }">
    <LoadingState v-if="loading" :rows="2" />

    <template v-else-if="event">
      <header class="page-head">
        <div>
          <RouterLink class="back" :to="`/invite/${event._id}`">{{ t.backCta }}</RouterLink>
          <span class="page-head__eyebrow">{{ t.manageTitle }}</span>
          <h1 class="page-head__title">{{ event.title }}</h1>
        </div>
      </header>

      <div class="card stack">
        <div class="stack stack--tight">
          <span class="strong">{{ whenText(event.start_local, event.end_local) }}</span>
          <span class="small muted">{{ event.venue_snapshot?.name }}</span>
        </div>
        <SeatMeter
          :roster-count="event.roster_count"
          :capacity="event.capacity"
          :waitlist-count="event.waitlist_count"
        />
      </div>

      <!-- Courts. Booking happens at the venue; this records what was booked. -->
      <div class="section">
        <span class="section__title">{{ t.courts }}</span>
        <span v-if="event.court_status === 'NOT_BOOKED'" class="pill pill--warn">
          {{ t.courtsNotBooked }}
        </span>
      </div>
      <div class="card stack">
        <label class="field">
          <span class="field__label">{{ t.courtLabelsField }}</span>
          <input v-model="courtLabels" class="input" type="text" placeholder="Court 3, Court 5" />
          <span class="hint">{{ t.courtLabelsHint }}</span>
        </label>
        <label class="field">
          <span class="field__label">{{ t.courtsLabel }}</span>
          <input
            v-model.number="courtCount"
            class="input input--figure"
            type="number"
            min="0"
            max="20"
          />
          <span class="hint">{{ t.courtHint }}</span>
        </label>
        <button class="btn btn--soft" type="button" :disabled="busy" @click="saveCourts">
          {{ t.saveCta }}
        </button>
      </div>

      <!-- Signup rules -->
      <div class="section">
        <span class="section__title">{{ t.signupRules }}</span>
      </div>
      <div class="card stack">
        <label class="field">
          <span class="field__label">{{ t.capacityLabel }}</span>
          <input
            v-model.number="capacity"
            class="input input--figure"
            :class="{ 'input--invalid': shrinking }"
            type="number"
            min="2"
            max="60"
          />
          <span v-if="shrinking" class="hint hint--error">
            {{ tf('capacityShrinkWarn', { n: event.roster_count - capacity }) }}
          </span>
          <span v-else-if="capacity > event.capacity && event.waitlist_count" class="hint">
            {{ t.reopenNote }}
          </span>
        </label>

        <label class="field">
          <span class="field__label">{{ t.guestsPerMember }}</span>
          <input v-model.number="maxGuests" class="input" type="number" min="0" max="3" />
        </label>

        <label class="field">
          <span class="field__label">{{ t.stopWithdrawBefore }}</span>
          <input v-model.number="withdrawHours" class="input" type="number" min="0" max="72" />
          <span class="hint">{{ t.withdrawNote }}</span>
        </label>

        <p class="hint">{{ t.signupRulesHint }}</p>
      </div>

      <!-- Roster. The organizer cannot be removed: they hold the court. -->
      <div class="section">
        <span class="section__title">{{ t.rosterManage }}</span>
        <span class="section__meta numeric">{{ event.roster.length }}</span>
      </div>
      <div class="card card--flush">
        <div class="list">
          <div v-for="person in removable" :key="person.openid" class="list__row">
            <span class="avatar" aria-hidden="true">{{ initial(person.name) }}</span>
            <span class="list__name">
              {{ person.name }}
              <span v-if="person.guest_count" class="faint small">+{{ person.guest_count }}</span>
            </span>
            <button
              class="btn btn--sm btn--danger"
              type="button"
              :disabled="busy"
              @click="remove(person)"
            >
              {{ t.removePlayer }}
            </button>
          </div>
          <p v-if="!removable.length" class="small faint" style="padding: var(--s-3) var(--s-4)">
            {{ t.noOneYet }}
          </p>
        </div>
      </div>

      <template v-if="event.waitlist.length">
        <div class="section">
          <span class="section__title">{{ t.waitlistTitle }}</span>
          <span class="section__meta numeric">{{ event.waitlist.length }}</span>
        </div>
        <div class="card card--flush">
          <PeopleList :people="event.waitlist" numbered />
        </div>
      </template>

      <div class="section" />
      <div class="stack stack--tight">
        <RouterLink class="btn btn--ghost center" :to="`/bill/${event._id}`">
          {{ t.costSplit }}
        </RouterLink>
        <button
          v-if="event.lifecycle === 'ACTIVE'"
          class="btn btn--danger"
          type="button"
          :disabled="busy"
          @click="cancelSession"
        >
          {{ t.cancelGame }}
        </button>
      </div>
    </template>
  </div>

  <!-- Only appears once something has changed, so it never covers content
       needlessly. -->
  <nav v-if="rulesChanged" class="action-bar">
    <div class="action-bar__inner">
      <button class="btn btn--block" type="button" :disabled="busy" @click="saveRules">
        {{ t.saveRules }}
      </button>
    </div>
  </nav>
</template>
