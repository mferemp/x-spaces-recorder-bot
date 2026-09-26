// Telegram control surface for the local recorder.
// Links point at TELEGRAM_PUBLIC_BASE_URL so playback stays on this backend
// and never goes through Telegram's upload limit.

const http = require('http')
const https = require('https')

function parseSpaceId(input) {
  if (!input) return null
  const text = String(input).trim()
  const match = text.match(/(?:spaces|broadcasts)\/([A-Za-z0-9]+)/)
  if (match) return match[1]
  if (/^[A-Za-z0-9]{10,}$/.test(text)) return text
  return null
}

function commandOf(text) {
  const match = String(text || '').trim().match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/)
  return match ? match[1].toLowerCase() : null
}

function extractRecordInput(text) {
  const trimmed = String(text || '').trim()
  const command = trimmed.match(/^\/record(?:@\w+)?(?:\s+([\s\S]+))?$/i)
  const body = (command ? command[1] || '' : trimmed).trim()
  const url = body.match(/https?:\/\/\S+/i)
  if (url) {
    const cleaned = url[0].replace(/[),.;>]+$/, '')
    return parseSpaceId(cleaned) ? cleaned : null
  }
  if (/^[A-Za-z0-9]{10,}$/.test(body)) return body
  return null
}

function parseClock(token) {
  const parts = String(token).split(':')
  if (parts.length < 1 || parts.length > 3) return null
  if (parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null
  const numbers = parts.map(Number)
  if (numbers.some((n) => !Number.isFinite(n))) return null
  if (numbers.length === 1) return numbers[0]
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1]
  return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
}

function parseClipRange(text) {
  const match = String(text || '').trim().match(/^(\d+(?::\d+){0,2})\s*-\s*(\d+(?::\d+){0,2})$/)
  if (!match) return null
  const start = parseClock(match[1])
  const end = parseClock(match[2])
  if (start == null || end == null || !(end > start)) return null
  return { start_seconds: start, end_seconds: end }
}

