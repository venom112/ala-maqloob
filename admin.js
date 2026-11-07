'use strict';
// The admin side: Google sign-in, permissions, and the REST API the /admin panel talks to.
// One owner (OWNER_EMAIL, default ana.wolfish@gmail.com) can do everything and appoints other admins with chosen permissions.
// Roles are looked up on every request, so removing an admin or changing his permissions takes effect at once.
const S = require('./storage');
const C = require('./content');
const SH = require('./shop');
const { verifyIdToken } = require('./google');

const OWNER_EMAIL = () => (process.env.OWNER_EMAIL || 'ana.wolfish@gmail.com').trim();
const PERMS = {
  'players.view':   'يشوف حسابات اللاعبين',
  'players.ban':    'يحظر ويفك الحظر',
  'players.edit':   'يغيّر اسم لاعب أو كلمة سره ويطرده من الاتصال',
  'players.delete': 'يمسح حسابات',
  'cards.edit':     'يضيف ويعدّل ويمسح الكروت',
  'assets.edit':    'يغيّر الصور (الشعار، ضهر الكارت، العملات، صور الكروت)',
  'settings.edit':  'يغيّر إعدادات اللعبة (النقط، الوقت، أسماء البوتات، النصوص)',
  'shop.edit':      'يدير المتجر: العناصر والباكجات والأسعار وبيانات الدفع ويدّي عملات',
  'orders.manage':  'يراجع طلبات شراء الباكجات ويوافق عليها أو يرفضها',
  'audit.view':     'يشوف سجل العمليات',
  'rooms.manage':   'يشوف الغرف الشغالة ويقفلها'
};
const PERM_KEYS = Object.keys(PERMS);
const IMG_TYPES = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/webp': null };
const MAX_IMG = 1.5 * 1024 * 1024;
const MAX_SND = 400 * 1024;
function sniffAudio(b) {
  if (b.length < 16) return null;
  const s4 = b.slice(0, 4).toString('latin1');
  if (s4 === 'OggS') return 'audio/ogg';
  if (s4 === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (s4.slice(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

function sniff(buf) {
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function install(ctx) {
  const { store, content, secret } = ctx;
  const ownerKey = () => S.emailKey(OWNER_EMAIL());
  const sign = S.signer(secret + ':admin');
  const clientId = () => process.env.GOOGLE_CLIENT_ID || '';

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };
  const fail = (res, code, msg) => json(res, code, { error: msg });
  const readBody = (req, max) => new Promise((ok, no) => {
    const a = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > max) { no(new Error('big')); req.destroy(); } else a.push(c); });
    req.on('end', () => { try { ok(n ? JSON.parse(Buffer.concat(a).toString()) : {}); } catch (e) { no(new Error('json')); } });
    req.on('error', no);
  });

  // who is asking, from the bearer token; null if not an admin (any more)
  async function whoami(req) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    const d = await sign.read(t); if (!d) return null;
    const key = String(d.u);
    if (key === ownerKey()) return { email: OWNER_EMAIL(), key, owner: true, perms: PERM_KEYS.slice() };
    const a = await store.getAdmin(key); if (!a) return null;
    return { email: a.email, key, owner: false, perms: a.perms.filter(p => PERM_KEYS.includes(p)) };
  }
  const can = (me, p) => me.owner || me.perms.includes(p);
  const actor = me => me.email;

  // checks the deck would still work after a change; returns an error text or ''
  function deckProblem(cards, settings) { return C.deckCheck(cards, settings); }

  async function handle(req, res, url) {
    const p = url.pathname, m = req.method;
    if (!p.startsWith('/api/admin/')) return false;
    const route = p.slice('/api/admin/'.length).split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } });
    try {
      /* ---- no session needed ---- */
      if (route[0] === 'config' && m === 'GET') return json(res, 200, { clientId: clientId(), owner: OWNER_EMAIL() }), true;
      if (route[0] === 'login' && m === 'POST') {
        if (ctx.tooMany(ctx.ipOf(req))) return fail(res, 429, 'محاولات كتير. استنى دقيقة.'), true;
        const b = await readBody(req, 8192);
        let g; try { g = await verifyIdToken(b.credential, clientId()); } catch (e) { return fail(res, 401, 'تعذّر التحقق من حساب Google (' + e.message + ').'), true; }
        const key = S.emailKey(g.email);
        let owner = key === ownerKey(), perms;
        if (owner) perms = PERM_KEYS.slice();
        else { const a = await store.getAdmin(key); if (!a) { await store.log(g.email, 'login.denied', null, null); return fail(res, 403, 'الحساب ده مش أدمن في اللعبة.'), true; } perms = a.perms; }
        await store.log(g.email, 'login', null, null);
        return json(res, 200, { token: await sign.make(key, 0.5, 0), email: owner ? OWNER_EMAIL() : g.email, owner, perms, name: g.name }), true;
      }

      /* ---- everything below needs a signed-in admin ---- */
      const me = await whoami(req);
      if (!me) return fail(res, 401, 'سجّل دخول تاني.'), true;
      const need = perm => { if (!can(me, perm)) { fail(res, 403, 'مفيش عندك صلاحية لده.'); return false; } return true; };

      if (route[0] === 'me' && m === 'GET') return json(res, 200, { email: me.email, owner: me.owner, perms: me.perms, permLabels: PERMS, ops: C.OPS, targets: C.TARGET_LABEL, slots: C.IMAGE_SLOTS }), true;

      /* ---- stats ---- */
      if (route[0] === 'stats' && m === 'GET') {
        const out = { players: can(me, 'players.view') ? await store.count() : null, banned: can(me, 'players.view') ? await store.countBanned() : null, online: ctx.online.size, rooms: ctx.rooms.size, cards: content.cards.filter(c => c.active).length, version: content.version };
        return json(res, 200, out), true;
      }

      /* ---- accounts backup: the owner downloads every account and can put them back after a wipe ---- */
      if (route[0] === 'backup' && m === 'GET') {
        if (!me.owner) return fail(res, 403, 'النسخة الاحتياطية للمالك بس.'), true;
        const users = await store.backupUsers(); await store.log(actor(me), 'users.backup', String(users.length), null);
        return json(res, 200, { app: 'ala-maqloob', at: Date.now(), users }), true;
      }
      if (route[0] === 'restore' && m === 'POST') {
        if (!me.owner) return fail(res, 403, 'الاسترجاع للمالك بس.'), true;
        const b = await readBody(req, 8 * 1024 * 1024);
        if (!b || !Array.isArray(b.users) || b.users.length > 50000) return fail(res, 400, 'ملف النسخة الاحتياطية مش مظبوط.'), true;
        const r = await store.restoreUsers(b.users); await store.log(actor(me), 'users.restore', null, r);
        return json(res, 200, r), true;
      }
      /* ---- players ---- */
      if (route[0] === 'players') {
        if (route.length === 1 && m === 'GET') {
          if (!need('players.view')) return true;
          const q = S.norm(url.searchParams.get('q') || '').slice(0, 30), page = Math.max(0, Number(url.searchParams.get('page')) || 0);
          const r = await store.listUsers(q, 25, page * 25);
          r.rows.forEach(x => { x.online = ctx.online.has(x.id); x.room = ctx.userRoom.get(x.id) || null; });
          return json(res, 200, r), true;
        }
        const id = route[1], u = await store.userFull(id);
        if (!u) return fail(res, 404, 'اللاعب مش موجود.'), true;
        const act = route[2];
        if (m === 'POST' && act === 'ban') {
          if (!need('players.ban')) return true;
          const b = await readBody(req, 4096);
          const reason = S.norm(b.reason).slice(0, 200) || 'مخالفة قواعد اللعبة';
          let until = null;
          if (b.hours != null && b.hours !== '') { const h = Number(b.hours); if (!(h > 0 && h <= 24 * 3650)) return fail(res, 400, 'مدة الحظر غلط.'), true; until = Date.now() + h * 3600e3; }
          await store.ban(id, reason, until, actor(me));
          await store.log(actor(me), 'player.ban', u.name + ' (' + id + ')', { reason, until });
          ctx.kick(id, 'حسابك اتحظر. السبب: ' + reason + (until ? '' : ''), 'banned');
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'POST' && act === 'unban') {
          if (!need('players.ban')) return true;
          const ok = await store.unban(id);
          await store.log(actor(me), 'player.unban', u.name + ' (' + id + ')', null);
          return json(res, 200, { ok }), true;
        }
        if (m === 'POST' && act === 'rename') {
          if (!need('players.edit')) return true;
          const b = await readBody(req, 2048), name = S.norm(b.name), bad = S.validName(name);
          if (bad) return fail(res, 400, bad), true;
          const r = await store.renameUser(id, name, S.nameKey(name));
          if (r === 'taken') return fail(res, 409, 'الاسم ده محجوز لحساب تاني.'), true;
          await store.bumpTokens(id);
          await store.log(actor(me), 'player.rename', id, { from: u.name, to: name });
          ctx.kick(id, 'الأدمن غيّر اسم حسابك لـ"' + name + '". ادخل بالاسم الجديد.', 'kicked');
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'POST' && act === 'password') {
          if (!need('players.edit')) return true;
          const b = await readBody(req, 2048), pass = String(b.pass || '');
          if (pass.length < 4 || pass.length > 64) return fail(res, 400, 'كلمة السر من ٤ لـ٦٤ حرف.'), true;
          const h = await S.newHash(pass); await store.setPassword(id, h.salt, h.hash);
          await store.log(actor(me), 'player.password', u.name + ' (' + id + ')', null);
          ctx.kick(id, 'كلمة سر حسابك اتغيّرت. ادخل بالجديدة.', 'kicked');
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'POST' && act === 'kick') {
          if (!need('players.edit')) return true;
          await store.bumpTokens(id);
          ctx.kick(id, 'الأدمن فصل اتصالك. ادخل تاني.', 'kicked');
          await store.log(actor(me), 'player.kick', u.name + ' (' + id + ')', null);
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'DELETE' && route.length === 2) {
          if (!need('players.delete')) return true;
          ctx.kick(id, 'حسابك اتمسح.', 'kicked');
          await store.deleteUser(id);
          await store.log(actor(me), 'player.delete', u.name + ' (' + id + ')', null);
          return json(res, 200, { ok: true }), true;
        }
        return fail(res, 404, 'غير موجود.'), true;
      }

      /* ---- cards ---- */
      if (route[0] === 'cards') {
        if (route.length === 1 && m === 'GET') {
          if (!can(me, 'cards.edit')) return fail(res, 403, 'مفيش عندك صلاحية لده.'), true;
          return json(res, 200, { cards: content.cards.map(c => Object.assign({}, c, { img: content.cardImg(c), customImg: !!content.assets['card-' + c.id], snd: content.soundFor(c), sndCustom: !!content.sounds[c.id], sfx: content.assets['snd-' + c.id] ? '/a/snd-' + c.id + '?v=' + content.assets['snd-' + c.id] : null })), settings: content.settings, version: content.version }), true;
        }
        if (!need('cards.edit')) return true;
        if (route.length === 1 && m === 'POST') {
          const r = C.cleanCard(await readBody(req, 16384), true); if (r.err) return fail(res, 400, r.err), true;
          const card = Object.assign({ active: true, sort: Math.max(0, ...content.cards.map(c => c.sort)) + 10 }, r.v);
          const bad = deckProblem(content.cards.concat([card]), content.settings); if (bad) return fail(res, 400, bad), true;
          const id = await content.insertCard(card); await content.reload();
          await store.log(actor(me), 'card.create', card.name + ' (#' + id + ')', card);
          return json(res, 200, { ok: true, id }), true;
        }
        if (route[1] === 'reorder' && m === 'POST') {
          const b = await readBody(req, 4096); const ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
          if (ids.length !== content.cards.length || !content.cards.every(c => ids.includes(c.id))) return fail(res, 400, 'ترتيب غلط.'), true;
          for (let i = 0; i < ids.length; i++) await store.run('UPDATE cards SET sort=?, updated=? WHERE id=?', [i * 10, Date.now(), ids[i]]);
          await content.reload(); await store.log(actor(me), 'card.reorder', null, ids);
          return json(res, 200, { ok: true }), true;
        }
        const id = Number(route[1]), card = content.cards.find(c => c.id === id);
        if (!card) return fail(res, 404, 'الكارت مش موجود.'), true;
        if (route[2] === 'sound' && route.length === 3 && (m === 'PUT' || m === 'DELETE')) {
          const all = Object.assign({}, content.sounds);
          if (m === 'PUT') { const b = await readBody(req, 16384); const sn = C.cleanSound(b.snd); if (!sn) return fail(res, 400, 'الصوت مش مظبوط: لازم قايمة خطوات (١–٢٤) كل واحدة k=t أو n وأرقام في الحدود.'), true; all[id] = sn; }
          else delete all[id];
          await store.setSetting('sounds', JSON.stringify(all));
          await content.reload(); await store.log(actor(me), m === 'PUT' ? 'card.sound' : 'card.sound.reset', card.name + ' (#' + id + ')', m === 'PUT' ? all[id] : null);
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'PATCH' && route.length === 2) {
          const r = C.cleanCard(await readBody(req, 16384), false); if (r.err) return fail(res, 400, r.err), true;
          const next = Object.assign({}, card, r.v);
          const bad = deckProblem(content.cards.map(c => c.id === id ? next : c), content.settings); if (bad) return fail(res, 400, bad), true;
          await store.run('UPDATE cards SET name=?,symbol=?,descr=?,pen_descr=?,cnt=?,active=?,color=?,power=?,penalty=?,sort=?,updated=? WHERE id=?',
            [next.name, next.symbol, next.descr, next.penDescr, next.cnt, next.active ? 1 : 0, next.color, JSON.stringify(next.power), JSON.stringify(next.penalty), next.sort, Date.now(), id]);
          await content.reload(); await store.log(actor(me), 'card.update', card.name + ' (#' + id + ')', r.v);
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'DELETE' && route.length === 2) {
          const bad = deckProblem(content.cards.filter(c => c.id !== id), content.settings); if (bad) return fail(res, 400, bad), true;
          await store.run('UPDATE cards SET deleted=1, updated=? WHERE id=?', [Date.now(), id]);
          await store.delAsset('card-' + id); await store.delAsset('snd-' + id);
          await content.reload(); await store.log(actor(me), 'card.delete', card.name + ' (#' + id + ')', null);
          return json(res, 200, { ok: true }), true;
        }
        return fail(res, 404, 'غير موجود.'), true;
      }

      /* ---- shop: items, packs, payment details, orders ---- */
      if (route[0] === 'shop') {
        const sub = route[1];
        if (sub === 'orders') {
          if (!need('orders.manage')) return true;
          if (route.length === 1 + 1 && m === 'GET') return json(res, 200, { orders: await store.ordersAll(url.searchParams.get('status') || '') }), true;
          const oid = Number(route[2]), act = route[3];
          if (m === 'POST' && Number.isInteger(oid) && (act === 'approve' || act === 'reject')) {
            const o = await store.orderDecide(oid, act === 'approve' ? 'approved' : 'rejected', actor(me));
            if (!o) return fail(res, 409, 'الطلب ده اتراجع قبل كده أو مش موجود.'), true;
            const u = 'u' + o.uid;
            if (act === 'approve') {   // the pack is delivered: coins first, then every item in it
              if (o.coins) await store.addCoins(u, o.coins);
              for (const it of JSON.parse(o.items || '[]')) await store.own(u, it);
            }
            await store.log(actor(me), 'order.' + act, '#' + o.id + ' ' + o.uname, { pack: o.pack_name, egp: o.price_egp });
            const ws = ctx.online.get(u);
            if (ws) { try { ws.send(JSON.stringify({ t: 'coins', order: act === 'approve' ? 1 : 2, pack: o.pack_name, coins: await store.getCoins(u) })); } catch (e) {} }
            return json(res, 200, { ok: true }), true;
          }
          return fail(res, 404, 'غير موجود.'), true;
        }
        if (!need('shop.edit')) return true;
        if (!sub && m === 'GET') return json(res, 200, { items: await store.shopItems(), packs: await store.packList(), cfg: content.shopCfg, kinds: SH.KINDS, media: Object.keys(content.assets).filter(k => k.startsWith('shop')) }), true;
        if (sub === 'config' && m === 'PUT') {
          const r = SH.cleanCfg(await readBody(req, 4096)); if (r.err) return fail(res, 400, r.err), true;
          await store.setSetting('shop', JSON.stringify(Object.assign({}, content.shopCfg, r.v))); await content.reload();
          await store.log(actor(me), 'shop.config', null, r.v); return json(res, 200, { ok: true }), true;
        }
        if (sub === 'grant' && m === 'POST') {
          const b = await readBody(req, 2048), id = await store.idByName(S.nameKey(S.norm(b.name))), n = Math.floor(Number(b.coins));
          if (!id) return fail(res, 404, 'مفيش لاعب بالاسم ده.'), true;
          if (!Number.isFinite(n) || !n || Math.abs(n) > 1000000) return fail(res, 400, 'العدد غلط.'), true;
          if (!(await store.addCoins(id, n))) return fail(res, 400, 'رصيد اللاعب أقل من المبلغ المخصوم.'), true;
          await store.log(actor(me), 'shop.grant', b.name, { coins: n });
          const ws = ctx.online.get(id); if (ws) { try { ws.send(JSON.stringify({ t: 'coins', coins: await store.getCoins(id) })); } catch (e) {} }
          return json(res, 200, { ok: true, coins: await store.getCoins(id) }), true;
        }
        if (sub === 'items') {
          if (route.length === 2 && m === 'POST') {
            const r = SH.cleanItem(await readBody(req, 4096)); if (r.err) return fail(res, 400, r.err), true; const v = r.v;
            const id = await store.insert('INSERT INTO shop_items(kind,name,emoji,price,active,sort) VALUES(?,?,?,?,?,?)', [v.kind, v.name, v.emoji, v.price, v.active ? 1 : 0, v.sort]);
            await content.reload(); await store.log(actor(me), 'shop.item.create', v.name + ' (#' + id + ')', v); return json(res, 200, { ok: true, id }), true;
          }
          const id = Number(route[2]), it = (await store.shopItems()).find(x => x.id === id);
          if (!it) return fail(res, 404, 'العنصر مش موجود.'), true;
          if (route[3] === 'media') {   // a picture and a sound, each optional: ?type=image | sound
            const snd = (url.searchParams.get('type') || 'image') === 'sound', slot = (snd ? 'shopsnd-' : 'shop-') + id;
            if (m === 'DELETE') { await store.delAsset(slot); await content.reload(); return json(res, 200, { ok: true }), true; }
            if (m === 'PUT') {
              const b = await readBody(req, 1 * 1024 * 1024), data = Buffer.from(String(b.data || ''), 'base64');
              const max = snd ? MAX_SND : 300 * 1024;
              if (!data.length || data.length > max) return fail(res, 400, 'الملف لازم يكون أقل من ' + Math.round(max / 1024) + ' كيلو.'), true;
              const mime = snd ? sniffAudio(data) : sniff(data);
              if (!mime) return fail(res, 400, snd ? 'الصوت لازم MP3 أو WAV أو OGG أو M4A.' : 'الصورة لازم PNG أو JPG أو WEBP.'), true;
              await store.putAsset(slot, mime, data, actor(me)); await content.reload();
              await store.log(actor(me), 'shop.item.media', it.name + ' (#' + id + ') ' + (snd ? 'sound' : 'image'), { bytes: data.length, mime }); return json(res, 200, { ok: true }), true;
            }
          }
          if (m === 'PATCH' && route.length === 3) {
            const r = SH.cleanItem(Object.assign({}, it, await readBody(req, 4096))); if (r.err) return fail(res, 400, r.err), true; const v = r.v;
            await store.run('UPDATE shop_items SET kind=?,name=?,emoji=?,price=?,active=?,sort=? WHERE id=?', [v.kind, v.name, v.emoji, v.price, v.active ? 1 : 0, v.sort, id]);
            await content.reload(); await store.log(actor(me), 'shop.item.update', it.name + ' (#' + id + ')', v); return json(res, 200, { ok: true }), true;
          }
          if (m === 'DELETE' && route.length === 3) {
            await store.run('DELETE FROM shop_items WHERE id=?', [id]); await store.run('DELETE FROM owned WHERE item_id=?', [id]); await store.delAsset('shop-' + id); await store.delAsset('shopsnd-' + id);
            await content.reload(); await store.log(actor(me), 'shop.item.delete', it.name + ' (#' + id + ')', null); return json(res, 200, { ok: true }), true;
          }
        }
        if (sub === 'packs') {
          const ids = (await store.shopItems()).map(x => x.id);
          if (route.length === 2 && m === 'POST') {
            const r = SH.cleanPack(await readBody(req, 8192), ids); if (r.err) return fail(res, 400, r.err), true; const v = r.v;
            const id = await store.insert('INSERT INTO packs(name,descr,price_egp,coins,items,active,sort) VALUES(?,?,?,?,?,?,?)', [v.name, v.descr, v.priceEgp, v.coins, JSON.stringify(v.items), v.active ? 1 : 0, v.sort]);
            await store.log(actor(me), 'shop.pack.create', v.name + ' (#' + id + ')', v); return json(res, 200, { ok: true, id }), true;
          }
          const id = Number(route[2]), pk = (await store.packList()).find(x => x.id === id);
          if (!pk) return fail(res, 404, 'الباكج مش موجود.'), true;
          if (m === 'PATCH' && route.length === 3) {
            const r = SH.cleanPack(Object.assign({}, pk, await readBody(req, 8192)), ids); if (r.err) return fail(res, 400, r.err), true; const v = r.v;
            await store.run('UPDATE packs SET name=?,descr=?,price_egp=?,coins=?,items=?,active=?,sort=? WHERE id=?', [v.name, v.descr, v.priceEgp, v.coins, JSON.stringify(v.items), v.active ? 1 : 0, v.sort, id]);
            await store.log(actor(me), 'shop.pack.update', pk.name + ' (#' + id + ')', v); return json(res, 200, { ok: true }), true;
          }
          if (m === 'DELETE' && route.length === 3) { await store.run('DELETE FROM packs WHERE id=?', [id]); await store.log(actor(me), 'shop.pack.delete', pk.name + ' (#' + id + ')', null); return json(res, 200, { ok: true }), true; }
        }
        return fail(res, 404, 'غير موجود.'), true;
      }

      /* ---- images ---- */
      if (route[0] === 'assets') {
        if (!need('assets.edit')) return true;
        if (route.length === 1 && m === 'GET') {
          const list = Object.keys(C.IMAGE_SLOTS).map(k => ({ slot: k, label: C.IMAGE_SLOTS[k].label, url: content.imgUrl(k, C.IMAGE_SLOTS[k].def), custom: !!content.assets[k] }));
          return json(res, 200, { slots: list }), true;
        }
        const slot = route[1];
        if (!slot || /^shop/.test(slot) || !C.slotOk(slot)) return fail(res, 404, 'مكان الصورة غير معروف.'), true;
        if (/^(card|snd)-/.test(slot) && !content.cards.some(c => 'card-' + c.id === slot || 'snd-' + c.id === slot)) return fail(res, 404, 'الكارت مش موجود.'), true;
        if (m === 'PUT') {
          const isSnd = slot.startsWith('snd-');
          const b = await readBody(req, 2.4 * 1024 * 1024);
          const data = Buffer.from(String(b.data || ''), 'base64');
          if (isSnd) { if (!data.length || data.length > MAX_SND) return fail(res, 400, 'ملف الصوت لازم يكون أقل من ٤٠٠ كيلو.'), true; }
          else if (!data.length || data.length > MAX_IMG) return fail(res, 400, 'الصورة لازم تكون أقل من ١٫٥ ميجا.'), true;
          const mime = isSnd ? sniffAudio(data) : sniff(data);
          if (!mime) return fail(res, 400, isSnd ? 'نوع الصوت لازم MP3 أو WAV أو OGG أو M4A.' : 'نوع الصورة لازم PNG أو JPG أو WEBP.'), true;
          await store.putAsset(slot, mime, data, actor(me)); await content.reload();
          await store.log(actor(me), 'asset.set', slot, { bytes: data.length, mime });
          return json(res, 200, { ok: true, url: content.imgUrl(slot, '') }), true;
        }
        if (m === 'DELETE') {
          const ok = await store.delAsset(slot); await content.reload();
          await store.log(actor(me), 'asset.reset', slot, null);
          return json(res, 200, { ok }), true;
        }
        return fail(res, 404, 'غير موجود.'), true;
      }

      /* ---- settings ---- */
      if (route[0] === 'settings') {
        if (!need('settings.edit')) return true;
        if (m === 'GET') return json(res, 200, { settings: content.settings, range: C.SETTING_RANGE, defaults: C.DEFAULT_SETTINGS }), true;
        if (m === 'PUT') {
          const r = C.cleanSettings(await readBody(req, 8192)); if (r.err) return fail(res, 400, r.err), true;
          const next = Object.assign({}, content.settings, r.v);
          const bad = deckProblem(content.cards, next); if (bad) return fail(res, 400, bad), true;
          await store.setSetting('cfg', JSON.stringify(next)); await content.reload();
          await store.log(actor(me), 'settings.update', null, r.v);
          return json(res, 200, { ok: true }), true;
        }
      }

      /* ---- admins: only the owner ---- */
      if (route[0] === 'admins') {
        if (!me.owner) return fail(res, 403, 'الأونر بس هو اللي يدير الأدمنز.'), true;
        if (m === 'GET') return json(res, 200, { owner: OWNER_EMAIL(), admins: await store.listAdmins(), perms: PERMS }), true;
        if (m === 'PUT') {
          const b = await readBody(req, 4096), email = String(b.email || '').trim();
          if (!S.validEmail(email)) return fail(res, 400, 'الإيميل غلط.'), true;
          const key = S.emailKey(email);
          if (key === ownerKey()) return fail(res, 400, 'ده إيميل الأونر. صلاحياته كاملة دايمًا.'), true;
          const perms = Array.isArray(b.perms) ? b.perms.filter(x => PERM_KEYS.includes(x)) : [];
          if (!perms.length) return fail(res, 400, 'اختار صلاحية واحدة على الأقل.'), true;
          await store.putAdmin(key, email, Array.from(new Set(perms)), actor(me));
          await store.log(actor(me), 'admin.set', email, perms);
          return json(res, 200, { ok: true }), true;
        }
        if (m === 'DELETE') {
          const key = S.emailKey(String(route[1] || '')); const ok = await store.removeAdmin(key);
          await store.log(actor(me), 'admin.remove', key, null);
          return json(res, 200, { ok }), true;
        }
      }

      /* ---- audit log ---- */
      if (route[0] === 'audit' && m === 'GET') {
        if (!need('audit.view')) return true;
        return json(res, 200, await store.audit(50, Math.max(0, Number(url.searchParams.get('page')) || 0) * 50)), true;
      }

      /* ---- live rooms ---- */
      if (route[0] === 'rooms') {
        if (!need('rooms.manage')) return true;
        if (m === 'GET') return json(res, 200, { rooms: Array.from(ctx.rooms.values()).map(r => ({ code: r.code, status: r.status, cap: r.cap, bots: r.bots, game: r.gameNo, players: r.roster.map(x => x.name + (x.bot ? ' (بوت)' : x.sub ? ' (فصل)' : '')) })) }), true;
        if (m === 'POST' && route[2] === 'close') {
          const r = ctx.rooms.get(route[1]); if (!r) return fail(res, 404, 'الغرفة مش موجودة.'), true;
          r.close('الأدمن قفل الغرفة.'); await store.log(actor(me), 'room.close', route[1], null);
          return json(res, 200, { ok: true }), true;
        }
      }
      return fail(res, 404, 'غير موجود.'), true;
    } catch (e) {
      if (e.message === 'big') return fail(res, 413, 'الطلب كبير.'), true;
      if (e.message === 'json') return fail(res, 400, 'طلب غلط.'), true;
      console.error('admin error', e); return fail(res, 500, 'حصلت مشكلة في السيرفر.'), true;
    }
  }

  // public: an uploaded picture, by slot
  async function asset(req, res, url) {
    const m = /^\/a\/([a-z0-9-]+)$/.exec(url.pathname); if (!m) return false;
    const a = C.slotOk(m[1]) && await store.getAsset(m[1]);
    if (!a) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return true; }
    const data = Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data);
    res.writeHead(200, { 'content-type': a.mime, 'x-content-type-options': 'nosniff', 'content-length': data.length, 'cache-control': url.searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'no-cache', 'content-security-policy': "default-src 'none'" });
    res.end(data); return true;
  }
  return { handle, asset, PERMS };
}

module.exports = { install, PERMS, OWNER_EMAIL };
