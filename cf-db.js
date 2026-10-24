'use strict';
// A Cloudflare Durable Object's built-in SQLite (ctx.storage.sql) as the store's database interface.
// The calls are synchronous on Cloudflare's side; they are wrapped in async functions to match the other engines.
function cfDb(sql) {
  // BLOBs go in and come out as ArrayBuffer
  const bind = p => (p || []).map(v => ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);
  const read = (q, p) => sql.exec(q, ...bind(p)).toArray().map(r => Object.assign({}, r));
  return {
    kind: 'cloudflare',
    ddl: { id: 'INTEGER PRIMARY KEY AUTOINCREMENT', blob: 'BLOB', big: 'INTEGER' },
    async exec(q) { sql.exec(q).toArray(); },
    async all(q, p) { return read(q, p); },
    async get(q, p) { return read(q, p)[0]; },
    async run(q, p) { const c = sql.exec(q, ...bind(p)); c.toArray(); return { changes: c.rowsWritten }; },   // callers only ask whether anything changed
    async insert(q, p) { return read(q + ' RETURNING id', p)[0].id; },
    like(col) { return 'LOWER(' + col + ') LIKE LOWER(?)'; },
    async close() {}
  };
}
module.exports = { cfDb };
