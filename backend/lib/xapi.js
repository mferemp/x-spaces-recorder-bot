// Minimal shared X (Twitter) API helpers used by both the recorder and the
// account-connection validator. Kept dependency-free (Node https only).
const https = require('https')

const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function jsonFetch(url, opts = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: opts.method || 'GET', headers: opts.headers || {}, timeout: 15000 },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(data)
          } catch {}
          resolve({ status: res.statusCode, json, raw: data })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e) }))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

// Pull ct0 (csrf) out of a cookie string if a separate value wasn't supplied.
function csrfFrom(cookie, csrf) {
  if (csrf) return csrf
  const m = String(cookie || '').match(/ct0=([^;]+)/)
  return m ? m[1] : ''
}

// Validate an authenticated browser session by asking X who the caller is.
// Returns { ok, handle, name, id } on success, or { ok:false, status, reason }.
async function verifySession(cookie, csrf) {
  const token = csrfFrom(cookie, csrf)
  if (!cookie || !/auth_token=/.test(cookie)) {
    return { ok: false, status: 0, reason: 'The session must include an auth_token cookie.' }
  }
  if (!token) {
    return { ok: false, status: 0, reason: 'The session must include a ct0 (csrf) value.' }
  }
  const r = await jsonFetch('https://api.twitter.com/1.1/account/verify_credentials.json', {
    headers: {
      Authorization: `Bearer ${BEARER}`,
      'User-Agent': UA,
      Cookie: cookie,
      'x-csrf-token': token,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      Accept: '*/*',
    },
  })
  if (r.status >= 200 && r.status < 300 && r.json?.screen_name) {
    return {
      ok: true,
      handle: r.json.screen_name,
      name: r.json.name || r.json.screen_name,
      id: String(r.json.id_str || r.json.id || ''),
      avatar: r.json.profile_image_url_https || null,
    }
  }
  const xMsg = r.json?.errors?.[0]?.message || r.json?.message
  return {
    ok: false,
    status: r.status,
    reason: xMsg || `X rejected the session (HTTP ${r.status}). The cookies may be expired.`,
  }
}

module.exports = { BEARER, UA, jsonFetch, csrfFrom, verifySession }
