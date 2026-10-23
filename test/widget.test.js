import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, buildDocument, parseAdditional, parseCredits, parseModels, parseSpend, toModelRow, toRow } from '../lib/index.js'

/** A `wham/usage` payload shaped like the live endpoint. */
const USAGE = {
  plan_type: 'plus',
  email: 'a2327106185@gmail.com',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 38, limit_window_seconds: 18000, reset_at: 1792784241 },
    secondary_window: { used_percent: 48, limit_window_seconds: 604800, reset_at: 1793295905 },
  },
}

test('toRow maps a reset epoch and names the window', () => {
  const row = toRow('primary_window', USAGE.rate_limit.primary_window)
  assert.equal(row.label, '5 小时窗口')
  assert.equal(row.usedPercent, 38)
  assert.equal(row.remaining, 62)
  assert.equal(row.resetsAt, '2026-10-23T19:37:21.000Z')
})

test('toRow names the weekly window and falls back to reset_after_seconds', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0, 0)
  const row = toRow('secondary_window', { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 3600 }, now)
  assert.equal(row.label, '周上限')
  assert.equal(row.remaining, 0)
  assert.equal(row.resetsAt, new Date(now + 3600_000).toISOString())
})

test('toRow refuses a window without a usable percentage', () => {
  assert.equal(toRow('primary_window', undefined), undefined)
  assert.equal(toRow('primary_window', { used_percent: 'lots' }), undefined)
})

test('buildDocument masks the account and keeps both windows', () => {
  const doc = buildDocument(USAGE)
  assert.equal(doc.ok, true)
  assert.equal(doc.plan, 'plus')
  assert.equal(doc.account, 'a23***@gmail.com')
  assert.equal(doc.limitReached, false)
  assert.deepEqual(doc.windows.map((row) => row.window), ['primary_window', 'secondary_window'])
})

test('buildDocument output never carries the raw address', () => {
  assert.equal(JSON.stringify(buildDocument(USAGE)).includes('a2327106185@gmail.com'), false)
})

/** Host stub: records routes, the injection table, and service lookups. */
function fakeHost(usage = USAGE) {
  const routes = new Map()
  const table = []
  const requests = []
  const hostCtx = {
    get: (id) => (id === 'credentials'
      ? {
          resolve: async () => ({ value: 'aaa.bbb.ccc' }),
          readRecord: async () => undefined,
        }
      : undefined),
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const root = {
    on: (event, fn) => {
      if (event === 'webserver/index-inject') fn(table)
      return () => {}
    },
    inject: (deps, cb) => cb(hostCtx),
    effect: () => () => {},
  }
  return { root, routes, table, requests }
}

test('apply registers both routes and one injection row', () => {
  const { root, routes, table } = fakeHost()
  apply(root)
  assert.deepEqual([...routes.keys()].sort(), ['/dsh-gpt/pet.png', '/dsh-gpt/quota', '/dsh-gpt/widget.js'])
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.match(table[0].text, /\/dsh-gpt\/widget\.js/)
})

test('the injection row is deduplicated when the table is replayed', () => {
  const { root, table } = fakeHost()
  apply(root)
  const replay = [{ kind: 'script', placement: 'body', text: 'x' }]
  replay.push(table[0])
  const seen = []
  const again = {
    on: (event, fn) => {
      if (event === 'webserver/index-inject') fn(replay)
      return () => {}
    },
    inject: () => {},
    effect: () => () => {},
  }
  apply(again)
  assert.equal(replay.filter((row) => String(row.text || '').includes('/dsh-gpt/widget.js')).length, 1)
  assert.equal(seen.length, 0)
})

/** Minimal request/response pair. */
function fakeExchange({ method = 'GET', address = '127.0.0.1', host = '127.0.0.1:62260', headers = {} } = {}) {
  const res = { statusCode: 0, headers: {}, body: '', raw: undefined }
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value }
  res.end = (chunk) => {
    if (chunk === undefined) {
      res.body = ''
      return
    }
    if (Buffer.isBuffer(chunk)) {
      res.raw = chunk
      return
    }
    res.body = String(chunk)
  }
  return { req: { method, url: '/', socket: { remoteAddress: address }, headers: { host, ...headers } }, res }
}

