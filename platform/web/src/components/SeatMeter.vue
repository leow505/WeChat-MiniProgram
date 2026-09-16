<script setup lang="ts">
/**
 * How full a session is.
 *
 * For a small session, discrete pips are read at a glance — six pips with two
 * filled is instantly "four spaces free". Past about a dozen seats, counting pips
 * is slower than reading a bar, so it switches.
 */
import { computed } from 'vue'

import { t, tf } from '@/shared/i18n'

const props = defineProps<{
  rosterCount: number
  capacity: number
  waitlistCount?: number
  /** Suppresses the "n left" line when the caller shows it elsewhere. */
  hideNote?: boolean
}>()

const PIP_LIMIT = 12

const seatsLeft = computed(() => Math.max(0, props.capacity - props.rosterCount))
const full = computed(() => seatsLeft.value === 0)
const percent = computed(() =>
  props.capacity ? Math.min(100, Math.round((props.rosterCount / props.capacity) * 100)) : 0
)
const usePips = computed(() => props.capacity > 0 && props.capacity <= PIP_LIMIT)
const pips = computed(() =>
  Array.from({ length: props.capacity }, (_unused, index) => index < props.rosterCount)
)
</script>

<template>
  <div class="meter" :class="{ 'meter--full': full }">
    <div class="meter__head">
      <span class="meter__label">{{ t.rosterTitle }}</span>
      <span class="meter__count">{{ rosterCount }}/{{ capacity }}</span>
    </div>

    <div v-if="usePips" class="pips" role="img" :aria-label="`${rosterCount}/${capacity}`">
      <span
        v-for="(taken, index) in pips"
        :key="index"
        class="pip"
        :class="{ 'pip--taken': taken, 'pip--full': taken && full }"
      />
    </div>
    <div v-else class="meter__track" role="img" :aria-label="`${rosterCount}/${capacity}`">
      <div class="meter__fill" :style="{ width: `${percent}%` }" />
    </div>

    <span v-if="!hideNote" class="meter__note">
      {{ full ? t.noSeatsLeft : tf('seatsLeftN', { n: seatsLeft }) }}
      <template v-if="waitlistCount"> · {{ t.waitlistTitle }} {{ waitlistCount }} </template>
    </span>
  </div>
</template>
