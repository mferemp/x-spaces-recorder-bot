const { Router } = require('express')
const { execFile } = require('child_process')
const ffmpegPath = require('ffmpeg-static')
const { dbQuery } = require('../lib/db')
const { decryptSecret } = require('../lib/secretbox')
const os = require('os')
const path = require('path')
const fs = require('fs')
const https = require('https')

const router = Router()

const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const QUERY_IDS = [
  'xVEzTKg_mLTHubK5ayL0HA',
  'Tvv_cf0MtSF1neJBwUZTjw',
  'lAZFmZ8y42BWQfDBrVj76A',
  'NGSHqfm2vNCXABuvXhSMag',
]

const jobs = new Map()
const monitors = new Map()
// Persistent archive dir (survives better than tmp; sits beside the backend).
const DL_DIR = path.join(__dirname, '..', 'archive')
fs.mkdirSync(DL_DIR, { recursive: true })

// --- publish guardrails ---
// Cap simultaneous downloads so one machine can't spawn unlimited ffmpeg work.
const MAX_ACTIVE = 3
// Safety-net disk cleanup: drop recordings older than this many days so a
// published server never fills up. The in-app 3-day nudge handles the rest.
const RETENTION_DAYS = 30
function activeCount() {
  let n = 0
  for (const j of jobs.values())
    if (j.state === 'downloading' || j.state === 'processing' || j.state === 'stopped') n++
  return n
}
async function sweepOldRecordings() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000
    const { rows } = await dbQuery(
      "SELECT id FROM recordings WHERE created_at < to_timestamp($1)",
      [Math.floor(cutoff / 1000)]
    )
    for (const r of rows) {
      for (const ext of ['.m4a', '.aac', '.raw']) {
        const p = path.join(DL_DIR, `${r.id}${ext}`)
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p)
          } catch {}
        }
      }
      await dbQuery('DELETE FROM recordings WHERE id = $1', [r.id])
    }
  } catch (e) {
    // table may not exist yet on very first boot; ignore
  }
}
setInterval(sweepOldRecordings, 6 * 3600 * 1000)
setTimeout(sweepOldRecordings, 10000)

// ---- small http helpers -----------------------------------------------------

function jsonFetch(url, opts = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: opts.method || 'GET', headers: opts.headers || {}, timeout: 15000 },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () =>
          resolve({ status: res.statusCode, json: safeJson(data), raw: data })
        )
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e) }))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}
function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
// fetch() with a hard timeout so a hung CDN connection can never freeze a job.
// `extra` lets a job pass its X login cookie so segment/playlist requests to
// the CDN are authenticated when the audio is login-restricted. We deliberately
// send ONLY User-Agent + Referer to the CDN (no Origin) — some CDN edges reject
// requests that carry an unexpected Origin, which silently breaks segment fetches.
async function fetchWithTimeout(url, ms = 20000, extra = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://x.com/', ...extra },
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(t)
  }
}
async function fetchText(url, extra = {}) {
  const r = await fetchWithTimeout(url, 20000, extra)
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
  return await r.text()
}
async function fetchBuf(url, extra = {}) {
  const r = await fetchWithTimeout(url, 20000, extra)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Retry a segment fetch a few times before giving up (network blips happen).
async function fetchBufRetry(url, tries = 4, extra = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchBuf(url, extra)
    } catch (e) {
      last = e
      await sleep(400 * (i + 1))
    }
  }
  throw last
}

// ---- X Space resolution (best-effort) --------------------------------------

async function getGuestToken() {
  const r = await jsonFetch('https://api.twitter.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { Authorization: `Bearer ${BEARER}`, 'User-Agent': UA },
  })
  return r.json?.guest_token || null
}

// Build the right headers for X's private API. When cookies are supplied we must
// authenticate as a LOGGED-IN user (OAuth2Session) — NOT send a guest token, or
// X ignores the login and returns an empty record. ct0 is auto-read from the
// cookie if the separate csrf field wasn't filled in.
function xHeaders(guestToken, cookie, csrf) {
  const base = {
    Authorization: `Bearer ${BEARER}`,
    'User-Agent': UA,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://x.com',
    Referer: 'https://x.com/',
    'x-twitter-client-language': 'en',
  }
  if (cookie) {
    // Pull ct0 out of the cookie string if csrf wasn't provided separately.
    let token = csrf
    if (!token) {
      const m = String(cookie).match(/ct0=([^;]+)/)
      if (m) token = m[1]
    }
    return {
      ...base,
      Cookie: cookie,
      'x-csrf-token': token || '',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
    }
  }
  return { ...base, 'x-guest-token': guestToken }
}
function parseSpaceId(input) {
  if (!input) return null
  const s = String(input).trim()
  const m = s.match(/(?:spaces|broadcasts)\/([A-Za-z0-9]+)/)
  if (m) return m[1]
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return s
  return null
}
async function audioSpaceById(spaceId, guestToken, cookie, csrf) {
  const variables = { id: spaceId, isMetatagsQuery: false, withReplays: true, withListeners: true }
  const features = {
    spaces_2022_h2_spaces_communities: true,
    spaces_2022_h2_clipping: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: false,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  }
  const headers = xHeaders(guestToken, cookie, csrf)
  let sawEmpty = false
  for (const qid of QUERY_IDS) {
    const url =
      `https://twitter.com/i/api/graphql/${qid}/AudioSpaceById?variables=` +
      encodeURIComponent(JSON.stringify(variables)) +
      '&features=' +
      encodeURIComponent(JSON.stringify(features))
    const r = await jsonFetch(url, { headers })
    const as = r.json?.data?.audioSpace
    // X returns an EMPTY object ({}) for guest/unauthenticated reads now — that's
    // not a real hit. Only accept it when it actually carries Space data.
    if (as && (as.metadata || as.participants)) return as
    if (as && Object.keys(as).length === 0) sawEmpty = true
  }
  // Signal "empty" distinctly so the caller can tell the user to add cookies,
  // rather than claiming the Space simply doesn't exist.
  return sawEmpty ? { __empty: true } : null
}
async function streamStatus(mediaKey, guestToken, cookie, csrf) {
  const headers = xHeaders(guestToken, cookie, csrf)
  const url = `https://twitter.com/i/api/1.1/live_video_stream/status/${mediaKey}?client=web&use_syndication_guest_id=false&cookie_set_host=x.com`
  const r = await jsonFetch(url, { headers })
  const src = r.json?.source
  return src?.noRedirectPlaybackUrl || src?.location || null
}

