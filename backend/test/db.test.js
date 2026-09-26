const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-db-'))
process.env.DATABASE_PATH = path.join(dir, 'test.db')

const { dbQuery, migrate, translate } = require('../lib/db')

test('translates $n placeholders, NOW(), and to_timestamp()', () => {
  const out = translate(
    'SELECT id FROM recordings WHERE created_at < to_timestamp($1) AND touched < NOW() AND id <> $2',
    [1_700_000_000, 'abc']
  )
  assert.equal(
    out.sql,
    "SELECT id FROM recordings WHERE created_at < datetime(?, 'unixepoch') AND touched < datetime('now') AND id <> ?"
  )
  assert.deepEqual(out.params, [1_700_000_000, 'abc'])
})

test('repeats a placeholder in left-to-right bind order', () => {
  const out = translate('SELECT $2, $1, $1', ['a', 'b'])
  assert.equal(out.sql, 'SELECT ?, ?, ?')
  assert.deepEqual(out.params, ['b', 'a', 'a'])
})

test('stores booleans as integers and upserts a recording', async () => {
  migrate()
  const sql = `INSERT INTO recordings (id, name, title, source, kind, m3u8, file_path, size_bytes, duration_seconds, enhanced, state, access_mode, x_connection_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
       ON CONFLICT (id) DO UPDATE SET size_bytes=EXCLUDED.size_bytes, file_path=EXCLUDED.file_path, state=EXCLUDED.state, name=EXCLUDED.name, duration_seconds=EXCLUDED.duration_seconds`
  await dbQuery(sql, [
    'rec1', 'Name', null, 'space', 'live', null, '/tmp/a.m4a', 10, 5, true, 'ready', 'public', null,
  ])
  await dbQuery(sql, [
    'rec1', 'Name 2', null, 'space', 'replay', null, '/tmp/b.m4a', 20, 9, false, 'ready', 'public', null,
  ])
  const { rows } = await dbQuery(
    'SELECT name, size_bytes, enhanced, file_path, kind FROM recordings WHERE id=$1',
    ['rec1']
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'Name 2')
  assert.equal(rows[0].size_bytes, 20)
  assert.equal(rows[0].file_path, '/tmp/b.m4a')
  // The route's ON CONFLICT clause updates size, path, state, name, and duration.
  // Columns it does not mention keep the first insert.
  assert.equal(rows[0].enhanced, 1)
  assert.equal(rows[0].kind, 'live')
})

test('retention query compares created_at against a unix cutoff', async () => {
  await dbQuery('INSERT INTO recordings (id, name, created_at) VALUES ($1, $2, $3)', [
    'old',
    'Old',
    '2000-01-01 00:00:00',
  ])
  const cutoff = Math.floor(Date.now() / 1000) - 86400
  const { rows } = await dbQuery(
    'SELECT id FROM recordings WHERE created_at < to_timestamp($1)',
    [cutoff]
  )
  const ids = rows.map((row) => row.id)
  assert.ok(ids.includes('old'))
  assert.equal(ids.includes('rec1'), false)
})

test('keeps an app key on conflict and reads it back', async () => {
  await dbQuery(
    'INSERT INTO app_keys (version, key_hex) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
    ['v1', 'aa']
  )
  await dbQuery(
    'INSERT INTO app_keys (version, key_hex) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
    ['v1', 'bb']
  )
  const { rows } = await dbQuery('SELECT key_hex FROM app_keys WHERE version = $1', ['v1'])
  assert.equal(rows[0].key_hex, 'aa')
})

test('upserts an x connection with NOW() timestamps', async () => {
  const params = [
    'x1', 'local', 'local', '123', 'handle', 'Name', null,
    'session', 'cipher', 'v1', 'active', 'read:spaces (session)',
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
  const { rows } = await dbQuery(
    "SELECT x_handle, status FROM x_connections WHERE workspace_id=$1 AND status <> 'disconnected'",
    ['local']
  )
  assert.equal(rows[0].x_handle, 'handle')
  assert.equal(rows[0].status, 'active')
})
