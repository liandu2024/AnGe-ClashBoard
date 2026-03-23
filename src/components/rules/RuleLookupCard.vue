<template>
  <div class="card">
    <div class="flex flex-col gap-2 p-2 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <span>{{ index }}.</span>
        <span class="text-main font-medium">
          {{ result.providerName }}
          <span class="text-base-content/55">({{ result.totalRules }})</span>
        </span>
        <span
          v-if="result.behavior"
          class="badge badge-sm"
        >
          {{ result.behavior }}
        </span>
        <span
          v-if="result.format"
          class="badge badge-sm"
        >
          {{ result.format }}
        </span>
      </div>

      <div class="text-base-content/80 flex flex-col gap-1 text-xs">
        <template v-if="result.linkedRules.length > 0">
          <div
            v-for="rule in result.linkedRules"
            :key="`${result.providerName}-${rule.proxy}`"
            class="flex min-h-6 flex-wrap items-center gap-1 md:gap-2"
          >
            <template
              v-for="(chain, chainIndex) in getProxyChains(rule.proxy)"
              :key="`${result.providerName}-${rule.proxy}-${chain}`"
            >
              <ArrowRightCircleIcon
                v-if="chainIndex > 0"
                class="h-4 w-4"
              />
              <ProxyName
                :name="chain"
                class="badge gap-0 text-xs"
              />
            </template>
            <template v-if="shouldShowFinalNode(rule.proxy)">
              <ArrowRightCircleIcon class="h-4 w-4" />
              <ProxyName
                :name="getNowProxyNodeName(rule.proxy)"
                class="badge cursor-not-allowed gap-0 text-xs"
              />
            </template>
            <span
              v-if="getLatency(rule.proxy) !== NOT_CONNECTED && displayLatencyInRule"
              :class="getLatencyClass(rule.proxy)"
              class="ml-1 text-xs"
            >
              {{ getLatency(rule.proxy) }}
            </span>
          </div>
        </template>
        <span
          v-else
          class="text-sm"
        >
          未在当前规则顺序中找到对应 RuleSet
        </span>
      </div>

      <div class="flex flex-col gap-1 text-sm font-normal">
        <div
          v-for="match in result.matches.slice(0, 5)"
          :key="`${result.providerName}-${match.line}-${match.value}`"
          class="text-base-content/80"
        >
          <span class="font-medium">L{{ match.line }}</span>
          <span class="ml-2">{{ match.mode }}</span>
          <span class="ml-2">{{ match.value }}</span>
        </div>
      </div>

      <div class="text-base-content/70 flex items-center gap-2 text-sm font-normal">
        <a
          :href="result.url"
          target="_blank"
          rel="noreferrer"
          class="link link-hover truncate leading-6"
        >
          {{ result.url }}
        </a>
        <button
          class="btn btn-ghost btn-xs"
          type="button"
          title="复制链接"
          @click="copyUrl(result.url)"
        >
          <DocumentDuplicateIcon class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NOT_CONNECTED } from '@/constant'
import { getColorForLatency } from '@/helper'
import { showNotification } from '@/helper/notification'
import { getLatencyByName, getNowProxyNodeName, getProxyGroupChains, proxyMap } from '@/store/proxies'
import { displayLatencyInRule, displayNowNodeInRule } from '@/store/settings'
import type { Rule } from '@/types'
import { ArrowRightCircleIcon } from '@heroicons/vue/24/solid'
import { DocumentDuplicateIcon } from '@heroicons/vue/24/outline'
import ProxyName from '../proxies/ProxyName.vue'

defineProps<{
  index: number
  result: {
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
  }
}>()

const hasNowNode = (proxyName: string) => {
  return Boolean(proxyMap.value[proxyName]?.now)
}

const getProxyChains = (proxyName: string) => {
  return getProxyGroupChains(proxyName)
}

const shouldShowFinalNode = (proxyName: string) => {
  if (!displayNowNodeInRule.value || !hasNowNode(proxyName)) {
    return false
  }

  const finalNodeName = getNowProxyNodeName(proxyName)
  const chains = getProxyChains(proxyName)

  return chains[chains.length - 1] !== finalNodeName
}

const getLatency = (proxyName: string) => {
  return getLatencyByName(proxyName, proxyName)
}

const getLatencyClass = (proxyName: string) => {
  return getColorForLatency(Number(getLatency(proxyName)))
}

const copyUrl = async (url: string) => {
  try {
    await navigator.clipboard.writeText(url)
    showNotification({
      content: 'copySuccess',
      type: 'alert-success',
      timeout: 1500,
    })
  } catch (error) {
    console.warn('Failed to copy rule source url', error)
  }
}
</script>