// ---- HLS parsing ------------------------------------------------------------

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).href
  } catch {
    return rel
  }
}
// From a master playlist, pick the HIGHEST-bitrate variant for best clarity.
function pickVariant(text, baseUrl) {
  const lines = text.split(/\r?\n/)
  let best = null
  let bestBw = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwm = lines[i].match(/BANDWIDTH=(\d+)/)
      const bw = bwm ? parseInt(bwm[1], 10) : 0
      for (let j = i + 1; j < lines.length; j++) {
        const u = lines[j].trim()
        if (u && !u.startsWith('#')) {
          if (bw > bestBw) {
            bestBw = bw
            best = resolveUrl(baseUrl, u)
          }
          break
        }
      }
    }
  }
  return best
}
function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/)
  const segments = []
  const durations = [] // seconds per segment, aligned 1:1 with `segments`
  let initUri = null
  let hasEndList = false
  let target = 3
  let pendingDur = 0
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('#EXT-X-MAP')) {
      const m = t.match(/URI="([^"]+)"/)
      if (m) initUri = resolveUrl(baseUrl, m[1])
    } else if (t.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true
    } else if (t.startsWith('#EXT-X-TARGETDURATION')) {
      const m = t.match(/:(\d+)/)
      if (m) target = parseInt(m[1], 10)
    } else if (t.startsWith('#EXTINF')) {
      const m = t.match(/#EXTINF:([\d.]+)/)
      if (m) pendingDur = parseFloat(m[1])
    } else if (!t.startsWith('#')) {
      segments.push(resolveUrl(baseUrl, t))
      durations.push(pendingDur > 0 ? pendingDur : target)
      pendingDur = 0
    }
  }
  return { segments, durations, initUri, hasEndList, target }
}
async function getMediaPlaylist(url, extra = {}) {
  const text = await fetchText(url, extra)
  // Guard: if X/CDN returns an error page or JSON instead of a playlist, parsing
  // it would yield 0 segments + no ENDLIST and loop forever. Fail loudly instead.
  if (!text.includes('#EXTM3U')) {
    throw new Error(
      'The audio URL did not return a playable stream (got: ' +
        text.trim().slice(0, 120).replace(/\s+/g, ' ') +
        '). The stream may be geo/login-restricted.'
    )
  }
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = pickVariant(text, url)
    if (!variant) throw new Error('No media variant found in master playlist.')
    const inner = await fetchText(variant, extra)
    return { url: variant, ...parseMedia(inner, variant) }
  }
  return { url, ...parseMedia(text, url) }
}
async function pool(items, worker, concurrency = 6) {
  const results = new Array(items.length)
  let idx = 0
  async function run() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

// Local ffmpeg step. enhance=true → normalize loudness & re-encode to a clean,
// consistent 192k AAC (audio-clarity assurance). enhance=false → fast stream copy.
function processLocal(inFile, outFile, enhance) {
  return new Promise((resolve) => {
    const args = enhance
      ? [
          '-y', '-i', inFile,
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=60,alimiter=limit=0.95',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
          outFile,
        ]
      : ['-y', '-i', inFile, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outFile]
    execFile(ffmpegPath, args, (err) =>
      resolve(!err && fs.existsSync(outFile) && fs.statSync(outFile).size > 0)
    )
  })
}

async function archiveInsert(job) {
  try {
    await dbQuery(
      `INSERT INTO recordings (id, name, title, source, kind, m3u8, file_path, size_bytes, duration_seconds, enhanced, state, access_mode, x_connection_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
       ON CONFLICT (id) DO UPDATE SET size_bytes=EXCLUDED.size_bytes, file_path=EXCLUDED.file_path, state=EXCLUDED.state, name=EXCLUDED.name, duration_seconds=EXCLUDED.duration_seconds`,
      [
        job.id, job.name, job.title || null, job.sourceKind || 'stream',
        job.kind, job.m3u8 || null, job.file, job.sizeBytes || 0,
        Math.round(job.recordedSecs || job.totalSecs || 0),
        !!job.enhance, 'ready', job.accessMode || 'public', job.xConnectionId || null,
      ]
    )
  } catch (e) {
    console.error('[space] archive insert failed:', e?.message || e)
  }
}

// Read the true audio duration (seconds) of a local file via ffmpeg. Used when a
// recording predates duration tracking, so the Clip Creator can validate ranges.
function probeDuration(file) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', file], (_err, _stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '')
      if (!m) return resolve(0)
      resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]))
    })
  })
}

// Extract a [start,end] interval from a source file into a fresh clip file. The
// source is only READ — never modified. Re-encodes to clean AAC so the cut is
// frame-accurate regardless of the source keyframes.
function extractClip(inFile, outFile, start, end, enhance) {
  return new Promise((resolve) => {
    const dur = Math.max(0.1, end - start)
    const args = ['-y', '-ss', String(start), '-i', inFile, '-t', String(dur)]
    if (enhance) {
      args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,highpass=f=60,alimiter=limit=0.95')
    }
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', outFile)
    execFile(ffmpegPath, args, (err) =>
      resolve(!err && fs.existsSync(outFile) && fs.statSync(outFile).size > 0)
    )
  })
}

// Find the on-disk audio file for a recording id (job cache or archive dir).
function recordingFile(id) {
  const job = jobs.get(id)
  if (job?.file && fs.existsSync(job.file)) return job.file
  for (const ext of ['.m4a', '.aac', '.raw']) {
    const p = path.join(DL_DIR, `${id}${ext}`)
    if (fs.existsSync(p)) return p
  }
  return null
}

