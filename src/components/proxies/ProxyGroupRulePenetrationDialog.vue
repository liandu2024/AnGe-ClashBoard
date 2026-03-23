<template>
  <DialogWrapper
    v-model="proxyGroupRulePenetrationDialogVisible"
    :mobile-fullscreen="true"
    :box-class="'max-w-256 md:max-w-256'"
    :header-class="'max-md:px-3'"
    :content-class="'max-md:px-3 max-md:py-3 md:h-[90dvh] md:max-h-[90dvh] md:overflow-hidden'"
  >
    <template #title-left>
      <div class="flex min-w-0 items-center gap-1">
        <div
          v-if="dialogGroup?.icon"
          class="flex h-5 w-5 shrink-0 items-center justify-center"
        >
          <ProxyIcon
            :icon="dialogGroup.icon"
            :size="20"
            :margin="0"
          />
        </div>
        <div class="min-w-0 flex items-center gap-0.5">
          <span class="truncate text-base leading-6 font-semibold">
            {{ proxyGroupRulePenetrationDialogGroupName }}
          </span>
          <span class="text-base-content/40 mx-1 shrink-0 text-sm leading-5 font-normal">|</span>
          <span class="truncate text-sm leading-5 font-semibold">
            {{ $t('domainPenetration') }}
          </span>
        </div>
      </div>
    </template>

    <template #title-right>
      <div class="ml-auto mr-8 flex shrink-0 justify-end md:hidden">
        <TextInput
          class="domain-penetration-title-search w-32 max-w-[40vw] md:w-96 md:max-w-none"
          v-model="proxyGroupRulePenetrationDialogSearch"
          :placeholder="$t('domainPenetrationSearchPlaceholder')"
          :clearable="true"
        />
      </div>
    </template>

    <div class="flex h-full min-h-0 min-w-0 flex-col gap-3 md:gap-4">
      <div class="flex items-center gap-4 max-md:block">
        <div class="domain-penetration-mode-shell min-w-0 overflow-x-auto">
          <div
            role="tablist"
            class="domain-penetration-mode bg-base-200/80 inline-flex h-9 min-w-max items-center gap-1 rounded-md p-1 md:h-10"
          >
            <button
              v-for="tab in tabs"
              :key="tab.value"
              type="button"
              role="tab"
              class="domain-penetration-mode-btn shrink-0 rounded-md px-3 py-1 text-sm leading-5 font-medium whitespace-nowrap transition-colors md:px-4 md:py-1.5"
              :class="[
                proxyGroupRulePenetrationDialogTab === tab.value && !tab.disabled
                  ? 'bg-base-100 text-base-content shadow-sm cursor-pointer'
                  : 'text-base-content/60 hover:text-base-content cursor-pointer',
                tab.disabled && 'text-base-content/30 opacity-55 cursor-default pointer-events-none hover:text-base-content/30',
              ]"
              :aria-disabled="tab.disabled"
              @click="!tab.disabled && (proxyGroupRulePenetrationDialogTab = tab.value)"
            >
              {{ tab.displayLabel }}
            </button>
          </div>
        </div>

        <div class="ml-auto hidden w-96 max-w-[38vw] shrink-0 justify-end md:flex">
          <TextInput
            class="w-full"
            v-model="proxyGroupRulePenetrationDialogSearch"
            :placeholder="$t('domainPenetrationSearchPlaceholder')"
            :clearable="true"
          />
        </div>
      </div>

      <div class="border-base-300/60 flex min-h-0 flex-1 flex-col overflow-hidden rounded-box border">
        <div
          v-if="cacheHintText"
          class="border-base-300/60 bg-base-200/40 border-b px-3 py-2 text-sm"
        >
          {{ cacheHintText }}
        </div>

        <div
          ref="tableShellRef"
          class="domain-penetration-table-shell min-h-0 flex-1 overflow-auto p-1.5 md:p-2"
          @scroll.passive="handleTableScroll"
        >
          <template v-if="proxyGroupRulePenetrationDialogLoading">
            <div class="flex min-h-56 items-center justify-center px-4 text-sm">
              {{ $t('domainPenetrationLoading') }}
            </div>
          </template>
          <template v-else-if="proxyGroupRulePenetrationDialogError">
            <div class="flex min-h-56 items-center justify-center px-4 text-sm">
              {{ proxyGroupRulePenetrationDialogError }}
            </div>
          </template>
          <template v-else-if="proxyGroupRulePenetrationDialogEntries.length === 0">
            <div class="flex min-h-56 items-center justify-center px-4 text-sm">
              {{ $t('domainPenetrationEmpty') }}
            </div>
          </template>
          <template v-else>
            <table class="domain-penetration-table table table-sm table-pin-rows table-auto w-max min-w-full rounded-none select-text">
              <thead class="bg-base-100 sticky -top-2 z-10">
                <tr>
                  <th
                    v-for="column in columns"
                    :key="column.key"
                    class="select-none whitespace-nowrap"
                    :class="column.width"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-1 text-left"
                      :class="column.sortable && 'cursor-pointer'"
                      @click="column.sortable && toggleSort(column.key)"
                    >
                      <span>{{ column.label }}</span>
                      <ArrowUpCircleIcon
                        v-if="proxyGroupRulePenetrationDialogSortKey === column.key && proxyGroupRulePenetrationDialogSortDirection === 'asc'"
                        class="h-4 w-4"
                      />
                      <ArrowDownCircleIcon
                        v-else-if="proxyGroupRulePenetrationDialogSortKey === column.key && proxyGroupRulePenetrationDialogSortDirection === 'desc'"
                        class="h-4 w-4"
                      />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(item, index) in proxyGroupRulePenetrationDialogEntries"
                  :key="`${item.type}-${item.content}-${item.params}-${item.raw}-${index}`"
                  :class="[index % 2 === 0 ? 'bg-base-100' : 'bg-base-200/70', 'select-text']"
                >
                  <td class="align-top text-sm font-medium whitespace-nowrap select-text cursor-text">
                    {{ getTypeLabel(item.type) }}
                  </td>
                  <td class="align-top text-sm whitespace-nowrap select-text cursor-text">
                    {{ item.content || '-' }}
                  </td>
                  <td class="align-top text-sm whitespace-nowrap select-text cursor-text">
                    {{ item.params || '-' }}
                  </td>
                  <td class="text-base-content/75 align-top whitespace-nowrap font-mono text-xs md:text-sm select-text cursor-text">
                    {{ item.raw }}
                  </td>
                </tr>
              </tbody>
            </table>

            <div
              v-if="proxyGroupRulePenetrationDialogLoadingMore"
              class="text-base-content/70 bg-base-100/80 sticky bottom-0 flex items-center justify-center py-2 text-sm"
            >
              {{ $t('domainPenetrationLoading') }}
            </div>
          </template>
        </div>
      </div>
    </div>
  </DialogWrapper>
