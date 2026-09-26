const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseClipRange,
  extractRecordInput,
  publicUrl,
  createRecorderBot,
  launchError,
} = require('../telegram-bot')

class FakeBot {
  constructor() {
    this.sent = []
    this.handlers = {}
    this.answers = []
  }
  on(event, fn) {
    this.handlers[event] = fn
  }
  sendMessage(chatId, text, extra) {
    this.sent.push({ chatId, text, extra })
    return Promise.resolve({ message_id: this.sent.length })
  }
  answerCallbackQuery(id) {
    this.answers.push(id)
    return Promise.resolve()
  }
}

function harness(request) {
  const bot = new FakeBot()
  const app = createRecorderBot({
    token: 'test-token',
    publicBaseUrl: 'https://recorder.example.com/',
    backendBaseUrl: 'http://127.0.0.1:3001',
    request,
    Bot: FakeBot,
    polling: false,
  })
  return { bot: app.bot, app }
}

test('launch refuses a missing allowlist and a private base URL', () => {
  const ok = { token: 'secret', publicBaseUrl: 'https://recorder.example.com', allowedUserIds: ['123'] }
  assert.equal(launchError(ok), null)
  assert.match(launchError({ ...ok, token: '' }), /TELEGRAM_BOT_TOKEN/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'http://recorder.example.com' }), /public https/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'https://localhost:3001' }), /public https/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'https://127.0.0.1:3001' }), /public https/)
  assert.match(launchError({ ...ok, publicBaseUrl: 'https://192.168.1.20' }), /public https/)
  assert.match(launchError({ ...ok, allowedUserIds: [] }), /numeric Telegram/)
  assert.match(launchError({ ...ok, allowedUserIds: ['@LOWKEYEMS'] }), /numeric Telegram/)
})

test('parses a minute-second clip range', () => {
  assert.deepEqual(parseClipRange('1:30-4:00'), { start_seconds: 90, end_seconds: 240 })
  assert.deepEqual(parseClipRange('1:02:03-1:05:00'), { start_seconds: 3723, end_seconds: 3900 })
  assert.equal(parseClipRange('4:00-1:30'), null)
  assert.equal(parseClipRange('later'), null)
})

test('reads a Space link from a paste or /record', () => {
  const link = 'https://x.com/i/spaces/1ypKdkAbCdEfGh'
  assert.equal(extractRecordInput(`see ${link}.`), link)
  assert.equal(extractRecordInput(`/record ${link}`), link)
  assert.equal(extractRecordInput('/record'), null)
  assert.equal(extractRecordInput('hello'), null)
})

test('builds public playback URLs without a trailing slash', () => {
  assert.equal(
    publicUrl('https://recorder.example.com/', '/api/space/preview/abc'),
    'https://recorder.example.com/api/space/preview/abc'
  )
})

test('a reachable Space starts a recording and offers listen and stop', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/resolve') {
      return { status: 200, json: { ok: true, m3u8: 'https://audio.example/live.m3u8', title: 'Launch', live: true } }
    }
    return { status: 200, json: { id: 'job123', kind: 'live' } }
  })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: 'https://x.com/i/spaces/1ypKdkAbCdEfGh' })
  assert.equal(calls[1].pathname, '/api/space/download')
  assert.equal(calls[1].body.input, 'https://x.com/i/spaces/1ypKdkAbCdEfGh')
  assert.match(bot.sent[0].text, /Recording started/)
  const buttons = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.equal(buttons[0].url, 'https://recorder.example.com/api/space/preview/job123')
  assert.equal(buttons[1].callback_data, 's:job123')
})

test('an unreachable Space offers watch, and the button arms the monitor', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/resolve') return { status: 200, json: { ok: false, reason: 'Not live yet.' } }
    return { status: 200, json: { id: 'mon1', state: 'watching' } }
  })
  const link = 'https://x.com/i/spaces/1ypKdkAbCdEfGh'
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: `/record ${link}` })
  assert.match(bot.sent[0].text, /Watch for it/)
  const data = bot.sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data
  await bot.handlers.callback_query({ id: 'cb', from: { id: 7 }, message: { chat: { id: 7 } }, data })
  assert.equal(calls.at(-1).pathname, '/api/space/monitor')
  assert.equal(calls.at(-1).body.input, link)
  assert.match(bot.sent.at(-1).text, /Watching/)
})

