<script setup lang="ts">
/**
 * Sessions you run, and what each one still needs.
 *
 * The organizer's jobs are otherwise only reachable by remembering which session
 * they belong to, which is exactly the bookkeeping this application exists to
 * remove. The server groups them: sessions coming up, and sessions waiting on an
 * action (a split to publish, money to collect).
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { call } from '@/api/client'
import type { HostingSummary } from '@/api/types'
import LoadingState from '@/components/LoadingState.vue'
import fmt from '@shared/format'
import { t } from '@/shared/i18n'
import { dateChip, statusLabel, whenText } from '@/shared/present'
import { toast } from '@/shared/toast'
import { session } from '@/stores/session'

const router = useRouter()
const summary = ref<HostingSummary | null>(null)
const loading = ref(true)

const toCollect = computed(() => summary.value?.to_collect)

/** The label for what a session is waiting on, from the shared dictionary. */
function needLabel(need: string): string {
  return t.value[`ha${need}`] ?? need
}

onMounted(async () => {
  await session.resume()
  if (!session.signedIn.value) {
    router.replace('/')
    return
  }
  try {
    summary.value = await call<HostingSummary>('event.hosting')
  } catch (error) {
    toast.showError(error)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="app app--with-bar">
    <header class="page-head">
      <div>
        <RouterLink class="back" to="/">{{ t.backCta }}</RouterLink>
        <h1 class="page-head__title">{{ t.hostingTitle }}</h1>
        <p class="page-head__sub">{{ t.hostingSub }}</p>
      </div>
    </header>

    <LoadingState v-if="loading" :rows="3" :hero="false" />

    <template v-else-if="summary">
      <!-- Money owed to you, across sessions. -->
      <div v-if="toCollect && toCollect.count > 0" class="card stack--tight">
        <span class="stat__label">{{ t.toCollectLabel }}</span>
        <div class="row--baseline row">
          <span v-if="!toCollect.mixed_currency" class="stat__value numeric">
            {{ fmt.money(toCollect.total_minor, toCollect.currency) }}
          </span>
          <span class="small muted">
            <template v-if="!toCollect.mixed_currency">{{ toCollect.currency }} · </template>
            {{ toCollect.count }}
          </span>
        </div>
      </div>

      <!-- Waiting on you -->
      <template v-if="summary.actions.length">
        <div class="section">
          <span class="section__title">{{ t.needsYou }}</span>
          <span class="section__meta numeric">{{ summary.action_count }}</span>
        </div>
        <div class="stack">
          <RouterLink
            v-for="item in summary.actions"
            :key="item._id"
            class="card card--link"
            :to="`/bill/${item._id}`"
          >
            <div class="row--between">
              <span class="stack stack--tight" style="min-width: 0">
                <span class="event__title">{{ item.title }}</span>
                <span class="event__meta">{{ whenText(item.start_local) }}</span>
              </span>
              <span class="event__side">
                <span class="pill pill--warn">{{ needLabel(item.need) }}</span>
                <span v-if="item.unpaid_minor" class="event__count">
                  {{ fmt.money(item.unpaid_minor, item.currency) }}
                </span>
              </span>
            </div>
          </RouterLink>
        </div>
      </template>

      <!-- Coming up -->
      <template v-if="summary.upcoming.length">
        <div class="section">
          <span class="section__title">{{ t.hostingUpcoming }}</span>
          <span class="section__meta numeric">{{ summary.upcoming.length }}</span>
        </div>
        <div class="stack">
          <RouterLink
            v-for="item in summary.upcoming"
            :key="item._id"
            class="card card--flush card--link"
            :to="`/manage/${item._id}`"
          >
            <div class="event">
              <div class="event__date" aria-hidden="true">
                <span class="event__day">{{ dateChip(item.start_local).day }}</span>
                <span class="event__month">{{ dateChip(item.start_local).month }}</span>
              </div>
              <div class="event__body">
                <span class="event__title">{{ item.title }}</span>
                <span class="event__meta">
                  {{ whenText(item.start_local, item.end_local) }}
                </span>
                <span v-if="item.court_status === 'NOT_BOOKED'" class="tiny warn-text">
                  {{ t.courtsNotBooked }}
                </span>
              </div>
              <div class="event__side">
                <span class="pill pill--quiet">{{ statusLabel(item.status, t) }}</span>
                <span class="event__count">{{ item.roster_count }}/{{ item.capacity }}</span>
              </div>
            </div>
          </RouterLink>
        </div>
      </template>

      <div v-if="!summary.upcoming.length && !summary.actions.length" class="empty">
        <div class="empty__mark" aria-hidden="true" />
        {{ t.hostingNone }}
      </div>
    </template>
  </div>

  <nav class="action-bar">
    <div class="action-bar__inner">
      <RouterLink class="btn btn--block center" to="/create">{{ t.newSession }}</RouterLink>
    </div>
  </nav>
</template>
