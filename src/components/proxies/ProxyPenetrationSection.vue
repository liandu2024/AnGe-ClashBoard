<template>
  <div class="mt-4">
    <div class="flex flex-wrap items-center gap-3">
      <button
        class="btn btn-sm min-w-24 gap-1.5"
        :class="isExpanded ? 'btn-neutral' : 'btn-outline'"
        :disabled="!canPenetrate"
        @click="togglePenetration"
      >
        <span>{{ buttonLabel }}</span>
        <ChevronDownIcon
          class="h-4 w-4 transition-transform duration-200"
          :class="isExpanded && 'rotate-180'"
        />
      </button>
      <div class="min-w-0 flex-1 truncate text-sm text-base-content/70">
        {{ selectedGroupName || '-' }}
      </div>
    </div>

    <div
      v-if="isExpanded && renderedGroups.length"
      class="mt-4 border-t border-base-300/60"
    >
      <div
        v-for="groupName in renderedGroups"
        :key="groupName"
        class="border-b border-base-300/60 py-4 last:border-b-0"
      >
        <ProxyEmbeddedGroup :name="groupName" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { collapseGroupMap } from '@/store/settings'
import { getDescendantProxyGroups, proxyMap } from '@/store/proxies'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ProxyEmbeddedGroup from './ProxyEmbeddedGroup.vue'

const props = defineProps<{
  groupName: string
}>()

const { locale } = useI18n()
const isExpanded = ref(false)
const selectedGroupName = computed(() => proxyMap.value[props.groupName]?.now || '')

const selectedProxyHasNodes = computed(() => {
  if (!selectedGroupName.value) {
    return false
  }

  return (proxyMap.value[selectedGroupName.value]?.all?.length ?? 0) > 0
})

const descendantGroups = computed(() => {
  if (!selectedGroupName.value) {
    return []
  }

  return getDescendantProxyGroups(selectedGroupName.value)
})

const canPenetrate = computed(() => selectedProxyHasNodes.value)

const renderedGroups = computed(() => {
  if (!selectedGroupName.value || !canPenetrate.value) {
    return []
  }

  return [selectedGroupName.value, ...descendantGroups.value]
})

const buttonLabel = computed(() => {
  const isZh = locale.value.toLowerCase().startsWith('zh')

  if (isZh) {
    return isExpanded.value ? '收起穿透' : '节点穿透'
  }

  return isExpanded.value ? 'Hide Descendants' : 'Node Drill'
})

watch(selectedGroupName, () => {
  isExpanded.value = false
})

watch(canPenetrate, (value) => {
  if (!value) {
    isExpanded.value = false
  }
})

const togglePenetration = () => {
  if (!canPenetrate.value) {
    return
  }

  const nextExpanded = !isExpanded.value

  if (nextExpanded) {
    renderedGroups.value.forEach((groupName) => {
      collapseGroupMap.value[groupName] = false
    })
  }

  isExpanded.value = nextExpanded
}
</script>