test('the quota route answers a loopback GET with the two windows', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => USAGE })
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange()
  await routes.get('/dsh-gpt/quota').handler(req, res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.ok, true)
  assert.equal(body.windows.length, 2)
})

test('the quota route rejects a non-loopback peer', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange({ address: '10.0.0.7' })
  await routes.get('/dsh-gpt/quota').handler(req, res)
  assert.equal(res.statusCode, 403)
})

test('the quota route rejects a rebinding Host header', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange({ host: '127.0.0.1.evil.com' })
  await routes.get('/dsh-gpt/quota').handler(req, res)
  assert.equal(res.statusCode, 403)
})

test('the quota route rejects an unsupported method', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange({ method: 'DELETE' })
  await routes.get('/dsh-gpt/quota').handler(req, res)
  assert.equal(res.statusCode, 405)
})

test('a missing credential surfaces as a documented error, not a throw', async () => {
  globalThis.fetch = async () => {
    throw new Error('should not be reached')
  }
  const routes = new Map()
  const hostCtx = {
    get: () => ({ resolve: async () => undefined, readRecord: async () => undefined }),
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }
  apply({ on: () => () => {}, inject: (deps, cb) => cb(hostCtx), effect: () => () => {} })
  const { req, res } = fakeExchange({ method: 'POST' })
  await routes.get('/dsh-gpt/quota').handler(req, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.match(body.error, /尚未登录 OpenAI Codex|无法读取 Codex/)
})

test('the widget script route serves JavaScript', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange({ method: 'GET' })
  await routes.get('/dsh-gpt/widget.js').handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /javascript/)
  assert.match(res.body, /__dshGptNiang/)
})

/** Payload carrying every block the enhanced bubble renders. */
const FULL_USAGE = {
  ...USAGE,
  model_usage: {
    'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false },
    'gpt-5-codex': { available: true, available_at: null, credits_would_enable: true },
    'gpt-6-nano': { available: true, available_at: null, credits_would_enable: false, used_percent: 75 },
    'gpt-7-preview': { available: false, available_at: '2026-11-01T09:00:00Z', credits_would_enable: true },
  },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: true, balance: '0' },
  spend_control: { reached: false, individual_limit: 20 },
  additional_rate_limits: [
    { name: 'code-review', used_percent: 90, limit_window_seconds: 18000, reset_at: 1792784241 },
    { used_percent: 4, limit_window_seconds: 604800, reset_at: 1793295905 },
  ],
}

test('parseModels orders usable models first, then unavailable ones', () => {
  const rows = parseModels(FULL_USAGE.model_usage)
  assert.deepEqual(rows.map((row) => row.name), ['gpt-5-codex', 'gpt-6-astra', 'gpt-6-nano', 'gpt-7-preview'])
  assert.equal(rows[0].creditsWouldEnable, true)
  assert.equal(rows[3].available, false)
  assert.equal(rows[3].availableAt, '2026-11-01T09:00:00Z')
})

test('a model only reports a percentage when the endpoint sends one', () => {
  const withSpend = toModelRow('gpt-6-nano', { available: true, used_percent: 75 })
  assert.equal(withSpend.remaining, 25)
  assert.equal(withSpend.usedPercent, 75)

  const availabilityOnly = toModelRow('gpt-6-astra', { available: true })
  assert.equal('remaining' in availabilityOnly, false)
  assert.equal(availabilityOnly.available, true)

  assert.equal(toModelRow('broken', null), undefined)
})

test('parseModels tolerates a missing or malformed map', () => {
  assert.deepEqual(parseModels(undefined), [])
  assert.deepEqual(parseModels(null), [])
  assert.deepEqual(parseModels(['nope']), [])
  assert.deepEqual(parseModels({ 'x': 'nope' }), [])
})

