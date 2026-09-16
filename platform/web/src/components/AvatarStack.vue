<script setup lang="ts">
/**
 * Overlapping avatars: "who is coming" without making the reader open a list.
 *
 * Faces (initials, here) are recognised faster than names in a column, which is
 * the point — the reader is usually checking whether their regular group is in.
 */
import { computed } from 'vue'

import type { Person } from '@/api/types'
import { initial } from '@/shared/present'

const props = withDefaults(defineProps<{ people: Person[]; max?: number }>(), { max: 6 })

const shown = computed(() => props.people.slice(0, props.max))
const overflow = computed(() => Math.max(0, props.people.length - props.max))
</script>

<template>
  <div v-if="people.length" class="row">
    <div class="avatars">
      <span
        v-for="person in shown"
        :key="person.openid"
        class="avatar avatar--sm"
        :class="{ 'avatar--me': person.is_me }"
        :title="person.name"
      >
        {{ initial(person.name) }}
      </span>
    </div>
    <span v-if="overflow" class="avatars__more">+{{ overflow }}</span>
  </div>
</template>
