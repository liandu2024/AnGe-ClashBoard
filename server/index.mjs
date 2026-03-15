import express from 'express'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
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

const getRuleProviderKind = (url, format) => {
  const normalizedUrl = url.toLowerCase()
  const normalizedFormat = format.toLowerCase()

  if (normalizedUrl.endsWith('.mrs') || normalizedFormat === 'mrs') {
    if (normalizedUrl.includes('/geoip/')) {
      return 'mrs-ip'
    }

    return 'mrs-domain'
  }

  return 'text'
}

const normalizeDomain = (domain) => domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
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

const closeSocketPair = (left, right, code = 1011, reason = '') => {
  if (left.readyState === WebSocket.OPEN || left.readyState === WebSocket.CONNECTING) {
    left.close(code, reason)
  }

  if (right.readyState === WebSocket.OPEN || right.readyState === WebSocket.CONNECTING) {
    right.close(code, reason)
  }
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
      if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
        upstreamSocket.close(code || 1000, reason?.toString())
      }
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
      if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
        clientSocket.close(code || 1000, reason?.toString())
      }
    })

    upstreamSocket.on('error', () => {
      closeBoth(1011, 'Upstream websocket error')
    })
  } catch (error) {
    clientSocket.close(1011, error instanceof Error ? error.message : String(error))

    if (upstreamSocket) {
      upstreamSocket.close(1011)
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

const findMatchesInTextRules = (domain, body) => {
  const matches = []
  const lines = body.split(/\r?\n/)

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()

    if (!line || line.startsWith('#') || line.startsWith('//')) {
      return
    }

    if (/^(payload|domain|suffix|keyword):/i.test(line)) {
      const [, key, value] = line.match(/^([^:]+):\s*(.+)$/) || []

      if (!key || !value) {
        return
      }

      const normalizedKey = key.toLowerCase()
      const mode =
        normalizedKey.includes('suffix')
          ? 'suffix'
          : normalizedKey.includes('keyword')
            ? 'keyword'
            : 'domain'

      if (isDomainMatch(domain, value, mode)) {
        matches.push({ line: index + 1, value, mode, raw: line })
      }

      return
    }

    if (line.startsWith('+.')) {
      const value = line.slice(2)

      if (isDomainMatch(domain, value, 'suffix')) {
        matches.push({ line: index + 1, value, mode: 'suffix', raw: line })
      }

      return
    }

    const parts = line.split(',').map((part) => part.trim())
    const ruleType = parts[0]?.toUpperCase()
    const value = parts[1] || parts[0]

    const mode =
      ruleType === 'DOMAIN-SUFFIX'
        ? 'suffix'
        : ruleType === 'DOMAIN-KEYWORD'
          ? 'keyword'
          : 'domain'

    if (
      ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(ruleType) ||
      (!ruleType.includes('IP') && !ruleType.includes('PROCESS') && !line.includes(','))
    ) {
      if (isDomainMatch(domain, value, mode)) {
        matches.push({ line: index + 1, value, mode, raw: line })
      }
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

  fs.writeFileSync(sourcePath, buffer)

  try {
    await execFileAsync(
      mihomoBinaryPath,
      ['convert-ruleset', 'domain', 'mrs', sourcePath, targetPath],
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

  return provider.kind === 'mrs-domain'
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
      kind: getRuleProviderKind(provider.url, provider.format),
    }))
    const cachedProviderMap = new Map(
      getCachedRuleProviderStatement.all().map((provider) => [provider.name, provider]),
    )
    const errors = []
    let updatedCount = 0
    let progressRules = 0
    const fetchedItems = []
    const unsupportedCount = providers.filter((provider) => provider.kind === 'mrs-ip').length

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

      if (provider.kind === 'mrs-ip') {
        continue
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
  if (
    activeRuleProviderUpdateController &&
    !activeRuleProviderUpdateController.signal.aborted
  ) {
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

const searchRuleProviderCache = async (domain) => {
  const cachedProviders = getCachedRuleProviderStatement.all()
  const configuredProviders = extractRuleProviderEntries(ruleSourceConfigPath).map((provider) => ({
    ...provider,
    kind: getRuleProviderKind(provider.url, provider.format),
  }))
  const matches = []
  const unsupported = configuredProviders
    .filter((provider) => provider.kind === 'mrs-ip')
    .map((provider) => ({
      name: provider.name,
      kind: provider.kind,
      behavior: provider.behavior,
      format: provider.format,
      url: provider.url,
      status: 'unsupported',
    }))

  for (const provider of cachedProviders) {
    const providerMatches = findMatchesInTextRules(domain, provider.body)

    if (providerMatches.length > 0) {
      matches.push({
        name: provider.name,
        behavior: provider.behavior,
        format: provider.format,
        url: provider.source_url,
        status: 'cached',
        matches: providerMatches.slice(0, 20),
      })
    }
  }

  return {
    domain,
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
  const domain = typeof req.query.domain === 'string' ? req.query.domain : ''

  if (!domain.trim()) {
    res.status(400).json({
      message: 'domain is required',
    })
    return
  }

  try {
    res.json(await searchRuleProviderCache(domain))
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))

  app.get(/^(?!\/api\/).*/, (_req, res) => {
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
