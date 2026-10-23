/**
 * dsh-gpt-niang — page half.
 *
 * A plain script (no build step, no React) that the host serves at
 * `/dsh-gpt/widget.js` and injects into the app shell. It draws a small GPT
 * character in the bottom-right corner; clicking it opens a bubble with the
 * ChatGPT / Codex subscription windows, the per-model availability the endpoint
 * reports, and the credits block when the account has one.
 *
 * Everything it needs is read from `/dsh-gpt/quota`, so the same file works in
 * the web shell and the desktop shell.
 *
 * Why raw DOM instead of a slot component: this is an *overlay*, and the settings
 * slot tree has no surface that floats above the conversation without moving
 * layout. Appending one fixed node to `document.body` is what a widget wants.
 */
(function () {
  'use strict'
  if (window.__dshGptNiang) return
  window.__dshGptNiang = true

  var SCRIPT_PATH = '/dsh-gpt/widget.js'
  var QUOTA_PATH = '/dsh-gpt/quota'
  var PET_PATH = '/dsh-gpt/pet.png'
  var PREFS_KEY = 'dsh-gpt-niang/prefs'
  var POLL_MS = 60000

  var prefs = {
    right: 24, bottom: 24, scale: 1,
    muted: false, alertMuted: false, alertLevel: 0,
    walk: false, talk: true, fold: {},
  }
  try {
    var stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')
    Object.keys(prefs).forEach(function (key) {
      if (typeof stored[key] === typeof prefs[key]) prefs[key] = stored[key]
    })
  } catch (err) {}
  prefs.fold = prefs.fold && typeof prefs.fold === 'object' ? prefs.fold : {}
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch (err) {}
  }
  function folded(section, byDefault) {
    var value = prefs.fold[section]
    return typeof value === 'boolean' ? value : byDefault
  }
  function setFolded(section, value) {
    prefs.fold[section] = value
    savePrefs()
  }

  // —— audio: synthesised, so the plugin ships no binary assets ——
  var audioCtx
  function blip(frequency, duration, volume) {
    if (prefs.muted) return
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') audioCtx.resume()
      var osc = audioCtx.createOscillator()
      var gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(volume, audioCtx.currentTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start()
      osc.stop(audioCtx.currentTime + duration + 0.02)
    } catch (err) {}
  }

  /**
   * Alert chime. Deliberately separate from the click blips: the click sounds are
   * "feedback", this one is "you are running out", so it gets its own mute flag
   * and a two/three-note phrase instead of a single beep.
   * @param {number} level - 1 = warning, 2 = critical.
   */
  function alertSound(level) {
    if (prefs.alertMuted) return
    if (level >= 2) {
      blip(1046, 0.1, 0.07)
      setTimeout(function () { blip(784, 0.11, 0.07) }, 115)
      setTimeout(function () { blip(523, 0.18, 0.075) }, 235)
      return
    }
    blip(784, 0.1, 0.06)
    setTimeout(function () { blip(587, 0.15, 0.06) }, 125)
  }

  // —— helpers ——
  function pad(value) {
    return (value < 10 ? '0' : '') + value
  }
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }
  function fmtReset(iso) {
    if (!iso) return '重置时间未知'
    var when = new Date(iso)
    if (isNaN(when.getTime())) return '重置时间未知'
    var clock = pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes())
    var diff = when.getTime() - Date.now()
    if (diff <= 0) return clock + '（已重置）'
    var minutes = Math.round(diff / 60000)
    if (minutes < 60) return clock + '（' + Math.max(1, minutes) + ' 分钟后）'
    var hours = diff / 3600000
    if (hours < 48) return clock + '（' + hours.toFixed(1) + ' 小时后）'
    return clock + '（' + Math.round(hours / 24) + ' 天后）'
  }
  function fmtWhen(iso) {
    var when = new Date(iso)
    if (isNaN(when.getTime())) return '时间未知'
    return pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes())
  }
  function tone(remaining) {
    if (remaining <= 10) return '#f85149'
    if (remaining <= 30) return '#d59f0a'
    return '#2ea043'
  }

  var CSS = ''
    // —— pet artwork (image with an inline-SVG fallback) ——
    + '#dsh-gpt-niang .dgn-img{display:block;width:100%;height:100%;object-fit:contain;'
    + 'animation:dgn-bob 3.6s ease-in-out infinite;transform-origin:50% 92%;-webkit-user-drag:none;user-select:none}'
    + '#dsh-gpt-niang .dgn-fallback{display:none;width:100%;height:100%}'
    + '#dsh-gpt-niang .dgn-pet.dgn-noimg .dgn-img{display:none}'
    + '#dsh-gpt-niang .dgn-pet.dgn-noimg .dgn-fallback{display:block}'
    + '#dsh-gpt-niang .dgn-pet.dgn-hopping .dgn-img{animation:dgn-hop .52s ease}'
    + '@keyframes dgn-hop{0%{transform:translateY(0) scale(1,1)}32%{transform:translateY(-13px) scale(.965,1.045)}'
    + '68%{transform:translateY(2px) scale(1.035,.965)}100%{transform:translateY(0) scale(1,1)}}'
    + '#dsh-gpt-niang .dgn-pet.dgn-sleeping .dgn-img{animation:dgn-sleep 5.2s ease-in-out infinite;opacity:.86}'
    + '@keyframes dgn-sleep{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(1.5px) scale(1.012,.986)}}'
    + '#dsh-gpt-niang .dgn-pet.dgn-worried .dgn-img{animation:dgn-worry 1s ease-in-out infinite}'
    + '@keyframes dgn-worry{0%,100%{transform:rotate(-2.4deg)}50%{transform:rotate(2.4deg)}}'
    + '#dsh-gpt-niang .dgn-pet.dgn-walking .dgn-img{animation:dgn-waddle .62s ease-in-out infinite}'
    + '@keyframes dgn-waddle{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-4px) rotate(3deg)}}'
    + '#dsh-gpt-niang .dgn-zzz{position:absolute;right:-2px;top:-4px;font-size:11px;font-weight:700;opacity:0;'
    + 'color:#cfd8ee;text-shadow:0 1px 4px rgba(0,0,0,.6);pointer-events:none;transition:opacity .4s}'
    + '#dsh-gpt-niang .dgn-pet.dgn-sleeping .dgn-zzz{opacity:.9;animation:dgn-zzz 3.2s ease-in-out infinite}'
    + '@keyframes dgn-zzz{0%{opacity:.1;transform:translate(0,2px) scale(.9)}50%{opacity:.95;transform:translate(-2px,-4px) scale(1)}'
    + '100%{opacity:.1;transform:translate(-5px,-9px) scale(1.05)}}'
    + '#dsh-gpt-niang .dgn-say{position:absolute;right:6px;bottom:100%;margin-bottom:7px;max-width:212px;'
    + 'padding:6px 10px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#1b2030f2);'
    + 'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));color:var(--dsw-alias-label-primary,#e8ecf4);'
    + 'font-size:11.5px;line-height:1.5;box-shadow:0 6px 18px rgba(0,0,0,.28);opacity:0;transform:translateY(4px);'
    + 'transition:opacity .22s ease,transform .22s ease;pointer-events:none;white-space:normal;word-break:break-word}'
    + '#dsh-gpt-niang .dgn-say.dgn-on{opacity:1;transform:none}'
    + '#dsh-gpt-niang .dgn-say:after{content:"";position:absolute;right:15px;top:100%;width:8px;height:8px;'
    + 'margin-top:-4px;transform:rotate(45deg);background:inherit}'
    + '#dsh-gpt-niang{position:fixed;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;'
    + 'gap:8px;pointer-events:none;font-family:inherit;transition:right .18s ease,bottom .18s ease}'
    + '#dsh-gpt-niang *{box-sizing:border-box}'
    + '#dsh-gpt-niang .dgn-pet{pointer-events:auto;width:84px;height:96px;cursor:grab;position:relative;'
    + 'filter:drop-shadow(0 6px 14px rgba(0,0,0,.28));transition:transform .16s ease;user-select:none;'
    + '-webkit-user-select:none;touch-action:none}'
    + '#dsh-gpt-niang .dgn-pet:hover{transform:translateY(-3px) scale(1.04)}'
    + '#dsh-gpt-niang .dgn-pet.dgn-dragging{cursor:grabbing;transform:scale(.97);transition:none}'
    + '#dsh-gpt-niang .dgn-pet svg{display:block;width:100%;height:100%;animation:dgn-bob 3.4s ease-in-out infinite}'
    + '@keyframes dgn-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}'
    + '#dsh-gpt-niang .dgn-dot{position:absolute;right:2px;top:6px;width:11px;height:11px;border-radius:50%;'
    + 'background:#8b93a7;border:2px solid rgba(255,255,255,.85);transition:background .3s}'
    + '#dsh-gpt-niang .dgn-dot.dgn-ok{background:#2ea043}'
    + '#dsh-gpt-niang .dgn-dot.dgn-warn{background:#d59f0a}'
    + '#dsh-gpt-niang .dgn-dot.dgn-bad{background:#f85149;animation:dgn-pulse 1.6s ease-in-out infinite}'
    + '@keyframes dgn-pulse{0%,100%{box-shadow:0 0 0 0 rgba(248,81,73,.5)}55%{box-shadow:0 0 0 7px rgba(248,81,73,0)}}'
    + '#dsh-gpt-niang .dgn-bubble{pointer-events:auto;display:none;min-width:246px;max-width:310px;'
    + 'max-height:min(72vh,440px);overflow-y:auto;overflow-x:hidden;'
    + 'padding:12px 14px;border-radius:14px;background:var(--dsw-alias-bg-layer-2,#1b2030f2);'
    + 'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));'
    + 'box-shadow:0 10px 30px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#e8ecf4);font-size:12px;'
    + 'backdrop-filter:blur(10px);animation:dgn-pop .16s ease}'
    + '#dsh-gpt-niang .dgn-bubble::-webkit-scrollbar{width:6px}'
    + '#dsh-gpt-niang .dgn-bubble::-webkit-scrollbar-thumb{background:rgba(127,127,127,.35);border-radius:999px}'
    + '#dsh-gpt-niang .dgn-bubble.dgn-open{display:block}'
    + '@keyframes dgn-pop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}'
    + '#dsh-gpt-niang .dgn-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;'
    + 'margin-bottom:9px;padding-bottom:8px;border-bottom:1px solid rgba(127,127,127,.22)}'
    + '#dsh-gpt-niang .dgn-title{font-size:13px;font-weight:700}'
    + '#dsh-gpt-niang .dgn-sub{font-size:10px;opacity:.62}'
    + '#dsh-gpt-niang .dgn-row{margin-bottom:9px}'
    + '#dsh-gpt-niang .dgn-row:last-child{margin-bottom:0}'
    + '#dsh-gpt-niang .dgn-row-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}'
    + '#dsh-gpt-niang .dgn-name{opacity:.8}'
    + '#dsh-gpt-niang .dgn-val{font-weight:700;font-variant-numeric:tabular-nums;font-size:14px}'
    + '#dsh-gpt-niang .dgn-track{height:5px;border-radius:999px;background:rgba(127,127,127,.26);overflow:hidden}'
    + '#dsh-gpt-niang .dgn-fill{height:100%;border-radius:999px;transition:width .4s ease}'
    + '#dsh-gpt-niang .dgn-meta{font-size:10px;opacity:.6;margin-top:4px}'
    + '#dsh-gpt-niang .dgn-msg{line-height:1.6;opacity:.85;word-break:break-word}'
    + '#dsh-gpt-niang .dgn-err{color:#f85149}'
    + '#dsh-gpt-niang .dgn-sec{margin-top:7px;border-top:1px solid rgba(127,127,127,.16);padding-top:5px}'
    + '#dsh-gpt-niang .dgn-sec-head{display:flex;align-items:center;gap:7px;cursor:pointer;'
    + 'padding:3px 4px;margin:0 -4px;border-radius:6px;user-select:none}'
    + '#dsh-gpt-niang .dgn-sec-head:hover{background:rgba(127,127,127,.16)}'
    + '#dsh-gpt-niang .dgn-sec-title{font-size:11px;font-weight:700;flex:1;letter-spacing:.02em;opacity:.92}'
    + '#dsh-gpt-niang .dgn-badge{font-size:10px;opacity:.55;font-variant-numeric:tabular-nums}'
    + '#dsh-gpt-niang .dgn-caret{font-size:9px;opacity:.6;transition:transform .15s ease;line-height:1}'
    + '#dsh-gpt-niang .dgn-sec.dgn-folded .dgn-caret{transform:rotate(-90deg)}'
    + '#dsh-gpt-niang .dgn-sec.dgn-folded .dgn-sec-body{display:none}'
    + '#dsh-gpt-niang .dgn-sec-body{padding-top:4px}'
    + '#dsh-gpt-niang .dgn-model{display:flex;align-items:center;justify-content:space-between;gap:8px;'
    + 'padding:2px 0;font-size:11px}'
    + '#dsh-gpt-niang .dgn-model-name{opacity:.82;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}'
    + '#dsh-gpt-niang .dgn-chip{font-size:10px;padding:1px 7px;border-radius:999px;white-space:nowrap;'
    + 'background:rgba(127,127,127,.2);opacity:.85}'
    + '#dsh-gpt-niang .dgn-chip.dgn-ok{color:#3fb950;background:rgba(46,160,67,.18)}'
    + '#dsh-gpt-niang .dgn-chip.dgn-warn{color:#d59f0a;background:rgba(213,159,10,.18)}'
    + '#dsh-gpt-niang .dgn-chip.dgn-bad{color:#f85149;background:rgba(248,81,73,.18)}'
    + '#dsh-gpt-niang .dgn-kv{display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:2px 0;opacity:.9}'
    + '#dsh-gpt-niang .dgn-kv span:first-child{opacity:.68}'
    + '#dsh-gpt-niang .dgn-menu{pointer-events:auto;display:none;position:absolute;right:0;bottom:0;'
    + 'min-width:142px;padding:5px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#1b2030f5);'
    + 'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));box-shadow:0 10px 26px rgba(0,0,0,.35);'
    + 'color:var(--dsw-alias-label-primary,#e8ecf4);font-size:12px}'
    + '#dsh-gpt-niang .dgn-menu.dgn-open{display:block}'
    + '#dsh-gpt-niang .dgn-item{padding:6px 9px;border-radius:7px;cursor:pointer;white-space:nowrap}'
    + '#dsh-gpt-niang .dgn-item:hover{background:rgba(127,127,127,.22)}'

  var SVG = ''
    + '<svg viewBox="0 0 120 140" aria-hidden="true">'
    + '<defs><linearGradient id="dgn-hair" x1="0" y1="0" x2="0.3" y2="1">'
    + '<stop offset="0" stop-color="#6f9dff"/><stop offset="1" stop-color="#a8c4ff"/></linearGradient>'
    + '<linearGradient id="dgn-cape" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#2b3b6b"/><stop offset="1" stop-color="#1b2547"/></linearGradient></defs>'
    + '<ellipse cx="60" cy="128" rx="30" ry="7" fill="rgba(0,0,0,.18)"/>'
    + '<path d="M28 122c0-16 14-24 32-24s32 8 32 24z" fill="url(#dgn-cape)"/>'
    + '<circle cx="60" cy="66" r="41" fill="#fff7f3"/>'
    + '<path d="M19 64a41 41 0 0 1 82 0c-6-4-12-13-16-19-5 7-14 12-21 12-9 0-17-4-22-11-4 8-11 15-23 18z" fill="url(#dgn-hair)"/>'
    + '<circle cx="45" cy="74" r="6.6" fill="#232838"/><circle cx="75" cy="74" r="6.6" fill="#232838"/>'
    + '<circle cx="47.2" cy="71.4" r="2.3" fill="#fff"/><circle cx="77.2" cy="71.4" r="2.3" fill="#fff"/>'
    + '<path d="M53 89q7 5.5 14 0" stroke="#232838" stroke-width="2.6" fill="none" stroke-linecap="round"/>'
    + '<ellipse cx="36" cy="85" rx="5.2" ry="3.6" fill="#ffc9d4" opacity=".85"/>'
    + '<ellipse cx="84" cy="85" rx="5.2" ry="3.6" fill="#ffc9d4" opacity=".85"/>'
    + '<circle cx="60" cy="27" r="3.4" fill="#ffd66b"/>'
    + '</svg>'

  var MENU = [
    { id: 'refresh', label: '刷新额度' },
    { id: 'walk', label: '散步：关' },
    { id: 'talk', label: '闲聊：开' },
    { id: 'bigger', label: '放大一点' },
    { id: 'smaller', label: '缩小一点' },
    { id: 'mute', label: '音效：开' },
    { id: 'alert', label: '告警音：开' },
    { id: 'reset', label: '复位位置' },
  ]

  var PET_HTML = ''
    + '<img class="dgn-img" src="' + PET_PATH + '" alt="" draggable="false">'
    + '<div class="dgn-fallback">' + SVG + '</div>'

  var host = document.createElement('div')
  host.id = 'dsh-gpt-niang'
  host.innerHTML = ''
    + '<div class="dgn-bubble"></div>'
    + '<div class="dgn-pet">' + PET_HTML + '<span class="dgn-zzz">z z</span><div class="dgn-say"></div>'
    + '<div class="dgn-dot"></div>'
    + '<div class="dgn-menu">' + MENU.map(function (item) {
      return '<div class="dgn-item" data-act="' + item.id + '">' + item.label + '</div>'
    }).join('') + '</div></div>'

  var styleEl = document.createElement('style')
  styleEl.textContent = CSS

  var bubble = host.querySelector('.dgn-bubble')
  var pet = host.querySelector('.dgn-pet')
  var dot = host.querySelector('.dgn-dot')
  var menu = host.querySelector('.dgn-menu')
  var say = host.querySelector('.dgn-say')
  var petImg = host.querySelector('.dgn-img')

  // The artwork is optional: a missing or unreadable PNG must degrade to the
  // inline SVG, never to an empty corner.
  petImg.addEventListener('error', function () { pet.classList.add('dgn-noimg') })

  var document_ = null
  var open = false
  var timer = null

  function applyPrefs() {
    host.style.right = prefs.right + 'px'
    host.style.bottom = prefs.bottom + 'px'
    var size = Math.round(104 * prefs.scale)
    pet.style.width = size + 'px'
    pet.style.height = size + 'px'
    menu.querySelector('[data-act="mute"]').textContent = '音效：' + (prefs.muted ? '关' : '开')
    menu.querySelector('[data-act="alert"]').textContent = '告警音：' + (prefs.alertMuted ? '关' : '开')
    menu.querySelector('[data-act="walk"]').textContent = '散步：' + (prefs.walk ? '开' : '关')
    menu.querySelector('[data-act="talk"]').textContent = '闲聊：' + (prefs.talk ? '开' : '关')
  }

  function setDot(remaining) {
    dot.className = 'dgn-dot'
    if (remaining === undefined) return
    lastLowest = remaining
    dot.classList.add(remaining <= 10 ? 'dgn-bad' : remaining <= 30 ? 'dgn-warn' : 'dgn-ok')
    // ≤10% left: the pet visibly fusses instead of standing there smiling.
    pet.classList.toggle('dgn-worried', remaining <= 10)
  }

  /** Lowest remaining percentage across the main windows, or undefined. */
  function lowestOf(rows) {
    var values = (rows || []).map(function (row) { return row.remaining }).filter(function (value) {
      return typeof value === 'number'
    })
    return values.length === 0 ? undefined : Math.min.apply(null, values)
  }

  /**
   * Chime once per *worsening* crossing. Improving is recorded silently, so a
   * window that recovers after a reset can alert again next time it drains.
   * @param {number | undefined} lowest - lowest remaining percentage.
   */
  function trackAlert(lowest) {
    var level = lowest === undefined ? 0 : lowest <= 10 ? 2 : lowest <= 30 ? 1 : 0
    var previous = typeof prefs.alertLevel === 'number' ? prefs.alertLevel : 0
    prefs.alertLevel = level
    savePrefs()
    if (level > previous) alertSound(level)
  }

  function section(id, title, badge, bodyHtml, byDefaultFolded) {
    var isFolded = folded(id, byDefaultFolded)
    return '<div class="dgn-sec' + (isFolded ? ' dgn-folded' : '') + '" data-sec="' + id + '">'
      + '<div class="dgn-sec-head"><span class="dgn-sec-title">' + escapeHtml(title) + '</span>'
      + (badge ? '<span class="dgn-badge">' + escapeHtml(badge) + '</span>' : '')
      + '<span class="dgn-caret">▾</span></div>'
      + '<div class="dgn-sec-body">' + bodyHtml + '</div>'
      + '</div>'
  }

  /** One main quota window: label, remaining %, bar, reset time. */
  function windowRow(row) {
    var colour = tone(row.remaining)
    return '<div class="dgn-row">'
      + '<div class="dgn-row-head"><span class="dgn-name">' + escapeHtml(row.label) + '</span>'
      + '<span class="dgn-val" style="color:' + colour + '">' + row.remaining + '%'
      + '<span style="font-size:10px;opacity:.7"> 剩余</span></span></div>'
      + '<div class="dgn-track"><div class="dgn-fill" style="width:' + row.remaining + '%;background:' + colour + '"></div></div>'
      + '<div class="dgn-meta">' + escapeHtml(fmtReset(row.resetsAt)) + '</div>'
      + '</div>'
  }

  /** One model: a percentage row when the endpoint reports spend, a chip otherwise. */
  function modelRow(model) {
    var chip
    if (typeof model.remaining === 'number') {
      chip = '<span class="dgn-chip" style="color:' + tone(model.remaining) + ';background:transparent">'
        + model.remaining + '% 剩余</span>'
    } else if (model.available === false) {
      chip = model.availableAt
        ? '<span class="dgn-chip dgn-warn">' + escapeHtml(fmtWhen(model.availableAt)) + ' 可用</span>'
        : '<span class="dgn-chip dgn-bad">不可用</span>'
    } else if (model.creditsWouldEnable) {
      chip = '<span class="dgn-chip dgn-warn">需积分</span>'
    } else {
      chip = '<span class="dgn-chip dgn-ok">可用</span>'
    }
    var name = escapeHtml(model.name)
    var row = '<div class="dgn-model"><span class="dgn-model-name" title="' + name + '">' + name + '</span>' + chip + '</div>'
    if (typeof model.remaining === 'number') {
      var colour = tone(model.remaining)
      row += '<div class="dgn-track" style="height:4px;margin-bottom:4px">'
        + '<div class="dgn-fill" style="width:' + model.remaining + '%;background:' + colour + '"></div></div>'
    }
    return row
  }

  /** Credits / spend-control / extra pools, merged into one collapsible section. */
  function extraRows(payload) {
    var bits = []
    var credits = payload.credits
    if (credits) {
      bits.push('<div class="dgn-kv"><span>积分</span><span>'
        + (credits.unlimited ? '无限' : credits.hasCredits ? (credits.balance !== undefined ? credits.balance : '有') : '无')
        + '</span></div>')
      if (credits.overageLimitReached) bits.push('<div class="dgn-kv"><span>超额</span><span class="dgn-err">已达上限</span></div>')
    }
    var spend = payload.spend
    if (spend) {
      bits.push('<div class="dgn-kv"><span>花费控制</span><span>'
        + (spend.reached ? '已达上限' : spend.limit === null ? '未设上限' : String(spend.limit))
        + '</span></div>')
    }
    ;(payload.additional || []).forEach(function (entry) {
      var row = entry.window
      if (!row) return
      bits.push('<div class="dgn-kv"><span>' + escapeHtml(entry.label) + '</span><span style="color:' + tone(row.remaining) + '">'
        + row.remaining + '% 剩余</span></div>')
    })
    return bits.join('')
  }

  function render() {
    if (!document_) {
      bubble.innerHTML = '<div class="dgn-msg">正在查询 ChatGPT / Codex 额度…</div>'
      return
    }
    if (!document_.ok) {
      bubble.innerHTML = '<div class="dgn-head"><span class="dgn-title">GPT / Codex</span>'
        + '<span class="dgn-sub">查询失败</span></div>'
        + '<div class="dgn-msg dgn-err"></div>'
        + '<div class="dgn-meta" style="margin-top:8px">在 DSH 模型设置里登录 OpenAI Codex 后可正常读取。</div>'
      bubble.querySelector('.dgn-err').textContent = document_.error || '未知错误'
      setDot(undefined)
      return
    }

    var rows = document_.windows || []
    var models = document_.models || []
    var lowest = lowestOf(rows)
    setDot(lowest)
    trackAlert(lowest)

    var metaBits = []
    if (document_.plan) metaBits.push(document_.plan.toUpperCase())
    if (document_.account) metaBits.push(document_.account)
    if (document_.limitReached) metaBits.push('已达上限')
    if (metaBits.length === 0) metaBits.push('ChatGPT / Codex 订阅额度')

    var html = '<div class="dgn-head"><span class="dgn-title">GPT / Codex</span>'
      + '<span class="dgn-sub">' + escapeHtml(metaBits.join(' · ')) + '</span></div>'

    if (rows.length === 0) {
      html += '<div class="dgn-msg">接口没有返回可用的额度窗口。</div>'
    } else {
      html += rows.map(windowRow).join('')
    }

    if (models.length > 0) {
      var withSpend = models.some(function (model) { return typeof model.remaining === 'number' })
      html += section('models', '模型用量', models.length + ' 个', models.map(modelRow).join(''), !withSpend)
    }

    var extra = extraRows(document_)
    if (extra) html += section('extra', '积分与附加', '', extra, true)

    bubble.innerHTML = html
  }

  function refresh(force) {
    fetch(QUOTA_PATH, force ? { method: 'POST', cache: 'no-store' } : { cache: 'no-store' })
      .then(function (response) { return response.json() })
      .then(function (payload) { document_ = payload; render() })
      .catch(function (error) {
        document_ = { ok: false, error: (error && error.message) || String(error) }
        render()
      })
  }

  function openBubble() {
    open = true
    bubble.classList.add('dgn-open')
    menu.classList.remove('dgn-open')
    say.classList.remove('dgn-on')
    render()
    refresh(true)
    if (timer === null) timer = setInterval(function () { refresh(false) }, POLL_MS)
  }

  function closeBubble() {
    open = false
    bubble.classList.remove('dgn-open')
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  // Collapsible sections: re-rendering rebuilds them from `prefs.fold`, so a
  // toggle only has to persist the choice and flip the class.
  bubble.addEventListener('click', function (event) {
    var head = event.target.closest('.dgn-sec-head')
    if (!head) return
    event.stopPropagation()
    var sec = head.parentNode
    var id = sec.getAttribute('data-sec')
    var next = !sec.classList.contains('dgn-folded')
    sec.classList.toggle('dgn-folded', next)
    setFolded(id, next)
  })

  menu.addEventListener('click', function (event) {
    var item = event.target.closest('[data-act]')
    if (!item) return
    event.stopPropagation()
    var action = item.getAttribute('data-act')
    touch()
    if (action === 'refresh') refresh(true)
    else if (action === 'walk') {
      prefs.walk = !prefs.walk
      if (prefs.walk) startWalk()
      else stopWalk()
    } else if (action === 'talk') {
      prefs.talk = !prefs.talk
      if (!prefs.talk) {
        say.classList.remove('dgn-on')
        if (sayTimer !== null) {
          clearTimeout(sayTimer)
          sayTimer = null
        }
      } else {
        speak(currentLine(), 3200)
      }
    } else if (action === 'bigger') prefs.scale = Math.min(1.8, Math.round((prefs.scale + 0.15) * 100) / 100)
    else if (action === 'smaller') prefs.scale = Math.max(0.6, Math.round((prefs.scale - 0.15) * 100) / 100)
    else if (action === 'mute') {
      prefs.muted = !prefs.muted
      blip(880, 0.08, 0.05)
    } else if (action === 'alert') {
      prefs.alertMuted = !prefs.alertMuted
      if (!prefs.alertMuted) alertSound(1)
    } else if (action === 'reset') {
      prefs.right = 24
      prefs.bottom = 24
      prefs.scale = 1
    }
    savePrefs()
    applyPrefs()
    menu.classList.remove('dgn-open')
  })

  // —— drag + throw + click ——
  var drag = null
  pet.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return
    if (event.target.closest('.dgn-menu')) return
    touch()
    if (flight !== null) {
      cancelAnimationFrame(flight)
      flight = null
    }
    if (sleeping) {
      // First click only wakes her; no accidental panel toggle on the way up.
      wake()
      speak('唔…我醒了。', 2200)
      blip(660, 0.06, 0.04)
      return
    }
    drag = {
      x: event.clientX, y: event.clientY,
      right: prefs.right, bottom: prefs.bottom,
      moved: false, vx: 0, vy: 0,
      lastX: event.clientX, lastY: event.clientY, lastT: performance.now(),
    }
    pet.classList.add('dgn-dragging')
    try { pet.setPointerCapture(event.pointerId) } catch (err) {}
    blip(660, 0.05, 0.04)
  })
  pet.addEventListener('pointermove', function (event) {
    if (!drag) return
    var dx = event.clientX - drag.x
    var dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    prefs.right = Math.max(0, Math.min(window.innerWidth - 40, drag.right - dx))
    prefs.bottom = Math.max(0, Math.min(window.innerHeight - 40, drag.bottom - dy))
    applyPrefs()
    var now = performance.now()
    var span = Math.max(8, now - drag.lastT) / 1000
    drag.vx = (event.clientX - drag.lastX) / span
    drag.vy = (event.clientY - drag.lastY) / span
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    drag.lastT = now
    var tilt = Math.max(-13, Math.min(13, drag.vx * 0.022))
    pet.style.transform = 'rotate(' + tilt.toFixed(2) + 'deg) scale(.97)'
  })
  pet.addEventListener('pointerup', function (event) {
    if (!drag) return
    var state = drag
    drag = null
    pet.classList.remove('dgn-dragging')
    pet.style.transform = ''
    try { pet.releasePointerCapture(event.pointerId) } catch (err) {}
    if (state.moved) {
      savePrefs()
      blip(520, 0.05, 0.035)
      if (walkState.paused === false) walkState.until = performance.now() + 2500
      throwPet(state.vx, state.vy)
      return
    }
    if (open) closeBubble()
    else openBubble()
  })
  pet.addEventListener('pointercancel', function () {
    drag = null
    pet.classList.remove('dgn-dragging')
    pet.style.transform = ''
  })

  pet.addEventListener('contextmenu', function (event) {
    event.preventDefault()
    event.stopPropagation()
    touch()
    closeBubble()
    menu.classList.toggle('dgn-open')
  })

  document.addEventListener('mousedown', function (event) {
    if (!host.contains(event.target)) {
      menu.classList.remove('dgn-open')
      if (open) closeBubble()
    }
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      menu.classList.remove('dgn-open')
      if (open) closeBubble()
    }
  })

  // —— desk-pet behaviour: idle chatter, sleeping, walking, throwing ——
  // All of it is optional garnish around the quota panel; every timer is cheap
  // and every loop stops itself when its mode is off.
  var LINES = {
    ok: [
      '额度还宽裕，放心写吧。',
      '今天也是陪你写代码的一天。',
      '要不要先喝口水？',
      '我在右下角，随时叫我。',
      '进度条很健康，继续。',
      '刚睡醒，脑子还在加载。',
      '写完这段记得保存。',
      '摸鱼也要有节奏。',
      '今天想写点什么？',
      '刚才那个提示音，是你点的我吗？',
    ],
    warn: [
      '额度掉到三成了，悠着点。',
      '快到警戒线了，要不清一下上下文？',
      '五小时窗口剩得不多啦。',
      '再写就要开始省着用了。',
      '要不要等等重置？',
      '提醒一下：额度不多了。',
    ],
    bad: [
      '只剩一点点了……要不要歇会儿？',
      '额度告急，我先紧张一下。',
      '真的快用完了，等重置吧。',
      '别硬撑，等窗口刷新。',
      '这次真的见底了。',
    ],
  }
  var lastLowest
  var sayTimer = null
  function pick(list) {
    return list[Math.floor(Math.random() * list.length)]
  }
  function speak(text, ms) {
    say.textContent = text
    say.classList.add('dgn-on')
    if (sayTimer !== null) clearTimeout(sayTimer)
    sayTimer = setTimeout(function () {
      sayTimer = null
      say.classList.remove('dgn-on')
    }, ms || 6000)
  }
  function currentLine() {
    if (typeof lastLowest !== 'number') return pick(LINES.ok)
    if (lastLowest <= 10) return pick(LINES.bad)
    if (lastLowest <= 30) return pick(LINES.warn)
    return pick(LINES.ok)
  }
  function hop() {
    pet.classList.remove('dgn-hopping')
    void pet.offsetWidth
    pet.classList.add('dgn-hopping')
    setTimeout(function () { pet.classList.remove('dgn-hopping') }, 560)
  }

  // Idle → asleep after five minutes; any interaction wakes her up.
  var idleAt = Date.now()
  var sleeping = false
  function wake() {
    idleAt = Date.now()
    if (!sleeping) return
    sleeping = false
    pet.classList.remove('dgn-sleeping')
  }
  function touch() {
    wake()
    idleAt = Date.now()
  }
  function checkIdle() {
    if (sleeping || open || drag !== null || flight !== null || prefs.walk) return
    if (Date.now() - idleAt > 5 * 60 * 1000) {
      sleeping = true
      pet.classList.add('dgn-sleeping')
    }
  }

  // Idle chatter: rare, silent while the panel is open, and off with one click.
  var chatterTimer = null
  function scheduleChatter() {
    if (chatterTimer !== null) clearTimeout(chatterTimer)
    chatterTimer = setTimeout(function () {
      chatterTimer = null
      if (prefs.talk && !open && !sleeping && drag === null && !document.hidden) speak(currentLine(), 6200)
      scheduleChatter()
    }, 90_000 + Math.random() * 150_000)
  }

  // Walk along the bottom edge, pausing at random intervals.
  var walkRaf = null
  var walkLast = 0
  var walkState = { dir: 1, paused: false, until: 0 }
  var walkSaveAt = 0
  function walkTick(now) {
    if (!prefs.walk) {
      walkRaf = null
      pet.classList.remove('dgn-walking')
      return
    }
    if (drag !== null) {
      walkRaf = requestAnimationFrame(walkTick)
      return
    }
    if (walkLast === 0) walkLast = now
    var dt = Math.min(0.05, (now - walkLast) / 1000)
    walkLast = now
    if (walkState.paused) {
      pet.classList.remove('dgn-walking')
      if (now >= walkState.until) {
        walkState.paused = false
        walkState.dir = Math.random() < 0.5 ? -1 : 1
        walkState.until = now + 1800 + Math.random() * 4200
      }
    } else {
      pet.classList.add('dgn-walking')
      var width = pet.offsetWidth || 104
      var maxRight = Math.max(24, window.innerWidth - width - 24)
      prefs.right -= walkState.dir * 24 * prefs.scale * dt
      if (prefs.right <= 24) {
        prefs.right = 24
        walkState.dir = 1
      } else if (prefs.right >= maxRight) {
        prefs.right = maxRight
        walkState.dir = -1
      }
      host.style.right = prefs.right + 'px'
      if (now >= walkState.until) {
        walkState.paused = true
        walkState.until = now + 700 + Math.random() * 2600
      }
      if (now - walkSaveAt > 2000) {
        walkSaveAt = now
        savePrefs()
      }
    }
    walkRaf = requestAnimationFrame(walkTick)
  }
  function startWalk() {
    if (walkRaf !== null) return
    walkLast = 0
    walkState.paused = false
    walkState.dir = Math.random() < 0.5 ? -1 : 1
    walkState.until = performance.now() + 1500 + Math.random() * 3000
    walkRaf = requestAnimationFrame(walkTick)
  }
  function stopWalk() {
    if (walkRaf !== null) cancelAnimationFrame(walkRaf)
    walkRaf = null
    pet.classList.remove('dgn-walking')
  }

  // Throw physics: only while the pet is airborne, so a pet you placed
  // mid-window stays where you put it instead of sinking to the floor.
  var flight = null
  function throwPet(vx, vy) {
    if (Math.abs(vx) < 70 && Math.abs(vy) < 140) return
    if (flight !== null) cancelAnimationFrame(flight)
    var GRAVITY = 2100
    var FLOOR = 8
    var last = performance.now()
    var speedX = vx
    var speedY = vy
    function step(now) {
      var dt = Math.min(0.05, (now - last) / 1000)
      last = now
      speedY += GRAVITY * dt
      var width = pet.offsetWidth || 104
      var height = pet.offsetHeight || 104
      var x = window.innerWidth - prefs.right - width + speedX * dt
      var y = window.innerHeight - prefs.bottom - height + speedY * dt
      var maxX = Math.max(0, window.innerWidth - width)
      var maxY = Math.max(0, window.innerHeight - height - FLOOR)
      if (x < 0) {
        x = 0
        speedX = -speedX * 0.55
      } else if (x > maxX) {
        x = maxX
        speedX = -speedX * 0.55
      }
      if (y < 0) {
        y = 0
        speedY = Math.abs(speedY) * 0.4
      } else if (y > maxY) {
        y = maxY
        speedY = -speedY * 0.45
        speedX *= 0.86
        if (Math.abs(speedY) < 90) speedY = 0
      }
      prefs.right = Math.max(0, window.innerWidth - x - width)
      prefs.bottom = Math.max(0, window.innerHeight - y - height)
      host.style.right = prefs.right + 'px'
      host.style.bottom = prefs.bottom + 'px'
      if (speedY === 0 && Math.abs(speedX) < 45) {
        flight = null
        savePrefs()
        if (Math.random() < 0.5) speak('欸——', 1600)
        return
      }
      flight = requestAnimationFrame(step)
    }
    flight = requestAnimationFrame(step)
  }

  function mount() {
    if (!window.location.pathname || window.location.pathname.indexOf(SCRIPT_PATH) === 0) return
    var parent = document.head || document.documentElement
    if (!parent.querySelector('#dsh-gpt-niang-style')) {
      styleEl.id = 'dsh-gpt-niang-style'
      parent.appendChild(styleEl)
    }
    document.body.appendChild(host)
    applyPrefs()
    render()
    scheduleChatter()
    setInterval(checkIdle, 20_000)
    if (prefs.walk) startWalk()
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
