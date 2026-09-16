<script setup lang="ts">
/**
 * Loading placeholder shaped like the content that is coming.
 *
 * Replaces a centred "Loading…", which on a slow connection reads as a broken
 * page rather than a fast one.
 */
withDefaults(defineProps<{ rows?: number; hero?: boolean }>(), { rows: 3, hero: true })
</script>

<template>
  <div class="stack" aria-hidden="true">
    <div v-if="hero" class="card stack">
      <div class="row">
        <div class="skeleton" style="width: 56px; height: 56px; border-radius: 14px" />
        <div class="stack stack--tight" style="flex: 1">
          <div class="skeleton skeleton--title" style="width: 70%" />
          <div class="skeleton skeleton--text" style="width: 45%" />
        </div>
      </div>
      <div class="skeleton" style="height: 10px; border-radius: 999px" />
    </div>

    <div v-for="row in rows" :key="row" class="skeleton skeleton--block" />
  </div>
  <span class="visually-hidden" role="status">{{ 'Loading' }}</span>
</template>
