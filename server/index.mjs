import express from 'express'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { parse as parseYaml } from 'yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
const dataDir = path.join(rootDir, 'data')
const bundledRuleSourceConfigPath = path.join(rootDir, 'config', 'rule-source.yaml')
const dbPath = process.env.ZASHBOARD_DB_PATH || path.join(dataDir, 'zashboard.sqlite')
const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 2048)
const backgroundImageStorageKey = '__background_image__'
const execFileAsync = promisify(execFile)
const defaultRuleSourceConfigPath = path.join(dataDir, 'rule-source.yaml')
const mihomoBinaryPath =
  process.env.ZASHBOARD_MIHOMO_BIN ||
  (process.platform === 'win32'
    ? path.resolve('.tools/mihomo-bin/mihomo-windows-amd64-compatible.exe')
    : path.resolve('.tools/mihomo-bin/mihomo'))
const ruleSearchTempDir = path.join(dataDir, 'rule-search-temp')
const proxyGroupRulePenetrationCache = new Map()
const proxyGroupRulePenetrationCacheBySignature = new Map()
const PROXY_GROUP_RULE_PENETRATION_CACHE_TTL_MS = 10 * 60 * 1000
const PROXY_GROUP_RULE_PENETRATION_CACHE_LIMIT = 16
const serviceWorkerCleanupScript = `
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys()
    await Promise.all(cacheKeys.map((cacheKey) => caches.delete(cacheKey)))
    await self.registration.unregister()
    const clientsList = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    })
    await Promise.all(
      clientsList.map((client) => {
        if ('navigate' in client) {
          return client.navigate(client.url)
        }

        return Promise.resolve()
      }),
    )
  })())
})
`.trim()
const registerSWCleanupScript = `
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) =>
      Promise.allSettled(registrations.map((registration) => registration.unregister())),
    )
    .then(() => ('caches' in window ? caches.keys() : Promise.resolve([])))
    .then((cacheKeys) => Promise.allSettled(cacheKeys.map((cacheKey) => caches.delete(cacheKey))))
    .catch(() => {})
}
`.trim()

fs.mkdirSync(path.dirname(dbPath), { recursive: true })
fs.mkdirSync(ruleSearchTempDir, { recursive: true })

if (!process.env.ZASHBOARD_RULE_SOURCE_PATH) {
  if (!fs.existsSync(defaultRuleSourceConfigPath) && fs.existsSync(bundledRuleSourceConfigPath)) {
    fs.mkdirSync(path.dirname(defaultRuleSourceConfigPath), { recursive: true })
    fs.copyFileSync(bundledRuleSourceConfigPath, defaultRuleSourceConfigPath)
  }
}

const ruleSourceConfigPath =
  process.env.ZASHBOARD_RULE_SOURCE_PATH ||
  (fs.existsSync(defaultRuleSourceConfigPath)
    ? defaultRuleSourceConfigPath
    : fs.existsSync(bundledRuleSourceConfigPath)
      ? bundledRuleSourceConfigPath
      : '')

