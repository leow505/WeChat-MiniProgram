<script setup lang="ts">
/**
 * App shell.
 *
 * Deliberately thin: the invite view has to work for somebody who arrived from a
 * chat link and has never seen this app, so there is no global chrome implying
 * they must sign in or navigate somewhere first. Each view owns its own layout
 * wrapper, because the invite and dashboard need different bottom padding for
 * their action bars.
 */
import ToastHost from '@/components/ToastHost.vue'
</script>

<template>
  <RouterView />
  <ToastHost />
</template>
