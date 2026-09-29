// One-shot migration for the snowflake-timestamp rework: message/user times
// are derived from ids now, so the created_at columns are dropped. Run
// `node migrate.js [--db=<file>]` once against an existing archive, then
// delete this file.
import Database from 'better-sqlite3'
import { parseArgs } from 'node:util'
import { log } from './lib/log.js'

const { values } = parseArgs({
  strict: false,
  options: { db: { type: 'string' } }
})

const db = new Database(values.db ?? 'data/database.db')

for (const table of ['messages', 'users']) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'created_at')) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN created_at`)
    log.info(`[migrate] dropped ${table}.created_at`)
  } else {
    log.info(`[migrate] ${table}.created_at already absent`)
  }
}

db.close()