</template>

<script setup lang="ts">
import {
  isProxyGroupRuleCacheEmpty,
  loadProxyGroupRulePenetration,
  proxyGroupRulePenetrationDialogCounts,
  proxyGroupRulePenetrationDialogEntries,
  proxyGroupRulePenetrationDialogError,
  proxyGroupRulePenetrationDialogGroupName,
  proxyGroupRulePenetrationDialogHasMore,
  proxyGroupRulePenetrationDialogLoading,
  proxyGroupRulePenetrationDialogLoadingMore,
  proxyGroupRulePenetrationDialogMissingProviders,
  proxyGroupRulePenetrationDialogSearch,
  proxyGroupRulePenetrationDialogSortDirection,
  proxyGroupRulePenetrationDialogSortKey,
  proxyGroupRulePenetrationDialogTab,
  proxyGroupRulePenetrationDialogVisible,
  type ProxyGroupRulePenetrationFamily,
  type ProxyGroupRulePenetrationSortKey,
} from '@/store/proxyGroupRulePenetration'
import { proxyMap } from '@/store/proxies'
import { ArrowDownCircleIcon, ArrowUpCircleIcon } from '@heroicons/vue/24/outline'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import DialogWrapper from '../common/DialogWrapper.vue'
import TextInput from '../common/TextInput.vue'
import ProxyIcon from './ProxyIcon.vue'

