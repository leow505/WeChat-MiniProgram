<script setup lang="ts">
/** The roster or waitlist. The caller's own row is marked. */
import type { Person } from '@/api/types'
import { t } from '@/shared/i18n'
import { initial } from '@/shared/present'

withDefaults(defineProps<{ people: Person[]; numbered?: boolean }>(), { numbered: false })
</script>

<template>
  <div class="list">
    <div v-for="(person, index) in people" :key="person.openid || index" class="list__row">
      <span v-if="numbered" class="list__index">{{ index + 1 }}</span>
      <span class="avatar" :class="{ 'avatar--me': person.is_me }" aria-hidden="true">
        {{ initial(person.name) }}
      </span>
      <span class="list__name">
        {{ person.name }}
        <span v-if="person.guest_count" class="faint small">+{{ person.guest_count }}</span>
      </span>
      <span v-if="person.is_organizer" class="pill pill--quiet pill--bare">{{ t.host }}</span>
    </div>

    <p v-if="!people.length" class="small faint" style="padding: var(--s-3) var(--s-4)">
      {{ t.noOneYet }}
    </p>
  </div>
</template>
