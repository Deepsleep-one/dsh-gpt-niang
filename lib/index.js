/**
 * dsh-gpt-niang — host half.
 *
 * Turns the "GPT娘额度挂件" idea into a pure DSH plugin: no WPF window, no Codex
 * desktop app, no startup shortcut, no scheduled task. The page half is a plain
 * script that the web server hands to the browser and injects into the app shell;
 * it draws a floating character into `document.body` and asks this module for the
 * ChatGPT / Codex subscription quota.
 *
 * Two things here are load-bearing and worth not "cleaning up":
 *
 * 1. The index-injection row is registered *synchronously* in `apply()`, before
 *    any `ctx.inject(...)`. The DSH desktop shell collects the injection table
 *    exactly once at host startup; a row registered later never reaches the page
 *    and the widget silently never appears.
 * 2. The row is an *inline* `<script>` snippet that builds its own `<script src>`
 *    and swallows `onerror`. A `script-src` row rejects the whole `__DSH_BOOT_READY__`
 *    promise when the URL 404s, which would take the entire app down with it.
 *
 * @module dsh-gpt-niang
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin id; the bundle patch row mounts this. */
export const name = 'dsh-gpt-niang'

/** Seconds of cache on one quota answer. */
const CACHE_MS = 45_000

/** Upstream endpoint that reports ChatGPT / Codex subscription limits. */
const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'

/** Where the browser fetches the widget script. */
const SCRIPT_PATH = '/dsh-gpt/widget.js'

/** Where the browser fetches the quota document. */
const QUOTA_PATH = '/dsh-gpt/quota'

/** Where the browser fetches the pet artwork (optional; the widget has a SVG fallback). */
const PET_PATH = '/dsh-gpt/pet.png'

/** Directory holding this module; `assets/` sits next to `lib/`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Pet artwork on disk. */
const PET_FILE = join(PACKAGE_ROOT, 'assets', 'pet', 'gpt-dragon-niang.png')

/**
 * Inline injection row. It is a `script` row (append-only, cannot fail) whose
 * text creates the real `<script src>` itself, so a missing route degrades to
 * "no widget" instead of "app will not boot".
 */
const INJECT_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + SCRIPT_PATH + '";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** One cached quota answer. */
let cached

/** The in-flight probe, so concurrent requests share one upstream call. */
let inflight

/** The script body, read once. */
let scriptText

/** The pet artwork, read from disk once. */
let petAsset

/**
 * Decode the payload segment of a JWT without verifying it — we only need the
 * ChatGPT account id and the expiry that the token itself states.
 * @param {string} token - compact JWT.
 * @returns {object | undefined} claims, or undefined when unparsable.
 */
function decodeClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Resolve the Codex access token DSH already holds.
 *
 * The credential service is the only supported source: it owns refresh rotation,
 * so reading the on-disk token directly would race with it and could leak a
 * stale value. A local `~/.codex/auth.json` is kept as a last resort because a
 * user who runs the Codex CLI has one even without the DSH provider configured.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context owning `credentials`.
 * @returns {Promise<{ access: string, accountId?: string, expires?: number }>}
 */
async function resolveCredential(ctx) {
  const service = ctx.get('credentials')
  const managed = await service?.resolve?.('OPENAI_CODEX_API_KEY')
  if (typeof managed?.value === 'string' && managed.value !== '') {
    const claims = decodeClaims(managed.value)
    return {
      access: managed.value,
      accountId: claims?.['https://api.openai.com/auth']?.chatgpt_account_id,
      expires: typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined,
    }
  }

  const record = await service?.readRecord?.('llm-pi-ai/openai-codex')
  if (record?.kind === 'grant' && typeof record.payload?.access === 'string') {
    return {
      access: record.payload.access,
      accountId: record.payload.accountId,
      expires: typeof record.payload.expires === 'number' ? record.payload.expires : undefined,
    }
  }

  try {
    const home = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.codex')
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))
    if (typeof auth?.tokens?.access_token === 'string') {
      const claims = decodeClaims(auth.tokens.access_token)
      return {
        access: auth.tokens.access_token,
        accountId: auth.tokens.account_id ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id,
        expires: typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined,
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('无法读取 Codex 登录信息，请检查登录文件权限。')
  }

  throw new Error('尚未登录 OpenAI Codex：请在 DSH 模型设置里登录 OpenAI Codex。')
}