test('/status reports an active job from the backend', async () => {
  const { bot, app } = harness(async (method, pathname) => {
    assert.equal(method, 'GET')
    assert.equal(pathname, '/api/space/status/job123')
    return { status: 200, json: { state: 'downloading', recordedSecs: 95, sizeBytes: 2048, name: 'Launch.m4a' } }
  })
  app.active.set('job123', { id: 'job123', chatId: 7, title: 'Launch' })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: '/status' })
  assert.match(bot.sent[0].text, /downloading/)
  assert.match(bot.sent[0].text, /1:35/)
  assert.equal(bot.sent[0].extra.reply_markup.inline_keyboard[0][0].text, 'Listen so far')
})

test('stop and confirmed delete call the recorder routes', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname) => {
    calls.push({ method, pathname })
    return { status: 200, json: { ok: true } }
  })
  await bot.handlers.callback_query({ id: 'cb1', from: { id: 7 }, message: { chat: { id: 7 } }, data: 's:job123' })
  await bot.handlers.callback_query({ id: 'cb2', from: { id: 7 }, message: { chat: { id: 7 } }, data: 'd:rec1' })
  await bot.handlers.callback_query({ id: 'cb3', from: { id: 7 }, message: { chat: { id: 7 } }, data: 'y:rec1' })
  assert.deepEqual(calls[0], { method: 'POST', pathname: '/api/space/stop/job123' })
  assert.equal(bot.sent[1].extra.reply_markup.inline_keyboard[0][0].callback_data, 'y:rec1')
  assert.deepEqual(calls[1], { method: 'DELETE', pathname: '/api/space/archive/rec1' })
  assert.match(bot.sent.at(-1).text, /deleted/i)
})

test('/archive offers open, clip, and delete; a range creates the clip', async () => {
  const calls = []
  const { bot } = harness(async (method, pathname, body) => {
    calls.push({ method, pathname, body })
    if (pathname === '/api/space/archive') {
      return { status: 200, json: [{ id: 'rec1', title: 'Launch', kind: 'live', duration_seconds: 600, size_bytes: 4096 }] }
    }
    return { status: 200, json: { id: 'clip1', title: 'Launch clip' } }
  })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: '/archive' })
  const row = bot.sent[0].extra.reply_markup.inline_keyboard[0]
  assert.equal(row[0].url, 'https://recorder.example.com/api/space/file/rec1')
  assert.equal(row[1].callback_data, 'c:rec1')
  assert.equal(row[2].callback_data, 'd:rec1')
  await bot.handlers.callback_query({ id: 'cb', from: { id: 7 }, message: { chat: { id: 7 } }, data: 'c:rec1' })
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: '1:30-4:00' })
  const clipCall = calls.at(-1)
  assert.equal(clipCall.pathname, '/api/space/recordings/rec1/clips')
  assert.equal(clipCall.body.start_seconds, 90)
  assert.equal(clipCall.body.end_seconds, 240)
  assert.match(bot.sent.at(-1).text, /https:\/\/recorder\.example\.com\/api\/space\/clip\/clip1\/file\?play=1/)
})

test('/clips returns direct playback links', async () => {
  const { bot } = harness(async () => ({
    status: 200,
    json: [{ id: 'clip9', title: 'Intro', parent_title: 'Launch', duration_seconds: 30 }],
  }))
  await bot.handlers.message({ chat: { id: 7 }, from: { id: 7 }, text: '/clips' })
  assert.match(bot.sent[0].text, /https:\/\/recorder\.example\.com\/api\/space\/clip\/clip9\/file\?play=1/)
})

test('poll announces a watched recording and a saved file link', async () => {
  let statusHits = 0
  const { bot, app } = harness(async (method, pathname) => {
    if (pathname === '/api/space/monitor/mon1') {
      return { status: 200, json: { state: 'recording', jobId: 'job9', title: 'Launch' } }
    }
    if (pathname === '/api/space/status/job9') {
      statusHits += 1
      if (statusHits === 1) return { status: 200, json: { state: 'downloading', recordedSecs: 1, sizeBytes: 10, name: 'Launch.m4a' } }
      return { status: 200, json: { state: 'ready', name: 'Launch.m4a' } }
    }
    throw new Error(`unexpected ${method} ${pathname}`)
  })
  app.monitors.set('mon1', { id: 'mon1', chatId: 7, title: 'Launch', jobId: null })
  await app.pollOnce()
  assert.match(bot.sent[0].text, /Recording started/)
  assert.equal(bot.sent[0].extra.reply_markup.inline_keyboard[0][0].url, 'https://recorder.example.com/api/space/preview/job9')
  await app.pollOnce()
  assert.match(bot.sent[1].text, /https:\/\/recorder\.example\.com\/api\/space\/file\/job9/)
  assert.equal(app.active.size, 0)
})
