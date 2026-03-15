import { updateRuleProviderAPI } from '@/api'
import { useCtrlsBar } from '@/composables/useCtrlsBar'
import { RULE_TAB_TYPE } from '@/constant'
import { showNotification } from '@/helper/notification'
import {
  cancelRuleProviderCacheUpdate,
  fetchRules,
  isRuleCacheUpdating,
  ruleCacheRefreshCount,
  ruleCacheTotalRules,
  ruleProviderList,
  rules,
  rulesFilter,
  rulesTabShow,
  updateRuleProviderCache,
} from '@/store/rules'
import {
  disconnectOnRuleDisable,
  displayLatencyInRule,
  displayNowNodeInRule,
} from '@/store/settings'
import { ArrowPathIcon, WrenchScrewdriverIcon } from '@heroicons/vue/24/outline'
import { computed, defineComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DialogWrapper from '../common/DialogWrapper.vue'
import TextInput from '../common/TextInput.vue'

export default defineComponent({
  name: 'RulesCtrl',
  setup() {
    const { t } = useI18n()
    const settingsModel = ref(false)
    const isUpgrading = ref(false)
    const isUpdatingCache = ref(false)
    const { isLargeCtrlsBar } = useCtrlsBar()
    const hasProviders = computed(() => ruleProviderList.value.length > 0)

    const handlerClickUpgradeAllProviders = async () => {
      if (isUpgrading.value) return
      isUpgrading.value = true

      try {
        let updateCount = 0

        await Promise.all(
          ruleProviderList.value.map((provider) =>
            updateRuleProviderAPI(provider.name).then(() => {
              updateCount++

              const isFinished = updateCount === ruleProviderList.value.length

              showNotification({
                key: 'updateFinishedTip',
                content: 'updateFinishedTip',
                params: {
                  number: `${updateCount}/${ruleProviderList.value.length}`,
                },
                type: isFinished ? 'alert-success' : 'alert-info',
                timeout: isFinished ? 2000 : 0,
              })
            }),
          ),
        )
      } finally {
        await fetchRules()
        isUpgrading.value = false
      }
    }

    const handlerClickUpdateCache = async () => {
      if (isUpdatingCache.value || isRuleCacheUpdating.value) {
        try {
          await cancelRuleProviderCacheUpdate()
          showNotification({
            key: 'ruleCacheStopped',
            content: '已停止刷新规则',
            type: 'alert-warning',
            timeout: 2000,
          })
        } catch (error) {
          showNotification({
            key: 'ruleCacheStopped',
            content: error instanceof Error ? error.message : String(error),
            type: 'alert-error',
            timeout: 3000,
          })
        } finally {
          isUpdatingCache.value = false
          isRuleCacheUpdating.value = false
        }
        return
      }

      isUpdatingCache.value = true
      isRuleCacheUpdating.value = true
      ruleCacheRefreshCount.value = 0

      try {
        const result = await updateRuleProviderCache()

        if (result.cancelled) {
          showNotification({
            key: 'ruleCacheUpdated',
            content: '已停止刷新规则',
            type: 'alert-warning',
            timeout: 2000,
          })
          return
        }

        ruleCacheRefreshCount.value = result.progressRules
        ruleCacheTotalRules.value = result.totalRules

        showNotification({
          key: 'ruleCacheUpdated',
          content: 'ruleCacheUpdated',
          params: {
            number: `${result.updatedCount}/${result.totalProviders}`,
          },
          type: result.errors.length > 0 ? 'alert-warning' : 'alert-success',
          timeout: 2500,
        })
      } catch (error) {
        showNotification({
          key: 'ruleCacheUpdated',
          content: error instanceof Error ? error.message : String(error),
          type: 'alert-error',
          timeout: 3000,
        })
      } finally {
        isUpdatingCache.value = false
        isRuleCacheUpdating.value = false
      }
    }

    const tabsWithNumbers = computed(() => {
      return Object.values(RULE_TAB_TYPE).map((type) => ({
        type,
        count: type === RULE_TAB_TYPE.RULES ? rules.value.length : ruleProviderList.value.length,
      }))
    })

    const refreshButtonLabel = computed(() => {
      return isUpdatingCache.value || isRuleCacheUpdating.value
        ? `停止刷新（${ruleCacheRefreshCount.value}）`
        : `刷新规则（${ruleCacheTotalRules.value}）`
    })

    return () => {
      const tabs = (
        <div
          role="tablist"
          class="tabs-box tabs tabs-xs"
        >
          {tabsWithNumbers.value.map(({ type, count }) => (
            <a
              role="tab"
              key={type}
              class={['tab', rulesTabShow.value === type && 'tab-active']}
              onClick={() => (rulesTabShow.value = type)}
            >
              {type === RULE_TAB_TYPE.PROVIDER ? '规则源' : t(type)} ({count})
            </a>
          ))}
        </div>
      )

      const upgradeAllIcon = rulesTabShow.value === RULE_TAB_TYPE.PROVIDER && (
        <button
          class="btn btn-circle btn-sm"
          onClick={handlerClickUpgradeAllProviders}
        >
          <ArrowPathIcon class={['h-4 w-4', isUpgrading.value && 'animate-spin']} />
        </button>
      )

      const updateCacheButton = rulesTabShow.value === RULE_TAB_TYPE.RULES && (
        <button
          class="btn btn-sm whitespace-nowrap"
          onClick={handlerClickUpdateCache}
        >
          <ArrowPathIcon
            class={[
              'h-4 w-4',
              (isUpdatingCache.value || isRuleCacheUpdating.value) && 'animate-spin',
            ]}
          />
          {refreshButtonLabel.value}
        </button>
      )

      const searchInput = (
        <TextInput
          class={isLargeCtrlsBar.value ? 'w-80' : 'w-32 flex-1'}
          v-model={rulesFilter.value}
          placeholder={`${t('search')} | ${t('searchMultiple')}`}
          clearable={true}
        />
      )

      const settingsModal = (
        <>
          <button
            class="btn btn-circle btn-sm"
            onClick={() => (settingsModel.value = true)}
          >
            <WrenchScrewdriverIcon class="h-4 w-4" />
          </button>
          <DialogWrapper
            v-model={settingsModel.value}
            title={t('ruleSettings')}
          >
            <div class="flex flex-col gap-4 p-2 text-sm">
              <div class="flex items-center gap-2">
                {t('displaySelectedNode')}
                <input
                  class="toggle"
                  type="checkbox"
                  v-model={displayNowNodeInRule.value}
                />
              </div>
              <div class="flex items-center gap-2">
                {t('displayLatencyNumber')}
                <input
                  class="toggle"
                  type="checkbox"
                  v-model={displayLatencyInRule.value}
                />
              </div>
              <div class="flex items-center gap-2">
                {t('disconnectOnRuleDisable')}
                <input
                  class="toggle"
                  type="checkbox"
                  v-model={disconnectOnRuleDisable.value}
                />
              </div>
            </div>
          </DialogWrapper>
        </>
      )

      const content = !isLargeCtrlsBar.value ? (
        <div class="flex flex-col gap-2 p-2">
          {hasProviders.value && (
            <div class="flex gap-2">
              {tabs}
              {upgradeAllIcon}
            </div>
          )}
          <div class="flex w-full gap-2">
            {searchInput}
            {updateCacheButton}
            {settingsModal}
          </div>
        </div>
      ) : (
        <div class="flex flex-wrap gap-2 p-2">
          {hasProviders.value && tabs}
          {searchInput}
          {updateCacheButton}
          <div class="flex-1"></div>
          {upgradeAllIcon}
          {settingsModal}
        </div>
      )

      return <div class="ctrls-bar">{content}</div>
    }
  },
})