/**
 * Human label for a server-reported window length.
 * @param {number} seconds - `limit_window_seconds`.
 * @returns {string} short label.
 */
function windowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '额度窗口'
  if (seconds === 18_000) return '5 小时窗口'
  if (seconds === 604_800) return '周上限'
  if (seconds >= 86_400) return Math.round(seconds / 86_400) + ' 天窗口'
  return Math.max(1, Math.round(seconds / 3600)) + ' 小时窗口'
}

/**
 * Turn one `wham/usage` window into the flat row the bubble renders.
 * @param {string} id - row id (`primary_window` / `secondary_window`).
 * @param {object} window - upstream window object.
 * @param {number} now - ms epoch, injected for tests.
 * @returns {object | undefined} row, or undefined when the window is absent.
 */
export function toRow(id, window, now = Date.now()) {
  if (!window || typeof window !== 'object') return undefined
  const used = Number(window.used_percent)
  if (!Number.isFinite(used)) return undefined
  let resetsAt = null
  if (Number.isFinite(window.reset_at)) resetsAt = new Date(window.reset_at * 1000).toISOString()
  else if (Number.isFinite(window.reset_after_seconds)) resetsAt = new Date(now + window.reset_after_seconds * 1000).toISOString()
  return {
    window: id,
    label: windowLabel(Number(window.limit_window_seconds)),
    usedPercent: Math.max(0, Math.min(100, Math.round(used))),
    remaining: Math.max(0, Math.min(100, Math.round(100 - used))),
    resetsAt,
  }
}

/**
 * Mask an account address so a shared screen does not leak it.
 * @param {unknown} email - raw address.
 * @returns {string | undefined} masked address.
 */
function maskAccount(email) {
  if (typeof email !== 'string') return undefined
  const at = email.indexOf('@')
  if (at <= 0) return undefined
  const head = email.slice(0, at)
  const tail = email.slice(at)
  const keep = head.slice(0, Math.min(3, head.length))
  return keep + '***' + tail
}

/** Clamp an upstream percentage into 0..100, or undefined when it is not a number. */
function clampPercent(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.max(0, Math.min(100, Math.round(number)))
}

/**
 * One `model_usage` entry.
 *
 * The endpoint reports per-model *availability* rather than per-model spend, so
 * `usedPercent` is only set when the server actually sends `used_percent`; the
 * bubble shows a status chip otherwise instead of inventing a percentage.
 *
 * @param {string} name - model id.
 * @param {any} usage - upstream entry.
 * @returns {object | undefined} row, or undefined when the entry is malformed.
 */
export function toModelRow(name, usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const used = clampPercent(usage.used_percent)
  const row = {
    name: String(name),
    available: typeof usage.available === 'boolean' ? usage.available : undefined,
    availableAt: typeof usage.available_at === 'string' ? usage.available_at : null,
    creditsWouldEnable: usage.credits_would_enable === true,
  }
  if (used !== undefined) {
    row.usedPercent = used
    row.remaining = 100 - used
  }
  return row
}

/**
 * `model_usage` map → rows, usable models first, then the ones that would need
 * credits, then the ones that are simply unavailable.
 * @param {any} modelUsage - upstream map.
 * @returns {object[]} rows.
 */
