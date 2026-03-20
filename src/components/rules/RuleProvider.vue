<template>
  <div class="card hover:bg-base-200 w-full gap-2 p-2 text-sm">
    <div class="flex h-6 items-center gap-2 leading-6">
      <span>{{ index }}.</span>
      <span class="text-main">{{ ruleProvider.name }}</span>
      <span class="text-base-content/80 text-xs"> ({{ ruleProvider.ruleCount }}) </span>
      <button
        v-if="ruleProvider.vehicleType !== 'Inline'"
        :class="twMerge('btn btn-circle btn-xs btn-ghost')"
        @click="updateRuleProviderClickHandler"
      >
        <ArrowPathIcon :class="twMerge('h-4 w-4', isUpdating ? 'animate-spin' : '')" />
      </button>
    </div>
    <div class="text-base-content/80 flex h-5 items-center gap-2 text-xs">
      <span
        v-if="ruleProvider.behavior"
        class="badge badge-sm min-w-16"
      >
        {{ ruleProvider.behavior }}
      </span>
      <span
        v-if="ruleProvider.vehicleType"
        class="badge badge-sm min-w-12"
      >
        {{ ruleProvider.vehicleType }}
      </span>
      <span>{{ $t('updated') }} {{ fromNow(ruleProvider.updatedAt) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { updateRuleProviderAPI } from '@/api'
import { useBounceOnVisible } from '@/composables/bouncein'
import { fromNow } from '@/helper/utils'
import { fetchRules } from '@/store/rules'
import type { RuleProvider } from '@/types'
import { ArrowPathIcon } from '@heroicons/vue/24/outline'
import { twMerge } from 'tailwind-merge'
import { ref } from 'vue'
const isUpdating = ref(false)
const props = defineProps<{
  ruleProvider: RuleProvider
  index: number
}>()

const updateRuleProviderClickHandler = async () => {
  if (isUpdating.value) return

  isUpdating.value = true
  await updateRuleProviderAPI(props.ruleProvider.name)
  fetchRules()
  isUpdating.value = false
}

useBounceOnVisible()
</script>
