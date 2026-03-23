<template>
  <div class="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
    <div class="border-base-300/60 bg-base-100 flex min-h-0 flex-1 flex-col overflow-hidden rounded-box border p-3 md:p-4">
      <div class="relative z-30 shrink-0 pb-3">
        <div class="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:gap-3">
          <div class="flex min-w-0 items-center gap-2 md:contents">
            <details
              ref="domainGroupMenuRef"
              class="dropdown dropdown-bottom"
            >
              <summary
                class="select select-sm flex min-w-36 cursor-pointer list-none items-center gap-2 pr-9 md:min-w-44 [&::-webkit-details-marker]:hidden"
              >
                <ProxyIcon
                  v-if="selectedGroupIcon"
                  :icon="selectedGroupIcon"
                  :size="16"
                  :margin="0"
                />
                <QueueListIcon
                  v-else
                  class="text-base-content/60 h-4 w-4 shrink-0"
                />
                <span class="truncate">{{ selectedGroupItem?.label }}</span>
              </summary>

              <ul class="dropdown-content bg-base-100 rounded-box border-base-300/60 z-[60] mt-2 flex max-h-[min(24rem,calc(100vh-12rem))] min-w-56 flex-col overflow-y-auto overflow-x-hidden overscroll-contain border p-2 shadow-lg backdrop-blur-none [scrollbar-gutter:stable]">
                <li
                  v-for="group in domainGroupItems"
                  :key="group.key"
                  class="w-full list-none"
                >
                  <button
                    type="button"
                    class="hover:bg-base-200 focus:bg-base-200 flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left transition-colors"
                    @click="selectDomainGroup(group.key)"
                  >
                    <ProxyIcon
                      v-if="group.icon"
                      :icon="group.icon"
                      :size="16"
                      :margin="0"
                    />
                    <QueueListIcon
                      v-else
                      class="text-base-content/60 h-4 w-4 shrink-0"
                    />
                    <span class="truncate">{{ group.label }}</span>
                  </button>
                </li>
              </ul>
            </details>

            <select
              v-model="selectedProvider"
              class="select select-sm min-w-40 md:min-w-44"
              :disabled="providerOptions.length <= 1"
            >
              <option
                v-for="option in providerOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </div>

          <div class="scrollbar-hidden max-w-full overflow-x-auto md:ml-auto">
            <div
              role="tablist"
              class="domain-penetration-mode bg-base-200/80 inline-flex h-9 min-w-max items-center gap-1 rounded-md p-1 md:h-10"
            >
              <button
                v-for="tab in familyTabs"
                :key="tab.value"
                type="button"
                role="tab"
                class="domain-penetration-mode-btn shrink-0 rounded-md px-3 py-1 text-sm leading-5 font-medium whitespace-nowrap transition-colors md:px-4 md:py-1.5"
                :class="[
                  selectedFamily === tab.value && !tab.disabled
                    ? 'bg-base-100 text-base-content shadow-sm cursor-pointer'
                    : 'text-base-content/60 hover:text-base-content cursor-pointer',
                  tab.disabled &&
                    'text-base-content/30 opacity-55 cursor-default pointer-events-none hover:text-base-content/30',
                ]"
                :aria-disabled="tab.disabled"
                @click="!tab.disabled && (selectedFamily = tab.value)"
              >
                {{ tab.displayLabel }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        class="border-base-300/60 bg-base-100 flex min-h-0 flex-1 flex-col overflow-hidden rounded-box border backdrop-blur-none"
      >
        <div
          v-if="cacheHintText"
          class="border-base-300/60 bg-base-200/40 shrink-0 border-b px-3 py-2 text-sm"
        >
          {{ cacheHintText }}
        </div>

        <div
          ref="tableShellRef"
          class="domain-penetration-table-shell bg-base-100 min-h-0 flex-1 overflow-auto overscroll-contain backdrop-blur-none"
          @scroll.passive="handleTableScroll"
        >
          <template v-if="loading">
            <div class="flex min-h-56 items-center justify-center px-4 text-sm">
              {{ $t('domainPenetrationLoading') }}
            </div>
          </template>
          <template v-else-if="error">
            <div class="flex min-h-56 items-center justify-center px-4 text-sm">
              {{ error }}
            </div>
          </template>
          <template v-else-if="entries.length === 0">
            <div class="flex min-h-56 items-center justify-center px-4 text-sm">
              {{ $t('domainPenetrationEmpty') }}
            </div>
          </template>
          <template v-else>
            <table class="domain-penetration-table table table-sm table-pin-rows table-auto w-max min-w-full rounded-none select-text">
              <thead class="bg-base-100 sticky top-0 z-10">
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
                        v-if="sortKey === column.key && sortDirection === 'asc'"
                        class="h-4 w-4"
                      />
                      <ArrowDownCircleIcon
                        v-else-if="sortKey === column.key && sortDirection === 'desc'"
                        class="h-4 w-4"
                      />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(item, index) in entries"
                  :key="`${item.type}-${item.content}-${item.params}-${item.raw}-${index}`"
                  :class="[index % 2 === 0 ? 'bg-base-100' : 'bg-base-200', 'select-text']"
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
              v-if="loadingMore"
              class="text-base-content/70 bg-base-100/80 sticky bottom-0 flex items-center justify-center py-2 text-sm"
            >
              {{ $t('domainPenetrationLoading') }}
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  disableProxiesPageScroll,
  domainGroupProviderNames,
  domainGroupSearch,
  domainGroupSelectedName,
  domainGroupSelectedProvider,
  domainGroups,
} from '@/composables/proxies'
import {
  DOMAIN_GROUP_CUSTOM_SOURCE,
  DOMAIN_GROUP_POST_CUSTOM_KEY,
  DOMAIN_GROUP_PRE_CUSTOM_KEY,
  isDomainGroupCustomKey,
} from '@/helper/proxyDomainGroups'
import { proxyMap } from '@/store/proxies'
import { fetchRules, rules } from '@/store/rules'
import { ArrowDownCircleIcon, ArrowUpCircleIcon, QueueListIcon } from '@heroicons/vue/24/outline'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  ProxyGroupRulePenetrationEntry,
  ProxyGroupRulePenetrationFamily,
  ProxyGroupRulePenetrationSortKey,
} from '@/store/proxyGroupRulePenetration'
import ProxyIcon from './ProxyIcon.vue'