const db = new DatabaseSync(dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS app_storage (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS rule_provider_cache (
    name TEXT PRIMARY KEY,
    behavior TEXT NOT NULL,
    format TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_url TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)

const ruleProviderCacheColumns = db
  .prepare(`PRAGMA table_info(rule_provider_cache)`)
  .all()
  .map((row) => row.name)

if (
  !ruleProviderCacheColumns.includes('source_url') ||
  !ruleProviderCacheColumns.includes('interval_seconds') ||
  !ruleProviderCacheColumns.includes('kind') ||
  !ruleProviderCacheColumns.includes('body')
) {
  db.exec('DROP TABLE IF EXISTS rule_provider_cache')
  db.exec(`
    CREATE TABLE rule_provider_cache (
      name TEXT PRIMARY KEY,
      behavior TEXT NOT NULL,
      format TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_url TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

const getSnapshotStatement = db.prepare(`
  SELECT key, value
  FROM app_storage
  ORDER BY key
`)

const insertSnapshotStatement = db.prepare(`
  INSERT INTO app_storage (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
`)

const upsertStorageValueStatement = db.prepare(`
  INSERT INTO app_storage (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = CURRENT_TIMESTAMP
`)

const getStorageValueStatement = db.prepare(`
  SELECT value
  FROM app_storage
  WHERE key = ?
`)

const deleteStorageValueStatement = db.prepare(`
  DELETE FROM app_storage
  WHERE key = ?
`)

const clearRuleProviderCacheStatement = db.prepare(`
  DELETE FROM rule_provider_cache
`)

const upsertRuleProviderCacheStatement = db.prepare(`
  INSERT INTO rule_provider_cache (
    name,
    behavior,
    format,
    kind,
    source_url,
    interval_seconds,
    body,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(name) DO UPDATE SET
    behavior = excluded.behavior,
    format = excluded.format,
    kind = excluded.kind,
    source_url = excluded.source_url,
    interval_seconds = excluded.interval_seconds,
    body = excluded.body,
    updated_at = CURRENT_TIMESTAMP
`)

const getCachedRuleProviderStatement = db.prepare(`
  SELECT name, behavior, format, kind, source_url, interval_seconds, body, updated_at
  FROM rule_provider_cache
  ORDER BY name
`)
const getCachedRuleProviderByNameStatement = db.prepare(`
  SELECT name, behavior, format, kind, source_url, interval_seconds, body, updated_at
  FROM rule_provider_cache
  WHERE name = ?
`)
const getRuleProviderCacheTotalCountStatement = db.prepare(`
  SELECT SUM(
    LENGTH(body) - LENGTH(REPLACE(body, CHAR(10), '')) +
    CASE
      WHEN LENGTH(TRIM(body)) = 0 THEN 0
      WHEN body LIKE '%' || CHAR(10) THEN 0
      ELSE 1
    END
  ) AS total
  FROM rule_provider_cache
`)
let activeRuleProviderUpdatePromise = null
let activeRuleProviderUpdateController = null
let ruleProviderUpdateState = {
  isUpdating: false,
  totalProviders: 0,
  updatedProviders: 0,
  totalRules: 0,
  errors: 0,
  unsupportedCount: 0,
  cancelled: false,
  completed: false,
}

const readSnapshot = () => {
  const snapshot = {}

  for (const row of getSnapshotStatement.all()) {
    if (row.key === backgroundImageStorageKey) continue
    snapshot[row.key] = row.value
  }

  return snapshot
}

const replaceSnapshot = (entries) => {
  db.exec('BEGIN')

  try {
    db.prepare('DELETE FROM app_storage WHERE key != ?').run(backgroundImageStorageKey)

    for (const [key, value] of Object.entries(entries)) {
      insertSnapshotStatement.run(key, value)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const isValidEntries = (entries) => {
  return (
    entries &&
    typeof entries === 'object' &&
    !Array.isArray(entries) &&
    Object.entries(entries).every(
      ([key, value]) => typeof key === 'string' && typeof value === 'string',
    )
  )
}

const extractRuleProviderEntries = (configPath) => {
  if (!configPath || !fs.existsSync(configPath)) {
    throw new Error(
      'Rule source config is not configured. Set ZASHBOARD_RULE_SOURCE_PATH or place rule-source.yaml under data/.',
    )
  }

  const content = fs.readFileSync(configPath, 'utf8')
  const parsed = parseYaml(content)
  const providers = parsed?.['rule-providers']

  if (!providers || typeof providers !== 'object') {
    return []
  }

  return Object.entries(providers)
    .map(([name, provider]) => {
      if (!provider || typeof provider !== 'object') {
        return null
      }

      const url = provider.url

      if (typeof url !== 'string' || !url) {
        return null
      }

      return {
        name,
        behavior: typeof provider.behavior === 'string' ? provider.behavior : '',
        format: typeof provider.format === 'string' ? provider.format : '',
        interval:
          typeof provider.interval === 'number'
            ? provider.interval
            : Number.parseInt(String(provider.interval || '0'), 10) || 0,
        url,
      }
    })
    .filter(Boolean)
}

const getRuleProviderKind = (url, format, behavior) => {
  const normalizedUrl = url.toLowerCase()
  const normalizedFormat = format.toLowerCase()
  const normalizedBehavior = behavior.toLowerCase()

  if (normalizedUrl.endsWith('.mrs') || normalizedFormat === 'mrs') {
    if (normalizedBehavior === 'ipcidr' || normalizedUrl.includes('/geoip/')) {
      return 'mrs-ip'
    }

    return 'mrs-domain'
  }

  return 'text'
}

const normalizeDomain = (domain) =>
  domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
const normalizeKeyword = (value) => value.trim().toLowerCase()
const RULE_TYPE_ALIAS_MAP = new Map([
  ['DOMAIN', 'DOMAIN'],
  ['DOMAINSUFFIX', 'DOMAIN-SUFFIX'],
  ['DOMAINKEYWORD', 'DOMAIN-KEYWORD'],
  ['IPCIDR', 'IP-CIDR'],
  ['IPCIDR6', 'IP-CIDR6'],
  ['SRCIP', 'SRC-IP'],
  ['SRCIPCIDR', 'SRC-IP-CIDR'],
  ['SRCIPCIDR6', 'SRC-IP-CIDR6'],
  ['DSTPORT', 'DST-PORT'],
  ['SRCPORT', 'SRC-PORT'],
  ['INPORT', 'IN-PORT'],
  ['GEOIP', 'GEOIP'],
  ['RULESET', 'RULE-SET'],
  ['FINAL', 'FINAL'],
  ['MATCH', 'MATCH'],
])

const normalizeRuleTypeName = (value) => {
  const normalizedKey = String(value || '')
    .trim()
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()

  return RULE_TYPE_ALIAS_MAP.get(normalizedKey) || String(value || '').trim().toUpperCase()
}

const getRuleEntryFamily = (type) => {
  if (['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(type)) {
    return 'domain'
  }

  if (
    ['IP-CIDR', 'IP-CIDR6', 'SRC-IP', 'SRC-IP-CIDR', 'SRC-IP-CIDR6', 'GEOIP'].includes(type)
  ) {
    return 'ip'
  }

  if (['DST-PORT', 'SRC-PORT', 'IN-PORT'].includes(type)) {
    return 'port'
  }

  return 'other'
}

const buildRuleEntry = (type, content, params = [], options = {}) => {
  const normalizedType = normalizeRuleTypeName(type)
  const normalizedContent = String(content || '').trim()
  const normalizedParams = params
    .map((param) => String(param || '').trim())
    .filter(Boolean)
  const raw =
    options.raw ||
    [normalizedType, normalizedContent, ...normalizedParams].filter(Boolean).join(',')

  return {
    type: normalizedType,
    family: getRuleEntryFamily(normalizedType),
    content: normalizedContent,
    params: normalizedParams.join(', '),
    raw,
    source: options.source || '',
    line: Number.isInteger(options.line) ? options.line : null,
  }
}

const parseRuleEntryFromTextLine = (rawLine, index = null, source = '') => {
  const line = String(rawLine || '').trim()

  if (!line || line.startsWith('#') || line.startsWith('//') || /^payload\s*:/i.test(line)) {
    return null
  }

  const normalizedLine = line.startsWith('- ') ? line.slice(2).trim() : line

  if (!normalizedLine) {
    return null
  }

  if (/^(domain|suffix|keyword|ip-cidr|ip-cidr6):/i.test(normalizedLine)) {
    const [, key, value] = normalizedLine.match(/^([^:]+):\s*(.+)$/) || []

    if (!key || !value) {
      return null
    }

    const canonicalType = normalizeRuleTypeName(key)

    return buildRuleEntry(canonicalType, value, [], {
      raw: `${canonicalType},${value.trim()}`,
      source,
      line: index,
    })
  }

  if (normalizedLine.startsWith('+.')) {
    const value = normalizedLine.slice(2).trim()

    return buildRuleEntry('DOMAIN-SUFFIX', value, [], {
      raw: `DOMAIN-SUFFIX,${value}`,
      source,
      line: index,
    })
  }

  if (!normalizedLine.includes(',')) {
    if (parseIpCidr(normalizedLine)) {
      return buildRuleEntry('IP-CIDR', normalizedLine, [], {
        raw: `IP-CIDR,${normalizedLine}`,
        source,
        line: index,
      })
    }

    return buildRuleEntry('DOMAIN', normalizedLine, [], {
      raw: `DOMAIN,${normalizedLine}`,
      source,
      line: index,
    })
  }

  const parts = normalizedLine.split(',').map((part) => part.trim())
  const canonicalType = normalizeRuleTypeName(parts[0])
  const content = parts[1] || ''
  const params = parts.slice(2)

  if (!canonicalType || !content) {
    return null
  }

  return buildRuleEntry(canonicalType, content, params, {
    raw: [canonicalType, content, ...params].filter(Boolean).join(','),
    source,
    line: index,
  })
}

const parseRuleEntriesFromBody = (body, source = '') => {
  const entries = []
  const lines = String(body || '').split(/\r?\n/)

  lines.forEach((line, index) => {
    const entry = parseRuleEntryFromTextLine(line, index + 1, source)

    if (entry) {
      entries.push(entry)
    }
  })

  return entries
}

const isRuleEnabled = (rule) => {
  if (rule?.extra) {
    return !rule.extra.disabled
  }

  return !rule?.disabled
}

const parseDirectControllerRuleEntry = (rule) => {
  const normalizedType = normalizeRuleTypeName(rule?.type)

  if (!normalizedType || normalizedType === 'RULE-SET') {
    return null
  }

  const payloadParts = String(rule?.payload || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const content = payloadParts[0] || ''
  const params = payloadParts.slice(1)
  const proxy = String(rule?.proxy || '').trim()
  const normalizedParams = proxy ? [...params, proxy] : params

  if (!content && normalizedType !== 'MATCH' && normalizedType !== 'FINAL') {
    return null
  }

  return buildRuleEntry(normalizedType, content, normalizedParams, {
    raw: [normalizedType, content, ...normalizedParams].filter(Boolean).join(','),
    source: 'controller',
    line: Number.isInteger(rule?.index) ? rule.index + 1 : null,
  })
}

const PROXY_GROUP_PRE_CUSTOM_KEY = '__custom_pre__'
const PROXY_GROUP_POST_CUSTOM_KEY = '__custom_post__'

const getProxyGroupCustomModeFromGroupName = (groupName) => {
  if (groupName === PROXY_GROUP_PRE_CUSTOM_KEY) {
    return 'pre'
  }

  if (groupName === PROXY_GROUP_POST_CUSTOM_KEY) {
    return 'post'
  }

  return null
}

const normalizeProxyGroupCustomMode = (value) => {
  return value === 'pre' || value === 'post' || value === 'all' ? value : null
}

const isProxyGroupCustomDirectRule = (normalizedType) => {
  return Boolean(
    normalizedType &&
      normalizedType !== 'RULE-SET' &&
      normalizedType !== 'MATCH' &&
      normalizedType !== 'FINAL',
  )
}

const expandProxyGroupRuleEntries = (groupName, rules, options = {}) => {
  const customGroupMode =
    normalizeProxyGroupCustomMode(options.customGroupMode) ||
    (options.customGroup === true ? 'all' : null) ||
    getProxyGroupCustomModeFromGroupName(groupName)
  const customGroup = customGroupMode !== null
  const relevantRules = []
  const sortedRules = [...rules]
    .filter((rule) => isRuleEnabled(rule))
    .sort((prev, next) => (prev?.index || 0) - (next?.index || 0))
  let hasSeenRuleSet = false

  sortedRules.forEach((rule) => {
    const normalizedType = normalizeRuleTypeName(rule?.type)

    if (customGroup) {
      if (normalizedType === 'RULE-SET') {
        hasSeenRuleSet = true
        return
      }

      if (!isProxyGroupCustomDirectRule(normalizedType)) {
        return
      }

      if (customGroupMode === 'all') {
        relevantRules.push(rule)
        return
      }

      const ruleMode = hasSeenRuleSet ? 'post' : 'pre'

      if (ruleMode === customGroupMode) {
        relevantRules.push(rule)
      }

      return
    }

    if (rule?.proxy === groupName) {
      relevantRules.push(rule)
    }
  })
  const entries = []
  const seenEntries = new Set()
  const missingProviders = new Set()

  const pushEntry = (entry) => {
    if (!entry) {
      return
    }

    const key = [entry.type, entry.content, entry.params, entry.raw].join('::')

    if (seenEntries.has(key)) {
      return
    }

    seenEntries.add(key)
    entries.push(entry)
  }

  for (const rule of relevantRules) {
    const normalizedType = normalizeRuleTypeName(rule?.type)

    if (normalizedType === 'RULE-SET') {
      const providerName = String(rule?.payload || '').trim()
      const cachedProvider = getCachedRuleProviderByNameStatement.get(providerName)

      if (!cachedProvider) {
        missingProviders.add(providerName)
        continue
      }

      parseRuleEntriesFromBody(cachedProvider.body, providerName).forEach(pushEntry)
      continue
    }

    pushEntry(parseDirectControllerRuleEntry(rule))
  }

  return {
    groupName,
    customGroup,
    customGroupMode,
    totalRules: relevantRules.length,
    items: entries,
    missingProviders: Array.from(missingProviders),
  }
}

const PROXY_GROUP_RULE_PENETRATION_TAB_SET = new Set(['all', 'domain', 'ip', 'port'])
const PROXY_GROUP_RULE_PENETRATION_SORT_KEY_SET = new Set(['type', 'content', 'params', 'raw'])
const PROXY_GROUP_RULE_PENETRATION_CACHE_VERSION = 3
const RULE_TYPE_DISPLAY_NAME_MAP = new Map([
  ['DOMAIN', '域名'],
  ['DOMAIN-SUFFIX', '域名后缀'],
  ['DOMAIN-KEYWORD', '关键字'],
  ['IP-CIDR', '目标IP'],
  ['IP-CIDR6', '目标IP'],
  ['SRC-IP', '源IP'],
  ['SRC-IP-CIDR', '源IP'],
  ['SRC-IP-CIDR6', '源IP'],
  ['DST-PORT', '目标端口'],
  ['SRC-PORT', '源端口'],
  ['IN-PORT', '入站端口'],
  ['GEOIP', '目标IP'],
  ['MATCH', '匹配'],
  ['FINAL', '最终'],
])

const pruneProxyGroupRulePenetrationCache = () => {
  const now = Date.now()

  for (const [cacheKey, entry] of proxyGroupRulePenetrationCache.entries()) {
    if (now - entry.lastAccessAt <= PROXY_GROUP_RULE_PENETRATION_CACHE_TTL_MS) {
      continue
    }

    proxyGroupRulePenetrationCache.delete(cacheKey)
    proxyGroupRulePenetrationCacheBySignature.delete(entry.signature)
  }

  if (proxyGroupRulePenetrationCache.size <= PROXY_GROUP_RULE_PENETRATION_CACHE_LIMIT) {
    return
  }

  const staleEntries = [...proxyGroupRulePenetrationCache.entries()].sort(
    (left, right) => left[1].lastAccessAt - right[1].lastAccessAt,
  )

  while (staleEntries.length > 0 && proxyGroupRulePenetrationCache.size > PROXY_GROUP_RULE_PENETRATION_CACHE_LIMIT) {
    const [cacheKey, entry] = staleEntries.shift()
    proxyGroupRulePenetrationCache.delete(cacheKey)
    proxyGroupRulePenetrationCacheBySignature.delete(entry.signature)
  }
}

const buildProxyGroupRulePenetrationSignature = (groupName, rules, options = {}) => {
  const customGroupMode =
    normalizeProxyGroupCustomMode(options.customGroupMode) || (options.customGroup === true ? 'all' : null)

  return createHash('sha1')
    .update(
      JSON.stringify({
        version: PROXY_GROUP_RULE_PENETRATION_CACHE_VERSION,
        groupName,
        customGroup: options.customGroup === true,
        customGroupMode,
        rules,
      }),
    )
    .digest('hex')
}

const getProxyGroupRulePenetrationDisplayType = (type) => {
  return RULE_TYPE_DISPLAY_NAME_MAP.get(type) || type
}

const normalizeProxyGroupRulePenetrationTab = (value) => {
  return PROXY_GROUP_RULE_PENETRATION_TAB_SET.has(value) ? value : 'all'
}

const normalizeProxyGroupRulePenetrationSortKey = (value) => {
  return PROXY_GROUP_RULE_PENETRATION_SORT_KEY_SET.has(value) ? value : null
}

const normalizeProxyGroupRulePenetrationSortDirection = (value) => {
  return value === 'desc' ? 'desc' : 'asc'
}

const normalizePositiveInteger = (value, defaultValue, maxValue) => {
  const parsed = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue
  }

  return Math.min(parsed, maxValue)
}

const getProxyGroupRulePenetrationCacheEntry = ({
  groupName,
  cacheKey,
  rules,
  customGroup = false,
  customGroupMode = null,
}) => {
  pruneProxyGroupRulePenetrationCache()
  const normalizedCustomGroupMode =
    normalizeProxyGroupCustomMode(customGroupMode) || (customGroup === true ? 'all' : null)

  if (cacheKey) {
    const cachedEntry = proxyGroupRulePenetrationCache.get(cacheKey)

    if (
      !cachedEntry ||
      cachedEntry.groupName !== groupName ||
      cachedEntry.customGroup !== customGroup ||
      cachedEntry.customGroupMode !== normalizedCustomGroupMode
    ) {
      const error = new Error('cache expired')
      error.code = 'CACHE_EXPIRED'
      throw error
    }

    cachedEntry.lastAccessAt = Date.now()
    return cachedEntry
  }

  const signature = buildProxyGroupRulePenetrationSignature(groupName, rules, {
    customGroup,
    customGroupMode: normalizedCustomGroupMode,
  })
  const reusedCacheKey = proxyGroupRulePenetrationCacheBySignature.get(signature)

  if (reusedCacheKey) {
    const reusedEntry = proxyGroupRulePenetrationCache.get(reusedCacheKey)

    if (reusedEntry) {
      reusedEntry.lastAccessAt = Date.now()
      return reusedEntry
    }

    proxyGroupRulePenetrationCacheBySignature.delete(signature)
  }

  const expanded = expandProxyGroupRuleEntries(groupName, rules, {
    customGroup,
    customGroupMode: normalizedCustomGroupMode,
  })
  const nextCacheKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const createdEntry = {
    cacheKey: nextCacheKey,
    signature,
    groupName,
    customGroup,
    customGroupMode: expanded.customGroupMode,
    totalRules: expanded.totalRules,
    items: expanded.items,
    missingProviders: expanded.missingProviders,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
  }

  proxyGroupRulePenetrationCache.set(nextCacheKey, createdEntry)
  proxyGroupRulePenetrationCacheBySignature.set(signature, nextCacheKey)
  pruneProxyGroupRulePenetrationCache()

  return createdEntry
}

const matchesProxyGroupRulePenetrationSearch = (entry, search) => {
  if (!search) {
    return true
  }

  const normalizedSearch = search.toLowerCase()

  return [
    entry.type,
    getProxyGroupRulePenetrationDisplayType(entry.type),
    entry.content,
    entry.params,
    entry.raw,
  ].some((value) => String(value || '').toLowerCase().includes(normalizedSearch))
}

const sortProxyGroupRulePenetrationEntries = (items, sortKey, sortDirection) => {
  if (!sortKey) {
    return items
  }

  const direction = sortDirection === 'desc' ? -1 : 1

  return [...items].sort((left, right) => {
    const leftValue = sortKey === 'type' ? getProxyGroupRulePenetrationDisplayType(left.type) : left[sortKey]
    const rightValue = sortKey === 'type' ? getProxyGroupRulePenetrationDisplayType(right.type) : right[sortKey]

    return (
      String(leftValue || '').localeCompare(String(rightValue || ''), 'zh-Hans-CN', {
        numeric: true,
        sensitivity: 'base',
      }) * direction
    )
  })
}

const normalizeLookupInput = (value) => {
  const input = value.trim()

  if (!input) {
    return null
  }

  let candidate = input

  try {
    candidate = new URL(input.includes('://') ? input : `https://${input}`).hostname || input
  } catch {
    candidate = input.split('/')[0]
  }

  const trimmedCandidate = candidate.trim()
  const ipVersion = isIP(trimmedCandidate)

  if (ipVersion) {
    const parsedIp = parseIpAddress(trimmedCandidate)

    if (!parsedIp) {
      return null
    }

    return {
      raw: input,
      type: 'ip',
      value: trimmedCandidate.toLowerCase(),
      parsedIp,
    }
  }

  const normalizedDomainValue = normalizeDomain(trimmedCandidate)

  if (/^[a-z0-9.-]+$/i.test(normalizedDomainValue) && normalizedDomainValue.includes('.')) {
    return {
      raw: input,
      type: 'domain',
      value: normalizedDomainValue,
    }
  }

  const keyword = normalizeKeyword(input)

  if (!keyword) {
    return null
  }

  return {
    raw: input,
    type: 'keyword',
    value: keyword,
  }
}
const countRulesInBody = (body) => {
  if (!body || !body.trim()) {
    return 0
  }

  const newLineCount = (body.match(/\n/g) || []).length

  return body.endsWith('\n') ? newLineCount : newLineCount + 1
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

const getProxyTarget = (req) => {
  const rawBase = req.header('x-zashboard-target-base')

  if (!rawBase) {
    throw new Error('Missing x-zashboard-target-base header')
  }

  const target = new URL(rawBase)

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Only http and https controller targets are supported')
  }

  return {
    base: target,
    secret: req.header('x-zashboard-target-secret') || '',
  }
}

const buildUpstreamUrl = (req, targetBase) => {
  const suffix = req.originalUrl.slice('/api/controller'.length) || '/'
  const normalizedBase = targetBase.toString().replace(/\/$/, '')

  return new URL(`${normalizedBase}${suffix.startsWith('/') ? suffix : `/${suffix}`}`)
}

const buildProxyPath = (basePath, suffix) => {
  const normalizedBasePath = (basePath || '').replace(/\/+$/, '')
  const normalizedSuffix = (suffix || '').replace(/^\/+/, '')

  if (!normalizedBasePath && !normalizedSuffix) {
    return '/'
  }

  if (!normalizedBasePath) {
    return `/${normalizedSuffix}`
  }

  if (!normalizedSuffix) {
    return normalizedBasePath || '/'
  }

  return `${normalizedBasePath}/${normalizedSuffix}`
}

const proxyControllerRequest = async (req, res) => {
  try {
    const { base, secret } = getProxyTarget(req)
    const upstreamUrl = buildUpstreamUrl(req, base)
    const headers = new Headers()

    Object.entries(req.headers).forEach(([key, value]) => {
      const normalizedKey = key.toLowerCase()

      if (
        HOP_BY_HOP_HEADERS.has(normalizedKey) ||
        normalizedKey.startsWith('x-zashboard-target-')
      ) {
        return
      }

      if (Array.isArray(value)) {
        headers.set(key, value.join(', '))
        return
      }

      if (typeof value === 'string') {
        headers.set(key, value)
      }
    })

    if (secret) {
      headers.set('Authorization', `Bearer ${secret}`)
    } else {
      headers.delete('Authorization')
    }

    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body:
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : Buffer.isBuffer(req.body) && req.body.length
            ? req.body
            : undefined,
    })

    res.status(response.status)

    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        res.setHeader(key, value)
      }
    })

    const body = Buffer.from(await response.arrayBuffer())
    res.send(body)
  } catch (error) {
    res.status(502).json({
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

const getWebSocketProxyTarget = (requestUrl) => {
  const targetBaseRaw = requestUrl.searchParams.get('targetBase')

  if (!targetBaseRaw) {
    throw new Error('Missing targetBase query parameter')
  }

  const targetBase = new URL(targetBaseRaw)

  if (!['http:', 'https:'].includes(targetBase.protocol)) {
    throw new Error('Only http and https controller targets are supported')
  }

  return {
    base: targetBase,
    secret: requestUrl.searchParams.get('secret') || '',
  }
}

const buildUpstreamWebSocketUrl = (requestUrl, targetBase, secret) => {
  const suffix = requestUrl.pathname.slice('/api/controller-ws'.length) || '/'
  const upstreamUrl = new URL(targetBase.toString())

  upstreamUrl.protocol = targetBase.protocol === 'https:' ? 'wss:' : 'ws:'
  upstreamUrl.pathname = buildProxyPath(upstreamUrl.pathname, suffix)
  upstreamUrl.search = ''

  requestUrl.searchParams.forEach((value, key) => {
    if (key !== 'targetBase' && key !== 'secret') {
      upstreamUrl.searchParams.append(key, value)
    }
  })

  if (secret) {
    upstreamUrl.searchParams.set('token', secret)
  }

  return upstreamUrl
}

const normalizeCloseCode = (code, fallback = 1000) => {
  if (!Number.isInteger(code)) {
    return fallback
  }

  if (code >= 3000 && code <= 4999) {
    return code
  }

  if (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) {
    return code
  }

  return fallback
}

const closeSocket = (socket, code = 1000, reason = '') => {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(normalizeCloseCode(code), reason)
  }
}

const closeSocketPair = (left, right, code = 1011, reason = '') => {
  closeSocket(left, code, reason)
  closeSocket(right, code, reason)
}

const relayControllerWebSocket = (clientSocket, request) => {
  let upstreamSocket

  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const { base, secret } = getWebSocketProxyTarget(requestUrl)
    const upstreamUrl = buildUpstreamWebSocketUrl(requestUrl, base, secret)

    upstreamSocket = new WebSocket(upstreamUrl)

    const closeBoth = (code, reason) => {
      closeSocketPair(clientSocket, upstreamSocket, code, reason)
    }

    clientSocket.on('message', (data, isBinary) => {
      if (upstreamSocket.readyState === WebSocket.OPEN) {
        upstreamSocket.send(data, { binary: isBinary })
      }
    })

    clientSocket.on('close', (code, reason) => {
      closeSocket(upstreamSocket, code, reason?.toString())
    })

    clientSocket.on('error', () => {
      closeBoth(1011, 'Client websocket error')
    })

    upstreamSocket.on('message', (data, isBinary) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary })
      }
    })

    upstreamSocket.on('close', (code, reason) => {
      closeSocket(clientSocket, code, reason?.toString())
    })

    upstreamSocket.on('error', () => {
      closeBoth(1011, 'Upstream websocket error')
    })
  } catch (error) {
    closeSocket(clientSocket, 1011, error instanceof Error ? error.message : String(error))

    if (upstreamSocket) {
      closeSocket(upstreamSocket, 1011)
    }
  }
}

