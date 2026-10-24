'use strict';
// Storage, the runtime-neutral part: names, passwords, tokens, and the store itself (accounts, bans, admins, audit, cards, assets).
// The store talks to a tiny database interface (exec / all / get / run / insert / like / ddl), so the same code runs on
// SQLite and PostgreSQL (storage-node.js) and on a Cloudflare Durable Object's SQLite (cf-db.js).
// Web Crypto (globalThis.crypto) works the same on Node and on Cloudflare. node:crypto is used only for scrypt, and only if it can be loaded.
let nodeCrypto = null; try { nodeCrypto = require('node:crypto'); } catch (e) {}
const subtle = () => globalThis.crypto.subtle;
const te = s => new TextEncoder().encode(String(s));
const toHex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => toHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
function sameBytes(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }   // no early exit
async function hmac(secret, text) {
  const k = await subtle().importKey('raw', te(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await subtle().sign('HMAC', k, te(text))).toString('base64url');
}
async function sha1hex(data) { return toHex(new Uint8Array(await subtle().digest('SHA-1', data))); }

/* ---------- names, passwords, tokens ---------- */
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
// a comparison key that ignores case, spaces, diacritics and look-alike Arabic letters
function nameKey(s) {
  const x = norm(s).normalize('NFKC').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
    .replace(/[\s_\-.]/g, '');
  return Array.from(x).map(c => c.codePointAt(0).toString(16)).join('-');
}
function validName(v) {
  const len = Array.from(v).length;
  if (len < 2) return 'الاسم لازم يكون حرفين على الأقل.';
  if (len > 100) return 'الاسم أطول من ١٠٠ حرف.';
  if (!/[\p{L}\p{N}]/u.test(v)) return 'اكتب اسم بحروف أو أرقام.';
  if (/[<>&"'`\\]/.test(v)) return 'الاسم فيه رموز مش مسموحة.';
  if (nameKey(v) === nameKey('أنا')) return 'اختار اسم تاني غير "أنا".';
  return '';
}
// Passwords: scrypt where the runtime has it (Node); PBKDF2-SHA512 from Web Crypto otherwise (Cloudflare).
// The scheme is recorded in the salt ('p1:' = PBKDF2), so an account keeps verifying whichever runtime reads it.
const hasScrypt = () => !!nodeCrypto && typeof nodeCrypto.scrypt === 'function';
async function pbkdf2(pass, salt) {
  const k = await subtle().importKey('raw', te(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: te(salt), iterations: 100000 }, k, 256);   // 100000 is the most Workers allow
  return toHex(new Uint8Array(bits));
}
function scrypt(pass, salt) { return new Promise((res, rej) => nodeCrypto.scrypt(pass, salt, 32, { N: 16384 }, (e, k) => e ? rej(e) : res(k.toString('hex')))); }
async function hashPass(pass, salt) { return salt.startsWith('p1:') ? pbkdf2(pass, salt) : scrypt(pass, salt); }
// PASS_SCHEME=pbkdf2 (set by the Cloudflare Worker) makes new accounts use PBKDF2 even if the runtime also offers scrypt
const wantPbkdf2 = () => typeof process !== 'undefined' && !!process.env && process.env.PASS_SCHEME === 'pbkdf2';
async function newHash(pass, forcePbkdf2) {
  const raw = randomHex(16), salt = (forcePbkdf2 || wantPbkdf2() || !hasScrypt()) ? 'p1:' + raw : raw;
  return { salt, hash: await hashPass(pass, salt) };
}
async function checkPass(pass, salt, hash) {
  const h = Buffer.from(await hashPass(pass, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return sameBytes(h, b);
}
// The same Google account can be written with dots / +tags in a Gmail address, so compare e-mails by this key.
function emailKey(e) {
  e = String(e || '').trim().toLowerCase();
  const at = e.lastIndexOf('@'); if (at < 1) return e;
  let local = e.slice(0, at), dom = e.slice(at + 1);
  if (dom === 'googlemail.com') dom = 'gmail.com';
  if (dom === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return local + '@' + dom;
}
const validEmail = e => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;

// Signed session tokens, no table needed. v = a number stored per account: bumping it signs that account out everywhere.
function signer(secret) {
  return {
    async make(uid, days, v) { const p = Buffer.from(JSON.stringify({ u: uid, e: Date.now() + days * 864e5, v: v || 0 })).toString('base64url'); return p + '.' + await hmac(secret, p); },
    async read(tok) {
      if (typeof tok !== 'string') return null;
      const [p, m] = tok.split('.'); if (!p || !m) return null;
      const want = await hmac(secret, p); if (!sameBytes(te(want), te(m))) return null;
      try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.e > Date.now() ? { u: d.u, v: d.v || 0 } : null; } catch (e) { return null; }
    }
  };
}

/* ---------- the store: accounts, bans, admins, audit, cards, assets ---------- */
async function makeStore(db) {
  const D = db.ddl;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (id ${D.id}, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created ${D.big} NOT NULL);
    CREATE TABLE IF NOT EXISTS user_email (uid INTEGER PRIMARY KEY, email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_meta (uid INTEGER PRIMARY KEY, last_login ${D.big}, tv INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS bans (uid INTEGER PRIMARY KEY, reason TEXT NOT NULL, until ${D.big}, by TEXT NOT NULL, at ${D.big} NOT NULL);
    CREATE TABLE IF NOT EXISTS admins (email_key TEXT PRIMARY KEY, email TEXT NOT NULL, perms TEXT NOT NULL, added_by TEXT NOT NULL, created ${D.big} NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id ${D.id}, at ${D.big} NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS cards (id ${D.id}, name TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL, pen_descr TEXT NOT NULL, cnt INTEGER NOT NULL, active INTEGER NOT NULL, color TEXT NOT NULL, power TEXT NOT NULL, penalty TEXT NOT NULL, sort INTEGER NOT NULL, default_img TEXT, deleted INTEGER NOT NULL DEFAULT 0, created ${D.big} NOT NULL, updated ${D.big} NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (slot TEXT PRIMARY KEY, mime TEXT NOT NULL, data ${D.blob} NOT NULL, hash TEXT NOT NULL, updated ${D.big} NOT NULL, by TEXT NOT NULL);
  `);
  const uid = id => Number(String(id).slice(1));
  const wrap = r => r ? { id: 'u' + r.id, name: r.name, created: r.created } : null;

  return Object.assign(db, {
    /* settings */
    async getSetting(k) { const r = await db.get('SELECT v FROM settings WHERE k=?', [k]); return r ? r.v : null; },
    async setSetting(k, v) { await db.run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, v]); },

    /* accounts */
    async byKey(key) { const r = await db.get('SELECT id,name,salt,hash FROM users WHERE name_key=?', [key]); return r ? { id: 'u' + r.id, name: r.name, salt: r.salt, hash: r.hash } : null; },
    async byId(id) {
      const n = uid(id); if (!Number.isInteger(n)) return null;
      const r = await db.get('SELECT u.id,u.name,u.created,COALESCE(m.tv,0) AS tv FROM users u LEFT JOIN user_meta m ON m.uid=u.id WHERE u.id=?', [n]);
      return r ? { id: 'u' + r.id, name: r.name, created: r.created, tv: r.tv } : null;
    },
    async create(name, key, salt, hash) {
      try { const id = await db.insert('INSERT INTO users(name,name_key,salt,hash,created) VALUES(?,?,?,?,?)', [name, key, salt, hash, Date.now()]); return { id: 'u' + id, name }; }
      catch (e) { if (/UNIQUE|23505|duplicate/i.test(String(e.message) + String(e.code))) return null; throw e; }
    },
    /* e-mail accounts (older accounts have no e-mail row and still sign in by name) */
    async byEmailKey(ekey) {
      const r = await db.get('SELECT u.id,u.name,u.salt,u.hash FROM user_email e JOIN users u ON u.id=e.uid WHERE e.email_key=?', [ekey]);
      return r ? { id: 'u' + r.id, name: r.name, salt: r.salt, hash: r.hash } : null;
    },
    async emailOf(id) { const n = uid(id); if (!Number.isInteger(n)) return null; const r = await db.get('SELECT email FROM user_email WHERE uid=?', [n]); return r ? r.email : null; },
    // returns { user } or { taken: 'name' | 'email' }
    async createWithEmail(name, key, salt, hash, email, ekey) {
      if (await db.get('SELECT uid FROM user_email WHERE email_key=?', [ekey])) return { taken: 'email' };
      const u = await this.create(name, key, salt, hash); if (!u) return { taken: 'name' };
      try { await db.run('INSERT INTO user_email(uid,email,email_key) VALUES(?,?,?)', [uid(u.id), email, ekey]); }
      catch (e) { await db.run('DELETE FROM users WHERE id=?', [uid(u.id)]); if (/UNIQUE|23505|duplicate/i.test(String(e.message) + String(e.code))) return { taken: 'email' }; throw e; }
      return { user: u };
    },
    /* a copy of every account (names, e-mails and the salted password hashes, never the passwords) and putting it back */
    async backupUsers() { return db.all('SELECT u.name AS name, u.name_key AS name_key, u.salt AS salt, u.hash AS hash, u.created AS created, e.email AS email, e.email_key AS email_key FROM users u LEFT JOIN user_email e ON e.uid=u.id ORDER BY u.id'); },
    async restoreUsers(list) {
      let added = 0, skipped = 0;
      for (const r of list) {
        if (!r || typeof r.name !== 'string' || typeof r.name_key !== 'string' || typeof r.salt !== 'string' || typeof r.hash !== 'string') { skipped++; continue; }
        if (await db.get('SELECT id FROM users WHERE name_key=?', [r.name_key]) || (r.email_key && await db.get('SELECT uid FROM user_email WHERE email_key=?', [r.email_key]))) { skipped++; continue; }
        const id = await db.insert('INSERT INTO users(name,name_key,salt,hash,created) VALUES(?,?,?,?,?)', [r.name, r.name_key, r.salt, r.hash, Number(r.created) || Date.now()]);
        if (r.email && r.email_key) await db.run('INSERT INTO user_email(uid,email,email_key) VALUES(?,?,?)', [id, r.email, r.email_key]);
        added++;
      }
      return { added, skipped };
    },
    async count() { return (await db.get('SELECT COUNT(*) c FROM users')).c; },
    async touchLogin(id) { await db.run('INSERT INTO user_meta(uid,last_login,tv) VALUES(?,?,0) ON CONFLICT(uid) DO UPDATE SET last_login=excluded.last_login', [uid(id), Date.now()]); },
    async tokenVersion(id) { const r = await db.get('SELECT tv FROM user_meta WHERE uid=?', [uid(id)]); return r ? r.tv : 0; },
    async bumpTokens(id) { await db.run('INSERT INTO user_meta(uid,last_login,tv) VALUES(?,NULL,1) ON CONFLICT(uid) DO UPDATE SET tv=user_meta.tv+1', [uid(id)]); },

    /* admin: players */
    async listUsers(q, limit, offset) {
      const where = q ? 'WHERE ' + db.like('u.name') : '';
      // Cloudflare's SQLite refuses a LIKE pattern longer than 50 bytes: cut the search text to fit
      let qq = q ? q.replace(/[%_]/g, '') : ''; while (Buffer.byteLength(qq) > 46) qq = qq.slice(0, -1);
      const args = q ? ['%' + qq + '%'] : [];
      const total = (await db.get('SELECT COUNT(*) c FROM users u ' + where, args)).c;
      const rows = await db.all(`SELECT u.id,u.name,u.created,m.last_login,b.reason,b.until,b.by,b.at FROM users u LEFT JOIN user_meta m ON m.uid=u.id LEFT JOIN bans b ON b.uid=u.id ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`, args.concat([limit, offset]));
      return { total, rows: rows.map(r => ({ id: 'u' + r.id, name: r.name, created: r.created, lastLogin: r.last_login || null, ban: r.reason == null ? null : { reason: r.reason, until: r.until || null, by: r.by, at: r.at } })) };
    },
    async userFull(id) { const n = uid(id); const r = Number.isInteger(n) && await db.get('SELECT id,name,created FROM users WHERE id=?', [n]); return wrap(r); },
    async renameUser(id, name, key) {
      try { const r = await db.run('UPDATE users SET name=?, name_key=? WHERE id=?', [name, key, uid(id)]); return r.changes > 0 ? 'ok' : 'none'; }
      catch (e) { if (/UNIQUE|23505|duplicate/i.test(String(e.message) + String(e.code))) return 'taken'; throw e; }
    },
    async setPassword(id, salt, hash) { await db.run('UPDATE users SET salt=?, hash=? WHERE id=?', [salt, hash, uid(id)]); await this.bumpTokens(id); },
    async deleteUser(id) {
      const n = uid(id);
      await db.run('DELETE FROM bans WHERE uid=?', [n]); await db.run('DELETE FROM user_meta WHERE uid=?', [n]); await db.run('DELETE FROM user_email WHERE uid=?', [n]);
      return (await db.run('DELETE FROM users WHERE id=?', [n])).changes > 0;
    },
    async countBanned() { return (await db.get('SELECT COUNT(*) c FROM bans WHERE until IS NULL OR until > ?', [Date.now()])).c; },

    /* bans: a ban with an end time stops counting once it has passed */
    async activeBan(id) {
      const r = await db.get('SELECT reason,until,by,at FROM bans WHERE uid=?', [uid(id)]);
      if (!r) return null;
      if (r.until && r.until <= Date.now()) { await db.run('DELETE FROM bans WHERE uid=?', [uid(id)]); return null; }
      return { reason: r.reason, until: r.until || null, by: r.by, at: r.at };
    },
    async ban(id, reason, until, by) {
      await db.run('INSERT INTO bans(uid,reason,until,by,at) VALUES(?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET reason=excluded.reason, until=excluded.until, by=excluded.by, at=excluded.at', [uid(id), reason, until || null, by, Date.now()]);
      await this.bumpTokens(id);
    },
    async unban(id) { return (await db.run('DELETE FROM bans WHERE uid=?', [uid(id)])).changes > 0; },

    /* admins (the owner is not stored: it comes from OWNER_EMAIL) */
    async listAdmins() { return (await db.all('SELECT email_key,email,perms,added_by,created FROM admins ORDER BY created')).map(r => ({ key: r.email_key, email: r.email, perms: JSON.parse(r.perms), addedBy: r.added_by, created: r.created })); },
    async getAdmin(key) { const r = await db.get('SELECT email_key,email,perms,added_by,created FROM admins WHERE email_key=?', [key]); return r ? { key: r.email_key, email: r.email, perms: JSON.parse(r.perms), addedBy: r.added_by, created: r.created } : null; },
    async putAdmin(key, email, perms, by) {
      await db.run('INSERT INTO admins(email_key,email,perms,added_by,created) VALUES(?,?,?,?,?) ON CONFLICT(email_key) DO UPDATE SET email=excluded.email, perms=excluded.perms', [key, email, JSON.stringify(perms), by, Date.now()]);
    },
    async removeAdmin(key) { return (await db.run('DELETE FROM admins WHERE email_key=?', [key])).changes > 0; },

    /* audit log: every admin action leaves a line; the oldest are dropped past 5000 */
    async log(actor, action, target, detail) {
      await db.insert('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)', [Date.now(), actor, action, target == null ? null : String(target), detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000)]);
      if (Math.random() < 0.02) await db.run('DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 5000');
    },
    async audit(limit, offset) {
      const total = (await db.get('SELECT COUNT(*) c FROM audit')).c;
      return { total, rows: await db.all('SELECT id,at,actor,action,target,detail FROM audit ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]) };
    },

    /* assets: uploaded images (the bundled defaults stay on disk) */
    async getAsset(slot) { return db.get('SELECT slot,mime,data,hash,updated FROM assets WHERE slot=?', [slot]); },
    async assetMeta() { return db.all('SELECT slot,mime,hash,updated,by FROM assets'); },
    async putAsset(slot, mime, data, by) {
      const hash = (await sha1hex(data)).slice(0, 10);
      await db.run('INSERT INTO assets(slot,mime,data,hash,updated,by) VALUES(?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET mime=excluded.mime, data=excluded.data, hash=excluded.hash, updated=excluded.updated, by=excluded.by', [slot, mime, data, hash, Date.now(), by]);
      return hash;
    },
    async delAsset(slot) { return (await db.run('DELETE FROM assets WHERE slot=?', [slot])).changes > 0; }
  });
}

module.exports = { randomHex, makeStore, nameKey, validName, norm, newHash, checkPass, signer, emailKey, validEmail };
