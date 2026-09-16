<script setup lang="ts">
import { t } from '@/shared/i18n'
</script>

<template>
  <div class="app">
    <div class="empty" style="padding-top: 25vh">
      <div class="empty__mark" aria-hidden="true" />
      <h1 style="margin-bottom: var(--s-2)">{{ t.notFoundTitle }}</h1>
      <p class="muted small" style="margin-bottom: var(--s-5)">{{ t.notFoundBody }}</p>
      <RouterLink class="btn" to="/">{{ t.goHome }}</RouterLink>
    </div>
  </div>
</template>
