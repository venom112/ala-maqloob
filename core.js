'use strict';
// The game server without any transport: accounts, rooms, the WebSocket protocol, the admin API.
// Two runtimes plug into it: server.js (Node: http + ws) and worker.mjs (a Cloudflare Durable Object).
// A "socket" is anything with send(text), close(), terminate(), readyState (1 = open) and on('message' | 'close' | 'error' | 'pong', fn).
// An "http request/response" is the small subset of Node's that admin.js uses (headers, method, on('data'/'end'), writeHead, end).
const { Room, MIN, MAX } = require('./game');
const S = require('./storage');
const { Content } = require('./content');
const Admin = require('./admin');
const { verifyIdToken } = require('./google');

async function createCore(store) {
  let secret = process.env.SESSION_SECRET || await store.getSetting('secret');
  if (!secret) { secret = S.randomHex(32); await store.setSetting('secret', secret); }
  const sign = S.signer(secret);
  const content = await new Content(store).load();

  const tries = new Map();        // ip -> [timestamps], slows down password guessing
  const rooms = new Map();        // code -> Room
  const userRoom = new Map();     // uid -> code
  const online = new Map();       // uid -> socket

  const ipOf = req => (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  function tooMany(ip) {
    const now = Date.now(), a = (tries.get(ip) || []).filter(t => now - t < 60000);
    a.push(now); tries.set(ip, a);
    if (tries.size > 500) for (const [k, v] of tries) if (!v.some(t => now - t < 60000)) tries.delete(k);   // no timer: an idle server must be able to go to sleep
    return a.length > (Number(process.env.LOGIN_LIMIT) || 12);
  }
  const adminApi = Admin.install({
    store, content, secret, rooms, userRoom, online, ipOf, tooMany,
    // sign a player out of everything: tell him why, take him out of his room, close his connection
    kick(uid, msg, kind) {
      const ws = online.get(uid);
      const room = rooms.get(userRoom.get(uid)); if (room) { userRoom.delete(uid); room.leave(uid); }
      if (ws) { try { ws.send(JSON.stringify({ t: kind || 'kicked', msg })); } catch (e) {} setTimeout(() => { try { ws.close(); } catch (e) {} }, 100); }
      online.delete(uid);
    }
  });

  // the API part of the web server; true when the request was answered
  async function handleApi(req, res, url) {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return true; }
    if (url.pathname === '/api/config') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(Object.assign({}, content.publicConfig(), { gid: process.env.GOOGLE_CLIENT_ID || '' }))); return true; }
    if (await adminApi.asset(req, res, url)) return true;
    if (await adminApi.handle(req, res, url)) return true;
    return false;
  }

  function genCode() {
    for (let n = 0; n < 50; n++) { const c = String(10000 + Math.floor(Math.random() * 90000)); if (!rooms.has(c)) return c; }
    return null;
  }
  function destroyed(room) { rooms.delete(room.code); for (const [u, c] of userRoom) if (c === room.code) userRoom.delete(u); }

  function connection(ws, ip) {
    let user = null, lastPong = Date.now();
    const send = m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    const err = (code, msg) => send({ t: 'err', code, msg });
    const touchRoom = () => { lastPong = Date.now(); if (user) { const rm = rooms.get(userRoom.get(user.id)); if (rm) rm.seen(user.id); } };
    ws.on('pong', touchRoom);

    async function signedIn(u) {
      const ban = await store.activeBan(u.id);
      if (ban) { send({ t: 'banned', msg: banMsg(ban) }); return; }
      await store.touchLogin(u.id);
      user = { id: u.id, uid: u.id, name: u.name }; u = user;
      const old = online.get(u.id);
      if (old && old !== ws) { try { old.send(JSON.stringify({ t: 'replaced' })); old.close(); } catch (e) {} }
      online.set(u.id, ws);
      const mail = await store.emailOf(u.id);
      send({ t: 'authed', name: u.name, email: mail || '', admin: !!mail && S.emailKey(mail) === S.emailKey(process.env.OWNER_EMAIL || 'ana.wolfish@gmail.com'), token: await sign.make(u.id, 60, await store.tokenVersion(u.id)), cv: content.version });
      const room = rooms.get(userRoom.get(u.id));
      if (room && room.idx(u.id) >= 0) room.attach(u.id, send);
    }
    const banMsg = b => 'حسابك محظور. السبب: ' + b.reason + (b.until ? ' (لحد ' + new Date(b.until).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' }) + ')' : ' (حظر دائم)');
    const myRoom = () => user && rooms.get(userRoom.get(user.id));

    ws.on('message', async raw => {
      touchRoom();
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (!m || typeof m.t !== 'string') return;
      try {
        if (m.t === 'ping') return send({ t: 'pong' });
        if (m.t === 'avail') {
          const name = S.norm(m.name), bad = S.validName(name);
          if (bad) return send({ t: 'avail', ok: false, msg: bad });
          const ex = await store.byKey(S.nameKey(name));
          return send({ t: 'avail', ok: !ex, msg: ex ? 'الاسم ده محجوز لحساب تاني.' : '' });
        }
        if (m.t === 'register' || m.t === 'login') {
          if (tooMany(ip)) return err('slow', 'محاولات كتير. استنى دقيقة وجرب تاني.');
          const pass = String(m.pass || '');
          if (!pass || pass.length > 1024) return err('pass', 'اكتب كلمة سر.');
          if (m.t === 'register') {
            const name = S.norm(m.name), email = String(m.email || '').trim(), bad = S.validName(name);
            if (!S.validEmail(email)) return err('email', 'اكتب إيميل صحيح.');
            if (bad) return err('name', bad);
            const h = await S.newHash(pass);
            const r = await store.createWithEmail(name, S.nameKey(name), h.salt, h.hash, email, S.emailKey(email));
            if (r.taken === 'email') return err('taken', 'الإيميل ده متسجل قبل كده. سجّل دخول بيه.');
            if (r.taken) return err('taken', 'الاسم ده محجوز لحساب تاني. اختار اسم مختلف.');
            return signedIn(r.user);
          }
          // sign in: by e-mail, or by name for accounts made before e-mails existed
          const id = String(m.email || m.name || '').trim();
          const u = id.includes('@') ? await store.byEmailKey(S.emailKey(id)) : await store.byKey(S.nameKey(S.norm(id)));
          if (!u || !(await S.checkPass(pass, u.salt, u.hash))) return err('login', 'الإيميل أو كلمة السر غلط.');
          return signedIn({ id: u.id, name: u.name });
        }
        if (m.t === 'google') {
          if (tooMany(ip)) return err('slow', 'محاولات كتير. استنى دقيقة وجرب تاني.');
          let g; try { g = await verifyIdToken(m.cred, process.env.GOOGLE_CLIENT_ID || ''); } catch (e) { return err('google', 'تعذّر التحقق من حساب Google (' + e.message + ').'); }
          const ekey = S.emailKey(g.email), ex = await store.byEmailKey(ekey);
          if (ex) return signedIn({ id: ex.id, name: ex.name });
          const name = S.norm(m.name || '');
          if (!name) return send({ t: 'gname', suggest: Array.from(S.norm(g.name || g.email.split('@')[0])).slice(0, 100).join('') });
          const bad = S.validName(name); if (bad) return send({ t: 'gname', suggest: name, msg: bad });
          const h = await S.newHash(S.randomHex(24));
          const r = await store.createWithEmail(name, S.nameKey(name), h.salt, h.hash, g.email, ekey);
          if (r.taken) return send({ t: 'gname', suggest: name, msg: r.taken === 'name' ? 'الاسم ده محجوز لحساب تاني. اختار اسم مختلف.' : 'الإيميل ده متسجل قبل كده.' });
          return signedIn(r.user);
        }
        if (m.t === 'resume') {
          const d = await sign.read(m.token); const u = d && await store.byId(d.u);
          if (!u || u.tv !== d.v) return send({ t: 'noauth' });
          return signedIn(u);
        }
        if (!user) return send({ t: 'noauth' });

        if (m.t === 'create') {
          if (userRoom.has(user.id)) return err('busy', 'إنت في غرفة بالفعل. اخرج منها الأول.');
          const cap = Number(m.cap);
          if (!Number.isInteger(cap) || cap < MIN || cap > MAX) return err('cap', 'عدد اللاعبين من ٣ لـ٨.');
          const code = genCode(); if (!code) return err('codes', 'مقدرناش نفتح غرفة دلوقتي.');
          const room = new Room(code, cap, user, destroyed, content); rooms.set(code, room); userRoom.set(user.id, code);
          const secs = (v, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(60, Math.max(15, Math.round(x))) * 1000 : d; };
          room.opts = { decideMs: secs(m.decide, 15000), pickMs: secs(m.pick, 15000), turnMs: secs(m.turn, 60000) }; room.applyOpts();
          room.attach(user.id, send); return;
        }
        if (m.t === 'bots') {
          if (userRoom.has(user.id)) return err('busy', 'إنت في غرفة بالفعل. اخرج منها الأول.');
          const n = Number(m.n);
          if (!Number.isInteger(n) || n < MIN || n > MAX) return err('cap', 'عدد اللاعبين من ٣ لـ٨.');
          const code = 'b' + genCode(); const room = new Room(code, n, user, destroyed, content); rooms.set(code, room); userRoom.set(user.id, code);
          room.attach(user.id, send); room.startBots(user, n); return;
        }
        if (m.t === 'join') {
          const code = String(m.code || '').replace(/\D/g, '');
          const room = rooms.get(code);
          if (!room || room.closed || room.bots) return err('nocode', 'الكود ده مش موجود. اتأكد منه مع صاحبك.');
          const mine = userRoom.get(user.id);
          if (mine && mine !== code) return err('busy', 'إنت في غرفة تانية. اخرج منها الأول.');
          if (room.idx(user.id) < 0) {
            const bad = room.add(user);
            if (bad === 'full') return err('full', 'الغرفة دي كاملة.');
            if (bad === 'started') return err('started', 'اللعبة في الغرفة دي بدأت بالفعل.');
          }
          userRoom.set(user.id, code); room.attach(user.id, send); return;
        }
        const room = myRoom();
        if (m.t === 'leave') { if (room) { userRoom.delete(user.id); room.leave(user.id); } return send({ t: 'left' }); }
        if (!room) return;
        if (m.t === 'start') { const bad = room.start(user.id); if (bad === 'notfull') err('notfull', 'اللعب مش هيبدأ غير لما كل اللاعبين يدخلوا.'); return; }
        if (m.t === 'fillbots') { room.fillBots(user.id); return; }
        if (m.t === 'again') return room.again(user.id);
        if (m.t === 'act') return room.act(user.id, m);
      } catch (e) { console.error('ws error', e); err('server', 'حصلت مشكلة عندنا. جرب تاني.'); }
    });
    ws.on('close', () => {
      clearInterval(hb);
      if (!user) return;
      if (online.get(user.id) === ws) online.delete(user.id);
      const room = rooms.get(userRoom.get(user.id)); if (room) room.detach(user.id, send);
    });
    ws.on('error', () => {});
    // a connection that has not been heard from for 25 s is cut, and the room puts a bot in that seat.
    // (Node: ws ping/pong every 5 s answers for the browser; Cloudflare has no ping frames, so the page's own 'ping' message does.)
    const hb = setInterval(() => { if (Date.now() - lastPong > 25000) { ws.terminate(); return; } try { if (ws.ping) ws.ping(); } catch (e) {} }, 5000);
  }

  return { store, content, rooms, userRoom, online, handleApi, connection, ipOf };
}

module.exports = { createCore };
