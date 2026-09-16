<script setup lang="ts">
/**
 * Create a session, and get a link to post in the group chat.
 *
 * This view is what lets a LINE- or WhatsApp-only club run itself: until it
 * existed, only somebody inside WeChat could start a session.
 *
 * The form asks for the few things a session cannot be posted without. Everything
 * else has a defensible default and can be changed afterwards from the manage
 * view, because the cost of a long form here is that nobody fills it in.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { call } from '@/api/client'
import fmt from '@shared/format'
import formats from '@shared/formats'
import { t } from '@/shared/i18n'
import { formatLabel } from '@/shared/present'
import { toast } from '@/shared/toast'
import { session } from '@/stores/session'

const router = useRouter()

const title = ref('')
const startLocal = ref(defaultStart())
const hours = ref(2)
const venueName = ref('')
const venueAddress = ref('')
const courts = ref(2)
const capacity = ref(12)
const formatTemplate = ref('DOUBLES')
const maxGuests = ref(1)
const currency = ref('SGD')
const costEstimate = ref('')
const busy = ref(false)
const createdId = ref('')

/** Next whole hour, a week out: the common case is "next weekend". */
function defaultStart(): string {
  const when = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  when.setMinutes(0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:00`
}

/** Formats in the shared display order: most common first. */
const formatOptions = computed(() =>
  formats.ORDER.map((value) => ({ value, label: formatLabel(value, t.value) }))
)

const currencies = computed(() => fmt.CURRENCIES)

/** A balanced format seats a fixed male/female split (DESIGN.md §3.9). */
const isBalanced = computed(() => formats.isBalanced(formatTemplate.value))

/** What the chosen format across this many courts implies. */
const implied = computed(() => formats.capacityFor(formatTemplate.value, courts.value))

/**
 * Choosing a format and a court count is how an organizer actually thinks about
 * capacity — "two courts of doubles" is eight people. So capacity follows from
 * those, and stays editable afterwards because a template is a starting point
 * rather than a constraint.
 */
watch([formatTemplate, courts], () => {
  capacity.value = implied.value.capacity
})

const capacityProblem = computed(() => {
  if (capacity.value <= 0) return t.value.vCapacityZero
  if (isBalanced.value && capacity.value % 2 !== 0) return t.value.capacityEven
  return ''
})

const canSubmit = computed(
  () =>
    title.value.trim().length > 0 &&
    venueName.value.trim().length > 0 &&
    startLocal.value.length >= 16 &&
    !capacityProblem.value &&
    !busy.value
)

const inviteUrl = computed(() =>
  createdId.value ? `${window.location.origin}/invite/${createdId.value}` : ''
)

/**
 * Wall clock to timestamp. The pair is stored deliberately: the timestamp drives
 * every comparison, the string drives every display (DESIGN.md §10.2).
 */
function timestampOf(local: string): number {
  const [date, time] = local.split('T')
  const [year, month, day] = (date ?? '').split('-').map(Number)
  const [hour, minute] = (time ?? '').split(':').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, 0, 0).getTime()
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  try {
    const startAt = timestampOf(startLocal.value)
    const byGender = implied.value.by_gender
    const result = await call<{ eventId: string }>('event.create', {
      event: {
        title: title.value.trim(),
        venue_snapshot: {
          name: venueName.value.trim(),
          address: venueAddress.value.trim(),
        },
        start_at: startAt,
        end_at: startAt + hours.value * 60 * 60 * 1000,
        start_local: startLocal.value,
        end_local: fmt.addHoursLocal(startLocal.value, hours.value),
        format_template: formatTemplate.value,
        roster_mode: isBalanced.value ? 'GENDER_BALANCED' : 'OPEN',
        capacity: capacity.value,
        capacity_by_gender: isBalanced.value ? byGender : null,
        court_count: courts.value,
        max_guests_per_member: maxGuests.value,
        on_full: 'WAITLIST',
        waitlist_capacity: 4,
        currency: currency.value,
        cost_estimate_per_person: costEstimate.value
          ? fmt.toMinor(costEstimate.value, currency.value)
          : 0,
      },
    })
    createdId.value = result.eventId
    toast.show(t.value.createdToast)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    toast.show(t.value.inviteLinkCopied)
  } catch {
    toast.show(inviteUrl.value)
  }
}

async function shareLink(): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ title: title.value, url: inviteUrl.value })
      return
    } catch {
      return
    }
  }
  await copyLink()
}

onMounted(async () => {
  await session.resume()
  if (!session.signedIn.value) router.replace('/')
})
</script>

<template>
  <div class="app" :class="{ 'app--with-bar': !createdId }">
    <header class="page-head">
      <div>
        <RouterLink class="back" to="/">{{ t.backCta }}</RouterLink>
        <h1 class="page-head__title">{{ t.createTitle }}</h1>
        <p class="page-head__sub">{{ t.createSub }}</p>
      </div>
    </header>

    <!-- Created. The link is the product, so it becomes the whole screen. -->
    <template v-if="createdId">
      <div class="card stack">
        <div class="row">
          <span class="pill pill--good">{{ t.createdToast }}</span>
        </div>
        <div class="code">{{ inviteUrl }}</div>
        <div class="btn-row">
          <button class="btn" type="button" @click="shareLink">{{ t.shareLink }}</button>
          <button class="btn btn--ghost" type="button" @click="copyLink">
            {{ t.copyLinkNow }}
          </button>
        </div>
      </div>

      <div class="section" />
      <div class="stack stack--tight">
        <RouterLink class="btn btn--soft center" :to="`/invite/${createdId}`">
          {{ t.rosterTitle }}
        </RouterLink>
        <RouterLink class="btn btn--link center" :to="`/manage/${createdId}`">
          {{ t.manageSession }}
        </RouterLink>
      </div>
    </template>

    <!-- The form -->
    <template v-else>
      <div class="card stack">
        <label class="field">
          <span class="field__label">{{ t.title }}</span>
          <input
            v-model="title"
            class="input"
            type="text"
            maxlength="40"
            :placeholder="t.newGame"
          />
        </label>

        <label class="field">
          <span class="field__label">{{ t.whenLabel }}</span>
          <input v-model="startLocal" class="input" type="datetime-local" />
        </label>

        <label class="field">
          <span class="field__label">{{ t.durationLabel }}</span>
          <input v-model.number="hours" class="input" type="number" min="1" max="8" step="1" />
        </label>
      </div>

      <div class="section">
        <span class="section__title">{{ t.venueNameLabel }}</span>
      </div>
      <div class="card stack">
        <label class="field">
          <span class="field__label">{{ t.venueNameLabel }}</span>
          <input v-model="venueName" class="input" type="text" maxlength="60" />
        </label>
        <label class="field">
          <span class="field__label">{{ t.venueAddressLabel }}</span>
          <input v-model="venueAddress" class="input" type="text" maxlength="120" />
        </label>
      </div>

      <div class="section">
        <span class="section__title">{{ t.format }}</span>
      </div>
      <div class="card stack">
        <div class="choice" role="group" :aria-label="t.format">
          <button
            v-for="option in formatOptions"
            :key="option.value"
            type="button"
            class="chip"
            :aria-pressed="formatTemplate === option.value"
            @click="formatTemplate = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <label class="field">
          <span class="field__label">{{ t.courtsLabel }}</span>
          <input v-model.number="courts" class="input" type="number" min="1" max="12" />
          <span class="hint">{{ t.courtHint }}</span>
        </label>

        <label class="field">
          <span class="field__label">{{ t.capacityLabel }}</span>
          <input
            v-model.number="capacity"
            class="input input--figure"
            :class="{ 'input--invalid': Boolean(capacityProblem) }"
            type="number"
            min="2"
            max="60"
            :step="isBalanced ? 2 : 1"
          />
          <span v-if="capacityProblem" class="hint hint--error">{{ capacityProblem }}</span>
          <span v-else-if="isBalanced && implied.by_gender" class="hint">
            {{ t.maleSlots }} {{ implied.by_gender.male }} · {{ t.femaleSlots }}
            {{ implied.by_gender.female }}
          </span>
        </label>

        <div class="field">
          <span class="field__label">{{ t.guestsPerMember }}</span>
          <div class="choice" role="group">
            <button
              v-for="count in 4"
              :key="count"
              type="button"
              class="chip"
              :aria-pressed="maxGuests === count - 1"
              @click="maxGuests = count - 1"
            >
              {{ count - 1 }}
            </button>
          </div>
          <span class="hint">{{ t.guestsHint }}</span>
        </div>
      </div>

      <div class="section">
        <span class="section__title">{{ t.costSplit }}</span>
      </div>
      <div class="card stack">
        <label class="field">
          <span class="field__label">{{ t.currency ?? 'Currency' }}</span>
          <select v-model="currency" class="select">
            <option v-for="code in currencies" :key="code" :value="code">{{ code }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">{{ t.estimatedPerPerson }}</span>
          <input
            v-model="costEstimate"
            class="input input--figure"
            type="text"
            inputmode="decimal"
          />
          <span class="hint">{{ t.totalPaidHint }}</span>
        </label>
      </div>
    </template>
  </div>

  <nav v-if="!createdId" class="action-bar">
    <div class="action-bar__inner">
      <button
        class="btn btn--block"
        type="button"
        :disabled="!canSubmit"
        data-testid="post"
        @click="submit"
      >
        {{ t.post }}
      </button>
    </div>
  </nav>
</template>