type GroupTabValue = Exclude<ProxyGroupRulePenetrationFamily, 'other'>
type FamilyTabItem = {
  value: GroupTabValue
  label: string
  count: number
  disabled: boolean
  displayLabel: string
}

type DomainGroupResponse = {
  cacheKey: string
  counts: {
    all: number
    domain: number
    ip: number
    port: number
  }
  items: ProxyGroupRulePenetrationEntry[]
  missingProviders: string[]
  page: number
  hasMore: boolean
}

const PAGE_SIZE = 100
const SEARCH_DEBOUNCE_MS = 180

const { t } = useI18n()
const tableShellRef = ref<HTMLElement | null>(null)
const domainGroupMenuRef = ref<HTMLDetailsElement | null>(null)
const selectedGroupName = domainGroupSelectedName
const selectedFamily = ref<GroupTabValue>('all')
const selectedProvider = domainGroupSelectedProvider
const search = domainGroupSearch
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const entries = ref<ProxyGroupRulePenetrationEntry[]>([])
const missingProviders = ref<string[]>([])
const counts = ref({
  all: 0,
  domain: 0,
  ip: 0,
  port: 0,
})
const sortKey = ref<ProxyGroupRulePenetrationSortKey | null>(null)
const sortDirection = ref<'asc' | 'desc'>('asc')
const page = ref(1)
const hasMore = ref(false)
const cacheKey = ref('')
const debouncedSearchRevision = ref(0)

let searchTimer = 0
let latestRequestId = 0
let fillingViewport = false

const serializeRules = (items: Rule[]) => {
  return items.map((rule) => ({
    type: rule.type,
    payload: rule.payload,
    proxy: rule.proxy,
    index: rule.index,
    disabled: rule.disabled,
    extra: rule.extra
      ? {
          disabled: rule.extra.disabled,
        }
      : undefined,
  }))
}

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

const columns = computed(() => {
  return [
    { key: 'type', label: t('category'), width: 'w-22 md:w-32', sortable: true },
    { key: 'content', label: t('content'), width: 'w-34 md:w-72', sortable: true },
    { key: 'params', label: t('params'), width: 'w-24 md:w-36', sortable: true },
    { key: 'raw', label: t('rawContent'), width: 'w-52 md:w-auto', sortable: true },
  ] as const
})

const resetSortState = () => {
  sortKey.value = null
  sortDirection.value = 'asc'
}

const getCustomGroupMode = (groupName: string) => {
  if (groupName === DOMAIN_GROUP_PRE_CUSTOM_KEY) {
    return 'pre'
  }

  if (groupName === DOMAIN_GROUP_POST_CUSTOM_KEY) {
    return 'post'
  }

  return ''
}