// ---- the download job -------------------------------------------------------

async function runJob(job, m3u8) {
  const rawFile = path.join(DL_DIR, `${job.id}.raw`)
  const ws = fs.createWriteStream(rawFile)
  const writeBuf = (buf) => new Promise((res, rej) => ws.write(buf, (e) => (e ? rej(e) : res())))
  const MAX_LIVE_MS = 8 * 3600 * 1000 // hard cap so a forgotten live capture can't run forever
  const MAX_CONSEC_FAILS = 20 // ~ minutes of unreachable playlist => treat as ended
  // Authenticate CDN requests with the user's cookie when supplied — X audio is
  // often login-restricted and the raw segments 403 without it.
  const hdr = job.cookie ? { Cookie: job.cookie } : {}
  const log = (...a) => console.log(`[job ${job.id}]`, ...a)
  try {
    let media = await getMediaPlaylist(m3u8, hdr)
    log(`playlist ok · segments=${media.segments.length} endlist=${media.hasEndList} target=${media.target}s`)
    if (media.initUri) {
      try {
        await writeBuf(await fetchBufRetry(media.initUri, 3, hdr))
      } catch {}
    }
    const seen = new Set()
    const isLive = !media.hasEndList
    // Correct the label now that we know for sure (resolved live URLs aren't
    // always named "dynamic_playlist"). Enables the Stop button for live.
    job.kind = isLive ? 'live' : 'replay'
    job.gaps = 0
    job.recordedSecs = 0 // real audio duration captured so far (from EXTINF timings)
    // For a VOD/replay the total length is known up front; expose it so the UI
    // can say "3:12 of 41:00" and show a true percentage.
    if (!isLive) job.totalSecs = media.durations.reduce((a, b) => a + b, 0)

    // FAST PROBE: try the very first audio chunk (with retries, same tolerance
    // as the main loop). For a REPLAY, a first chunk that fails outright means
    // the audio is unreachable/login-restricted — surface that clearly instead
    // of writing an empty file. For a LIVE stream we NEVER hard-fail here: the
    // sliding window can momentarily lag, so we just log and let the normal
    // loop (and its 90s no-audio guard) decide.
    if (media.segments.length > 0) {
      try {
        const first = await fetchBufRetry(media.segments[0], 4, hdr)
        seen.add(media.segments[0])
        job.total += 1
        job.done += 1
        job.recordedSecs += media.durations[0] || 0
        await writeBuf(first)
        log(`first chunk ok · ${first.length} bytes`)
      } catch (e) {
        const why = String(e?.message || e)
        log(`first chunk failed · ${why}`)
        if (!isLive) {
          throw new Error(
            `Could not download the audio chunks (first chunk: ${why}). ` +
              (job.cookie
                ? 'Your connected X account session may be expired — reconnect it in Settings.'
                : 'This audio is login-restricted. Connect an X account in Settings and record with the Connected account access mode.')
          )
        }
        // live: leave segment[0] un-seen so the normal loop retries it.
      }
    }

    async function downloadNew(list, durs) {
      const freshIdx = []
      list.forEach((u, i) => {
        if (!seen.has(u)) {
          seen.add(u)
          freshIdx.push(i)
        }
      })
      job.total += freshIdx.length
      // Fetch with retry; a permanently-bad segment is skipped (counted as a
      // gap) instead of killing an entire multi-hour recording.
      const bufs = await pool(
        freshIdx,
        async (i) => {
          const u = list[i]
          try {
            const b = await fetchBufRetry(u, 3, hdr)
            job.done += 1
            job.recordedSecs += durs[i] || 0
            return b
          } catch (e) {
            job.gaps += 1
            job.done += 1
            job.recordedSecs += durs[i] || 0 // gap still spans that slice of time
            job.lastSegErr = String(e?.message || e)
            return null
          }
        },
        6
      )
      for (const b of bufs) if (b) await writeBuf(b)
    }

    await downloadNew(media.segments, media.durations)
    log(`initial batch done · done=${job.done} gaps=${job.gaps} recSec=${Math.round(job.recordedSecs)}`)

    let consecFails = 0
    let lastNewAt = Date.now()
    while (isLive && job.state === 'downloading') {
      if (Date.now() - job.startedAt > MAX_LIVE_MS) break // safety cap
      // Fast fail: if a "live" stream produced NO audio at all within 90s, it's
      // almost certainly login/geo-restricted or not really streaming — don't
      // spin forever, surface a clear error.
      if (job.done === 0 && Date.now() - job.startedAt > 90 * 1000) {
        throw new Error(
          'Connected to the live stream but received no audio in 90s — it is likely login-restricted. Connect an X account in Settings and record with the Connected account access mode.'
        )
      }
      await sleep(Math.max(2, media.target) * 1000)
      if (job.state !== 'downloading') break
      let next
      try {
        next = await getMediaPlaylist(media.url, hdr)
        consecFails = 0
      } catch {
        // playlist temporarily unreachable — retry, but give up after a while
        consecFails += 1
        if (consecFails >= MAX_CONSEC_FAILS) break
        continue
      }
      media = next
      const before = job.done
      await downloadNew(media.segments, media.durations)
      if (job.done > before) lastNewAt = Date.now()
      // If the Space ended, X marks the playlist ENDLIST.
      if (media.hasEndList) break
      // Or if no new audio has appeared for a long stretch, assume it ended.
      if (Date.now() - lastNewAt > 5 * 60 * 1000) break
    }
    await new Promise((res) => ws.end(res))
    if (job.done === 0) throw new Error('No audio segments were downloaded.')

    job.state = 'processing'
    const outFile = path.join(DL_DIR, `${job.id}.m4a`)
    const ok = await processLocal(rawFile, outFile, job.enhance)
    if (ok) {
      job.file = outFile
      job.name = job.baseName + '.m4a'
      try {
        fs.unlinkSync(rawFile)
      } catch {}
    } else {
      job.file = rawFile
      job.name = job.baseName + '.aac'
    }
    job.sizeBytes = fs.statSync(job.file).size
    job.state = 'ready'
    await archiveInsert(job)
    onJobTerminal(job)
  } catch (e) {
    try {
      ws.end()
    } catch {}
    // If we captured anything usable before erroring, still keep it.
    if (job.done > 0 && fs.existsSync(rawFile) && fs.statSync(rawFile).size > 0) {
      job.file = rawFile
      job.name = job.baseName + '.aac'
      job.sizeBytes = fs.statSync(rawFile).size
      job.state = 'ready'
      await archiveInsert(job)
      onJobTerminal(job)
    } else {
      job.state = 'error'
      job.error = String(e?.message || e)
      log(`ERROR · ${job.error}`)
      onJobTerminal(job)
    }
  }
}