function publicUrl(base, pathname) {
  const root = String(base || '').replace(/\/+$/, '')
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return root + path
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function clipLabel(title) {
  const clean = String(title || 'Space').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || 'Space'
}

function defaultRequest(base, method, pathname, body) {
  const target = new URL(publicUrl(base, pathname))
  const payload = body == null ? null : Buffer.from(JSON.stringify(body))
  const lib = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          if (text) {
            try {
              json = JSON.parse(text)
            } catch {
              json = { error: text.slice(0, 300) }
            }
          }
          resolve({ status: res.statusCode || 0, json })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function allowedUser(fromId, allowList) {
  if (!allowList.length) return true
  return allowList.includes(String(fromId))
}

function createRecorderBot({
  token,
  publicBaseUrl,
  backendBaseUrl,
  request,
  Bot,
  polling = false,
  allowedUserIds = [],
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required')
  if (!publicBaseUrl) throw new Error('TELEGRAM_PUBLIC_BASE_URL is required')
  if (!Bot) throw new Error('A Telegram Bot implementation is required')

  const publicBase = String(publicBaseUrl).replace(/\/+$/, '')
  const apiBase = String(backendBaseUrl || 'http://127.0.0.1:3001').replace(/\/+$/, '')
  const call = request || ((method, pathname, body) => defaultRequest(apiBase, method, pathname, body))
  const allowList = allowedUserIds.map(String)
  const bot = new Bot(token, { polling })
  const active = new Map()
  const monitors = new Map()
  const awaitingClip = new Map()
  const pendingWatch = new Map()

  function listenUrl(id) {
    return publicUrl(publicBase, `/api/space/preview/${id}`)
  }
  function fileUrl(id) {
    return publicUrl(publicBase, `/api/space/file/${id}`)
  }
  function clipUrl(id) {
    return publicUrl(publicBase, `/api/space/clip/${id}/file?play=1`)
  }
  function recordingKeyboard(id) {
    return {
      inline_keyboard: [[
        { text: 'Listen so far', url: listenUrl(id) },
        { text: 'Stop & save', callback_data: `s:${id}` },
      ]],
    }
  }

  async function send(chatId, text, extra) {
    return bot.sendMessage(chatId, text, extra)
  }

  async function guard(msgOrQuery) {
    const fromId = msgOrQuery.from?.id
    const chatId = msgOrQuery.chat?.id || msgOrQuery.message?.chat?.id
    if (allowedUser(fromId, allowList)) return true
    if (chatId) await send(chatId, 'This bot is private.')
    return false
  }

  async function startFromInput(chatId, input) {
    const resolved = await call('POST', '/api/space/resolve', { input })
    const body = resolved.json || {}
    if (body.ok && body.m3u8) {
      const started = await call('POST', '/api/space/download', {
        m3u8: body.m3u8,
        name: body.title || 'Space',
        title: body.title || null,
        source: 'space',
        input,
        enhance: true,
      })
      const job = started.json || {}
      if (!job.id) {
        await send(chatId, job.error || 'Could not start the recording.')
        return
      }
      active.set(job.id, { id: job.id, chatId, title: body.title || 'Space' })
      await send(
        chatId,
        `Recording started.\n${clipLabel(body.title)}\n${body.live ? 'Live' : 'Replay'}`,
        { reply_markup: recordingKeyboard(job.id) }
      )
      return
    }
    if (parseSpaceId(input)) {
      const tokenId = Math.random().toString(36).slice(2, 8)
      pendingWatch.set(tokenId, { input, title: body.title || null })
      await send(
        chatId,
        `${body.reason || 'This Space is not reachable yet.'}\n\nWatch for it and record when audio is available?`,
        { reply_markup: { inline_keyboard: [[{ text: 'Watch for it', callback_data: `w:${tokenId}` }]] } }
      )
      return
    }
    await send(chatId, body.reason || 'Paste an X Space link, or use /record <link>.')
  }

  async function sendStatus(chatId) {
    const mine = [...active.values()].filter((job) => job.chatId === chatId)
    const watching = [...monitors.values()].filter((mon) => mon.chatId === chatId && !mon.jobId)
    if (!mine.length && !watching.length) {
      await send(chatId, 'No active recordings.')
      return
    }
    for (const mon of watching) {
      await send(chatId, `Watching.\n${clipLabel(mon.title)}\n${mon.lastReason || 'Waiting for the Space.'}`)
    }
    for (const job of mine) {
      const status = await call('GET', `/api/space/status/${job.id}`)
      const row = status.json || {}
      if (status.status === 404) {
        active.delete(job.id)
        continue
      }
      const lines = [
        clipLabel(row.name || job.title),
        `${row.state || 'unknown'} · ${formatClock(row.recordedSecs)} captured · ${formatBytes(row.sizeBytes)}`,
      ]
      if (row.error) lines.push(String(row.error))
      const extra = row.state === 'downloading' || row.state === 'processing' || row.state === 'stopped'
        ? { reply_markup: recordingKeyboard(job.id) }
        : undefined
      await send(chatId, lines.join('\n'), extra)
    }
  }

  async function sendArchive(chatId) {
    const listed = await call('GET', '/api/space/archive')
    const rows = Array.isArray(listed.json) ? listed.json : []
    if (!rows.length) {
      await send(chatId, listed.json?.error || 'Archive is empty.')
      return
    }
    for (const row of rows.slice(0, 8)) {
      const title = clipLabel(row.title || row.name)
      await send(
        chatId,
        `${title}\n${row.kind || 'audio'} · ${formatClock(row.duration_seconds)} · ${formatBytes(row.size_bytes)}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Open audio', url: fileUrl(row.id) },
              { text: 'Create clip', callback_data: `c:${row.id}` },
              { text: 'Delete', callback_data: `d:${row.id}` },
            ]],
          },
        }
      )
    }
  }

  async function sendClips(chatId) {
    const listed = await call('GET', '/api/space/clips')
    const rows = Array.isArray(listed.json) ? listed.json : []
    if (!rows.length) {
      await send(chatId, listed.json?.error || 'No clips yet.')
      return
    }
    for (const row of rows.slice(0, 8)) {
      const parent = row.parent_title || row.parent_name || 'recording'
      await send(chatId, `${clipLabel(row.title)}\nFrom ${clipLabel(parent)} · ${formatClock(row.duration_seconds)}\n${clipUrl(row.id)}`)
    }
  }

  async function onMessage(msg) {
    if (!msg?.text || !msg.chat) return
    if (!(await guard(msg))) return
    const text = msg.text.trim()
    const command = commandOf(text)
    const chatId = msg.chat.id
    if (command === 'start' || command === 'help') {
      await send(chatId, 'Paste an X Space link, or use /record <link>.\n/status · /archive · /clips')
      return
    }
    if (command === 'status') return sendStatus(chatId)
    if (command === 'archive') return sendArchive(chatId)
    if (command === 'clips') return sendClips(chatId)
    if (command === 'record') {
      const input = extractRecordInput(text)
      if (!input) {
        await send(chatId, 'Usage: /record <X Space link>')
        return
      }
      return startFromInput(chatId, input)
    }
    if (command) {
      await send(chatId, 'Unknown command. Use /record, /status, /archive, or /clips.')
      return
    }
    const range = parseClipRange(text)
    if (range && awaitingClip.has(chatId)) {
      const pending = awaitingClip.get(chatId)
      awaitingClip.delete(chatId)
      const created = await call('POST', `/api/space/recordings/${pending.id}/clips`, {
        title: `${clipLabel(pending.title)} clip`,
        start_seconds: range.start_seconds,
        end_seconds: range.end_seconds,
        enhance: true,
      })
      const clip = created.json || {}
      if (!clip.id) {
        await send(chatId, clip.error || 'Could not create that clip.')
        return
      }
      await send(chatId, `Clip ready.\n${clipUrl(clip.id)}`)
      return
    }
    const input = extractRecordInput(text)
    if (input) return startFromInput(chatId, input)
    if (awaitingClip.has(chatId)) {
      await send(chatId, 'Send the clip range as 1:30-4:00')
      return
    }
    await send(chatId, 'Paste an X Space link, or use /record <link>.')
  }

  async function onCallback(query) {
    if (!query?.data) return
    if (bot.answerCallbackQuery) await bot.answerCallbackQuery(query.id)
    if (!(await guard(query))) return
    const chatId = query.message?.chat?.id
    if (!chatId) return
    const [action, id] = String(query.data).split(':')
    if (action === 'w') {
      const pending = pendingWatch.get(id)
      pendingWatch.delete(id)
      if (!pending) {
        await send(chatId, 'That watch request expired. Send the link again.')
        return
      }
      const started = await call('POST', '/api/space/monitor', {
        input: pending.input,
        name: pending.title || 'Space',
        enhance: true,
      })
      const mon = started.json || {}
      if (!mon.id) {
        await send(chatId, mon.error || 'Could not start watching.')
        return
      }
      monitors.set(mon.id, { id: mon.id, chatId, input: pending.input, title: pending.title, jobId: null })
      await send(chatId, `Watching ${clipLabel(pending.title)}.\nI'll start recording when the Space is reachable.`)
      return
    }
    if (action === 's') {
      const stopped = await call('POST', `/api/space/stop/${id}`)
      const body = stopped.json || {}
      await send(chatId, body.ok ? 'Stopping and saving what has been captured.' : (body.error || 'Could not stop that recording.'))
      return
    }
    if (action === 'c') {
      awaitingClip.set(chatId, { id, title: 'Clip' })
      await send(chatId, 'Send the clip range as 1:30-4:00')
      return
    }
    if (action === 'd') {
      await send(chatId, 'Delete this recording?', {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Delete', callback_data: `y:${id}` },
            { text: 'Keep', callback_data: `n:${id}` },
          ]],
        },
      })
      return
    }
    if (action === 'y') {
      const removed = await call('DELETE', `/api/space/archive/${id}`)
      const body = removed.json || {}
      await send(chatId, body.ok ? 'Recording deleted.' : (body.error || 'Could not delete that recording.'))
      return
    }
    if (action === 'n') {
      await send(chatId, 'Kept.')
    }
  }

  async function pollOnce() {
    for (const mon of [...monitors.values()]) {
      const status = await call('GET', `/api/space/monitor/${mon.id}`)
      const row = status.json || {}
      if (row.lastReason) mon.lastReason = row.lastReason
      if (row.title) mon.title = row.title
      if (row.state === 'recording' && row.jobId && !mon.jobId) {
        mon.jobId = row.jobId
        active.set(row.jobId, { id: row.jobId, chatId: mon.chatId, title: row.title || mon.title || 'Space' })
        await send(mon.chatId, `Recording started.\n${clipLabel(row.title || mon.title)}`, {
          reply_markup: recordingKeyboard(row.jobId),
        })
      }
      if (row.state === 'error' || row.state === 'cancelled' || row.state === 'ended') {
        monitors.delete(mon.id)
        if (row.state === 'error') await send(mon.chatId, row.lastReason || 'Stopped watching.')
      }
    }
    for (const job of [...active.values()]) {
      const status = await call('GET', `/api/space/status/${job.id}`)
      const row = status.json || {}
      if (status.status === 404) {
        active.delete(job.id)
        continue
      }
      if (row.state === 'ready') {
        active.delete(job.id)
        await send(job.chatId, `Saved.\n${clipLabel(row.name || job.title)}\n${fileUrl(job.id)}`, {
          reply_markup: { inline_keyboard: [[{ text: 'Open audio', url: fileUrl(job.id) }]] },
        })
      } else if (row.state === 'error') {
        active.delete(job.id)
        await send(job.chatId, row.error || 'Recording failed.')
      }
    }
  }

  bot.on('message', (msg) => onMessage(msg))
  bot.on('callback_query', (query) => onCallback(query))

  return { bot, pollOnce, active, monitors, awaitingClip, onMessage, onCallback }
}

function readAllowList(raw = process.env.TELEGRAM_ALLOWED_USER_IDS || '') {
  return String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function launchError({ token, publicBaseUrl, allowedUserIds }) {
  if (!token) return 'TELEGRAM_BOT_TOKEN is required. Set it in the terminal. Do not paste it into chat.'
  if (!publicBaseUrl) return 'TELEGRAM_PUBLIC_BASE_URL is required. Use the HTTPS address your phone can open.'
  let url
  try {
    url = new URL(publicBaseUrl)
  } catch {
    return 'TELEGRAM_PUBLIC_BASE_URL must be a full https:// address.'
  }
  const host = url.hostname.toLowerCase()
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  if (url.protocol !== 'https:' || privateHost) {
    return 'TELEGRAM_PUBLIC_BASE_URL must be a public https:// address. localhost and private IPs will not open from Telegram on your phone.'
  }
  if (!allowedUserIds.length || allowedUserIds.some((id) => !/^\d+$/.test(id))) {
    return 'TELEGRAM_ALLOWED_USER_IDS must be your numeric Telegram user ID. A @handle is not accepted.'
  }
  return null
}

// node-telegram-bot-api v2 is a different client from the old polling constructor.
// This adapter keeps the recorder logic on plain messages and callback queries.
function V2Bot(token) {
  const { Bot } = require('node-telegram-bot-api')
  this.inner = new Bot(token)
}

V2Bot.prototype.on = function on(event, fn) {
  if (event === 'message') {
    this.inner.on('message', (ctx) => {
      const message = ctx.message
      if (!message) return undefined
      return fn({ ...message, from: message.from || ctx.from, chat: message.chat })
    })
  }
  if (event === 'callback_query') {
    this.inner.on('callback_query', (ctx) => {
      const query = ctx.callbackQuery
      if (!query) return undefined
      return fn({
        id: query.id,
        data: query.data,
        from: query.from || ctx.from,
        message: query.message,
      })
    })
  }
  return undefined
}

V2Bot.prototype.sendMessage = function sendMessage(chatId, text, extra) {
  return this.inner.api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: extra && extra.reply_markup,
  })
}

