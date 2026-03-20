<template>
  <div class="relative size-full overflow-x-hidden">
    <template v-if="!isVirtualScroller">
      <RulesCtrl />
      <div
        class="flex flex-col gap-2 p-2"
        :style="padding"
      >
        <template
          v-if="
            (rulesTabShow === RULE_TAB_TYPE.RULES || rulesTabShow === RULE_TAB_TYPE.PROVIDER) &&
            isRuleLookupQuery
          "
        >
          <div
            v-if="isRuleLookupLoading"
            class="card p-2 text-sm"
          >
            正在查询规则缓存...
          </div>
          <div
            v-else-if="ruleLookupError"
            class="card p-2 text-sm"
          >
            {{ ruleLookupError }}
          </div>
          <template v-else>
            <div
              v-if="ruleLookupResults.length === 0"
              class="card p-2 text-sm"
            >
              <div>未命中规则缓存。</div>
              <div
                v-if="ruleLookupUnsupported.length > 0"
                class="text-base-content/70 mt-1 text-xs"
              >
                当前还有 {{ ruleLookupUnsupported.length }} 个 `.mrs` 规则集暂不支持解析。
              </div>
            </div>
            <RuleFallbackCard
              v-if="ruleLookupResults.length === 0 && ruleLookupFallbackRule"
              :rule="ruleLookupFallbackRule"
            />
            <RuleLookupCard
              v-for="(result, index) in ruleLookupResults"
              :key="result.providerName"
              :result="result"
              :index="index + 1"
            />
            <div
              v-if="ruleLookupUnsupported.length > 0"
              class="card p-2 text-xs"
            >
              暂不支持解析的规则集：
              {{ ruleLookupUnsupported.map((item) => item.name).join('、') }}
            </div>
          </template>
        </template>
        <template v-else-if="rulesTabShow === RULE_TAB_TYPE.PROVIDER">
          <RuleProvider
            v-for="(ruleProvider, index) in renderRulesProvider"
            :key="ruleProvider.name"
            :ruleProvider="ruleProvider"
            :index="index + 1"
          />
        </template>
        <template v-else>
          <RuleCard
            v-for="rule in renderRules"
            :key="`${rule.type}-${rule.payload}-${rule.proxy}`"
            :rule="rule"
            :index="rules.indexOf(rule) + 1"
          />
        </template>
      </div>
    </template>
    <VirtualScroller
      v-else
      :data="renderRules"
      :size="64"
    >
      <template #before>
        <RulesCtrl />
      </template>
      <template #default="{ item: rule }: { item: Rule }">
        <RuleCard
          :key="`${rule.type}-${rule.payload}-${rule.proxy}`"
          :rule="rule"
          :index="rules.indexOf(rule) + 1"
        />
      </template>
    </VirtualScroller>
  </div>
</template>

<script setup lang="ts">
import VirtualScroller from '@/components/common/VirtualScroller.vue'
import RuleCard from '@/components/rules/RuleCard.vue'
import RuleFallbackCard from '@/components/rules/RuleFallbackCard.vue'
import RuleLookupCard from '@/components/rules/RuleLookupCard.vue'
import RuleProvider from '@/components/rules/RuleProvider.vue'
import RulesCtrl from '@/components/sidebar/RulesCtrl.tsx'
import { usePaddingForViews } from '@/composables/paddingViews'
import { RULE_TAB_TYPE } from '@/constant'
import { showNotification } from '@/helper/notification'
import {
  fetchRuleProviderCacheStats,
  fetchRules,
  isRuleCacheUpdating,
  isRuleLookupLoading,
  isRuleLookupQuery,
  renderRules,
  renderRulesProvider,
  ruleCacheRefreshCount,
  ruleCacheTotalRules,
  ruleLookupError,
  ruleLookupFallbackRule,
  ruleLookupResults,
  ruleLookupUnsupported,
  ruleProviderList,
  rules,
  rulesFilter,
  rulesTabShow,
  searchRuleByQuery,
  updateRuleProviderCache,
} from '@/store/rules'
import { fetchProxies } from '@/store/proxies'
import type { Rule } from '@/types'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const autoRuleCacheBootstrapAttempted = ref(false)

const syncRuleCacheStats = async () => {
  try {
    const stats = await fetchRuleProviderCacheStats()
    ruleCacheTotalRules.value = stats.totalRules

    if (stats.progress?.isUpdating) {
      isRuleCacheUpdating.value = true
      ruleCacheRefreshCount.value = stats.progress.totalRules || 0
      return
    }

    if (isRuleCacheUpdating.value) {
      ruleCacheRefreshCount.value = 0
    }

    isRuleCacheUpdating.value = false
  } catch {
    isRuleCacheUpdating.value = false
  }
}

const ensureRuleCacheBootstrap = async () => {
  if (autoRuleCacheBootstrapAttempted.value) {
    return
  }

  if (
    ruleProviderList.value.length === 0 ||
    ruleCacheTotalRules.value > 0 ||
    isRuleCacheUpdating.value
  ) {
    return
  }

  autoRuleCacheBootstrapAttempted.value = true
  isRuleCacheUpdating.value = true
  ruleCacheRefreshCount.value = 0

  try {
    const result = await updateRuleProviderCache()

    if (result.cancelled) {
      autoRuleCacheBootstrapAttempted.value = false
      return
    }

    ruleCacheRefreshCount.value = result.progressRules
    ruleCacheTotalRules.value = result.totalRules
  } catch (error) {
    autoRuleCacheBootstrapAttempted.value = false
    showNotification({
      key: 'ruleCacheAutoInitFailed',
      content: error instanceof Error ? error.message : String(error),
      type: 'alert-error',
      timeout: 3000,
    })
  } finally {
    await syncRuleCacheStats()
  }
}

const initializeRulesPage = async () => {
  await Promise.allSettled([fetchRules(), fetchProxies()])
  await syncRuleCacheStats()
  await ensureRuleCacheBootstrap()
}

void initializeRulesPage()

const statsPollingTimer = setInterval(() => {
  if (isRuleCacheUpdating.value) {
    syncRuleCacheStats()
  }
}, 500)

onBeforeUnmount(() => {
  clearInterval(statsPollingTimer)
})

watch(
  rulesFilter,
  () => {
    searchRuleByQuery()
  },
  { immediate: true },
)

watch(rulesTabShow, () => {
  fetchProxies()
})

const { padding } = usePaddingForViews({
  offsetTop: 8,
  offsetBottom: 8,
})

const isVirtualScroller = computed(() => {
  return (
    rulesTabShow.value === RULE_TAB_TYPE.RULES &&
    !isRuleLookupQuery.value &&
    renderRules.value.length > 200
  )
})
</script>