const isDomainMatch = (domain, ruleValue, mode) => {
  const normalizedDomain = normalizeDomain(domain)
  const normalizedRule = normalizeDomain(ruleValue)

  if (!normalizedDomain || !normalizedRule) {
    return false
  }

  if (mode === 'domain') {
    return normalizedDomain === normalizedRule
  }

  if (mode === 'suffix') {
    return normalizedDomain === normalizedRule || normalizedDomain.endsWith(`.${normalizedRule}`)
  }

  if (mode === 'keyword') {
    return normalizedDomain.includes(normalizedRule)
  }

  return false
}

const isKeywordMatch = (keyword, ruleValue) => {
  const normalizedRule = normalizeDomain(ruleValue)

  return Boolean(keyword && normalizedRule && normalizedRule.includes(keyword))
}

const parseIPv4Address = (value) => {
  const parts = value.split('.')

  if (parts.length !== 4) {
    return null
  }

  let result = 0n

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null
    }

    const octet = Number(part)

    if (octet < 0 || octet > 255) {
      return null
    }

    result = (result << 8n) + BigInt(octet)
  }

  return {
    version: 4,
    bits: 32,
    value: result,
  }
}

const parseIPv6Address = (value) => {
  let normalized = value.toLowerCase()

  if (normalized.includes('.')) {
    const lastColonIndex = normalized.lastIndexOf(':')

    if (lastColonIndex === -1) {
      return null
    }

    const ipv4Address = parseIPv4Address(normalized.slice(lastColonIndex + 1))

    if (!ipv4Address) {
      return null
    }

    normalized = `${normalized.slice(0, lastColonIndex)}:${Number(
      (ipv4Address.value >> 16n) & 0xffffn,
    ).toString(16)}:${Number(ipv4Address.value & 0xffffn).toString(16)}`
  }

  const doubleColonIndex = normalized.indexOf('::')

  if (doubleColonIndex !== normalized.lastIndexOf('::')) {
    return null
  }

  const headSegments =
    doubleColonIndex === -1
      ? normalized.split(':')
      : normalized.slice(0, doubleColonIndex).split(':').filter(Boolean)
  const tailSegments =
    doubleColonIndex === -1
      ? []
      : normalized
          .slice(doubleColonIndex + 2)
          .split(':')
          .filter(Boolean)

  if (doubleColonIndex === -1 && headSegments.length !== 8) {
    return null
  }

  if (headSegments.length + tailSegments.length > 8) {
    return null
  }

  const segments =
    doubleColonIndex === -1
      ? headSegments
      : [
          ...headSegments,
          ...Array.from({ length: 8 - headSegments.length - tailSegments.length }, () => '0'),
          ...tailSegments,
        ]

  if (segments.length !== 8) {
    return null
  }

  let result = 0n

  for (const segment of segments) {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return null
    }

    result = (result << 16n) + BigInt(`0x${segment}`)
  }

  return {
    version: 6,
    bits: 128,
    value: result,
  }
}