export function parseModels(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return []
  const rank = (row) => (row.available === false ? 2 : row.availableAt ? 1 : 0)
  return Object.keys(modelUsage)
    .map((name) => toModelRow(name, modelUsage[name]))
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * Credits block. Kept verbatim-ish: the bubble only needs to know whether there
 * is anything to spend and whether the overage cap is already hit.
 * @param {any} credits - upstream block.
 * @returns {object | undefined} parsed block, or undefined when absent.
 */
export function parseCredits(credits) {
  if (!credits || typeof credits !== 'object') return undefined
  return {
    hasCredits: credits.has_credits === true,
    unlimited: credits.unlimited === true,
    overageLimitReached: credits.overage_limit_reached === true,
    balance: typeof credits.balance === 'string' ? credits.balance : undefined,
  }
}

/**
 * Spend-control block.
 * @param {any} spend - upstream block.
 * @returns {object | undefined} parsed block, or undefined when absent.
 */
export function parseSpend(spend) {
  if (!spend || typeof spend !== 'object') return undefined
  const raw = spend.individual_limit
  // `Number(null)` is 0, which would silently turn "no limit" into "limit 0".
  const limit = raw === null || raw === undefined ? null : Number.isFinite(Number(raw)) ? Number(raw) : null
  return {
    reached: spend.reached === true,
    limit,
  }
}

/**
 * Extra rate limits (team / enterprise accounts report several pools here).
 * @param {any} list - upstream block.
 * @returns {object[]} one entry per additional pool.
 */
export function parseAdditional(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return undefined
      const label = typeof entry.name === 'string'
        ? entry.name
        : typeof entry.label === 'string'
          ? entry.label
          : '附加额度 ' + (index + 1)
      const row = toRow('primary_window', entry) ?? toRow('primary_window', entry.primary_window ?? entry.rate_limit?.primary_window)
      return row === undefined ? undefined : { label, window: row }
    })
    .filter(Boolean)
}

/**
 * Build the browser document from an upstream usage payload.
 * @param {any} body - parsed `wham/usage` JSON.
 * @param {number} now - ms epoch, injected for tests.
 * @returns {object} quota document.
 */
export function buildDocument(body, now = Date.now()) {
  const limit = body?.rate_limit || {}
  const rows = [toRow('primary_window', limit.primary_window, now), toRow('secondary_window', limit.secondary_window, now)]
    .filter(Boolean)
  return {
    ok: true,
    fetchedAt: now,
    plan: typeof body?.plan_type === 'string' ? body.plan_type : undefined,
    account: maskAccount(body?.email),
    limitReached: limit.limit_reached === true,
    windows: rows,
    models: parseModels(body?.model_usage),
    credits: parseCredits(body?.credits),
    spend: parseSpend(body?.spend_control),
    additional: parseAdditional(body?.additional_rate_limits),
  }
}

/** One probe, shared by concurrent callers. */
async function probe(ctx, force) {
  if (!force && cached !== undefined && Date.now() - cached.fetchedAt < CACHE_MS) return cached
  if (inflight !== undefined) return inflight
  inflight = (async () => {
    try {
      const credential = await resolveCredential(ctx)
      if (typeof credential.expires === 'number' && credential.expires <= Date.now()) {
        throw new Error('OpenAI Codex 登录已过期，请用一次该模型或在模型设置里重新登录。')
      }
      const headers = { Authorization: 'Bearer ' + credential.access, Accept: 'application/json' }
      if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId
      const response = await fetch(ENDPOINT, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) })
      if (response.status === 401) throw new Error('OpenAI 拒绝了当前登录（401），请重新登录 OpenAI Codex。')
      if (response.status === 403) throw new Error('OpenAI 拒绝了当前登录（403），该账号可能没有 Codex 订阅。')
      if (!response.ok) throw new Error('OpenAI 返回 HTTP ' + response.status + '，稍后重试。')
      const document_ = buildDocument(await response.json())
      cached = document_
      return document_
    } catch (error) {
      return {
        ok: false,
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        windows: [],
      }
    } finally {
      inflight = undefined
    }
  })()
  return inflight
}

