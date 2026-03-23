import { fetchRuleProvidersAPI, fetchRulesAPI } from '@/api'
import { RULE_TAB_TYPE } from '@/constant'
import type { Rule, RuleProvider } from '@/types'
import { useStorage } from '@vueuse/core'
import { computed, ref } from 'vue'

export const rulesFilter = ref('')
export const rulesTabShow = useStorage<RULE_TAB_TYPE>('cache/rules-tab-show', RULE_TAB_TYPE.RULES)

export const rules = ref<Rule[]>([])
export const ruleProviderList = ref<RuleProvider[]>([])
export const ruleCacheTotalRules = ref(0)
export const ruleCacheRefreshCount = ref(0)
export const isRuleCacheUpdating = ref(false)
export const isRuleLookupLoading = ref(false)
export const ruleLookupError = ref('')
export const ruleLookupResults = ref<
  {
    providerName: string
    behavior: string
    format: string
    url: string
    totalRules: number
    matches: {
      line: number
      value: string
      mode: string
      raw: string
    }[]
    linkedRules: Rule[]
  }[]
>([])
export const ruleLookupUnsupported = ref<
  {
    name: string
    kind: string
    behavior: string
    format: string
    url: string
    status: string
  }[]
>([])
export const ruleLookupLiveErrors = ref<
  {
    name: string
    url: string
    message: string
  }[]
>([])
export const isRuleLookupQuery = computed(() => {
  const value = rulesFilter.value.trim()

  return value !== '' && !value.includes(' ') && !value.includes('|')
})

export const renderRules = computed(() => {
  const rulesFilterValue = rulesFilter.value.split(' ').map((f) => f.toLowerCase().trim())

  if (rulesFilter.value === '') {
    return rules.value
  }

  return rules.value.filter((rule) => {
    return rulesFilterValue.every((f) =>
      [rule.type.toLowerCase(), rule.payload.toLowerCase(), rule.proxy.toLowerCase()].some((i) =>
        i.includes(f),
      ),
    )
  })
})

export const renderRulesProvider = computed(() => {
  const rulesFilterValue = rulesFilter.value.split(' ').map((f) => f.toLowerCase().trim())

  if (rulesFilter.value === '') {
    return ruleProviderList.value
  }

  return ruleProviderList.value.filter((ruleProvider) => {
    return rulesFilterValue.every((f) =>
      [
        ruleProvider.name.toLowerCase(),
        ruleProvider.behavior.toLowerCase(),
        ruleProvider.vehicleType.toLowerCase(),
      ].some((i) => i.includes(f)),
    )
  })
})

const isRuleEnabled = (rule: Rule) => {
  if (rule.extra) {
    return !rule.extra.disabled
  }

  return !rule.disabled
}

export const ruleLookupFallbackRule = computed(() => {
  const enabledRules = rules.value.filter(isRuleEnabled)

  for (let index = enabledRules.length - 1; index >= 0; index--) {
    const rule = enabledRules[index]
    const normalizedType = rule.type.toLowerCase()

    if (normalizedType === 'match' || normalizedType === 'final') {
      return rule
    }
  }

  return null
})

export const fetchRules = async () => {
  const { data: ruleData } = await fetchRulesAPI()
  const { data: providerData } = await fetchRuleProvidersAPI()

  rules.value = ruleData.rules.map((rule) => {
    const proxy = rule.proxy
    const proxyName = proxy.startsWith('route(') ? proxy.substring(6, proxy.length - 1) : proxy

    return {
      ...rule,
      proxy: proxyName,
    }
  })
  ruleProviderList.value = Object.values(providerData.providers)
}

export const updateRuleProviderCache = async () => {
  const response = await fetch('/api/rule-provider-cache/update', {
    method: 'POST',
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(errorBody?.message || `Failed to update rule cache: ${response.status}`)
  }

  return (await response.json()) as {
    ok: boolean
    totalProviders: number
    updatedCount: number
    unsupportedCount: number
    totalRules: number
    progressRules: number
    cancelled: boolean
    errors: { name: string; url: string; message: string }[]
  }
}

export const cancelRuleProviderCacheUpdate = async () => {
  const response = await fetch('/api/rule-provider-cache/cancel', {
    method: 'POST',
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(errorBody?.message || `Failed to cancel rule cache update: ${response.status}`)
  }

  return (await response.json()) as {
    ok: boolean
  }
}

export const fetchRuleProviderCacheStats = async () => {
  const response = await fetch('/api/rule-provider-cache/stats')

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(errorBody?.message || `Failed to fetch rule cache stats: ${response.status}`)
  }

  return (await response.json()) as {
    totalRules: number
    progress: {
      isUpdating: boolean
      totalProviders: number
      updatedProviders: number
      totalRules: number
      errors: number
      unsupportedCount: number
      cancelled: boolean
      completed: boolean
    }
  }
}

export const searchRuleByQuery = async () => {
  if (!isRuleLookupQuery.value) {
    ruleLookupResults.value = []
    ruleLookupUnsupported.value = []
    ruleLookupLiveErrors.value = []
    ruleLookupError.value = ''
    return
  }

  const query = rulesFilter.value.trim()

  if (!query) {
    ruleLookupResults.value = []
    ruleLookupUnsupported.value = []
    ruleLookupLiveErrors.value = []
    ruleLookupError.value = ''
    return
  }

  isRuleLookupLoading.value = true
  ruleLookupError.value = ''

  try {
    const response = await fetch(`/api/rule-provider-search?query=${encodeURIComponent(query)}`)

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(errorBody?.message || `Failed to search rule cache: ${response.status}`)
    }

    const data = (await response.json()) as {
      matches: {
        name: string
        behavior: string
        format: string
        url: string
        totalRules: number
        matches: {
          line: number
          value: string
          mode: string
          raw: string
        }[]
      }[]
      unsupported: {
        name: string
        kind: string
        behavior: string
        format: string
        url: string
        status: string
      }[]
      errors: {
        name: string
        url: string
        message: string
      }[]
    }

    ruleLookupResults.value = data.matches
      .map((item) => ({
        providerName: item.name,
        behavior: item.behavior,
        format: item.format,
        url: item.url,
        totalRules: item.totalRules,
        matches: item.matches,
        linkedRules: rules.value.filter(
          (rule) => rule.type === 'RuleSet' && rule.payload === item.name,
        ),
      }))
      .sort((prev, next) => {
        const prevIndex = Math.min(...prev.linkedRules.map((rule) => rule.index))
        const nextIndex = Math.min(...next.linkedRules.map((rule) => rule.index))

        const safePrevIndex = Number.isFinite(prevIndex) ? prevIndex : Number.MAX_SAFE_INTEGER
        const safeNextIndex = Number.isFinite(nextIndex) ? nextIndex : Number.MAX_SAFE_INTEGER

        if (safePrevIndex !== safeNextIndex) {
          return safePrevIndex - safeNextIndex
        }

        return prev.providerName.localeCompare(next.providerName)
      })
    ruleLookupUnsupported.value = data.unsupported
    ruleLookupLiveErrors.value = data.errors
  } catch (error) {
    ruleLookupResults.value = []
    ruleLookupUnsupported.value = []
    ruleLookupLiveErrors.value = []
    ruleLookupError.value = error instanceof Error ? error.message : String(error)
  } finally {
    isRuleLookupLoading.value = false
  }
}
