'use strict';
// The game shop: reactions (emoji, pictures, sounds) bought with shop coins, and coin packs bought with real money.
// Coins are earned by winning a game against other people. Real money never touches the server: a player asks for a pack, pays by
// Instapay or an e-wallet, sends the transfer screenshot on WhatsApp, and an admin approves the order in the panel.
const KINDS = { emoji: 'إيموجي', image: 'صورة', sound: 'صوت' };
const DEFAULTS = { winReward: 20, payNumber: '01002540876', waNumber: '01002540876', payNote: '' };
const num = (v, lo, hi) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const str = (v, max) => Array.from(String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim()).slice(0, max).join('');

function cleanItem(b) {
  if (!b || typeof b !== 'object') return { err: 'بيانات غلط.' };
  const kind = KINDS[b.kind] ? String(b.kind) : 'emoji';   // kept for old rows; an item may now carry an emoji, a picture and a sound together
  const name = str(b.name, 24); if (!name) return { err: 'اكتب اسم للعنصر.' };
  const price = num(b.price, 0, 100000); if (price == null) return { err: 'السعر رقم من ٠ لـ١٠٠٠٠٠ (٠ = مجاني للكل).' };
  const emoji = str(b.emoji, 8);
  return { v: { kind, name, price, emoji, active: b.active !== false, sort: num(b.sort, 0, 100000) == null ? 0 : num(b.sort, 0, 100000) } };
}
function cleanPack(b, itemIds) {
  if (!b || typeof b !== 'object') return { err: 'بيانات غلط.' };
  const name = str(b.name, 30); if (!name) return { err: 'اكتب اسم الباكج.' };
  const priceEgp = num(b.priceEgp, 1, 1000000); if (priceEgp == null) return { err: 'السعر بالجنيه رقم صحيح.' };
  const coins = num(b.coins, 0, 10000000); if (coins == null) return { err: 'عدد العملات رقم صحيح.' };
  const items = Array.isArray(b.items) ? Array.from(new Set(b.items.map(Number).filter(x => itemIds.includes(x)))).slice(0, 60) : [];
  if (!coins && !items.length) return { err: 'الباكج لازم يديك عملات أو عناصر.' };
  return { v: { name, descr: str(b.descr, 120), priceEgp, coins, items, active: b.active !== false, sort: num(b.sort, 0, 100000) || 0 } };
}
function cleanCfg(b) {
  b = b || {}; const v = {};
  if (b.winReward !== undefined) { const x = num(b.winReward, 0, 100000); if (x == null) return { err: 'مكافأة الفوز رقم من ٠ لـ١٠٠٠٠٠.' }; v.winReward = x; }
  for (const k of ['payNumber', 'waNumber']) if (b[k] !== undefined) { const x = String(b[k]).replace(/\D/g, ''); if (x.length < 10 || x.length > 15) return { err: 'الرقم لازم يكون من ١٠ لـ١٥ رقم.' }; v[k] = x; }
  if (b.payNote !== undefined) v.payNote = str(b.payNote, 200);
  return { v };
}
// the number as wa.me wants it: Egyptian 01xxxxxxxxx becomes 201xxxxxxxxx
const waDigits = n => { n = String(n || '').replace(/\D/g, ''); return n.startsWith('0') ? '2' + n : n; };

async function seed(store) {
  if ((await store.get('SELECT COUNT(*) c FROM shop_items')).c) return;
  const ins = (kind, name, emoji, price, sort) => store.insert('INSERT INTO shop_items(kind,name,emoji,price,active,sort) VALUES(?,?,?,?,1,?)', [kind, name, emoji, price, sort]);
  const ids = [];
  const free = [['👍', 'تمام'], ['😂', 'هههه'], ['😮', 'يا نهار']]; let s = 0;
  for (const [e, n] of free) await ins('emoji', n, e, 0, s += 10);
  for (const [e, n, p] of [['😎', 'كول', 30], ['🔥', 'نار', 30], ['👏', 'برافو', 40], ['😡', 'غضبان', 40], ['🤡', 'مهرّج', 60], ['💀', 'مت', 60], ['😭', 'بعيّط', 60], ['👑', 'ملك', 120]]) ids.push(await ins('emoji', n, e, p, s += 10));
  const pk = (name, descr, egp, coins, items, sort) => store.insert('INSERT INTO packs(name,descr,price_egp,coins,items,active,sort) VALUES(?,?,?,?,?,1,?)', [name, descr, egp, coins, JSON.stringify(items), sort]);
  await pk('باكج البداية', '٢٠٠ عملة تشتري بيها اللي تحبه', 20, 200, [], 10);
  await pk('باكج المحترفين', '٨٠٠ عملة + إيموجي الملك والمهرّج', 70, 800, [ids[7], ids[4]], 20);
  await pk('باكج الأساطير', '٢٠٠٠ عملة + كل الإيموجيات', 150, 2000, ids, 30);
}
module.exports = { KINDS, DEFAULTS, cleanItem, cleanPack, cleanCfg, waDigits, seed };
