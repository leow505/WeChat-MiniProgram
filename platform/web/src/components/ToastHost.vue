<script setup lang="ts">
/**
 * Transient messages. One at a time, dismissed on a timer — the same
 * lightweight feedback the mini program's `wx.showToast` gives.
 */
import { toast } from '@/shared/toast'
</script>

<template>
  <Transition name="toast">
    <div v-if="toast.message.value" class="toast" role="status" aria-live="polite">
      {{ toast.message.value }}
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}
</style>