// ---- routes -----------------------------------------------------------------

// Resolve the credentials for a request from its ACCESS MODE, never from raw
// cookies in the request body. This is the security boundary: the recording form
// only sends { accessMode, xConnectionId }; the actual secret material is loaded
// from the encrypted connection record server-side and decrypted here.
//   accessMode 'public'            → no credentials (guest access)
//   accessMode 'connected_account' → decrypt the named connection's session
// Returns { accessMode, cookie, csrf, connectionId, handle, error }.
async function credsForRequest(body = {}) {
  const accessMode = body.accessMode === 'connected_account' ? 'connected_account' : 'public'
  if (accessMode !== 'connected_account') {
    return { accessMode: 'public', cookie: null, csrf: null, connectionId: null }
  }
  const connId = body.xConnectionId
  if (!connId) {
    return { accessMode: 'public', cookie: null, csrf: null, connectionId: null, error: 'no-connection' }
  }
  let conn
  try {
    const { rows } = await dbQuery(
      'SELECT id, x_handle, status, encrypted_credentials, credential_key_version FROM x_connections WHERE id=$1',
      [connId]
    )
    conn = rows[0]
  } catch {
    return { accessMode: 'public', cookie: null, csrf: null, connectionId: null, error: 'lookup-failed' }
  }
  if (!conn || !conn.encrypted_credentials) {
    return { accessMode: 'public', cookie: null, csrf: null, connectionId: null, error: 'connection-unavailable' }
  }
  try {
    const creds = JSON.parse(await decryptSecret(conn.encrypted_credentials, conn.credential_key_version))
    return {
      accessMode: 'connected_account',
      cookie: creds.cookie || null,
      csrf: creds.csrf || null,
      connectionId: conn.id,
      handle: conn.x_handle || null,
      status: conn.status,
    }
  } catch {
    return { accessMode: 'public', cookie: null, csrf: null, connectionId: null, error: 'decrypt-failed' }
  }
}

async function markConnectionUsed(id) {
  if (!id) return
  try {
    await dbQuery('UPDATE x_connections SET last_used_at=NOW(), updated_at=NOW() WHERE id=$1', [id])
  } catch {}
}

// Shared resolution used by both /resolve and the auto-capture monitor.
async function resolveSpaceCore({ input, cookie, csrf }) {
  const spaceId = parseSpaceId(input)
  if (!spaceId) return { ok: false, reason: 'Could not read a Space ID from that link.' }
  const guestToken = await getGuestToken()
  if (!guestToken) return { ok: false, reason: 'Could not obtain a guest token from X.' }
  const space = await audioSpaceById(spaceId, guestToken, cookie, csrf)
  if (!space || space.__empty) {
    return {
      ok: false,
      reason:
        "X returned no data for this Space. That usually means the ID is wrong or the Space no longer exists. Double-check the link. If you're sure it's valid and currently live/recorded, try again in a moment, or connect an X account in Settings and use the Connected account access mode.",
    }
  }
  const meta = space.metadata || {}
  const title = meta.title || 'X Space'
  const state = meta.state
  const live = !!(state && String(state).toLowerCase() === 'running')
  if (!meta.media_key) {
    return {
      ok: false,
      title,
      state,
      live,
      reason: live
        ? "This Space is live but X hasn't exposed its audio stream yet — retrying…"
        : 'This Space has no downloadable recording (the host did not record it, so no audio was ever stored).',
    }
  }
  const m3u8 = await streamStatus(meta.media_key, guestToken, cookie, csrf)
  if (!m3u8) {
    return {
      ok: false,
      title,
      state,
      live,
      reason: 'Found the Space but not its audio stream — connect an X account in Settings and use the Connected account access mode.',
    }
  }
  return { ok: true, m3u8, title, state, live }
}

// Create + start a download job. Returns the job (or null if at capacity).
function createJob({ m3u8, name, enhance, title, source, input, cookie, csrf, groupId, role, accessMode, xConnectionId }) {
  if (activeCount() >= MAX_ACTIVE) return null
  const id = Math.random().toString(36).slice(2, 10)
  const baseName = (name && String(name).replace(/[^\w.-]+/g, '_').slice(0, 80)) || `x_space_${id}`
  const isLive = /dynamic_playlist|type=live/i.test(m3u8)
  const job = {
    id,
    state: 'downloading',
    done: 0,
    total: 0,
    gaps: 0,
    sizeBytes: 0,
    error: null,
    file: null,
    baseName,
    name: baseName + '.m4a',
    title: title || null,
    m3u8,
    enhance: enhance !== false, // clarity on by default
    sourceKind: source || 'stream',
    startedAt: Date.now(),
    kind: isLive ? 'live' : 'replay',
    // --- backup grouping: lets us re-fetch the whole Space after it ends ---
    input: input || null, // original Space link/ID so we can re-resolve later
    cookie: cookie || null, // decrypted in-memory only; never persisted or returned
    csrf: csrf || null,
    accessMode: accessMode || 'public', // audit trail: how this was resolved
    xConnectionId: xConnectionId || null,
    groupId: groupId || id, // live + its completion-backup share one groupId
    role: role || 'live', // 'live' | 'backup'
    backup: null, // null | pending | recording | kept-live | kept-replay | unavailable
    backupStarted: false,
  }
  jobs.set(id, job)
  runJob(job, m3u8)
  return job
}

