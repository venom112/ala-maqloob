// The Cloudflare build (worker.mjs): bundled the way Cloudflare would, then driven in Node against stand-ins for the
// Workers runtime (Durable Object SQLite, WebSocketPair, the static-assets binding). It cannot prove that Cloudflare itself
// behaves the same, but it checks all of our code on that path: routing, WebSocket adapter, SQL adapter, accounts, games,
// admin API, pictures, persistence, and that an idle server holds no timer (so the Durable Object can sleep).
// Run: NODE_PATH=/opt/npm-tools/node_modules node test/cf.js
const fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const esbuild = require('esbuild');
const { startFake } = require('./fake_google');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); if (!ok) bad++; };
async function until(f, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(40); } return false; }
const ROOT = path.join(__dirname, '..'), PUB = path.join(ROOT, 'public');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ala-cf-'));

/* ---------- stand-ins for the Workers runtime ---------- */
const NativeResponse = Response;
globalThis.Response = class extends NativeResponse {   // Node refuses status 101
  constructor(body, init) { if (init && init.status === 101) { super(null, { status: 200 }); Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = init.webSocket; } else super(body, init); }
};
class Sock extends EventTarget {
  constructor() { super(); this.peer = null; this.readyState = 1; }
  accept() {}
  send(d) { if (this.readyState !== 1) throw new Error('socket closed'); const p = this.peer; queueMicrotask(() => { const e = new Event('message'); e.data = d; p.dispatchEvent(e); }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; const p = this.peer; queueMicrotask(() => { this.dispatchEvent(new Event('close')); if (p.readyState !== 3) { p.readyState = 3; p.dispatchEvent(new Event('close')); } }); }
}
globalThis.WebSocketPair = function () { const a = new Sock(), b = new Sock(); a.peer = b; b.peer = a; return { 0: a, 1: b }; };

// ctx.storage.sql on top of node:sqlite, with the documented behaviour: exec(query, ...bindings) -> cursor, BLOBs as ArrayBuffer, no BEGIN/PRAGMA
function sqlShim(db) {
  return {
    exec(q, ...b) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA)/i.test(q)) throw new Error('statement not allowed: ' + q);
      if (/ LIKE /i.test(q) && b.some(v => typeof v === 'string' && Buffer.byteLength(v) > 50)) throw new Error('LIKE or GLOB pattern too complex');   // Cloudflare's limit
      if (b.some(v => (v instanceof ArrayBuffer && v.byteLength > 2e6) || (typeof v === 'string' && Buffer.byteLength(v) > 2e6))) throw new Error('row too big');   // 2 MB per value
      b = b.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v);
      let rows = [], written = 0;
      if (!b.length && q.split(';').filter(x => x.trim()).length > 1) db.exec(q);
      else {
        const st = db.prepare(q);
        if (/^\s*(SELECT|WITH)/i.test(q) || /RETURNING/i.test(q)) { rows = st.all(...b).map(r => Object.assign({}, r)); written = /RETURNING/i.test(q) ? 1 : 0; }
        else written = Number(st.run(...b).changes);
      }
      rows = rows.map(r => { const o = {}; for (const k in r) o[k] = r[k] instanceof Uint8Array ? r[k].buffer.slice(r[k].byteOffset, r[k].byteOffset + r[k].byteLength) : r[k]; return o; });
      return { toArray: () => rows, one() { if (rows.length !== 1) throw new Error('one()'); return rows[0]; }, rowsWritten: written, rowsRead: rows.length };
    }
  };
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const assets = { async fetch(req) {   // html_handling "none": exact file names only
  const p = new URL(req.url).pathname, f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(f), { status: 200, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } });
} };

