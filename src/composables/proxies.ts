import { isSingBox } from '@/api'
import { GLOBAL, PROXY_TAB_TYPE } from '@/constant'
import { isHiddenGroup } from '@/helper'
import { getDomainGroupNames, getDomainGroupRuleSetOptions } from '@/helper/proxyDomainGroups'
import { configs } from '@/store/config'
import { proxiesTabShow, proxyGroupList, proxyMap, proxyProviederList } from '@/store/proxies'
import { rules } from '@/store/rules'
import { customGlobalNode, displayGlobalByMode, manageHiddenGroup } from '@/store/settings'
import { isEmpty } from 'lodash'
import { computed, ref } from 'vue'

const filterGroups = (all: string[]) => {
  if (manageHiddenGroup.value) {
    return all
  }

  return all.filter((name) => !isHiddenGroup(name))
}

const getRenderGroups = () => {
  if (isEmpty(proxyMap.value)) {
    return []
  }

  if (proxiesTabShow.value === PROXY_TAB_TYPE.PROVIDER) {
    return proxyProviederList.value.map((group) => group.name)
  }

  const currentGroups = getCurrentProxyGroups()

  if (proxiesTabShow.value === PROXY_TAB_TYPE.POLICY) {
    return currentGroups.filter((name) => isPolicyGroup(name))
  }

  if (proxiesTabShow.value === PROXY_TAB_TYPE.NODE) {
    return currentGroups.filter((name) => !isPolicyGroup(name))
  }

  if (proxiesTabShow.value === PROXY_TAB_TYPE.DOMAIN) {
    return []
  }

  return currentGroups
}

const getCurrentProxyGroups = () => {
  if (displayGlobalByMode.value) {
    if (configs.value?.mode.toUpperCase() === GLOBAL) {
      return [
        isSingBox.value && proxyMap.value[customGlobalNode.value] ? customGlobalNode.value : GLOBAL,
      ]
    }

    return filterGroups(proxyGroupList.value)
  }

  return filterGroups([...proxyGroupList.value, GLOBAL])
}

const ruleProxyNames = computed(() => {
  return new Set(rules.value.map((rule) => rule.proxy))
})

const getCurrentGroupSet = () => {
  return new Set(getCurrentProxyGroups())
}

const getChildGroupNames = (name: string, currentGroupSet: Set<string>) => {
  const proxyGroup = proxyMap.value[name]

  if (!proxyGroup?.all?.length) {
    return []
  }

  return proxyGroup.all.filter((member) => currentGroupSet.has(member))
}

const hasDescendantGroup = (
  rootName: string,
  targetName: string,
  currentGroupSet: Set<string>,
  visited = new Set<string>(),
): boolean => {
  if (rootName === targetName) {
    return false
  }

  if (visited.has(rootName)) {
    return false
  }

  visited.add(rootName)

  for (const member of getChildGroupNames(rootName, currentGroupSet)) {
    if (member === targetName) {
      return true
    }

    if (hasDescendantGroup(member, targetName, currentGroupSet, visited)) {
      return true
    }
  }

  return false
}

const referencedCurrentGroupNames = computed(() => {
  const currentGroupSet = getCurrentGroupSet()
  const referenced = new Set<string>()

  currentGroupSet.forEach((name) => {
    getChildGroupNames(name, currentGroupSet).forEach((member) => {
      referenced.add(member)
    })
  })

  return referenced
})

const fallbackPolicyGroupNames = computed(() => {
  const currentGroups = getCurrentProxyGroups()
  const referenced = referencedCurrentGroupNames.value

  return new Set(currentGroups.filter((name) => !referenced.has(name)))
})

const resolvedPolicyGroupNames = computed(() => {
  const currentGroupSet = getCurrentGroupSet()
  const directRulePolicyGroups = [...ruleProxyNames.value].filter((name) => currentGroupSet.has(name))

  if (directRulePolicyGroups.length > 0) {
    const topLevelRulePolicyGroups = directRulePolicyGroups.filter((name) => {
      return !directRulePolicyGroups.some((candidate) =>
        candidate !== name && hasDescendantGroup(candidate, name, currentGroupSet),
      )
    })

    if (topLevelRulePolicyGroups.length > 0) {
      return new Set(topLevelRulePolicyGroups)
    }
  }

  return fallbackPolicyGroupNames.value
})

const isPolicyGroup = (name: string) => {
  return resolvedPolicyGroupNames.value.has(name)
}

export const disableProxiesPageScroll = ref(false)
export const isProxiesPageMounted = ref(false)
export const domainGroupSelectedName = ref('')
export const domainGroupSelectedProvider = ref('')
export const domainGroupSearch = ref('')
export const policyGroups = computed(() => getCurrentProxyGroups().filter((name) => isPolicyGroup(name)))
export const domainGroups = computed(() => getDomainGroupNames(rules.value, policyGroups.value))
export const domainGroupProviderNames = computed(() =>
  getDomainGroupRuleSetOptions(domainGroupSelectedName.value, rules.value),
)
export const nodeGroups = computed(() => getCurrentProxyGroups().filter((name) => !isPolicyGroup(name)))
export const nodeGroupBlocks = computed(() => {
  const groups = nodeGroups.value
  const groupSet = new Set(groups)
  const referenced = new Set<string>()

  groups.forEach((name) => {
    getChildGroupNames(name, groupSet).forEach((childName) => {
      referenced.add(childName)
    })
  })

  const assigned = new Set<string>()
  const blocks: string[][] = []

  const appendBlock = (rootName: string) => {
    if (assigned.has(rootName) || !groupSet.has(rootName)) {
      return
    }

    const block: string[] = []
    const visited = new Set<string>()

    const walk = (name: string) => {
      if (visited.has(name) || assigned.has(name) || !groupSet.has(name)) {
        return
      }

      visited.add(name)
      assigned.add(name)
      block.push(name)

      getChildGroupNames(name, groupSet).forEach((childName) => {
        walk(childName)
      })
    }

    walk(rootName)

    if (block.length > 0) {
      blocks.push(block)
    }
  }

  groups
    .filter((name) => !referenced.has(name))
    .forEach((name) => {
      appendBlock(name)
    })

  groups.forEach((name) => {
    appendBlock(name)
  })

  return blocks
})
export const renderGroups = computed(() => {
  const groups = getRenderGroups()

  if (isProxiesPageMounted.value) {
    return groups
  }

  return groups.slice(0, 16)
})