// After a Space recording finishes, X usually publishes a complete replay. Grab
// it as a backup so we always end up with the most complete copy, even if the
// live capture had gaps or started late.
function maybeStartBackup(job) {
  if (job.role === 'backup') return // don't back up a backup
  if (job.backupStarted) return
  if (!job.input) return // manual .m3u8 jobs can't be re-resolved
  job.backupStarted = true
  job.backup = 'pending'
  runBackup(job)
}

async function runBackup(liveJob) {
  try {
    // The replay may take a little while to appear after the Space ends — poll.
    let m3u8 = null
    let title = liveJob.title
    for (let i = 0; i < 40 && !m3u8; i++) {
      if (jobs.get(liveJob.id) !== liveJob) return // live job was cleaned up
      try {
        const r = await resolveSpaceCore({
          input: liveJob.input,
          cookie: liveJob.cookie,
          csrf: liveJob.csrf,
        })
        if (r.ok && r.m3u8) {
          m3u8 = r.m3u8
          if (r.title) title = r.title
        }
      } catch {}
      if (!m3u8) await sleep(15000)
    }
    if (!m3u8) {
      liveJob.backup = 'unavailable'
      return
    }
    // Wait for a free slot if we're at capacity.
    let waited = 0
    while (activeCount() >= MAX_ACTIVE && waited < 120) {
      await sleep(2000)
      waited++
    }
    const bjob = createJob({
      m3u8,
      name: liveJob.baseName,
      enhance: liveJob.enhance,
      title,
      source: 'backup',
      input: liveJob.input,
      cookie: liveJob.cookie,
      csrf: liveJob.csrf,
      accessMode: liveJob.accessMode,
      xConnectionId: liveJob.xConnectionId,
      groupId: liveJob.groupId,
      role: 'backup',
    })
    if (!bjob) {
      liveJob.backup = 'unavailable'
      return
    }
    bjob.parentId = liveJob.id
    liveJob.backup = 'recording'
  } catch {
    liveJob.backup = 'unavailable'
  }
}

// When both the live capture and its replay backup have finished, keep the more
// complete one. The LIVE job id stays canonical (the UI is polling it), so if
// the replay wins we move its file onto the live id and drop the backup record.
async function reconcileGroup(backupJob) {
  const live = [...jobs.values()].find(
    (j) => j.groupId === backupJob.groupId && j.role === 'live'
  )
  if (!live) return
  const liveScore = live.state === 'ready' ? live.recordedSecs || 0 : -1
  const backupScore = backupJob.state === 'ready' ? backupJob.recordedSecs || 0 : -1

  if (backupScore > liveScore) {
    // Replay is more complete → promote it to the canonical (live) id.
    try {
      const ext = path.extname(backupJob.file || '.m4a') || '.m4a'
      const newPath = path.join(DL_DIR, `${live.id}${ext}`)
      if (live.file && fs.existsSync(live.file) && live.file !== newPath) {
        try {
          fs.unlinkSync(live.file)
        } catch {}
      }
      if (backupJob.file && fs.existsSync(backupJob.file)) fs.renameSync(backupJob.file, newPath)
      live.file = newPath
      live.recordedSecs = backupJob.recordedSecs
      live.totalSecs = backupJob.totalSecs
      live.sizeBytes = fs.existsSync(newPath) ? fs.statSync(newPath).size : live.sizeBytes
      live.name = live.baseName + ext
      live.kind = 'replay'
      live.state = 'ready'
      await archiveInsert(live)
    } catch {}
    live.backup = 'kept-replay'
  } else {
    if (backupJob.file && fs.existsSync(backupJob.file)) {
      try {
        fs.unlinkSync(backupJob.file)
      } catch {}
    }
    live.backup = 'kept-live'
  }
  // Drop the backup's own record — the live id is the single kept copy.
  try {
    await dbQuery('DELETE FROM recordings WHERE id = $1', [backupJob.id])
  } catch {}
  jobs.delete(backupJob.id)
}

function onJobTerminal(job) {
  if (job.role === 'backup') reconcileGroup(job)
  else maybeStartBackup(job)
}

router.post('/resolve', async (req, res) => {
  try {
    const creds = await credsForRequest(req.body || {})
    const r = await resolveSpaceCore({ input: (req.body || {}).input, cookie: creds.cookie, csrf: creds.csrf })
    if (r.ok && creds.connectionId) markConnectionUsed(creds.connectionId)
    return res.json({ ...r, accessMode: creds.accessMode, xConnectionId: creds.connectionId || null })
  } catch (e) {
    return res.json({ ok: false, reason: String(e?.message || e) })
  }
})