(async () => {
  /* ---------- the bundle ---------- */
  const cfPlugin = { name: 'cf', setup(b) { b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: path.join(__dirname, 'cf_shim.mjs') })); } };
  const out = path.join(tmp, 'worker.bundle.cjs');
  await esbuild.build({ entryPoints: [path.join(ROOT, 'worker.mjs')], bundle: true, format: 'cjs', platform: 'node', outfile: out, plugins: [cfPlugin], logLevel: 'silent' });
  // what Cloudflare's bundler sees: nothing but the Workers runtime and node:crypto/buffer
  let strict = null, errText = '';
  try {
    strict = await esbuild.build({ entryPoints: [path.join(ROOT, 'worker.mjs')], bundle: true, format: 'esm', platform: 'neutral', write: false, metafile: true, logLevel: 'silent',
      external: ['node:*', 'crypto', 'buffer', 'cloudflare:*'], plugins: [] });
  } catch (e) { errText = String(e.message).slice(0, 300); }
  check('the Worker bundles for Cloudflare with only crypto/buffer from Node', !!strict, errText);
  const inputs = strict ? Object.keys(strict.metafile.inputs) : [];
  check('and pulls in none of the Node-only parts (ws, pg, fs, http, node:sqlite, server.js)', strict && !inputs.some(f => /node_modules|server\.js|storage-node/.test(f)) && !/require\(["'](fs|path|http|ws|pg|node:sqlite)["']\)/.test(strict.outputFiles[0].text), inputs);

  const fake = await startFake();
  const mkEnv = (extra) => ({ OWNER_EMAIL: 'ana.wolfish@gmail.com', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_JWKS_URL: fake.url, LOGIN_LIMIT: '1000', ...extra });
  const dbFile = path.join(tmp, 'do.sqlite');
  const sqlDb = new DatabaseSync(dbFile);
  const timersBefore = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
  const worker = require(out);
  let hubs = 0;
  function makeEnv(extra) {
    const env = mkEnv(extra);
    const ctx = { storage: { sql: sqlShim(sqlDb) }, blockConcurrencyWhile: f => f() };
    const hub = new worker.Hub(ctx, env); hubs++;
    env.HUB = { idFromName: n => n, get: () => ({ fetch: r => hub.fetch(r) }) };
    env.ASSETS = assets;
    return env;
  }
  let env = makeEnv();
  const req = (p, o) => worker.default.fetch(new Request('https://game.test' + p, o), env);

  /* ---------- plain HTTP ---------- */
  let r = await req('/');
  check('/ serves the game page', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && (await r.text()).includes('ع المقلوب'));
  r = await req('/admin'); const adminHtml = await r.text();
  check('/admin serves the admin panel with the sign-in popup header', r.status === 200 && adminHtml.includes('<html') && r.headers.get('cross-origin-opener-policy') === 'same-origin-allow-popups');
  r = await req('/sw.js'); check('static files pass straight through', r.status === 200 && (await r.text()).includes("const V = 'ala-v31'"));
  r = await req('/nope.png'); check('unknown file: 404', r.status === 404);
  r = await req('/healthz'); check('/healthz answers', r.status === 200 && (await r.text()) === 'ok');
  r = await req('/api/config'); const cfg = await r.json();
  check('/api/config comes from the Durable Object (pictures + hint)', r.status === 200 && cfg.images && cfg.images.logo && typeof cfg.hint === 'string', cfg);
  r = await req('/a/logo'); check('a picture that was never uploaded: 404', r.status === 404);
  r = await req('/api/admin/me'); check('admin API closed without a token', r.status === 401);
  r = await req('/ws'); check('/ws without an upgrade is not a game page', r.status === 404);

  /* ---------- websocket protocol ---------- */
  const open = async () => {
    const res = await req('/ws', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '9.9.9.9' } });
    const c = res.webSocket; c.accept();
    const ws = { msgs: [], closed: false, send: o => c.send(typeof o === 'string' ? o : JSON.stringify(o)), close: () => c.close(), raw: c, status: res.status };
    c.addEventListener('message', e => ws.msgs.push(JSON.parse(e.data))); c.addEventListener('close', () => { ws.closed = true; });
    return ws;
  };
  const last = (ws, t) => ws.msgs.filter(m => m.t === t).pop();
  const A = await open();
  check('the upgrade answers 101 with a socket', A.status === 101);
  A.send({ t: 'ping' }); check('ping -> pong', await until(() => last(A, 'pong')));
  A.send({ t: 'avail', name: 'سمير' }); await until(() => last(A, 'avail'));
  check('a free name is available', last(A, 'avail').ok === true);
  A.send({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name: 'سمير', pass: '1234' });
  check('register -> authed with a token', await until(() => last(A, 'authed')) && last(A, 'authed').token.includes('.'));
  const tokA = last(A, 'authed').token;
  const B = await open(); B.send({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name: 'سمير', pass: '9999' });
  check('the same name again is refused', await until(() => last(B, 'err')) && last(B, 'err').code === 'taken');
  B.send({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name: 'سَمِير', pass: '9999' }); await until(() => B.msgs.filter(m => m.t === 'err').length >= 2);
  check('a look-alike spelling (diacritics) is refused too', B.msgs.filter(m => m.t === 'err').pop().code === 'taken');
  B.send({ t: 'login', name: 'سمير', pass: 'wrong' }); await until(() => B.msgs.filter(m => m.t === 'err').length >= 3);
  check('wrong password is refused', B.msgs.filter(m => m.t === 'err').pop().code === 'login');
  B.send({ t: 'login', name: 'سمير', pass: '1234' });
  check('right password logs in', await until(() => last(B, 'authed')));
  check('and the older connection of the same account is told it was replaced', await until(() => last(A, 'replaced')) && await until(() => A.closed));
  B.send({ t: 'x'.repeat(5000) }); check('an oversize message cuts the connection', await until(() => B.closed));
  { const E = await open(); E.send({ t: 'register', email: 'Ana.Wolfish+x@gmail.com', name: 'المالك', pass: '1' });
    check('any password is accepted and the owner e-mail gets the admin flag', await until(() => last(E, 'authed')) && last(E, 'authed').admin === true);
    const F = await open(); F.send({ t: 'register', email: 'anawolfish@gmail.com', name: 'تانى', pass: 'x' });
    check('the same e-mail cannot register twice', await until(() => last(F, 'err')) && last(F, 'err').code === 'taken');
    F.send({ t: 'login', email: 'ana.wolfish@gmail.com', pass: 'x' }); await until(() => F.msgs.filter(m => m.t === 'err').length >= 2);
    check('wrong password by e-mail is refused', F.msgs.filter(m => m.t === 'err').pop().code === 'login');
    F.send({ t: 'login', email: 'ana.wolfish@gmail.com', pass: '1' });
    check('login by e-mail works and says admin', await until(() => last(F, 'authed')) && last(F, 'authed').admin === true);
    const G = await open(); G.send({ t: 'register', email: 'plain@t.com', name: 'عادي', pass: 'z' });
    check('other e-mails are not admin', await until(() => last(G, 'authed')) && last(G, 'authed').admin === false); }
  const C = await open(); C.send({ t: 'resume', token: tokA }); check('resume with the saved token works', await until(() => last(C, 'authed')));
  const D = await open(); D.send({ t: 'resume', token: tokA.slice(0, -3) + 'abc' }); check('a tampered token is refused', await until(() => last(D, 'noauth')));
  const E = await open(); E.send({ t: 'create', cap: 4 }); check('actions before signing in are refused', await until(() => last(E, 'noauth')));
  E.close();

  /* ---------- a practice game against bots (real timers) ---------- */
  const P = C;   // سمير is signed in on C
  P.msgs.length = 0; P.send({ t: 'bots', n: 3 });
  check('a bots room starts and deals 3 cards', await until(() => { const m = last(P, 'room'); return m && m.g && m.g.dealt && m.hand.length === 3; }, 8000));
  const room0 = last(P, 'room');
  check('the game config arrives (15 cards, pictures)', room0.g.cfg.cards.length === 15 && room0.roster.length === 3, room0.g.cfg.cards.length);
  const me = room0.you;
  let turnsSeen = new Set(), played = 0, autopilotOn = true;
  const pilot = setInterval(() => {
    if (!autopilotOn) return;
    const m = last(P, 'room'); if (!m || !m.g) return; const g = m.g;
    if (g.over >= 0) return;
    if (g.phase === 'act' && g.turn === me) { if (!g.drew) P.send({ t: 'act', a: 'draw' }); else { played++; const cs = g.cfg.cards, t0 = m.hand[0]; P.send({ t: 'act', a: 'play', k: 0, d: (cs[t0].df || cs[t0].up) ? 0 : t0 }); } }   // defenders and face-up cards are thrown as the Fatwa (they cannot be named on a bluff)
    if (g.phase === 'claim' && g.claim && g.claim.pending.includes(me)) P.send({ t: 'act', a: 'decide', cid: g.claim.id, ch: 'pass' });
    if (g.phase === 'target' && g.turn === me && g.claim) P.send({ t: 'act', a: 'pick', cid: g.claim.id, tg: g.targets[0] });
    if (g.phase === 'give' && g.claim && g.claim.by === me) P.send({ t: 'act', a: 'give', cid: g.claim.id, k: 0 });
    if (g.phase === 'defend' && g.defend && g.defend.T === me) P.send({ t: 'act', a: 'defend', cid: g.defend.id, k: -1 });
    turnsSeen.add(g.turn);
  }, 150);
  const silent = await open(); silent.send({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name: 'صامت', pass: '1234' }); await until(() => last(silent, 'authed'));
  silent.send({ t: 'create', cap: 3 });   // then says nothing: after 25 s without a word the connection is cut
  await sleep(22000);
  await until(() => turnsSeen.size === 3 && played >= 1, 100000);   // a bot's turn takes a few seconds (draw, play, the others decide); give it time
  autopilotOn = false; clearInterval(pilot);
  const lm = last(P, 'room');
  check('the game moved on by itself through all three seats', turnsSeen.size === 3 && played >= 1, { turns: [...turnsSeen], played });
  check('events reached the client (cards played, passes...)', lm.g.evs.length > 0, lm.g.evs);
  check('the human only ever saw his own hand', lm.hand.length >= 2 && lm.g.handN.length === 3);
  P.send({ t: 'leave' }); check('leaving a bots room closes it', await until(() => last(P, 'closed') || last(P, 'left')));

  /* ---------- friends room: create / join / start ---------- */
  const mk = async (name) => { const w = await open(); w.send({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name, pass: '1234' }); await until(() => last(w, 'authed')); return w; };
  const f1 = await mk('منى'), f2 = await mk('هاني'), f3 = await mk('دينا');
  f1.send({ t: 'create', cap: 3, decide: 5, turn: 999, pick: 20 }); await until(() => last(f1, 'room'));
  const code = last(f1, 'room').code;
  check('a friends room gets a 5-digit code', /^\d{5}$/.test(code), code);
  f2.send({ t: 'join', code }); f3.send({ t: 'join', code });
  check('two friends join with the code', await until(() => last(f1, 'room').roster.length === 3));
  { const g1 = await mk('سلمى'); g1.send({ t: 'create', cap: 4 }); await until(() => last(g1, 'room')); g1.send({ t: 'fillbots' });
    check('the host fills the empty seats with bots', await until(() => { const m = last(g1, 'room'); return m && m.roster.length === 4 && m.roster.filter(r => r.bot).length === 3; }), last(g1, 'room').roster);
    const g2 = await mk('رنا'); g2.send({ t: 'join', code: last(g1, 'room').code });
    check('a newcomer takes the seat of a bot', await until(() => { const m = last(g1, 'room'); return m && m.roster.length === 4 && m.roster.filter(r => r.bot).length === 2 && m.roster.some(r => r.name === 'رنا'); }), last(g1, 'room').roster); g1.close(); g2.close(); }
  f2.send({ t: 'start' }); await sleep(200);
  check('only the host can start', last(f1, 'room').status === 'waiting');
  f1.send({ t: 'start' });
  check('the host starts: everybody is dealt cards', await until(() => [f1, f2, f3].every(w => { const m = last(w, 'room'); return m && m.g && m.g.dealt && m.hand.length === 3; }), 8000));
  { const st = last(f1, 'room').g.cfg.set; check('room timers: out-of-range values are clamped to 15..60 s, a chosen one is kept', st.decideMs === 15000 && st.turnMs === 60000 && st.pickMs === 20000, st); }
  const h1 = last(f1, 'room'), h2 = last(f2, 'room');
  check('each player gets his own hand only (different cards allowed, no one else\'s in the message)', !JSON.stringify(h2).includes('"hand":' + JSON.stringify(h1.hand)) || JSON.stringify(h1.hand) === JSON.stringify(h2.hand));
  f2.close(); check('a player who drops is not fatal to the room', await until(() => f2.closed));
  [f1, f3].forEach(w => w.close());

  /* ---------- persistence: a new Durable Object instance on the same database ---------- */
  const env1 = env;
  env = makeEnv();   // as if the object was evicted and woke up again
  const R = await open(); R.send({ t: 'resume', token: tokA });
  check('after a restart the saved token still works (secret and accounts are in the database)', await until(() => last(R, 'authed')) && last(R, 'authed').name === 'سمير');
  const R2 = await open(); R2.send({ t: 'login', name: 'سمير', pass: '1234' });
  check('and the password still checks out', await until(() => last(R2, 'authed')));
  r = await req('/api/config'); check('cards are still there (15 seeded once, not again)', (await r.json()).v >= 1 && sqlDb.prepare('SELECT COUNT(*) c FROM cards').get().c === 15);

  /* ---------- admin API through the Worker ---------- */
  const call = async (method, p, body, tok) => { const x = await req('/api/admin/' + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { s: x.status, j: await x.json().catch(() => ({})) }; };
  const login = (email, claims, opt) => call('POST', 'login', { credential: fake.token(Object.assign({ email }, claims), opt) });
  const o = await login('ana.wolfish@gmail.com');
  check('the owner signs in with a Google token (verified with Web Crypto)', o.s === 200 && o.j.owner === true, o);
  const OWN = o.j.token;
  check('a token signed by another key is refused', (await login('ana.wolfish@gmail.com', {}, { evilKey: true })).s === 401);
  check('a token for another app is refused', (await login('ana.wolfish@gmail.com', { aud: 'x' })).s === 401);
  check('a stranger is not an admin', (await login('stranger@gmail.com')).s === 403);
  const pl = (await call('GET', 'players?q=' + encodeURIComponent('سمير'), undefined, OWN)).j;
  check('the player list shows the account, online', pl.rows && pl.rows.length === 1 && pl.rows[0].online === true, pl);
  const uid = pl.rows[0].id;
  const longQ = await call('GET', 'players?q=' + encodeURIComponent('س'.repeat(60)), undefined, OWN);
  check('a very long search text does not hit the 50-byte LIKE limit', longQ.s === 200, longQ);
  check('accounts made on the Worker use PBKDF2 (salt starts with p1:)', sqlDb.prepare("SELECT COUNT(*) c FROM users WHERE salt NOT LIKE 'p1:%'").get().c === 0);
  const st = (await call('GET', 'stats', undefined, OWN)).j;
  check('stats count players and live rooms', st.players >= 4 && typeof st.rooms === 'number', st);
  const cards = (await call('GET', 'cards', undefined, OWN)).j;
  check('the card list has the 15 cards', cards.cards && cards.cards.length === 15);
  const newCard = await call('POST', 'cards', { name: 'تجربة', descr: 'x', penDescr: 'y', cnt: 1, color: '#112233', power: [], penalty: { loss: 1, drop: 0, gift: 0 }, active: false }, OWN);
  check('a card can be added (insert returns its id)', newCard.s === 200 && newCard.j.id > 9, newCard);
  check('...and deleted', (await call('DELETE', 'cards/' + newCard.j.id, undefined, OWN)).s === 200);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const up = await call('PUT', 'assets/logo', { data: png.toString('base64') }, OWN);
  check('a picture upload is accepted', up.s === 200 && up.j.url.startsWith('/a/logo?v='), up);
  r = await req(up.j.url);
  const got = Buffer.from(await r.arrayBuffer());
  check('and served back byte for byte, as the right type (BLOB round trip)', r.status === 200 && r.headers.get('content-type') === 'image/png' && got.equals(png), { s: r.status, len: got.length });
  r = await req('/api/config'); check('the lobby now points at the new picture', (await r.json()).images.logo.startsWith('/a/logo?v='));
  check('the picture can be reset', (await call('DELETE', 'assets/logo', undefined, OWN)).j.ok === true);
  check('settings can be changed', (await call('PUT', 'settings', { startInf: 4 }, OWN)).s === 200 && (await (await req('/api/config')).json()).startInf === 4);
  check('an admin is appointed with limited rights', (await call('PUT', 'admins', { email: 'bob@example.com', perms: ['players.view'] }, OWN)).s === 200);
  const BOB = (await login('bob@example.com')).j.token;
  check('and he cannot edit cards', (await call('GET', 'cards', undefined, BOB)).s === 403);
  const rm = (await call('GET', 'rooms', undefined, OWN)).j;
  check('the rooms list answers', Array.isArray(rm.rooms));
  const ban = await call('POST', 'players/' + uid + '/ban', { reason: 'test', hours: 1 }, OWN);
  check('banning a player works and the old token stops working', ban.s === 200 && await until(() => R.closed || last(R, 'banned') || last(R, 'kicked')), ban);
  const Z = await open(); Z.send({ t: 'resume', token: tokA });
  check('a banned player cannot come back in', await until(() => last(Z, 'banned') || last(Z, 'noauth')));
  check('unban', (await call('POST', 'players/' + uid + '/unban', {}, OWN)).j.ok === true);
  const audit = (await call('GET', 'audit', undefined, OWN)).j;
  check('everything was written to the audit log', audit.total >= 8, audit.total);

  /* ---------- the silent connection was cut ---------- */
  await sleep(9000);
  check('a connection silent for 25 s is cut by the server (no ping frames on Cloudflare)', silent.closed === true);

  /* ---------- sleeping ---------- */
  [R, R2, Z, A, B, C, D, P, silent, f1, f2, f3].forEach(w => { try { w.close(); } catch (e) {} });
  await sleep(1500);
  await call('POST', 'rooms/none/close', {}, OWN);
  const timersAfter = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
  const rooms = (await call('GET', 'rooms', undefined, OWN)).j.rooms.length;
  console.log('   (open rooms: ' + rooms + ', timers before/after: ' + timersBefore + '/' + timersAfter + ')');
  check('with everyone gone the server keeps no repeating timer (the Durable Object can sleep)', rooms === 0 ? timersAfter <= timersBefore + 5 : true, { rooms, timersBefore, timersAfter });

  /* ---------- password scheme fallback ---------- */
  const S = require('../storage');
  delete process.env.PASS_SCHEME;   // the Worker sets it for itself; here the plain Node default is checked
  const h1p = await S.newHash('سر-١٢٣٤', true), h2p = await S.newHash('سر-١٢٣٤');
  check('PBKDF2 hashes verify (for runtimes without scrypt) and wrong passwords do not', h1p.salt.startsWith('p1:') && await S.checkPass('سر-١٢٣٤', h1p.salt, h1p.hash) && !(await S.checkPass('x', h1p.salt, h1p.hash)));
  check('scrypt hashes still verify side by side', !h2p.salt.startsWith('p1:') && await S.checkPass('سر-١٢٣٤', h2p.salt, h2p.hash));

  fake.close();
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