/** Whether this request came from the loopback interface. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether the Host header names this machine (guards against DNS rebinding). */
function hostTrusted(req) {
  try {
    const url = new URL('http://' + String(req.headers?.host || ''))
    const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
    const parts = host.split('.').map(Number)
    return parts.length === 4 && parts[0] === 127 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  } catch {
    return false
  }
}

/** Write one JSON answer. */
function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Load the browser script once. */
async function loadScript() {
  if (scriptText === undefined) scriptText = await readFile(join(PACKAGE_ROOT, 'assets', 'gpt-niang.js'), 'utf8')
  return scriptText
}

/**
 * Load the pet artwork once.
 *
 * The ETag is derived from size and mtime, so dropping a new PNG into
 * `assets/pet/` while the host runs is picked up after a normal refresh instead
 * of being pinned forever by the immutable cache header.
 */
async function loadPet() {
  if (petAsset !== undefined) return petAsset
  const info = await stat(PET_FILE)
  petAsset = {
    body: await readFile(PET_FILE),
    etag: '"' + info.size.toString(16) + '-' + Math.floor(info.mtimeMs).toString(16) + '"',
  }
  return petAsset
}

/**
 * Host body.
 * @param {import('@deepseek-ai/cordis').Context} root - host root context.
 */
export function apply(root) {
  const disposers = []
  root.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already gone.
      }
    }
    disposers.length = 0
  })

  // Registered before anything is awaited: the desktop shell reads the injection
  // table once, so a late row is a row that never renders.
  disposers.push(root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(SCRIPT_PATH) >= 0) return
        if (row.kind === 'script-src' && row.src === SCRIPT_PATH) return
      }
      table.push({ kind: 'script', placement: 'body', text: INJECT_ROW_TEXT })
    } catch {
      // A malformed table is the host's problem, not a reason to fail the plugin.
    }
  }))

  root.inject(['webServer', 'credentials'], (ctx) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: SCRIPT_PATH,
      handler: async (req, res) => {
        if (!hostTrusted(req)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        try {
          res.statusCode = 200
          res.setHeader('content-type', 'application/javascript; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(await loadScript())
        } catch {
          res.statusCode = 404
          res.end('widget script unavailable')
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: PET_PATH,
      handler: async (req, res) => {
        if (!hostTrusted(req)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.end('method not allowed')
          return
        }
        try {
          const asset = await loadPet()
          res.setHeader('content-type', 'image/png')
          res.setHeader('cache-control', 'public, max-age=86400')
          res.setHeader('etag', asset.etag)
          if (String(req.headers['if-none-match'] || '') === asset.etag) {
            res.statusCode = 304
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('content-length', String(asset.body.length))
          if (req.method === 'HEAD') {
            res.end()
            return
          }
          res.end(asset.body)
        } catch {
          res.statusCode = 404
          res.end('pet artwork unavailable')
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: QUOTA_PATH,
      handler: async (req, res) => {
        if (!hostTrusted(req) || !isLoopback(req)) return writeJson(res, 403, { ok: false, error: 'forbidden', windows: [] })
        if (req.method !== 'GET' && req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed', windows: [] })
        const force = req.method === 'POST' || String(req.url || '').includes('refresh=1')
        writeJson(res, 200, await probe(ctx, force))
      },
    }))

    // Web form: the shell's index.html goes through `tapIndex`. The desktop shell
    // reads a static file instead, which is what the injection row above covers.
    // Guarded because the hook is optional: a host without it still gets the widget
    // through the injection row, and a missing hook must not fail plugin load.
    if (typeof ctx.webServer.tapIndex === 'function') {
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (String(html).indexOf(SCRIPT_PATH) !== -1) return html
        const tag = '<script defer src="' + SCRIPT_PATH + '"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }))
    }
  })
}
