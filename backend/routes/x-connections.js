// X Account Connections — the secure, explicit account-linking feature.
//
// Credentials are NEVER accepted in the recording form or returned to the
// browser. They are validated against X, encrypted at rest (AES-256-GCM), and
// only decrypted server-side when the owner selects the connection for a job.
//
// Scope note: this is a single-user studio, so every connection is scoped to a
// local workspace/user. The table carries workspace_id/user_id so multi-tenant
// RBAC can be layered on later without a migration.

const { Router } = require('express')
const { dbQuery } = require('../lib/db')
const { encryptSecret } = require('../lib/secretbox')
const { verifySession } = require('../lib/xapi')

const router = Router()

const WORKSPACE = 'local'
const USER = 'local'

// Shape returned to the frontend — NEVER includes encrypted_credentials or any
// raw secret material.
function publicConn(row) {
  if (!row) return null
  return {
    id: row.id,
    x_account_id: row.x_account_id || null,
    x_handle: row.x_handle || null,
    display_name: row.display_name || null,
    avatar_url: row.avatar_url || null,
    auth_type: row.auth_type || 'session',
    status: row.status || 'pending',
    granted_scopes: row.granted_scopes || null,
    connected_at: row.connected_at || null,
    last_validated_at: row.last_validated_at || null,
    last_used_at: row.last_used_at || null,
    expires_at: row.expires_at || null,
    revoked_at: row.revoked_at || null,
    created_at: row.created_at || null,
    // Security posture flags so the UI can reassure the user.
    encrypted: true,
    key_managed: !!process.env.X_CONN_ENC_KEY,
  }
}

function audit(event, conn) {
  // Deliberately logs only non-secret metadata.
  console.log(
    `[x-connections] ${event} · id=${conn?.id || '?'} handle=@${conn?.x_handle || '?'} status=${conn?.status || '?'}`
  )
}

// OAuth entry point. If a supported X OAuth app is configured, this would return
// an authorization URL. It isn't wired up in this environment, so we tell the
// client to use the authenticated-session connector instead.
router.post('/start', (_req, res) => {
  res.json({
    ok: false,
    oauth_available: false,
    supported_auth_types: ['session'],
    reason:
      'OAuth with X is not configured in this deployment. Connect using an authenticated session under Settings instead.',
  })
})

// Complete a connection with an authenticated session (auth_type: 'session').
// Body: { auth_type, cookie, csrf, consent }
router.post('/complete', async (req, res) => {
  const { auth_type = 'session', cookie, csrf, consent } = req.body || {}
  if (auth_type !== 'session') {
    return res.status(400).json({ error: 'Unsupported connection type in this deployment.' })
  }
  if (consent !== true) {
    return res
      .status(400)
      .json({ error: 'You must confirm you own/are authorized to connect this account.' })
  }
  if (!cookie || typeof cookie !== 'string') {
    return res.status(400).json({ error: 'An authenticated session (cookie header) is required.' })
  }

  // Validate the session against X BEFORE storing anything.
  let who
  try {
    who = await verifySession(cookie, csrf)
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach X to validate the session.' })
  }
  if (!who.ok) {
    return res.status(400).json({ error: who.reason })
  }

  // Encrypt the minimum secret material needed (cookie + csrf) as one blob.
  const { ciphertext, keyVersion } = await encryptSecret(
    JSON.stringify({ cookie, csrf: csrf || null })
  )

  // One connection per X account within a workspace: update in place if it
  // already exists, else insert.
  const { rows: existing } = await dbQuery(
    'SELECT id FROM x_connections WHERE workspace_id=$1 AND x_account_id=$2 LIMIT 1',
    [WORKSPACE, who.id]
  )
  const id = existing[0]?.id || 'x' + Math.random().toString(36).slice(2, 11)

  const params = [
    id, WORKSPACE, USER, who.id, who.handle, who.name, who.avatar || null,
    'session', ciphertext, keyVersion, 'active', 'read:spaces (session)',
  ]
  await dbQuery(
    `INSERT INTO x_connections
       (id, workspace_id, user_id, x_account_id, x_handle, display_name, avatar_url,
        auth_type, encrypted_credentials, credential_key_version, status, granted_scopes,
        connected_at, last_validated_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW(), NOW(), NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET
       x_handle=EXCLUDED.x_handle, display_name=EXCLUDED.display_name, avatar_url=EXCLUDED.avatar_url,
       auth_type=EXCLUDED.auth_type, encrypted_credentials=EXCLUDED.encrypted_credentials,
       credential_key_version=EXCLUDED.credential_key_version, status='active',
       granted_scopes=EXCLUDED.granted_scopes, last_validated_at=NOW(), revoked_at=NULL, updated_at=NOW()`,
    params
  )

  const { rows } = await dbQuery('SELECT * FROM x_connections WHERE id=$1', [id])
  audit(existing[0] ? 'reconnected' : 'connected', rows[0])
  res.json({ ok: true, connection: publicConn(rows[0]) })
})

