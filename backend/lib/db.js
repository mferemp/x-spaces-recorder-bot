// Local database. Same call shape the routes already use:
//   const { rows } = await dbQuery('SELECT * FROM t WHERE id = $1', [id])
// Postgres-only functions in those queries (NOW(), to_timestamp($n), $n)
// are translated here. Data lives in a SQLite file, not a hosted service.

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const { SQL } = require('../db/schema')

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'app.db')

let db

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
    db = new DatabaseSync(DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
  }
  return db
}

function normalize(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return Number(value)
  return value
}

// $1 is 1-based and may be repeated. Bind in left-to-right placeholder order.
function translate(sql, params = []) {
  let text = String(sql).replace(/\bNOW\(\)/gi, "datetime('now')")
  text = text.replace(/\bto_timestamp\(\$(\d+)\)/gi, "datetime($$$1, 'unixepoch')")
  const bound = []
  text = text.replace(/\$(\d+)/g, (_, n) => {
    const index = Number(n) - 1
    if (!Number.isInteger(index) || index < 0 || index >= params.length) {
      throw new Error(`SQL placeholder $${n} is missing a value`)
    }
    bound.push(normalize(params[index]))
    return '?'
  })
  return { sql: text, params: bound }
}

function returnsRows(sql) {
  const head = sql.trim().replace(/^\(+/, '')
  return /^(select|with|pragma)\b/i.test(head)
}

async function dbQuery(sql, params = []) {
  const translated = translate(sql, params)
  const statement = getDb().prepare(translated.sql)
  if (returnsRows(translated.sql)) {
    return { rows: statement.all(...translated.params) }
  }
  statement.run(...translated.params)
  return { rows: [] }
}

function migrate() {
  getDb().exec(SQL)
}

module.exports = { dbQuery, migrate, translate, getDb, DB_PATH }