const domainGroupItems = computed(() => {
  return domainGroups.value.map((name) => {
    const proxy = proxyMap.value[name]
    const label =
      name === DOMAIN_GROUP_PRE_CUSTOM_KEY
        ? t('preCustom')
        : name === DOMAIN_GROUP_POST_CUSTOM_KEY
          ? t('postCustom')
          : name

    return {
      key: name,
      label,
      icon: isDomainGroupCustomKey(name) ? '' : (proxy?.icon || ''),
    }
  })
})

const selectedGroupItem = computed(() => {
  return domainGroupItems.value.find((item) => item.key === selectedGroupName.value) || null
})

const selectedGroupIcon = computed(() => {
  return selectedGroupItem.value?.icon || ''
})

const closeDomainGroupMenu = () => {
  domainGroupMenuRef.value?.removeAttribute('open')
}

const handleOutsidePointerDown = (event: PointerEvent) => {
  const menu = domainGroupMenuRef.value
  const target = event.target

  if (!menu?.hasAttribute('open') || !(target instanceof Node) || menu.contains(target)) {
    return
  }

  closeDomainGroupMenu()
}

const selectDomainGroup = (key: string) => {
  selectedGroupName.value = key
  closeDomainGroupMenu()
}

const providerOptions = computed(() => {
  const options = [
    {
      value: '',
      label: t('allRuleSets'),
    },
  ]

  if (!selectedGroupName.value || isDomainGroupCustomKey(selectedGroupName.value)) {
    return options
  }

  domainGroupProviderNames.value.forEach((option) => {
    options.push({
      value: option,
      label: option === DOMAIN_GROUP_CUSTOM_SOURCE ? t('custom') : option,
    })
  })

  return options
})

const familyTabs = computed<FamilyTabItem[]>(() => {
  return [
    {
      value: 'all' as GroupTabValue,
      label: t('all'),
      count: counts.value.all,
      disabled: counts.value.all === 0,
    },
    {
      value: 'domain' as GroupTabValue,
      label: t('domain'),
      count: counts.value.domain,
      disabled: counts.value.domain === 0,
    },
    {
      value: 'ip' as GroupTabValue,
      label: t('ip'),
      count: counts.value.ip,
      disabled: counts.value.ip === 0,
    },
    {
      value: 'port' as GroupTabValue,
      label: t('port'),
      count: counts.value.port,
      disabled: counts.value.port === 0,
    },
  ].map((tab) => ({
    ...tab,
    displayLabel: tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label,
  }))
})

const cacheHintText = computed(() => {
  if (missingProviders.value.length === 0) {
    return ''
  }

  return `${t('domainPenetrationMissingProviders')}: ${missingProviders.value.join(', ')}`
})

const getTypeLabel = (type: string) => {
  return t(ruleTypeLabelKeyMap[type] || 'ruleTypeOther')
}

const resetListState = () => {
  entries.value = []
  missingProviders.value = []
  error.value = ''
  counts.value = {
    all: 0,
    domain: 0,
    ip: 0,
    port: 0,
  }
  page.value = 1
  hasMore.value = false
}

const buildRequestBody = (targetPage: number) => {
  const customGroupMode = getCustomGroupMode(selectedGroupName.value)

  return {
    groupName: selectedGroupName.value,
    customGroup: Boolean(customGroupMode),
    customGroupMode: customGroupMode || undefined,
    providerName:
      selectedProvider.value === DOMAIN_GROUP_CUSTOM_SOURCE ? 'controller' : selectedProvider.value,
    page: targetPage,
    pageSize: PAGE_SIZE,
    tab: selectedFamily.value,
    search: search.value.trim(),
    sortKey: sortKey.value,
    sortDirection: sortDirection.value,
    ...(cacheKey.value ? { cacheKey: cacheKey.value } : { rules: serializeRules(rules.value) }),
  }
}

const requestEntries = async (targetPage: number) => {
  let response = await fetch('/api/proxy-group-rule-penetration', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildRequestBody(targetPage)),
  })

  if (response.status === 410 && cacheKey.value) {
    cacheKey.value = ''
    response = await fetch('/api/proxy-group-rule-penetration', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody(targetPage)),
    })
  }

  return response
}

const maybeFillViewport = async () => {
  if (fillingViewport) {
    return
  }

  const shell = tableShellRef.value

  if (!shell || loading.value || loadingMore.value || !hasMore.value) {
    return
  }

  fillingViewport = true

  try {
    while (
      hasMore.value &&
      !loading.value &&
      !loadingMore.value &&
      shell.scrollHeight <= shell.clientHeight + 48
    ) {
      await loadEntries({ append: true })
      await nextTick()
    }
  } finally {
    fillingViewport = false
  }
}