const parseIpAddress = (value) => {
  const ipVersion = isIP(value)

  if (ipVersion === 4) {
    return parseIPv4Address(value)
  }

  if (ipVersion === 6) {
    return parseIPv6Address(value)
  }

  return null
}

const parseIpCidr = (value) => {
  const trimmedValue = value.trim()

  if (!trimmedValue) {
    return null
  }

  const parts = trimmedValue.split('/')

  if (parts.length > 2) {
    return null
  }

  const parsedAddress = parseIpAddress(parts[0])

  if (!parsedAddress) {
    return null
  }

  const prefix = parts.length === 2 ? Number.parseInt(parts[1], 10) : parsedAddress.bits

  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsedAddress.bits) {
    return null
  }

  const suffixBits = BigInt(parsedAddress.bits - prefix)
  const network =
    suffixBits === 0n ? parsedAddress.value : (parsedAddress.value >> suffixBits) << suffixBits
  const size = 1n << suffixBits

  return {
    version: parsedAddress.version,
    prefix,
    start: network,
    end: network + size - 1n,
  }
}

const isIpInCidr = (parsedIp, ruleValue) => {
  const parsedRule = parseIpCidr(ruleValue)

  if (!parsedRule || parsedRule.version !== parsedIp.version) {
    return false
  }

  return parsedIp.value >= parsedRule.start && parsedIp.value <= parsedRule.end
}