const { t } = useI18n()
const tableShellRef = ref<HTMLElement | null>(null)
const debouncedSearchRevision = ref(0)
type DialogTabValue = Exclude<ProxyGroupRulePenetrationFamily, 'other'>
let searchTimer = 0
let fillingViewport = false

const tabs = computed(() => {
  return [
    {
      value: 'all' as DialogTabValue,
      label: t('all'),
      count: proxyGroupRulePenetrationDialogCounts.value.all,
      disabled: proxyGroupRulePenetrationDialogCounts.value.all === 0,
    },
    {
      value: 'domain' as DialogTabValue,
      label: t('domain'),
      count: proxyGroupRulePenetrationDialogCounts.value.domain,
      disabled: proxyGroupRulePenetrationDialogCounts.value.domain === 0,
    },
    {
      value: 'ip' as DialogTabValue,
      label: t('ip'),
      count: proxyGroupRulePenetrationDialogCounts.value.ip,
      disabled: proxyGroupRulePenetrationDialogCounts.value.ip === 0,
    },
    {
      value: 'port' as DialogTabValue,
      label: t('port'),
      count: proxyGroupRulePenetrationDialogCounts.value.port,
      disabled: proxyGroupRulePenetrationDialogCounts.value.port === 0,
    },
  ].map((tab) => ({
    ...tab,
    displayLabel: tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label,
  }))
})

const dialogGroup = computed(() => proxyMap.value[proxyGroupRulePenetrationDialogGroupName.value])

const ruleTypeLabelKeyMap: Record<string, string> = {
  DOMAIN: 'ruleTypeDomain',
  'DOMAIN-SUFFIX': 'ruleTypeDomainSuffix',
  'DOMAIN-KEYWORD': 'ruleTypeDomainKeyword',
  'IP-CIDR': 'ruleTypeDestinationIP',
  'IP-CIDR6': 'ruleTypeDestinationIP',
  'SRC-IP': 'ruleTypeSourceIP',
  'SRC-IP-CIDR': 'ruleTypeSourceIP',
  'SRC-IP-CIDR6': 'ruleTypeSourceIP',
  'DST-PORT': 'ruleTypeDestinationPort',
  'SRC-PORT': 'ruleTypeSourcePort',
  'IN-PORT': 'ruleTypeInboundPort',
  GEOIP: 'ruleTypeGeoIP',
  MATCH: 'ruleTypeMatch',
  FINAL: 'ruleTypeFinal',
}

const getTypeLabel = (type: string) => {
  return t(ruleTypeLabelKeyMap[type] || 'ruleTypeOther')
}

const columns = computed(() => {
  return [
    { key: 'type', label: t('category'), width: 'w-22 md:w-32', sortable: true },
    { key: 'content', label: t('content'), width: 'w-34 md:w-72', sortable: true },
    { key: 'params', label: t('params'), width: 'w-24 md:w-36', sortable: true },
    { key: 'raw', label: t('rawContent'), width: 'w-52 md:w-auto', sortable: true },
  ] as const
})

const toggleSort = (key: ProxyGroupRulePenetrationSortKey) => {
  if (proxyGroupRulePenetrationDialogSortKey.value !== key) {
    proxyGroupRulePenetrationDialogSortKey.value = key
    proxyGroupRulePenetrationDialogSortDirection.value = 'asc'
    return
  }

  if (proxyGroupRulePenetrationDialogSortDirection.value === 'asc') {
    proxyGroupRulePenetrationDialogSortDirection.value = 'desc'
    return
  }

  proxyGroupRulePenetrationDialogSortKey.value = null
  proxyGroupRulePenetrationDialogSortDirection.value = 'asc'
}