// Step-by-step diagnostics so a user can see EXACTLY where resolution fails
// (guest token? space lookup? stream URL?) instead of a single opaque message.
router.post('/diagnose', async (req, res) => {
  const { input } = req.body || {}
  const creds = await credsForRequest(req.body || {})
  const cookie = creds.cookie
  const csrf = creds.csrf
  const steps = []
  const add = (name, ok, detail) => steps.push({ name, ok, detail })
  try {
    const spaceId = parseSpaceId(input)
    add('Read Space ID from link', !!spaceId, spaceId || 'Could not find a Space ID in that text.')
    if (!spaceId) return res.json({ ok: false, steps })

    const guestToken = await getGuestToken()
    add('Get guest token from X', !!guestToken, guestToken ? 'ok' : 'X did not return a guest token.')
    if (!guestToken) return res.json({ ok: false, steps })

    add(
      'Access mode',
      true,
      creds.accessMode === 'connected_account'
        ? `Connected X account${creds.handle ? ' (@' + creds.handle + ')' : ''} — using its authorized access.`
        : creds.error
        ? `Public access (the selected connection was unavailable: ${creds.error}).`
        : 'Public access — no account connected (fine for most public Spaces).'
    )

    // Direct call so we can surface X's real HTTP status + error message.
    const dbgVars = { id: spaceId, isMetatagsQuery: false, withReplays: true, withListeners: true }
    const dbgFeat = {
      spaces_2022_h2_spaces_communities: true, spaces_2022_h2_clipping: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: false,
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    }
    const dbgUrl =
      `https://twitter.com/i/api/graphql/${QUERY_IDS[0]}/AudioSpaceById?variables=` +
      encodeURIComponent(JSON.stringify(dbgVars)) + '&features=' + encodeURIComponent(JSON.stringify(dbgFeat))
    const raw = await jsonFetch(dbgUrl, { headers: xHeaders(guestToken, cookie, csrf) })
    const xMsg = raw.json?.errors?.[0]?.message || raw.json?.message
    add('X responded to the request', raw.status >= 200 && raw.status < 300,
      `HTTP ${raw.status}${xMsg ? ' · X says: ' + xMsg : ''}`)

    const space = await audioSpaceById(spaceId, guestToken, cookie, csrf)
    if (!space || space.__empty) {
      add(
        'Look up the Space',
        false,
        space?.__empty
          ? 'X returned an EMPTY record — the Space ID is likely wrong or the Space no longer exists. Verify the link. (Connecting an X account in Settings can help as a fallback.)'
          : 'X returned nothing (Space may not exist, or the query is blocked).'
      )
      return res.json({ ok: false, steps })
    }
    const meta = space.metadata || {}
    add('Look up the Space', true, `title: ${meta.title || '(untitled)'} · state: ${meta.state || '?'}`)
    add('Space has audio (media_key)', !!meta.media_key, meta.media_key ? 'yes' : 'no audio was ever recorded for this Space')
    if (!meta.media_key) return res.json({ ok: false, steps })

    const m3u8 = await streamStatus(meta.media_key, guestToken, cookie, csrf)
    add('Get the audio stream URL', !!m3u8, m3u8 ? m3u8.slice(0, 80) + '…' : 'X did not return a playback URL (try connecting/reconnecting an X account in Settings).')
    if (!m3u8) return res.json({ ok: false, steps })

    // Confirm the playlist is actually fetchable from the server.
    const dhdr = cookie ? { Cookie: cookie } : {}
    let media = null
    try {
      media = await getMediaPlaylist(m3u8, dhdr)
      add('Download the playlist', true, `ok — ${media.segments.length} audio chunk(s) listed${media.hasEndList ? ' (complete replay)' : ' (live)'}`)
    } catch (e) {
      add('Download the playlist', false, 'The stream URL was returned but the playlist could not be fetched: ' + String(e?.message || e))
      return res.json({ ok: false, steps, m3u8 })
    }

    // The real test: can we actually pull an AUDIO chunk? This is where
    // login-restricted Spaces fail even though everything above succeeded.
    if (media.segments.length === 0) {
      add('Download an audio chunk', false, 'The playlist contained no audio chunks yet.')
      return res.json({ ok: false, steps, m3u8 })
    }
    let chunkOk = false
    try {
      const b = await fetchBuf(media.segments[0], dhdr)
      chunkOk = b && b.length > 0
      add('Download an audio chunk', chunkOk, chunkOk ? `ok — got ${b.length} bytes. Recording will work.` : 'The chunk came back empty.')
    } catch (e) {
      add('Download an audio chunk', false, `Failed: ${String(e?.message || e)}. The audio is login-restricted — connect an X account in Settings and use the Connected account access mode.`)
    }

    return res.json({ ok: chunkOk, steps, m3u8 })
  } catch (e) {
    add('Unexpected error', false, String(e?.message || e))
    return res.json({ ok: false, steps })
  }
})

// Auto-capture monitor: keep polling until the Space is reachable, then start
// recording automatically. Ideal for non-recorded / not-yet-started Spaces
// where you must catch the LIVE stream and don't want to miss the opening.
router.post('/monitor', async (req, res) => {
  const { input, name, enhance } = req.body || {}
  if (!parseSpaceId(input)) {
    return res.status(400).json({ error: 'A valid X Space link or ID is required.' })
  }
  const creds = await credsForRequest(req.body || {})
  const cookie = creds.cookie
  const csrf = creds.csrf
  const accessMode = creds.accessMode
  const xConnectionId = creds.connectionId
  const id = 'm' + Math.random().toString(36).slice(2, 9)
  const intervalMs = 15000
  const maxAttempts = 480 // ~2 hours of watching before giving up
  const mon = {
    id,
    state: 'watching', // watching | recording | ended | error | cancelled
    attempts: 0,
    maxAttempts,
    lastReason: 'Waiting for the Space to go live…',
    jobId: null,
    title: null,
    startedAt: Date.now(),
  }
  monitors.set(id, mon)

  ;(async () => {
    while (mon.state === 'watching') {
      mon.attempts += 1
      let r
      try {
        r = await resolveSpaceCore({ input, cookie, csrf })
      } catch (e) {
        r = { ok: false, reason: String(e?.message || e) }
      }
      if (mon.state !== 'watching') break
      if (r.title) mon.title = r.title
      if (r.ok) {
        // Wait for a free slot if we're at capacity.
        let waited = 0
        while (activeCount() >= MAX_ACTIVE && mon.state === 'watching' && waited < 60) {
          await sleep(2000)
          waited++
        }
        const job = createJob({
          m3u8: r.m3u8,
          name,
          enhance,
          title: r.title,
          source: 'monitor',
          input,
          cookie,
          csrf,
          accessMode,
          xConnectionId,
          role: 'live',
        })
        if (job) {
          mon.jobId = job.id
          mon.state = 'recording'
          mon.lastReason = 'Stream found — recording started.'
          if (xConnectionId) markConnectionUsed(xConnectionId)
          return
        }
        mon.lastReason = 'Stream found but downloader is busy; retrying…'
      } else {
        mon.lastReason = r.reason || 'Not available yet…'
      }
      if (mon.attempts >= mon.maxAttempts) {
        mon.state = 'error'
        mon.lastReason = `Gave up after ${mon.attempts} checks. The Space never became reachable.`
        return
      }
      await sleep(intervalMs)
    }
  })()

  res.json({ id, state: mon.state })
})