const findMatchesInTextRules = (lookup, body) => {
  const matches = []
  const lines = body.split(/\r?\n/)

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()

    if (!line || line.startsWith('#') || line.startsWith('//') || /^payload\s*:/i.test(line)) {
      return
    }

    const normalizedLine = line.startsWith('- ') ? line.slice(2).trim() : line

    if (!normalizedLine) {
      return
    }

    if (/^(domain|suffix|keyword|ip-cidr|ip-cidr6):/i.test(normalizedLine)) {
      const [, key, value] = normalizedLine.match(/^([^:]+):\s*(.+)$/) || []

      if (!key || !value) {
        return
      }

      const normalizedKey = key.toLowerCase()

      if (lookup.type === 'ip') {
        const mode = normalizedKey.includes('6') ? 'ip-cidr6' : 'ip-cidr'

        if (normalizedKey.includes('ip') && isIpInCidr(lookup.parsedIp, value)) {
          matches.push({ line: index + 1, value, mode, raw: normalizedLine })
        }

        return
      }

      const mode = normalizedKey.includes('suffix')
        ? 'suffix'
        : normalizedKey.includes('keyword')
          ? 'keyword'
          : 'domain'

      const isMatched =
        lookup.type === 'domain'
          ? isDomainMatch(lookup.value, value, mode)
          : isKeywordMatch(lookup.value, value)

      if (isMatched) {
        matches.push({ line: index + 1, value, mode, raw: normalizedLine })
      }

      return
    }

    if (lookup.type !== 'ip' && normalizedLine.startsWith('+.')) {
      const value = normalizedLine.slice(2)
      const isMatched =
        lookup.type === 'domain'
          ? isDomainMatch(lookup.value, value, 'suffix')
          : isKeywordMatch(lookup.value, value)

      if (isMatched) {
        matches.push({ line: index + 1, value, mode: 'suffix', raw: normalizedLine })
      }

      return
    }

    const parts = normalizedLine.split(',').map((part) => part.trim())
    const ruleType = parts[0]?.toUpperCase()
    const value = parts[1] || parts[0]

    if (lookup.type === 'ip') {
      const supportsIpMatch =
        ['IP-CIDR', 'IP-CIDR6'].includes(ruleType) ||
        (!normalizedLine.includes(',') && Boolean(parseIpCidr(normalizedLine)))

      if (supportsIpMatch && isIpInCidr(lookup.parsedIp, value)) {
        matches.push({
          line: index + 1,
          value,
          mode: ruleType === 'IP-CIDR6' ? 'ip-cidr6' : 'ip-cidr',
          raw: normalizedLine,
        })
      }

      return
    }

    const supportsDomainMatch =
      ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(ruleType) ||
      (!ruleType.includes('IP') && !ruleType.includes('PROCESS') && !normalizedLine.includes(','))

    if (!supportsDomainMatch) {
      return
    }

    const mode =
      ruleType === 'DOMAIN-SUFFIX' ? 'suffix' : ruleType === 'DOMAIN-KEYWORD' ? 'keyword' : 'domain'
    const isMatched =
      lookup.type === 'domain'
        ? isDomainMatch(lookup.value, value, mode)
        : isKeywordMatch(lookup.value, value)

    if (isMatched) {
      matches.push({ line: index + 1, value, mode, raw: normalizedLine })
    }
  })

  return matches
}

