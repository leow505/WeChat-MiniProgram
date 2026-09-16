<script setup lang="ts">
/**
 * The money. Publishing the split, and tracking who has paid.
 *
 * Amounts are integer minor units with a currency code throughout — never floats,
 * and never divided by 100, because JPY and KRW have no fractional part. The input
 * goes through `toMinor` on the way in and `toMajorInput` on the way out
 * (DESIGN.md §10.3).
 *
 * Every head that held a seat pays: there is no attendance step, because a seat
 * was yours to release or to fill. `WAIVE` covers the genuinely unfair case.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import type { BillRow, BillView } from '@/api/bill-types'
import { call } from '@/api/client'
import LoadingState from '@/components/LoadingState.vue'
import fmt from '@shared/format'
import { t } from '@/shared/i18n'
import { initial, whenText } from '@/shared/present'
import { toast } from '@/shared/toast'
import { session } from '@/stores/session'

const route = useRoute()
const router = useRouter()
const eventId = computed(() => String(route.params.id ?? ''))

const view = ref<BillView | null>(null)
const loading = ref(true)
const busy = ref(false)
const totalInput = ref('')
const note = ref('')

const currency = computed(() => view.value?.event.currency ?? 'SGD')
const published = computed(() => Boolean(view.value?.bill) && view.value?.bill?.status !== 'DRAFT')

const money = (minor: number) => fmt.money(minor, currency.value)

/** What publishing the amount currently typed would charge each person. */
const previewTotalMinor = computed(() =>
  totalInput.value ? fmt.toMinor(totalInput.value, currency.value) : 0
)

const outstanding = computed(() => view.value?.totals.unpaid_minor ?? 0)
const unpaidRows = computed(() => (view.value?.rows ?? []).filter((row) => row.status === 'UNPAID'))
const settledAll = computed(() => published.value && unpaidRows.value.length === 0)

async function load(): Promise<void> {
  try {
    const result = await call<BillView>('bill.get', { eventId: eventId.value })
    view.value = result
    if (result.bill?.total_minor) {
      totalInput.value = fmt.toMajorInput(result.bill.total_minor, result.event.currency)
    }
    note.value = result.bill?.payment_note ?? ''
  } catch (error) {
    toast.showError(error)
    router.replace(`/invite/${eventId.value}`)
  } finally {
    loading.value = false
  }
}