const maybeFillViewport = async () => {
  if (fillingViewport) {
    return
  }

  const shell = tableShellRef.value

  if (
    !shell ||
    !proxyGroupRulePenetrationDialogVisible.value ||
    proxyGroupRulePenetrationDialogLoading.value ||
    proxyGroupRulePenetrationDialogLoadingMore.value ||
    !proxyGroupRulePenetrationDialogHasMore.value
  ) {
    return
  }

  fillingViewport = true

  try {
    while (
      proxyGroupRulePenetrationDialogHasMore.value &&
      !proxyGroupRulePenetrationDialogLoading.value &&
      !proxyGroupRulePenetrationDialogLoadingMore.value &&
      shell.scrollHeight <= shell.clientHeight + 48
    ) {
      await loadProxyGroupRulePenetration(undefined, { append: true })
      await nextTick()
    }
  } finally {
    fillingViewport = false
  }
}

const handleTableScroll = () => {
  const shell = tableShellRef.value

  if (
    !shell ||
    proxyGroupRulePenetrationDialogLoading.value ||
    proxyGroupRulePenetrationDialogLoadingMore.value ||
    !proxyGroupRulePenetrationDialogHasMore.value
  ) {
    return
  }

  if (shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 160) {
    void loadProxyGroupRulePenetration(undefined, { append: true })
  }
}

watch(
  () => proxyGroupRulePenetrationDialogSearch.value,
  () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      debouncedSearchRevision.value += 1
    }, 180)
  },
)

watch(
  tabs,
  (items) => {
    const currentTab = items.find((item) => item.value === proxyGroupRulePenetrationDialogTab.value)

    if (currentTab && !currentTab.disabled) {
      return
    }

    proxyGroupRulePenetrationDialogTab.value = items.find((item) => !item.disabled)?.value || 'all'
  },
  { immediate: true },
)

watch(
  [
    () => proxyGroupRulePenetrationDialogTab.value,
    () => proxyGroupRulePenetrationDialogSortKey.value,
    () => proxyGroupRulePenetrationDialogSortDirection.value,
    debouncedSearchRevision,
  ],
  async () => {
    if (!proxyGroupRulePenetrationDialogVisible.value || !proxyGroupRulePenetrationDialogGroupName.value) {
      return
    }

    await loadProxyGroupRulePenetration()
    await nextTick()
    await maybeFillViewport()
  },
)

watch(
  () => proxyGroupRulePenetrationDialogEntries.value.length,
  async () => {
    await nextTick()
    await maybeFillViewport()
  },
)

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer)
})

const cacheHintText = computed(() => {
  if (proxyGroupRulePenetrationDialogMissingProviders.value.length === 0) {
    return ''
  }

  if (isProxyGroupRuleCacheEmpty()) {
    return t('domainPenetrationCacheEmptyHint')
  }

  return `${t('domainPenetrationMissingProviders')}: ${proxyGroupRulePenetrationDialogMissingProviders.value.join('、')}`
})
</script>

<style scoped>
.domain-penetration-table tbody::before {
  content: none !important;
  display: none !important;
}

.domain-penetration-table-shell,
.domain-penetration-table,
.domain-penetration-table tbody,
.domain-penetration-table-shell tbody,
.domain-penetration-table tr,
.domain-penetration-table-shell tr,
.domain-penetration-table td,
.domain-penetration-table-shell td,
.domain-penetration-table th,
.domain-penetration-table-shell th {
  -webkit-user-select: text;
  user-select: text;
}

.domain-penetration-title-search :deep(.input) {
  height: 2.25rem;
  min-height: 2.25rem;
  font-size: 0.875rem;
  line-height: 1.25rem;
}

.domain-penetration-mode-shell {
  scrollbar-width: none;
}

.domain-penetration-mode-shell::-webkit-scrollbar {
  display: none;
}
</style>
