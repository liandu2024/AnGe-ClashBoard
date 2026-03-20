<template>
  <div
    class="card"
    :class="{ 'opacity-50': isDisabled }"
  >
    <div
      class="flex flex-col gap-2 overflow-hidden p-2 text-sm"
      :class="{
        'cursor-pointer': isSelectable,
      }"
      @click="clickHandler"
    >
      <div class="min-h-6 leading-6">
        <span>{{ index }}.</span>
        <span class="ml-2">{{ rule.type }}</span>
        <span
          class="text-main ml-2"
          v-if="rule.payload"
        >
          {{ rule.payload }}
        </span>
        <span
          v-if="typeof size === 'number' && size !== -1"
          class="text-base-content/80 ml-1 text-xs"
        >
          ({{ size }})
          <QuestionMarkCircleIcon
            v-if="size === 0"
            class="-mt-1 ml-1 inline-block h-4 w-4"
            @mouseenter="showMMDBSizeTip"
          />
        </span>
        <button
          v-if="isUpdateableRuleSet"
          :class="twMerge('btn btn-circle btn-ghost btn-xs -mt-[2px] ml-1')"
          @click.stop="updateRuleProviderClickHandler"
        >
          <ArrowPathIcon :class="twMerge('h-4 w-4', isUpdating ? 'animate-spin' : '')" />
        </button>
        <InformationCircleIcon
          v-if="rule.extra"
          class="-mt-[2px] ml-1 inline-block h-4 w-4"
          @mouseenter="showRuleHitInfoTip"
          @click.stop
        />
      </div>
      <div class="flex min-h-6 flex-wrap items-center gap-1 md:gap-2">
        <input
          v-if="rule.uuid || rule.extra"
          type="checkbox"
          class="toggle toggle-sm"
          :checked="!isDisabled"
          @change="toggleRuleDisabledHandler"
          @click.stop
        />
        <ProxyName
          v-if="isCollapsed"
          :name="rule.proxy"
          class="badge gap-0 text-xs"
        />
        <template v-if="!isCollapsed">
          <template
            v-for="(chain, index) in proxyChains"
            :key="chain"
          >
            <ArrowRightCircleIcon
              class="h-4 w-4"
              v-if="index > 0"
            />
            <ProxyName
              :name="chain"
              class="badge gap-0 text-xs"
              :class="{
                'bg-neutral text-neutral-content': selected === chain,
              }"
              @click.stop="selected = chain"
            />
          </template>
        </template>
        <template v-if="proxyNode?.now && displayNowNodeInRule">
          <ArrowRightCircleIcon class="h-4 w-4" />
          <ProxyName
            :name="getNowProxyNodeName(rule.proxy)"
            class="badge cursor-not-allowed gap-0 text-xs"
            @click.stop
          />
        </template>
        <span
          v-if="latency !== NOT_CONNECTED && displayLatencyInRule"
          :class="latencyColor"
          class="ml-1 text-xs"
        >
          {{ latency }}
        </span>
      </div>
    </div>

    <template v-if="isSelectable && !isCollapsed">
      <div class="border-base-content/15 border-b"></div>
      <ProxyGroup
        :name="selected"
        class="transparent-collapse"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  disconnectByIdAPI,
  toggleRuleDisabledAPI,
  toggleRuleDisabledSingBoxAPI,
  updateRuleProviderAPI,
} from '@/api'
import { useBounceOnVisible } from '@/composables/bouncein'
import { NOT_CONNECTED } from '@/constant'
import { getColorForLatency } from '@/helper'
import { useTooltip } from '@/helper/tooltip'
import { activeConnections } from '@/store/connections'
import {
  getLatencyByName,
  getNowProxyNodeName,
  getProxyGroupChains,
  proxyGroupList,
  proxyMap,
} from '@/store/proxies'
import { fetchRules, ruleProviderList } from '@/store/rules'
import {
  disconnectOnRuleDisable,
  displayLatencyInRule,
  displayNowNodeInRule,
} from '@/store/settings'
import type { Rule } from '@/types'
import {
  ArrowPathIcon,
  ArrowRightCircleIcon,
  InformationCircleIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/vue/24/outline'
import dayjs from 'dayjs'
import { twMerge } from 'tailwind-merge'
import { computed, createApp, defineComponent, h, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ProxyGroup from '../proxies/ProxyGroup.vue'
import ProxyName from '../proxies/ProxyName.vue'

const props = defineProps<{
  rule: Rule
  index: number
}>()

const isCollapsed = ref(true)
const isSelectable = computed(() => proxyGroupList.value.includes(props.rule.proxy))
const selected = ref('')
const proxyChains = computed(() => getProxyGroupChains(props.rule.proxy))

const { t } = useI18n()
const { showTip } = useTooltip()
const proxyNode = computed(() => proxyMap.value[props.rule.proxy])
const latency = computed(() => getLatencyByName(props.rule.proxy, props.rule.proxy))
const latencyColor = computed(() => getColorForLatency(Number(latency.value)))

const size = computed(() => {
  if (props.rule.type === 'RuleSet') {
    return ruleProviderList.value.find((provider) => provider.name === props.rule.payload)
      ?.ruleCount
  }

  return props.rule.size
})

const isUpdating = ref(false)
const isTogglingDisabled = ref(false)
const isDisabled = computed(() => {
  const rule = props.rule

  if (rule.extra) {
    return rule.extra.disabled
  }

  return rule.disabled
})

const isUpdateableRuleSet = computed(() => {
  if (props.rule.type !== 'RuleSet') {
    return false
  }

  const provider = ruleProviderList.value.find((provider) => provider.name === props.rule.payload)

  if (!provider) {
    return false
  }
  return provider.vehicleType !== 'Inline'
})

const updateRuleProviderClickHandler = async () => {
  if (isUpdating.value) return

  isUpdating.value = true
  await updateRuleProviderAPI(props.rule.payload)
  await fetchRules()
  isUpdating.value = false
}

const toggleRuleDisabledHandler = async () => {
  if (isTogglingDisabled.value) return

  try {
    isTogglingDisabled.value = true
    const willBeDisabled = !isDisabled.value

    if (props.rule.uuid) {
      await toggleRuleDisabledSingBoxAPI(props.rule.uuid)
    } else {
      await toggleRuleDisabledAPI({ [props.rule.index]: willBeDisabled })
    }

    if (willBeDisabled && disconnectOnRuleDisable.value) {
      const matchingConnections = activeConnections.value.filter((conn) => {
        const ruleTypeMatches = conn.rule === props.rule.type
        const rulePayloadMatches = (conn.rulePayload || '') === (props.rule.payload || '')
        return ruleTypeMatches && rulePayloadMatches
      })

      if (matchingConnections.length > 0) {
        matchingConnections.forEach((conn) => disconnectByIdAPI(conn.id))
      }
    }

    await fetchRules()
  } finally {
    isTogglingDisabled.value = false
  }
}

const showMMDBSizeTip = (e: Event) => {
  showTip(e, t('mmdbSizeTip'))
}

const ruleHitCount = computed(() => t('ruleHitCount', { count: props.rule.extra?.hitCount }))
const ruleLastHit = computed(() =>
  t('ruleLastHit', { time: dayjs(props.rule.extra?.hitAt).format('YYYY-MM-DD HH:mm:ss') }),
)
const ruleMissCount = computed(() => t('ruleMissCount', { count: props.rule.extra?.missCount }))
const ruleLastMiss = computed(() =>
  t('ruleLastMiss', { time: dayjs(props.rule.extra?.missAt).format('YYYY-MM-DD HH:mm:ss') }),
)

const showRuleHitInfoTip = (e: Event) => {
  if (!props.rule.extra) return

  const PopContent = defineComponent({
    setup() {
      return () =>
        h('div', { class: 'flex flex-col gap-2 text-sm' }, [
          h('div', { class: 'flex flex-col gap-1' }, [
            h('div', ruleHitCount.value),
            h('div', ruleLastHit.value),
          ]),
          h('div', { class: 'flex flex-col gap-1' }, [
            h('div', ruleMissCount.value),
            h('div', ruleLastMiss.value),
          ]),
        ])
    },
  })
  const mountEl = document.createElement('div')
  const app = createApp(PopContent)

  app.mount(mountEl)

  showTip(e, mountEl, {
    delay: [500, 0],
    trigger: 'mouseenter',
  })
}

const clickHandler = () => {
  if (isSelectable.value && !props.rule.disabled) {
    isCollapsed.value = !isCollapsed.value
    selected.value = props.rule.proxy
  }
}

useBounceOnVisible()
</script>
