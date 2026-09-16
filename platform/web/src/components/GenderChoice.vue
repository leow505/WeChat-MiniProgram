<script setup lang="ts">
/** A gender choice. Only asked because balanced formats need it (DESIGN.md §3.9). */
import { t } from '@/shared/i18n'

import type { Gender } from '@/api/types'

const model = defineModel<Gender>({ required: true })

const options: { value: Gender; labelKey: string }[] = [
  { value: 'MALE', labelKey: 'genderMale' },
  { value: 'FEMALE', labelKey: 'genderFemale' },
]
</script>

<template>
  <div class="field">
    <span class="field__label">{{ t.gender }}</span>
    <div class="choice" role="group" :aria-label="t.gender">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="chip"
        :aria-pressed="model === option.value"
        @click="model = option.value"
      >
        {{ t[option.labelKey] }}
      </button>
    </div>
    <span class="hint">{{ t.genderWhy }}</span>
  </div>
</template>