router.get('/monitor/:id', (req, res) => {
  const mon = monitors.get(req.params.id)
  if (!mon) return res.status(404).json({ error: 'Monitor not found' })
  res.json({
    id: mon.id,
    state: mon.state,
    attempts: mon.attempts,
    maxAttempts: mon.maxAttempts,
    lastReason: mon.lastReason,
    jobId: mon.jobId,
    title: mon.title,
    elapsedMs: Date.now() - mon.startedAt,
  })
})

router.post('/monitor/:id/cancel', (req, res) => {
  const mon = monitors.get(req.params.id)
  if (!mon) return res.status(404).json({ error: 'Monitor not found' })
  if (mon.state === 'watching') {
    mon.state = 'cancelled'
    mon.lastReason = 'Cancelled.'
  }
  res.json({ ok: true })
})

router.post('/download', async (req, res) => {
  const { m3u8, name, enhance, title, source, input } = req.body || {}
  if (!m3u8 || !/^https?:\/\//i.test(m3u8)) {
    return res.status(400).json({ error: 'A valid https stream URL (.m3u8) is required.' })
  }
  const creds = await credsForRequest(req.body || {})
  const job = createJob({
    m3u8, name, enhance, title, source, input,
    cookie: creds.cookie, csrf: creds.csrf,
    accessMode: creds.accessMode, xConnectionId: creds.connectionId,
    role: 'live',
  })
  if (!job) {
    return res
      .status(429)
      .json({ error: `Too many downloads running at once (max ${MAX_ACTIVE}). Please wait for one to finish.` })
  }
  if (creds.connectionId) markConnectionUsed(creds.connectionId)
  res.json({ id: job.id, kind: job.kind, enhance: job.enhance, accessMode: job.accessMode })
})

router.post('/stop/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  if (job.state === 'downloading') job.state = 'stopped'
  res.json({ ok: true })
})

router.get('/status/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  const { id, state, done, total, gaps, sizeBytes, error, name, kind, startedAt, enhance,
    recordedSecs, totalSecs, groupId, role, backup } = job
  res.json({
    id, state, done, total, gaps, sizeBytes, error, name, kind, enhance,
    recordedSecs: recordedSecs || 0,
    totalSecs: totalSecs || 0,
    groupId, role, backup: backup || null,
    elapsedMs: Date.now() - startedAt,
    ready: state === 'ready',
  })
})