// List connections (redacted).
router.get('/', async (_req, res) => {
  try {
    const { rows } = await dbQuery(
      "SELECT * FROM x_connections WHERE workspace_id=$1 AND status <> 'disconnected' ORDER BY created_at DESC",
      [WORKSPACE]
    )
    res.json(rows.map(publicConn))
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

router.get('/:id', async (req, res) => {
  const { rows } = await dbQuery('SELECT * FROM x_connections WHERE id=$1 AND workspace_id=$2', [
    req.params.id,
    WORKSPACE,
  ])
  if (!rows[0]) return res.status(404).json({ error: 'Connection not found' })
  res.json(publicConn(rows[0]))
})

// Re-check the stored session against X and update status.
router.post('/:id/validate', async (req, res) => {
  const { decryptSecret } = require('../lib/secretbox')
  const { rows } = await dbQuery('SELECT * FROM x_connections WHERE id=$1 AND workspace_id=$2', [
    req.params.id,
    WORKSPACE,
  ])
  const conn = rows[0]
  if (!conn) return res.status(404).json({ error: 'Connection not found' })
  let creds
  try {
    creds = JSON.parse(await decryptSecret(conn.encrypted_credentials, conn.credential_key_version))
  } catch {
    await dbQuery("UPDATE x_connections SET status='invalid', updated_at=NOW() WHERE id=$1", [conn.id])
    return res.json({ ok: false, status: 'invalid', reason: 'Stored credentials could not be read.' })
  }
  const who = await verifySession(creds.cookie, creds.csrf)
  const status = who.ok ? 'active' : 'reauth_required'
  await dbQuery(
    'UPDATE x_connections SET status=$1, last_validated_at=NOW(), updated_at=NOW() WHERE id=$2',
    [status, conn.id]
  )
  const { rows: fresh } = await dbQuery('SELECT * FROM x_connections WHERE id=$1', [conn.id])
  audit('validated', fresh[0])
  res.json({ ok: who.ok, status, reason: who.ok ? null : who.reason, connection: publicConn(fresh[0]) })
})

// Reconnect = supply a fresh session for an existing connection.
router.post('/:id/reconnect', async (req, res) => {
  const { cookie, csrf, consent } = req.body || {}
  if (consent !== true) return res.status(400).json({ error: 'Confirmation is required to reconnect.' })
  if (!cookie) return res.status(400).json({ error: 'A fresh authenticated session is required.' })
  const { rows } = await dbQuery('SELECT * FROM x_connections WHERE id=$1 AND workspace_id=$2', [
    req.params.id,
    WORKSPACE,
  ])
  const conn = rows[0]
  if (!conn) return res.status(404).json({ error: 'Connection not found' })
  const who = await verifySession(cookie, csrf)
  if (!who.ok) return res.status(400).json({ error: who.reason })
  const { ciphertext, keyVersion } = await encryptSecret(JSON.stringify({ cookie, csrf: csrf || null }))
  await dbQuery(
    `UPDATE x_connections SET encrypted_credentials=$1, credential_key_version=$2, status='active',
       x_handle=$3, display_name=$4, x_account_id=$5, last_validated_at=NOW(), revoked_at=NULL, updated_at=NOW()
     WHERE id=$6`,
    [ciphertext, keyVersion, who.handle, who.name, who.id, conn.id]
  )
  const { rows: fresh } = await dbQuery('SELECT * FROM x_connections WHERE id=$1', [conn.id])
  audit('reconnected', fresh[0])
  res.json({ ok: true, connection: publicConn(fresh[0]) })
})

// Disconnect = wipe encrypted credentials and remove the connection. Logs the
// deletion (metadata only).
router.delete('/:id', async (req, res) => {
  const { rows } = await dbQuery('SELECT * FROM x_connections WHERE id=$1 AND workspace_id=$2', [
    req.params.id,
    WORKSPACE,
  ])
  const conn = rows[0]
  if (!conn) return res.status(404).json({ error: 'Connection not found' })
  // First null out the secret material, then delete the row.
  await dbQuery(
    "UPDATE x_connections SET encrypted_credentials=NULL, status='disconnected', revoked_at=NOW(), updated_at=NOW() WHERE id=$1",
    [conn.id]
  )
  await dbQuery('DELETE FROM x_connections WHERE id=$1', [conn.id])
  audit('disconnected+deleted', { ...conn, status: 'disconnected' })
  res.json({ ok: true })
})

module.exports = router