async function publish(): Promise<void> {
  const totalMinor = previewTotalMinor.value
  if (totalMinor <= 0) {
    toast.show(t.value.noTotalYet)
    return
  }
  busy.value = true
  try {
    await call('bill.publish', {
      eventId: eventId.value,
      total_minor: totalMinor,
      payment_note: note.value.trim(),
    })
    await load()
    toast.show(t.value.billPublished)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function setPaid(row: BillRow, paid: boolean): Promise<void> {
  busy.value = true
  try {
    await call('bill.markPaid', { eventId: eventId.value, targetOpenid: row.openid, paid })
    await load()
    toast.show(paid ? t.value.markedPaid : t.value.markUnpaid)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function waive(row: BillRow, waived: boolean): Promise<void> {
  busy.value = true
  try {
    await call('bill.waive', { eventId: eventId.value, targetOpenid: row.openid, waived })
    await load()
    toast.show(t.value.waived)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

/** A player's own "I've paid" flag. It informs; it does not settle the share. */
async function claimPaid(): Promise<void> {
  busy.value = true
  try {
    await call('bill.claimPaid', { eventId: eventId.value })
    await load()
    toast.show(t.value.claimedPaidNote)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

async function voidBill(): Promise<void> {
  if (!window.confirm(t.value.confirmVoidBillBody)) return
  busy.value = true
  try {
    await call('bill.void', { eventId: eventId.value })
    await load()
    toast.show(t.value.billVoided)
  } catch (error) {
    toast.showError(error)
  } finally {
    busy.value = false
  }
}

function statusPill(row: BillRow): { text: string; tone: string } {
  if (row.status === 'PAID') return { text: t.value.ssPAID, tone: 'pill--good' }
  if (row.status === 'WAIVED') return { text: t.value.ssWAIVED, tone: 'pill--quiet' }
  if (row.claimed_paid_at) return { text: t.value.claimedPaid, tone: 'pill--warn' }
  if (row.overdue) return { text: t.value.ssUNPAID, tone: 'pill--danger' }
  return { text: t.value.ssUNPAID, tone: '' }
}

onMounted(async () => {
  await session.resume()
  if (!session.signedIn.value) {
    router.replace('/')
    return
  }
  await load()
})
</script>

<template>
  <div class="app">
    <LoadingState v-if="loading" :rows="2" />

    <template v-else-if="view">
      <header class="page-head">
        <div>
          <RouterLink class="back" :to="`/invite/${eventId}`">{{ t.backCta }}</RouterLink>
          <span class="page-head__eyebrow">{{ t.billTitle }}</span>
          <h1 class="page-head__title">{{ view.event.title }}</h1>
          <p class="page-head__sub">
            {{ whenText(view.event.start_local, view.event.end_local) }}
          </p>
        </div>
      </header>

      <!-- A player's own share. -->
      <template v-if="!view.is_manager">
        <template v-if="view.my_share">
          <div class="card stack">
            <div class="row--between">
              <div>
                <span class="stat__label">{{ t.myShareTitle }}</span>
                <div class="stat__value">{{ money(view.my_share.share_minor) }}</div>
                <span class="tiny faint">{{ currency }}</span>
              </div>
              <span
                class="pill"
                :class="{
                  'pill--good': view.my_share.status === 'PAID',
                  'pill--danger': view.my_share.status === 'UNPAID' && view.my_share.overdue,
                  'pill--quiet': view.my_share.status === 'WAIVED',
                }"
              >
                {{
                  view.my_share.status === 'PAID'
                    ? t.ssPAID
                    : view.my_share.status === 'WAIVED'
                      ? t.ssWAIVED
                      : t.ssUNPAID
                }}
              </span>
            </div>

            <p v-if="view.bill?.payment_note" class="small muted">{{ view.bill.payment_note }}</p>

            <p v-if="view.my_share.claimed_paid_at" class="notice notice--quiet">
              <span class="notice__body">{{ t.claimedPaidNote }}</span>
            </p>
            <button
              v-else-if="view.my_share.status === 'UNPAID'"
              class="btn"
              type="button"
              :disabled="busy"
              @click="claimPaid"
            >
              {{ t.iPaidCta }}
            </button>
            <span class="hint">{{ t.claimPaidHint }}</span>
          </div>
        </template>
        <div v-else class="empty">
          <div class="empty__mark" aria-hidden="true" />
          {{ t.noBillYet }}
        </div>
      </template>

      <!-- The organizer's view: set the amount, then track payment. -->
      <template v-else>
        <div class="card stack">
          <label class="field">
            <span class="field__label">{{ t.billTotalLabel }} · {{ currency }}</span>
            <input
              v-model="totalInput"
              class="input input--figure"
              type="text"
              inputmode="decimal"
              :placeholder="fmt.toMajorInput(0, currency)"
            />
            <span class="hint">{{ t.totalPaidHint }}</span>
          </label>

          <label class="field">
            <span class="field__label">{{ t.billNoteLabel }}</span>
            <input v-model="note" class="input" type="text" maxlength="120" />
          </label>

          <div v-if="previewTotalMinor > 0" class="card card--quiet row--between">
            <span class="stat__label">{{ t.perShareLabel }}</span>
            <span class="numeric strong" style="font-size: var(--t-h2)">
              {{ money(view.preview.per_unit_minor) }}
            </span>
          </div>

          <button
            class="btn"
            type="button"
            :disabled="busy || previewTotalMinor <= 0"
            @click="publish"
          >
            {{ published ? t.billRepublishCta : t.billPublishCta }}
          </button>
        </div>

        <div class="section">
          <span class="section__title">{{ t.sharesTitle }}</span>
          <span v-if="published" class="section__meta numeric">
            {{ view.totals.settled_count }}/{{ view.totals.share_count }}
          </span>
        </div>

        <div class="card card--flush">
          <div class="list">
            <div v-for="row in view.rows" :key="row.openid" class="list__row">
              <span class="avatar" :class="{ 'avatar--me': row.is_me }" aria-hidden="true">
                {{ initial(row.name) }}
              </span>
              <span class="list__name">
                {{ row.name }}
                <span v-if="row.guest_count" class="faint small">+{{ row.guest_count }}</span>
                <span v-if="row.off_roster" class="tiny faint"> · {{ t.offRoster }}</span>
              </span>
              <span v-if="published || row.preview_minor > 0" class="list__value">
                {{ money(published ? row.share_minor : row.preview_minor) }}
              </span>
              <span v-else class="list__value faint">—</span>
              <span v-if="published" class="pill" :class="statusPill(row).tone">
                {{ statusPill(row).text }}
              </span>
            </div>
          </div>
        </div>

        <!-- Marking payment, kept out of the list above so that stays readable. -->
        <template v-if="published">
          <div class="section">
            <span class="section__title">{{ t.markPaid }}</span>
            <span v-if="!settledAll" class="section__meta warn-text numeric">
              {{ money(outstanding) }}
            </span>
          </div>

          <div v-if="settledAll" class="notice notice--good">
            <span class="notice__body">
              {{ t.ssPAID }} · <strong class="numeric">{{ money(view.totals.paid_minor) }}</strong>
            </span>
          </div>

          <div v-else class="card stack">
            <div v-for="row in unpaidRows" :key="row.openid" class="row--between">
              <span class="small strong">{{ row.name }}</span>
              <span class="row" style="flex: 0 0 auto">
                <span class="list__value">{{ money(row.share_minor) }}</span>
                <button
                  class="btn btn--sm"
                  type="button"
                  :disabled="busy"
                  @click="setPaid(row, true)"
                >
                  {{ t.markPaid }}
                </button>
                <button
                  class="btn btn--sm btn--ghost"
                  type="button"
                  :disabled="busy"
                  @click="waive(row, true)"
                >
                  {{ t.waiveShare }}
                </button>
              </span>
            </div>
          </div>

          <div class="section" />
          <button
            class="btn btn--danger btn--block"
            type="button"
            :disabled="busy"
            @click="voidBill"
          >
            {{ t.voidBill }}
          </button>
          <p class="hint">{{ t.billVoidNote }}</p>
        </template>
      </template>
    </template>
  </div>
</template>