test('parseCredits and parseSpend keep only what they can trust', () => {
  assert.deepEqual(parseCredits({ has_credits: true, unlimited: false, overage_limit_reached: false, balance: '12' }), {
    hasCredits: true,
    unlimited: false,
    overageLimitReached: false,
    balance: '12',
  })
  assert.equal(parseCredits(undefined), undefined)
  assert.equal(parseCredits('nope'), undefined)

  assert.deepEqual(parseSpend({ reached: true, individual_limit: 50 }), { reached: true, limit: 50 })
  assert.deepEqual(parseSpend({ reached: false, individual_limit: null }), { reached: false, limit: null })
  assert.equal(parseSpend(undefined), undefined)
})

test('parseAdditional flattens both pool shapes and labels the unnamed one', () => {
  const rows = parseAdditional(FULL_USAGE.additional_rate_limits)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label, 'code-review')
  assert.equal(rows[0].window.remaining, 10)
  assert.equal(rows[1].label, '附加额度 2')
  assert.equal(rows[1].window.label, '周上限')
  assert.deepEqual(parseAdditional(null), [])
  assert.deepEqual(parseAdditional({}), [])
})

test('buildDocument carries models, credits, spend and extra pools', () => {
  const doc = buildDocument(FULL_USAGE)
  assert.equal(doc.models.length, 4)
  assert.equal(doc.credits.overageLimitReached, true)
  assert.deepEqual(doc.spend, { reached: false, limit: 20 })
  assert.equal(doc.additional.length, 2)
})

test('a payload without the optional blocks still builds a valid document', () => {
  const doc = buildDocument(USAGE)
  assert.deepEqual(doc.models, [])
  assert.deepEqual(doc.additional, [])
  assert.equal(doc.credits, undefined)
  assert.equal(doc.spend, undefined)
})

test('the shipped widget implements folding, model rows and the alert chime', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange()
  await routes.get('/dsh-gpt/widget.js').handler(req, res)
  assert.match(res.body, /dgn-sec-head/)
  assert.match(res.body, /function section/)
  assert.match(res.body, /模型用量/)
  assert.match(res.body, /function alertSound/)
  assert.match(res.body, /alertMuted/)
  assert.match(res.body, /trackAlert/)
})

test('the pet artwork route serves the PNG with a cacheable ETag', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange()
  await routes.get('/dsh-gpt/pet.png').handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.match(String(res.headers['cache-control']), /max-age/)
  assert.match(String(res.headers.etag), /^".+"$/)
  assert.ok(Buffer.isBuffer(res.raw), 'expected raw bytes')
  assert.equal(res.raw.subarray(1, 4).toString(), 'PNG')
})

test('the pet artwork route revalidates with If-None-Match', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const first = fakeExchange()
  await routes.get('/dsh-gpt/pet.png').handler(first.req, first.res)
  const again = fakeExchange({ headers: { 'if-none-match': first.res.headers.etag } })
  await routes.get('/dsh-gpt/pet.png').handler(again.req, again.res)
  assert.equal(again.res.statusCode, 304)
  assert.equal(again.res.raw, undefined)
})

test('the pet artwork route rejects verbs other than GET and HEAD', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange({ method: 'POST' })
  await routes.get('/dsh-gpt/pet.png').handler(req, res)
  assert.equal(res.statusCode, 405)
})

test('the shipped widget draws the dragon artwork with an SVG fallback', async () => {
  const { root, routes } = fakeHost()
  apply(root)
  const { req, res } = fakeExchange()
  await routes.get('/dsh-gpt/widget.js').handler(req, res)
  assert.match(res.body, /\/dsh-gpt\/pet\.png/)
  assert.match(res.body, /dgn-noimg/)
  assert.match(res.body, /function throwPet/)
  assert.match(res.body, /function walkTick/)
  assert.match(res.body, /dgn-sleeping/)
  assert.match(res.body, /function scheduleChatter/)
})