const loadEntries = async (options?: { append?: boolean }) => {
  if (!selectedGroupName.value) {
    resetListState()
    return
  }

  if (rules.value.length === 0) {
    await fetchRules()
  }

  const append = options?.append === true
  const targetPage = append ? page.value + 1 : 1
  const requestId = ++latestRequestId

  if (append) {
    if (loading.value || loadingMore.value || !hasMore.value) {
      return
    }

    loadingMore.value = true
  } else {
    loading.value = true
    error.value = ''
    page.value = 1
    hasMore.value = false
    entries.value = []
    missingProviders.value = []
  }

  try {
    const response = await requestEntries(targetPage)

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(errorBody?.message || `Failed to load domain group rules: ${response.status}`)
    }

    const data = (await response.json()) as DomainGroupResponse

    if (requestId !== latestRequestId) {
      return
    }

    cacheKey.value = data.cacheKey || cacheKey.value
    counts.value = data.counts
    page.value = data.page
    hasMore.value = data.hasMore
    missingProviders.value = data.missingProviders
    entries.value = append ? [...entries.value, ...data.items] : data.items

    if (!append) {
      tableShellRef.value?.scrollTo({ top: 0 })
    }

    await nextTick()
    await maybeFillViewport()
  } catch (loadError) {
    if (requestId !== latestRequestId) {
      return
    }

    if (!append) {
      resetListState()
    }

    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  } finally {
    if (requestId === latestRequestId) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

const handleTableScroll = () => {
  const shell = tableShellRef.value

  if (!shell || loading.value || loadingMore.value || !hasMore.value) {
    return
  }

  if (shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 160) {
    void loadEntries({ append: true })
  }
}

const toggleSort = (key: ProxyGroupRulePenetrationSortKey) => {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDirection.value = 'asc'
    return
  }

  if (sortDirection.value === 'asc') {
    sortDirection.value = 'desc'
    return
  }

  sortKey.value = null
  sortDirection.value = 'asc'
}

watch(
  domainGroupItems,
  (items) => {
    if (items.length === 0) {
      selectedGroupName.value = ''
      resetListState()
      return
    }

    if (items.some((item) => item.key === selectedGroupName.value)) {
      return
    }

    selectedGroupName.value = items[0].key
  },
  { immediate: true },
)

watch(
  selectedGroupName,
  (groupName, previousGroupName) => {
    if (groupName === previousGroupName) {
      return
    }

    if (isDomainGroupCustomKey(groupName)) {
      resetSortState()
      selectedProvider.value = ''
    }
  },
)

watch(
  providerOptions,
  (items) => {
    if (items.some((item) => item.value === selectedProvider.value)) {
      return
    }

    selectedProvider.value = ''
  },
  { immediate: true },
)

watch(
  familyTabs,
  (items) => {
    const currentTab = items.find((item) => item.value === selectedFamily.value)

    if (currentTab && !currentTab.disabled) {
      return
    }

    selectedFamily.value = items.find((item) => !item.disabled)?.value || 'all'
  },
  { immediate: true },
)

watch(search, () => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    debouncedSearchRevision.value += 1
  }, SEARCH_DEBOUNCE_MS)
})

watch(
  [
    selectedGroupName,
    selectedProvider,
    selectedFamily,
    sortKey,
    sortDirection,
    debouncedSearchRevision,
  ],
  async ([groupName], [previousGroupName]) => {
    if (!groupName) {
      resetListState()
      return
    }

    if (groupName !== previousGroupName) {
      cacheKey.value = ''
    }

    await loadEntries()
  },
  { immediate: true },
)

onMounted(() => {
  disableProxiesPageScroll.value = true
  void (async () => {
    if (rules.value.length === 0) {
      await fetchRules()
    }

    await nextTick()
    await maybeFillViewport()
  })()
  document.addEventListener('pointerdown', handleOutsidePointerDown)
  window.addEventListener('resize', maybeFillViewport)
})

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer)
  disableProxiesPageScroll.value = false
  document.removeEventListener('pointerdown', handleOutsidePointerDown)
  window.removeEventListener('resize', maybeFillViewport)
})
</script>

<style scoped>
.domain-penetration-table tbody::before {
  content: none !important;
  display: none !important;
}

.domain-penetration-table thead {
  background-color: hsl(var(--b1)) !important;
}

.domain-penetration-table tbody tr:nth-child(odd) {
  background-color: hsl(var(--b1)) !important;
}

.domain-penetration-table tbody tr:nth-child(even) {
  background-color: hsl(var(--b2)) !important;
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
</style>
