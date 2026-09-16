/**
 * Transient feedback, shown by ToastHost.
 *
 * Errors arrive from the server as codes; `showError` localizes them through the
 * shared dictionary so the wording lives in one place (DESIGN.md §10.1).
 */

import { ref } from 'vue'

import { errorText } from './i18n'

const message = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

function show(next: string, ms = 2400): void {
  message.value = next
  clearTimeout(timer)
  timer = setTimeout(() => {
    message.value = ''
  }, ms)
}

export const toast = {
  message,
  show,
  /** Show a server failure in the reader's language. */
  showError(error: unknown): void {
    show(errorText(error), 3000)
  },
  clear(): void {
    clearTimeout(timer)
    message.value = ''
  },
}