// Persistent archive list (auto-archive verification lives here).
router.get('/archive', async (_req, res) => {
  try {
    const { rows } = await dbQuery(
      'SELECT id, name, title, kind, source, size_bytes, duration_seconds, enhanced, access_mode, x_connection_id, created_at FROM recordings ORDER BY created_at DESC'
    )
    const withExist = rows.map((r) => ({
      ...r,
      available: (() => {
        // file may be .m4a or .aac
        const p1 = path.join(DL_DIR, `${r.id}.m4a`)
        const p2 = path.join(DL_DIR, `${r.id}.raw`)
        return fs.existsSync(p1) || fs.existsSync(p2)
      })(),
    }))
    res.json(withExist)
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

router.delete('/archive/:id', async (req, res) => {
  const id = req.params.id
  try {
    for (const ext of ['.m4a', '.aac', '.raw']) {
      const p = path.join(DL_DIR, `${id}${ext}`)
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p)
        } catch {}
      }
    }
    jobs.delete(id)
    await dbQuery('DELETE FROM recordings WHERE id = $1', [id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

// Sniff the audio container from the first bytes so the browser gets the right
// content-type: fragmented MP4 (starts with a `ftyp` box) vs raw ADTS AAC.
function sniffAudioType(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(12)
    fs.readSync(fd, buf, 0, 12, 0)
    fs.closeSync(fd)
    if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4'
    if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) return 'audio/aac'
  } catch {}
  return 'audio/aac'
}

// Serve a file (even one still being written) with HTTP Range support so an
// <audio> element can stream + seek it. Used for live "listen so far" preview.
function serveWithRange(req, res, file, contentType) {
  let size
  try {
    size = fs.statSync(file).size
  } catch {
    return res.status(404).json({ error: 'File not found' })
  }
  if (size === 0) return res.status(404).json({ error: 'Nothing captured yet' })
  res.setHeader('Content-Type', contentType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    const start = m ? parseInt(m[1], 10) : 0
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    if (start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`)
      return res.status(416).end()
    }
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', end - start + 1)
    fs.createReadStream(file, { start, end }).pipe(res)
  } else {
    res.setHeader('Content-Length', size)
    fs.createReadStream(file).pipe(res)
  }
}

// In-browser playback — works WHILE recording (plays whatever is captured so
// far) and after it's done. Prefers the finished file, falls back to the raw
// in-progress capture.
router.get('/preview/:id', (req, res) => {
  const id = req.params.id
  const job = jobs.get(id)
  const candidates = []
  if (job?.file) candidates.push(job.file)
  candidates.push(
    path.join(DL_DIR, `${id}.m4a`),
    path.join(DL_DIR, `${id}.aac`),
    path.join(DL_DIR, `${id}.raw`)
  )
  const file = candidates.find((p) => p && fs.existsSync(p))
  if (!file) return res.status(404).json({ error: 'Nothing captured yet' })
  const type = file.endsWith('.m4a') ? 'audio/mp4' : sniffAudioType(file)
  serveWithRange(req, res, file, type)
})

router.get('/file/:id', async (req, res) => {
  const id = req.params.id
  const job = jobs.get(id)
  let file = job?.file
  let name = job?.name
  if (!file) {
    // fall back to the persistent archive
    for (const ext of ['.m4a', '.aac']) {
      const p = path.join(DL_DIR, `${id}${ext}`)
      if (fs.existsSync(p)) {
        file = p
        break
      }
    }
    if (file) {
      try {
        const { rows } = await dbQuery('SELECT name FROM recordings WHERE id = $1', [id])
        name = rows[0]?.name || path.basename(file)
      } catch {
        name = path.basename(file)
      }
    }
  }
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' })
  res.download(file, name)
})

// ---- Clip Creator ----------------------------------------------------------
// Clips are derived cuts from a completed recording. The ORIGINAL is never
// modified — each clip is a distinct file that references its parent recording.

const MIN_CLIP_SECS = 1
const MAX_CLIP_SECS = 4 * 3600

// Get a recording's true duration: prefer the stored value, fall back to probing
// the file (covers recordings made before duration tracking existed).
async function recordingDuration(id) {
  try {
    const { rows } = await dbQuery('SELECT duration_seconds FROM recordings WHERE id = $1', [id])
    const stored = Number(rows[0]?.duration_seconds || 0)
    if (stored > 0) return stored
  } catch {}
  const file = recordingFile(id)
  if (!file) return 0
  const probed = await probeDuration(file)
  if (probed > 0) {
    try {
      await dbQuery('UPDATE recordings SET duration_seconds = $1 WHERE id = $2', [Math.round(probed), id])
    } catch {}
  }
  return probed
}

// How long is the source recording? (used by the clip UI to validate ranges)
router.get('/recordings/:id/duration', async (req, res) => {
  const dur = await recordingDuration(req.params.id)
  if (!dur) return res.status(404).json({ error: 'Recording not found or has no audio.' })
  res.json({ id: req.params.id, duration_seconds: dur })
})

// Create a clip from a recording. Body: { title, start_seconds, end_seconds, enhance }
router.post('/recordings/:id/clips', async (req, res) => {
  const parentId = req.params.id
  const { title, start_seconds, end_seconds, enhance } = req.body || {}
  const start = Number(start_seconds)
  const end = Number(end_seconds)
  const srcFile = recordingFile(parentId)
  if (!srcFile) return res.status(404).json({ error: 'The source recording is unavailable or has been deleted.' })
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0)
    return res.status(400).json({ error: 'Enter valid start and end timestamps.' })
  if (start >= end) return res.status(400).json({ error: 'The start time must be earlier than the end time.' })
  const dur = await recordingDuration(parentId)
  if (dur && end > dur + 1)
    return res.status(400).json({ error: `The end time is past the recording length (${Math.floor(dur)}s).` })
  const clipDur = end - start
  if (clipDur < MIN_CLIP_SECS) return res.status(400).json({ error: `Clips must be at least ${MIN_CLIP_SECS}s long.` })
  if (clipDur > MAX_CLIP_SECS) return res.status(400).json({ error: 'That clip is too long.' })

  const id = 'c' + Math.random().toString(36).slice(2, 10)
  const doEnhance = enhance !== false
  const outFile = path.join(DL_DIR, `${id}.m4a`)
  const clipTitle = (title && String(title).trim().slice(0, 200)) || 'Clip'
  try {
    await dbQuery(
      `INSERT INTO clips (id, parent_recording_id, title, start_seconds, end_seconds, duration_seconds, status, format, size_bytes, enhanced, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'rendering','m4a',0,$7, NOW())`,
      [id, parentId, clipTitle, start, end, clipDur, doEnhance]
    )
  } catch (e) {
    return res.status(500).json({ error: 'Could not start the clip: ' + String(e?.message || e) })
  }

  const ok = await extractClip(srcFile, outFile, start, end, doEnhance)
  if (!ok) {
    try { await dbQuery("UPDATE clips SET status='failed' WHERE id=$1", [id]) } catch {}
    return res.status(500).json({ error: 'Rendering the clip failed. Try a slightly different range.' })
  }
  const size = fs.statSync(outFile).size
  try {
    await dbQuery("UPDATE clips SET status='completed', size_bytes=$1 WHERE id=$2", [size, id])
  } catch {}
  res.json({ id, status: 'completed', size_bytes: size, duration_seconds: clipDur, title: clipTitle })
})

// Clips for one recording (the recording's "Clips" tab).
router.get('/recordings/:id/clips', async (req, res) => {
  try {
    const { rows } = await dbQuery(
      'SELECT * FROM clips WHERE parent_recording_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    )
    res.json(rows.map((r) => ({ ...r, available: fs.existsSync(path.join(DL_DIR, `${r.id}.m4a`)) })))
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

// The whole Clips library (with parent Space title for attribution).
router.get('/clips', async (_req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT c.*, r.title AS parent_title, r.name AS parent_name
       FROM clips c LEFT JOIN recordings r ON r.id = c.parent_recording_id
       ORDER BY c.created_at DESC`
    )
    res.json(rows.map((r) => ({ ...r, available: fs.existsSync(path.join(DL_DIR, `${r.id}.m4a`)) })))
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

router.delete('/clips/:id', async (req, res) => {
  const id = req.params.id
  try {
    const p = path.join(DL_DIR, `${id}.m4a`)
    if (fs.existsSync(p)) { try { fs.unlinkSync(p) } catch {} }
    await dbQuery('DELETE FROM clips WHERE id = $1', [id])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

// Play / download a clip file.
router.get('/clip/:id/file', async (req, res) => {
  const id = req.params.id
  const file = path.join(DL_DIR, `${id}.m4a`)
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Clip file not found' })
  let name = `${id}.m4a`
  try {
    const { rows } = await dbQuery('SELECT title FROM clips WHERE id = $1', [id])
    if (rows[0]?.title) name = String(rows[0].title).replace(/[^\w.-]+/g, '_').slice(0, 80) + '.m4a'
  } catch {}
  if (req.query.play) return serveWithRange(req, res, file, 'audio/mp4')
  res.download(file, name)
})

module.exports = router
