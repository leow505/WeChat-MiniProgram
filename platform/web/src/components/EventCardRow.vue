<script setup lang="ts">
/**
 * A session, as it appears in a list. Tapping it opens the invite view — the same
 * page a link from a group chat opens, so there is one canonical page per session.
 */
import { computed } from 'vue'

import type { EventCard } from '@/api/types'
import { t, tf } from '@/shared/i18n'
import {
  dateChip,
  fillPercent,
  money,
  seatsLeft,
  statusLabel,
  statusTone,
  whenText,
} from '@/shared/present'

const props = defineProps<{ event: EventCard }>()

const chip = computed(() => dateChip(props.event.start_local))
const tone = computed(() => statusTone(props.event))
const seats = computed(() => seatsLeft(props.event))

const stateText = computed(() => {
  if (props.event.my_state === 'ROSTER') return t.value.joined
  if (props.event.my_state === 'WAITLIST') return t.value.waitlistTitle
  return statusLabel(props.event.status, t.value)
})

const meta = computed(() =>
  [whenText(props.event.start_local, props.event.end_local), props.event.venue_snapshot?.name]
    .filter(Boolean)
    .join(' · ')
)

const owes = computed(
  () => props.event.my_share_status === 'UNPAID' && Boolean(props.event.my_share_minor)
)
</script>

<template>
  <RouterLink class="card card--flush card--link" :to="`/invite/${event._id}`">
    <div class="event">
      <div class="event__date" aria-hidden="true">
        <span class="event__day">{{ chip.day }}</span>
        <span class="event__month">{{ chip.month }}</span>
      </div>

      <div class="event__body">
        <span class="event__title">{{ event.title }}</span>
        <span class="event__meta">{{ meta }}</span>
        <span v-if="owes" class="tiny warn-text strong">
          {{ t.myShareTitle }} {{ money(event.my_share_minor ?? 0, event.currency) }}
        </span>
      </div>

      <div class="event__side">
        <span
          class="pill"
          :class="{
            'pill--good': tone === 'good',
            'pill--warn': tone === 'warn',
            'pill--quiet': tone === 'quiet',
          }"
        >
          {{ stateText }}
        </span>
        <span class="event__count">{{ event.roster_count }}/{{ event.capacity }}</span>
        <span v-if="seats > 0 && event.status === 'OPEN'" class="tiny faint">
          {{ tf('seatsLeftN', { n: seats }) }}
        </span>
      </div>
    </div>

    <div class="event__fill" :style="{ width: `${fillPercent(event)}%` }" />
  </RouterLink>
</template>