const convertMrsToText = async (provider, buffer) => {
  if (!fs.existsSync(mihomoBinaryPath)) {
    throw new Error(`Mihomo binary not found: ${mihomoBinaryPath}`)
  }

  const tempName = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const sourcePath = path.join(ruleSearchTempDir, `${tempName}.mrs`)
  const targetPath = path.join(ruleSearchTempDir, `${tempName}.txt`)
  const behavior = provider.kind === 'mrs-ip' ? 'ipcidr' : 'domain'

  fs.writeFileSync(sourcePath, buffer)

  try {
    await execFileAsync(
      mihomoBinaryPath,
      ['convert-ruleset', behavior, 'mrs', sourcePath, targetPath],
      {
        windowsHide: true,
      },
    )

    return fs.readFileSync(targetPath, 'utf8')
  } finally {
    if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath)
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
  }
}

const fetchProviderBody = async (provider) => {
  const response = await fetch(provider.url, {
    signal: activeRuleProviderUpdateController?.signal,
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return provider.kind === 'mrs-domain' || provider.kind === 'mrs-ip'
    ? await convertMrsToText(provider, Buffer.from(await response.arrayBuffer()))
    : await response.text()
}

const saveProviderToCache = (provider, body) => {
  upsertRuleProviderCacheStatement.run(
    provider.name,
    provider.behavior,
    provider.format,
    provider.kind,
    provider.url,
    provider.interval,
    body,
  )
}

const getRuleProviderCacheRuleCount = () => {
  const row = getRuleProviderCacheTotalCountStatement.get()

  return Number(row?.total || 0)
}

const replaceRuleProviderCache = (items, options = {}) => {
  const force = options.force ?? false

  db.exec('BEGIN')

  try {
    if (force) {
      clearRuleProviderCacheStatement.run()
    }

    for (const item of items) {
      saveProviderToCache(item.provider, item.body)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const isCacheExpired = (updatedAt, intervalSeconds) => {
  if (!intervalSeconds || intervalSeconds <= 0) {
    return false
  }

  const updatedTime = new Date(updatedAt).getTime()

  if (Number.isNaN(updatedTime)) {
    return true
  }

  return Date.now() - updatedTime >= intervalSeconds * 1000
}

const updateRuleProviderCache = async (options = {}) => {
  if (activeRuleProviderUpdatePromise) {
    return await activeRuleProviderUpdatePromise
  }

  activeRuleProviderUpdatePromise = (async () => {
    const force = options.force ?? true
    const providers = extractRuleProviderEntries(ruleSourceConfigPath).map((provider) => ({
      ...provider,
      kind: getRuleProviderKind(provider.url, provider.format, provider.behavior),
    }))
    const cachedProviderMap = new Map(
      getCachedRuleProviderStatement.all().map((provider) => [provider.name, provider]),
    )
    const errors = []
    let updatedCount = 0
    let progressRules = 0
    const fetchedItems = []
    const unsupportedCount = 0

    activeRuleProviderUpdateController = new AbortController()
    ruleProviderUpdateState = {
      isUpdating: true,
      totalProviders: providers.length,
      updatedProviders: 0,
      totalRules: 0,
      errors: 0,
      unsupportedCount,
      cancelled: false,
      completed: false,
    }

    for (const provider of providers) {
      if (activeRuleProviderUpdateController.signal.aborted) {
        break
      }

      const cachedProvider = cachedProviderMap.get(provider.name)
      const shouldRefresh =
        force ||
        !cachedProvider ||
        cachedProvider.source_url !== provider.url ||
        cachedProvider.kind !== provider.kind ||
        cachedProvider.behavior !== provider.behavior ||
        cachedProvider.format !== provider.format ||
        cachedProvider.interval_seconds !== provider.interval ||
        isCacheExpired(cachedProvider.updated_at, provider.interval)

      if (!shouldRefresh) {
        continue
      }

      try {
        const body = await fetchProviderBody(provider)

        if (activeRuleProviderUpdateController.signal.aborted) {
          break
        }

        fetchedItems.push({ provider, body })
        updatedCount++
        progressRules += countRulesInBody(body)
        ruleProviderUpdateState = {
          ...ruleProviderUpdateState,
          updatedProviders: updatedCount,
          totalRules: progressRules,
        }
      } catch (error) {
        if (activeRuleProviderUpdateController.signal.aborted) {
          break
        }

        errors.push({
          name: provider.name,
          url: provider.url,
          message: error instanceof Error ? error.message : String(error),
        })
        ruleProviderUpdateState = {
          ...ruleProviderUpdateState,
          errors: errors.length,
        }
      }
    }

    const cancelled = activeRuleProviderUpdateController.signal.aborted

    if (!cancelled) {
      replaceRuleProviderCache(fetchedItems, { force })
    }

    ruleProviderUpdateState = {
      ...ruleProviderUpdateState,
      isUpdating: false,
      cancelled,
      completed: true,
    }

    return {
      ok: true,
      totalProviders: providers.length,
      updatedCount,
      unsupportedCount,
      mode: force ? 'force' : 'interval',
      totalRules: getRuleProviderCacheRuleCount(),
      progressRules,
      cancelled,
      errors,
    }
  })()

  try {
    return await activeRuleProviderUpdatePromise
  } finally {
    activeRuleProviderUpdatePromise = null
    activeRuleProviderUpdateController = null
  }
}

const cancelRuleProviderUpdate = () => {
  if (activeRuleProviderUpdateController && !activeRuleProviderUpdateController.signal.aborted) {
    activeRuleProviderUpdateController.abort()
    ruleProviderUpdateState = {
      ...ruleProviderUpdateState,
      isUpdating: false,
      cancelled: true,
      completed: true,
    }
    return true
  }

  return false
}

const searchRuleProviderCache = async (query) => {
  const lookup = normalizeLookupInput(query)

  if (!lookup) {
    throw new Error('query is invalid')
  }

  const cachedProviders = getCachedRuleProviderStatement.all()
  const configuredProviders = extractRuleProviderEntries(ruleSourceConfigPath).map((provider) => ({
    ...provider,
    kind: getRuleProviderKind(provider.url, provider.format, provider.behavior),
  }))
  const matches = []
  const unsupported = []

  for (const provider of cachedProviders) {
    const providerMatches = findMatchesInTextRules(lookup, provider.body)

    if (providerMatches.length > 0) {
      matches.push({
        name: provider.name,
        behavior: provider.behavior,
        format: provider.format,
        url: provider.source_url,
        totalRules: countRulesInBody(provider.body),
        status: 'cached',
        matches: providerMatches.slice(0, 20),
      })
    }
  }

  return {
    query: lookup.raw,
    queryType: lookup.type,
    mode: 'cached',
    matches,
    unsupported,
    errors: [],
    totalProviders: configuredProviders.length,
    cachedProviders: cachedProviders.length,
  }
}

const app = express()
const server = http.createServer(app)
const websocketServer = new WebSocketServer({ noServer: true })

app.use('/api/storage', express.json({ limit: '25mb' }))
app.use('/api/background-image', express.json({ limit: '25mb' }))
app.use('/api/proxy-group-rule-penetration', express.json({ limit: '5mb' }))
app.use('/api/controller', express.raw({ type: '*/*', limit: '25mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    dbPath,
  })
})

app.all(/^\/api\/controller(?:\/.*)?$/, proxyControllerRequest)

app.get('/api/storage', (_req, res) => {
  res.json({
    entries: readSnapshot(),
  })
})

app.put('/api/storage', (req, res) => {
  const { entries } = req.body ?? {}

  if (!isValidEntries(entries)) {
    res.status(400).json({
      message: 'entries must be an object with string values',
    })
    return
  }

  replaceSnapshot(entries)

  res.json({
    ok: true,
    count: Object.keys(entries).length,
  })
})

app.get('/api/background-image', (_req, res) => {
  const row = getStorageValueStatement.get(backgroundImageStorageKey)

  res.json({
    image: row?.value || '',
  })
})

app.put('/api/background-image', (req, res) => {
  const { image } = req.body ?? {}

  if (typeof image !== 'string') {
    res.status(400).json({
      message: 'image must be a string',
    })
    return
  }

  upsertStorageValueStatement.run(backgroundImageStorageKey, image)

  res.json({
    ok: true,
    size: image.length,
  })
})

app.delete('/api/background-image', (_req, res) => {
  deleteStorageValueStatement.run(backgroundImageStorageKey)

  res.json({
    ok: true,
  })
})

app.post('/api/rule-provider-cache/update', async (_req, res) => {
  try {
    res.json(await updateRuleProviderCache())
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/rule-provider-cache/cancel', (_req, res) => {
  res.json({
    ok: cancelRuleProviderUpdate(),
    progress: ruleProviderUpdateState,
  })
})

app.get('/api/rule-provider-cache/stats', (_req, res) => {
  res.json({
    totalRules: getRuleProviderCacheRuleCount(),
    progress: ruleProviderUpdateState,
  })
})

app.get('/api/rule-provider-search', async (req, res) => {
  const query =
    typeof req.query.query === 'string'
      ? req.query.query
      : typeof req.query.domain === 'string'
        ? req.query.domain
        : ''

  if (!query.trim()) {
    res.status(400).json({
      message: 'query is required',
    })
    return
  }

  try {
    res.json(await searchRuleProviderCache(query))
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/proxy-group-rule-penetration', (req, res) => {
  const groupName = typeof req.body?.groupName === 'string' ? req.body.groupName.trim() : ''
  const cacheKey = typeof req.body?.cacheKey === 'string' ? req.body.cacheKey.trim() : ''
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : null
  const customGroupMode =
    normalizeProxyGroupCustomMode(req.body?.customGroupMode) || getProxyGroupCustomModeFromGroupName(groupName)
  const customGroup = customGroupMode !== null || req.body?.customGroup === true
  const providerName = typeof req.body?.providerName === 'string' ? req.body.providerName.trim() : ''
  const page = normalizePositiveInteger(req.body?.page, 1, 10000)
  const pageSize = normalizePositiveInteger(req.body?.pageSize, 100, 500)
  const tab = normalizeProxyGroupRulePenetrationTab(req.body?.tab)
  const search = typeof req.body?.search === 'string' ? req.body.search.trim() : ''
  const sortKey = normalizeProxyGroupRulePenetrationSortKey(req.body?.sortKey)
  const sortDirection = normalizeProxyGroupRulePenetrationSortDirection(req.body?.sortDirection)

  if (!groupName) {
    res.status(400).json({
      message: 'groupName is required',
    })
    return
  }

  if (!cacheKey && !Array.isArray(rules)) {
    res.status(400).json({
      message: 'rules must be an array when cacheKey is missing',
    })
    return
  }

  try {
    const cacheEntry = getProxyGroupRulePenetrationCacheEntry({
      groupName,
      cacheKey,
      rules: rules || [],
      customGroup,
      customGroupMode,
    })
    const scopedEntries = providerName
      ? cacheEntry.items.filter((entry) => {
          return providerName === 'controller' ? entry.source === 'controller' : entry.source === providerName
        })
      : cacheEntry.items
    const searchMatchedEntries = scopedEntries.filter((entry) =>
      matchesProxyGroupRulePenetrationSearch(entry, search),
    )
    const counts = {
      all: searchMatchedEntries.length,
      domain: 0,
      ip: 0,
      port: 0,
    }

    searchMatchedEntries.forEach((entry) => {
      if (entry.family === 'domain') {
        counts.domain += 1
      } else if (entry.family === 'ip') {
        counts.ip += 1
      } else if (entry.family === 'port') {
        counts.port += 1
      }
    })

    const tabMatchedEntries =
      tab === 'all' ? searchMatchedEntries : searchMatchedEntries.filter((entry) => entry.family === tab)
    const sortedEntries = sortProxyGroupRulePenetrationEntries(tabMatchedEntries, sortKey, sortDirection)
    const start = (page - 1) * pageSize
    const end = start + pageSize

    res.json({
      cacheKey: cacheEntry.cacheKey,
      groupName,
      customGroup,
      customGroupMode,
      providerName,
      totalRules: cacheEntry.totalRules,
      totalMatched: tabMatchedEntries.length,
      counts,
      items: sortedEntries.slice(start, end),
      missingProviders: cacheEntry.missingProviders,
      page,
      pageSize,
      hasMore: end < sortedEntries.length,
    })
  } catch (error) {
    if (error?.code === 'CACHE_EXPIRED') {
      res.status(410).json({
        message: 'cache expired',
      })
      return
    }

    res.status(500).json({
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.type('application/javascript')
  res.send(serviceWorkerCleanupScript)
})

app.get('/registerSW.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.type('application/javascript')
  res.send(registerSWCleanupScript)
})

if (fs.existsSync(distDir)) {
  app.use(
    express.static(distDir, {
      setHeaders: (res, filePath) => {
        const fileName = path.basename(filePath)

        if (
          fileName === 'index.html' ||
          fileName === 'sw.js' ||
          fileName === 'registerSW.js' ||
          fileName === 'manifest.webmanifest'
        ) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
          return
        }

        if (/^index-[A-Za-z0-9_-]+\.(js|css)$/.test(fileName)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )

  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

server.on('upgrade', (request, socket, head) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)

    if (!requestUrl.pathname.startsWith('/api/controller-ws')) {
      socket.destroy()
      return
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request)
    })
  } catch {
    socket.destroy()
  }
})

websocketServer.on('connection', relayControllerWebSocket)

server.listen(port, host, () => {
  console.log(`zashboard server listening on http://${host}:${port}`)
  console.log(`sqlite db: ${dbPath}`)
})