V2Bot.prototype.answerCallbackQuery = function answerCallbackQuery(id) {
  return this.inner.api.answerCallbackQuery({ callback_query_id: id })
}

function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const publicBaseUrl = process.env.TELEGRAM_PUBLIC_BASE_URL
  const allowedUserIds = readAllowList()
  const error = launchError({ token, publicBaseUrl, allowedUserIds })
  if (error) {
    console.error(error)
    process.exit(1)
  }
  const { run } = require('node-telegram-bot-api/node')
  const port = Number(process.env.BACKEND_PORT || 3001)
  const recorder = createRecorderBot({
    token,
    publicBaseUrl,
    backendBaseUrl: `http://127.0.0.1:${port}`,
    Bot: V2Bot,
    polling: true,
    allowedUserIds,
  })
  setInterval(() => {
    recorder.pollOnce().catch((err) => console.error('[telegram] poll failed:', err?.message || err))
  }, 5000)
  console.log(`[telegram] bot polling; recorder API at http://127.0.0.1:${port}`)
  run(recorder.bot.inner).catch((err) => {
    console.error('[telegram] polling stopped:', err?.message || err)
    process.exit(1)
  })
}

if (require.main === module) main()

module.exports = {
  parseSpaceId,
  parseClipRange,
  extractRecordInput,
  publicUrl,
  createRecorderBot,
  formatClock,
  launchError,
}
