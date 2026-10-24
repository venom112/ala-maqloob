'use strict';
// Storage engines for Node: SQLite (a file) by default; PostgreSQL when DATABASE_URL is set.
// Everything talks to one tiny interface (all / get / run / insert), so the same store code runs on both.
const path = require('path');
const fs = require('fs');
const S = require('./storage');

function sqliteDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const norm = r => (r ? Object.assign({}, r) : r);
  return {
    kind: 'sqlite',
    ddl: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', blob: 'BLOB', big: 'INTEGER' },
    async exec(sql) { db.exec(sql); },
    async all(sql, p) { return db.prepare(sql).all(...(p || [])).map(norm); },
    async get(sql, p) { return norm(db.prepare(sql).get(...(p || []))); },
    async run(sql, p) { const r = db.prepare(sql).run(...(p || [])); return { changes: Number(r.changes) }; },
    async insert(sql, p) { const r = db.prepare(sql).run(...(p || [])); return Number(r.lastInsertRowid); },
    like(col) { return 'LOWER(' + col + ') LIKE LOWER(?)'; },
    async close() { db.close(); }
  };
}

async function pgDb(url) {
  const pg = require('pg');
  pg.types.setTypeParser(20, v => Number(v));   // BIGINT -> number
  const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
  const fix = sql => { let n = 0; return sql.replace(/\?/g, () => '$' + (++n)); };
  return {
    kind: 'postgres',
    ddl: { id: 'SERIAL PRIMARY KEY', blob: 'BYTEA', big: 'BIGINT' },
    async exec(sql) { await pool.query(sql); },
    async all(sql, p) { return (await pool.query(fix(sql), p || [])).rows; },
    async get(sql, p) { return (await pool.query(fix(sql), p || [])).rows[0]; },
    async run(sql, p) { const r = await pool.query(fix(sql), p || []); return { changes: r.rowCount }; },
    async insert(sql, p) { const r = await pool.query(fix(sql) + ' RETURNING id', p || []); return r.rows[0].id; },
    like(col) { return col + ' ILIKE ?'; },
    async close() { await pool.end(); }
  };
}

async function openDb() {
  if (process.env.DATABASE_URL) return pgDb(process.env.DATABASE_URL);
  return sqliteDb(process.env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
}


async function openStore() { return S.makeStore(await openDb()); }

module.exports = { openStore, openDb };
