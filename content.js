'use strict';
// Everything the admin can change about the game: the cards, the numbers, the texts and the images.
// It lives in the database; this module loads it, checks every edit, and hands each game a frozen copy (a "snapshot"),
// so an edit never changes a game that is already being played. It takes effect from the next game.
//
// A card's power and penalty are not code. They are built from a small fixed set of effects with numbers,
// so the admin panel can make new cards without anyone being able to run arbitrary code on the server.

const OPS = {
  steal:    { label: 'سرقة نفوذ',        targets: ['pick', 'random'],                         max: 5 },  // the player takes n points from the target
  inf_loss: { label: 'خسارة نفوذ',       targets: ['pick', 'random', 'all_others', 'self'],   max: 5 },
  inf_gain: { label: 'كسب نفوذ',         targets: ['self', 'pick', 'random', 'all_others'],   max: 5 },
  draw:     { label: 'سحب كروت',         targets: ['self', 'pick', 'random', 'all_others'],   max: 3 },
  drop:     { label: 'رمي كروت من الإيد', targets: ['pick', 'random', 'all_others', 'self'],   max: 3 },
  skip:     { label: 'تخطّي الدور الجاي', targets: ['pick', 'random', 'all_others'],           max: 1 },
  swap:     { label: 'تبديل كارت عشوائي من إيده بكارت من إيدك', targets: ['pick', 'random'],     max: 1 },
  peek:     { label: 'كشف كل كروت لاعب لصاحب الكارت بس', targets: ['pick', 'random'],           max: 1 },
  take:     { label: 'سرقة كروت عشوائية من إيده', targets: ['pick', 'random'],                    max: 2 },
  // a defending card against a swap: played in someone else's turn, it blocks the swap and keeps its owner's cards
  guard:    { label: 'يصد هجوم التبديل ويحمي الكروت', targets: ['self'],                       max: 1 },
  // a defending card: played in someone else's turn against a steal aimed at its owner, it sends the steal back to the attacker
  // gets back the points the player lost during the last lap (since his previous turn began); he can play it once every two laps
  regain:   { label: 'يسترد النقط اللي خسرها في آخر لفة من البنك (مرة كل لفتين)', targets: ['self'],       max: 1 },
  // draws two cards instead of one on the player's next turn; playable once every three turns
  smuggle:  { label: 'يسحب كارتين بدل كارت في دوره الجاي (مرة كل ٣ أدوار)', targets: ['self'],      max: 1 },
  // the victim throws away a random card from his hand and takes another one from the draw pile in its place
  recycle:  { label: 'يجبر اللاعب على رمي كارت وسحب غيره', targets: ['all_others', 'pick', 'random'], max: 3 },
  // played face up (nobody can challenge it): the player cannot be attacked for n of his own turns
  immune:   { label: 'يتلعب مكشوف ويديك حصانة ضد كل الهجمات (عدد الأدوار)', targets: ['self'], max: 3 },
  // copies the power of the card played just before (face down, and not caught lying) and runs it as if it were its own
  copy:     { label: 'ينسخ قدرة آخر كارت اتلعب مقلوب وينفذها', targets: ['self'],                         max: 1 },
  // played face up; wins the game on the spot if the player has at least n influence points (otherwise it cannot be played, he keeps it)
  victory:  { label: 'يتلعب مكشوف ويعلن فوزك لو معاك نقط نفوذ (العدد المطلوب)', targets: ['self'],      max: 30 },
  // played out of turn, while someone else's action is open: if it stands, that action is cancelled (it is claimed like a defender)
  judge:    { label: 'يتلعب في أي وقت لإلغاء أي أكشن على الترابيزة (ماعدا السياسي)', targets: ['self'],   max: 1 },
  // defence: cancels any attack (steal / swap) aimed at its player, who then steals a point from a player of his choice
  elder:    { label: 'يصد أي هجوم ضدك ويسحب نقطة من أي لاعب', targets: ['self'], max: 1 },
  reflect:  { label: 'يصد هجوم السرقة ويعكسه', targets: ['self'],                             max: 1 }
};
const TARGET_LABEL = { self: 'صاحب الكارت', pick: 'لاعب يختاره', random: 'لاعب عشوائي', all_others: 'كل اللاعبين التانيين' };
const MAX_OPS = 3;

// pictures: slot -> where the bundled default is. A card's slot is 'card-<id>'.
const IMAGE_SLOTS = {
  logo: { label: 'شعار اللعبة', def: '/img/logo.jpg' },
  back: { label: 'ضهر الكارت', def: '/img/back.jpg' },
  coin1: { label: 'عملة ١ (برونز)', def: '/img/coin1.webp' },
  coin5: { label: 'عملة ٥ (فضة)', def: '/img/coin5.webp' },
  coin10: { label: 'عملة ١٠ (دهب)', def: '/img/coin10.webp' }
};
const cardSlot = id => 'card-' + id;
const slotOk = s => IMAGE_SLOTS[s] || /^card-\d{1,9}$/.test(s);

const DEFAULT_SETTINGS = {
  startCards: 3,      // cards dealt to each player
  startInf: 3,        // influence points each player starts with
  decideSec: 9,       // seconds the others get to challenge or pass
  pickSec: 12,        // seconds to choose a target
  botAfterSec: 25,    // a player cut off this long is replaced by a bot until he is back
  botNames: ['كريم', 'نورا', 'مصطفى', 'سلمى', 'عمر', 'هبة', 'ياسين', 'ليلى'],
  hint: 'في كل دور لازم تسحب ورقة واحدة بس من الكومة، وبعدها تلعب كارت مقلوب وتعلن قوته. الرقم والعملات جنب الاسم هم نقاط النفوذ: ٥ نقط عملة فضية و١٠ نقط عملة دهبية.'
};
const SETTING_RANGE = { startCards: [1, 5], startInf: [1, 10], decideSec: [3, 30], pickSec: [5, 60], botAfterSec: [10, 120] };

const LAWYER = { name: 'المحامي', symbol: '', color: '#2f8f9d', cnt: 8, descr: 'يُلعب في دور غيرك لصد هجوم الفتوّة ورده للمهاجم.', penDescr: 'يخسر نقطة نفوذ للبنك ويتفعّل عليه هجوم الفتوّة',
  power: [{ op: 'reflect', n: 1, target: 'self' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/lawyer.jpg' };
const SHADOW = { name: 'الظل', symbol: '', color: '#6d4bd1', cnt: 6, descr: 'بدّل كارت عشوائي من إيد لاعب تختاره بكارت من إيدك.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'swap', n: 1, target: 'pick' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/shadow.jpg' };
const OFFICER = { name: 'الضابط الفاسد', symbol: '', color: '#8a6d3b', cnt: 6, descr: 'يُلعب لصد هجوم الظل وحماية كروتك من التبديل.', penDescr: 'يخسر نقطة نفوذ وهجوم الظل يتنفذ عليه',
  power: [{ op: 'guard', n: 1, target: 'self' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/officer.jpg' };
const PICKPOCKET = { name: 'النشال', symbol: '', color: '#2f7d46', cnt: 6, descr: 'اسرق كارت عشوائي من إيد أي لاعب.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'take', n: 1, target: 'pick' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/pickpocket.jpg' };
const SPARROW = { name: 'العصفورة', symbol: '', color: '#9a3b8a', cnt: 6, descr: 'اختار لاعب وشوف كل كروته. الكروت بتتكشف ليك إنت لوحدك.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'peek', n: 1, target: 'pick' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/sparrow.jpg' };
const ACCOUNTANT = { name: 'المحاسب', symbol: '', color: '#2e6b4f', cnt: 6, descr: 'استرد كل النقط اللي خسرتها في آخر لفة من البنك. مينفعش تلعبه غير مرة كل لفتين.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'regain', n: 1, target: 'self' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/accountant.jpg' };
const DOCTOR = { name: 'طبيب العصابة', symbol: '', color: '#8f9aa3', cnt: 5, descr: 'استرد نقطتين نفوذ من البنك.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'inf_gain', n: 2, target: 'self' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/doctor.jpg' };
const SMUGGLER = { name: 'المُهرِّب', symbol: '', color: '#5b6b3a', cnt: 4, descr: 'في دورك الجاي هتسحب كارتين بدل كارت. مينفعش تلعبه غير مرة كل ٣ أدوار.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي ويخسر دوره الجاي',
  power: [{ op: 'smuggle', n: 1, target: 'self' }], penalty: { loss: 1, drop: 0, gift: 0, skip: 1 }, defaultImg: '/img/smuggler.jpg' };
const BOMBER = { name: 'المُفجِّر', symbol: '', color: '#3f7a2a', cnt: 4, descr: 'أجبر كل اللاعيبة ما عداك على رمي كارت وسحب غيره.', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي ويرمي كارت من إيده',
  power: [{ op: 'recycle', n: 1, target: 'all_others' }], penalty: { loss: 1, drop: 1, gift: 0, skip: 0 }, defaultImg: '/img/bomber.jpg' };
const POLITICIAN = { name: 'السياسي', symbol: '', color: '#2f5d6b', cnt: 4, descr: 'بيتلعب مكشوف (مفيش تحدي) وبيديك حصانة ضد كل الهجمات لمدة دورين.', penDescr: 'مفيش عقوبة: بيتلعب مكشوف فمفيش كدب',
  power: [{ op: 'immune', n: 2, target: 'self' }], penalty: { loss: 0, drop: 0, gift: 0, skip: 0 }, defaultImg: '/img/politician.jpg' };
const FORGER = { name: 'المُزوِّر', symbol: '', color: '#2b6d6a', cnt: 6, descr: 'انسخ قدرة آخر كارت اتلعب مقلوب ونفّذها كأنها الأصلية.', penDescr: 'قوة الكارت بتتلغي وكروت إيده بتتكشف لكل اللاعيبة',
  power: [{ op: 'copy', n: 1, target: 'self' }], penalty: { loss: 0, drop: 0, gift: 0, skip: 0, reveal: 1 }, defaultImg: '/img/forger.jpg' };
const CITYKEY = { name: 'مفتاح المدينة', symbol: '', color: '#b8892b', cnt: 4, descr: 'بيتلعب مكشوف: أعلن فوزك واستولي على المدينة لو معاك ١٠ نقط نفوذ أو أكتر. لو معاك أقل احتفظ بيه لحد ما تجمّعهم.', penDescr: 'مفيش عقوبة: بيتلعب مكشوف فمفيش كدب',
  power: [{ op: 'victory', n: 10, target: 'self' }], penalty: { loss: 0, drop: 0, gift: 0, skip: 0, reveal: 0 }, defaultImg: '/img/citykey.jpg' };
const JUDGE = { name: 'القاضي', symbol: '', color: '#1f4e79', cnt: 5, descr: 'العبه في أي وقت ضد أي أكشن عادي على الترابيزة عشان تلغيه (مش كروت الدفاع ولا الكروت المكشوفة).', penDescr: 'يخسر نقطة نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'judge', n: 1, target: 'self' }], penalty: { loss: 1, drop: 0, gift: 0, skip: 0, reveal: 0 }, defaultImg: '/img/judge.jpg' };
const ELDER = { name: 'العجوز', symbol: '', color: '#6b2d1a', cnt: 4, descr: 'دفاع: بيلغي أي هجوم عليك (سرقة أو تبديل) وبعدها تسحب نقطة من أي لاعب تختاره.', penDescr: 'يخسر نقطتين نفوذ وقوة الكارت بتتلغي',
  power: [{ op: 'elder', n: 1, target: 'self' }], penalty: { loss: 2, drop: 0, gift: 0, skip: 0, reveal: 0 }, defaultImg: '/img/elder.jpg' };
// zero-copy filler cards: NOT part of the game. Only the rules tests use them (Content.fixed) so their card numbers stay put.
const TEST_FILLERS = [
  { name: 'تجريبي ١', symbol: '♥', color: '#b4121f', cnt: 0, descr: 'قوته لسه متحددتش.', penDescr: 'يخسر نقطتين نفوذ',
    power: [], penalty: { loss: 2, drop: 0, gift: 0 } },
  { name: 'تجريبي ٢', symbol: '♦', color: '#b4121f', cnt: 0, descr: 'قوته لسه متحددتش.', penDescr: 'يخسر نقطة نفوذ ويرمي كارت من إيده',
    power: [], penalty: { loss: 1, drop: 1, gift: 0 } },
  { name: 'تجريبي ٣', symbol: '♣', color: '#17130b', cnt: 0, descr: 'قوته لسه متحددتش.', penDescr: 'يخسر نقطة نفوذ ويدّي المتحدي نقطة',
    power: [], penalty: { loss: 1, drop: 0, gift: 1 } }
];
const SEED_CARDS = [
  { name: 'الفتوّة', symbol: '', color: '#c8a24b', cnt: 8, descr: 'اسرق نقطة نفوذ واحدة من أي لاعب.', penDescr: 'يخسر نقطة نفوذ',
    power: [{ op: 'steal', n: 1, target: 'pick' }], penalty: { loss: 1, drop: 0, gift: 0 }, defaultImg: '/img/fatwa.jpg' },
  LAWYER,
  SHADOW,
  OFFICER,
  PICKPOCKET,
  SPARROW,
  ACCOUNTANT,
  DOCTOR,
  SMUGGLER,
  BOMBER,
  POLITICIAN,
  FORGER,
  CITYKEY,
  JUDGE,
  ELDER
];

/* ---------- validation: every admin edit goes through these ---------- */
const int = (v, lo, hi) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null;
const str = (v, max, min) => { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return v.length >= (min || 0) && Array.from(v).length <= max ? v : null; };

function cleanPower(p) {
  if (!Array.isArray(p)) return { err: 'القوة لازم تبقى قايمة تأثيرات.' };
  if (p.length > MAX_OPS) return { err: 'أقصى عدد تأثيرات للكارت ' + MAX_OPS + '.' };
  const out = [];
  for (const o of p) {
    const def = o && OPS[o.op];
    if (!def) return { err: 'تأثير غير معروف.' };
    const n = (o.op === 'skip' || o.op === 'reflect' || o.op === 'swap' || o.op === 'guard' || o.op === 'peek' || o.op === 'regain' || o.op === 'smuggle' || o.op === 'copy' || o.op === 'judge' || o.op === 'elder') ? 1 : int(o.n, 1, def.max);
    if (n == null) return { err: 'العدد في "' + def.label + '" لازم يكون من ١ لـ' + def.max + '.' };
    if (!def.targets.includes(o.target)) return { err: 'الهدف ده مش مسموح مع "' + def.label + '".' };
    out.push({ op: o.op, n, target: o.target });
  }
  return { v: out };
}
function cleanPenalty(p) {
  p = p || {};
  const loss = int(p.loss == null ? 0 : p.loss, 0, 5), drop = int(p.drop == null ? 0 : p.drop, 0, 3), gift = int(p.gift == null ? 0 : p.gift, 0, 3), skip = int(p.skip == null ? 0 : p.skip, 0, 1), reveal = int(p.reveal == null ? 0 : p.reveal, 0, 1);
  if (loss == null || drop == null || gift == null || skip == null || reveal == null) return { err: 'العقوبة: الخسارة من ٠ لـ٥، الرمي من ٠ لـ٣، الهدية من ٠ لـ٣، خسارة الدور ٠ أو ١، كشف الإيد ٠ أو ١.' };
  return { v: { loss, drop, gift, skip, reveal } };
}
// plain Arabic sentence for a penalty, used when the admin leaves the description empty
function penText(pen) {
  const a = [];
  if (pen.loss) a.push(pen.loss === 1 ? 'يخسر نقطة نفوذ' : pen.loss === 2 ? 'يخسر نقطتين نفوذ' : 'يخسر ' + pen.loss + ' نقط نفوذ');
  if (pen.drop) a.push(pen.drop === 1 ? 'يرمي كارت من إيده' : 'يرمي ' + pen.drop + ' كروت من إيده');
  if (pen.gift) a.push(pen.gift === 1 ? 'يدّي المتحدي نقطة' : 'يدّي المتحدي ' + pen.gift + ' نقط');
  if (pen.skip) a.push('يخسر دوره الجاي');
  if (pen.reveal) a.push('كروت إيده تتكشف للكل');
  return a.length ? a.join(' و') : 'مفيش عقوبة';
}

// full = a new card (every field needed); otherwise only the fields that were sent are checked and returned
function cleanCard(b, full) {
  b = b || {}; const o = {};
  const has = k => full || b[k] !== undefined;
  if (has('name')) { const v = str(b.name, 16, 1); if (v == null) return { err: 'اسم الكارت من ١ لـ١٦ حرف.' }; o.name = v; }
  if (has('symbol')) { const v = str(b.symbol, 2); if (v == null) return { err: 'الرمز حرفين أو رمزين على الأكتر.' }; o.symbol = v; }
  if (has('color')) { if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) return { err: 'اللون لازم يكون كود زي #c8a24b.' }; o.color = String(b.color).toLowerCase(); }
  if (has('cnt')) { const v = int(b.cnt, 0, 60); if (v == null) return { err: 'عدد النسخ في الكوتشينة من ٠ لـ٦٠.' }; o.cnt = v; }
  if (has('descr')) { const v = str(b.descr, 140, 1); if (v == null) return { err: 'وصف القوة مطلوب (لحد ١٤٠ حرف).' }; o.descr = v; }
  if (has('power')) { const r = cleanPower(b.power); if (r.err) return r; o.power = r.v; }
  if (has('penalty')) { const r = cleanPenalty(b.penalty); if (r.err) return r; o.penalty = r.v; }
  if (has('penDescr') || has('penalty')) {
    const pen = o.penalty || (b.penalty ? cleanPenalty(b.penalty).v : null);
    let v = b.penDescr === undefined ? '' : str(b.penDescr, 100);
    if (v == null) return { err: 'وصف العقوبة لحد ١٠٠ حرف.' };
    if (!v && pen) v = penText(pen);
    if (v || full || b.penDescr !== undefined) o.penDescr = v;
  }
  if (has('active')) o.active = b.active === undefined ? true : !!b.active;
  if (b.sort !== undefined) { const v = int(b.sort, -1000, 100000); if (v == null) return { err: 'ترتيب غير صالح.' }; o.sort = v; }
  return { v: o };
}
function cleanSettings(b) {
  b = b || {}; const o = {};
  for (const k of Object.keys(SETTING_RANGE)) {
    if (b[k] === undefined) continue;
    const v = int(b[k], SETTING_RANGE[k][0], SETTING_RANGE[k][1]);
    if (v == null) return { err: 'القيمة "' + k + '" لازم تكون من ' + SETTING_RANGE[k][0] + ' لـ' + SETTING_RANGE[k][1] + '.' };
    o[k] = v;
  }
  if (b.botNames !== undefined) {
    if (!Array.isArray(b.botNames)) return { err: 'أسماء البوتات قايمة.' };
    const names = b.botNames.map(x => str(x, 10, 2));
    if (names.some(x => x == null)) return { err: 'كل اسم بوت من حرفين لـ١٠ حروف.' };
    if (new Set(names.map(x => x.toLowerCase())).size !== names.length) return { err: 'أسماء البوتات لازم تبقى مختلفة.' };
    if (names.length < 8 || names.length > 30) return { err: 'لازم ٨ أسماء بوتات على الأقل (لحد ٣٠).' };
    o.botNames = names;
  }
  if (b.hint !== undefined) { const v = str(b.hint, 400); if (v == null) return { err: 'نص التلميح لحد ٤٠٠ حرف.' }; o.hint = v; }
  return { v: o };
}
// is the deck big enough to deal 8 players their hands and still have a pile to draw from?
function deckCheck(cards, set) {
  const act = cards.filter(c => c.active && !c.deleted);
  if (act.length < 2) return 'لازم يفضل كارتين شغالين على الأقل.';
  if (act.length > 20) return 'أقصى عدد كروت شغالة ٢٠.';
  const total = act.reduce((s, c) => s + c.cnt, 0);
  const need = 8 * set.startCards + 8;
  if (total < need) return 'الكوتشينة (' + total + ' كارت) صغيرة. لازم ' + need + ' كارت على الأقل عشان ٨ لاعبين.';
  return '';
}

/* ---------- the live copy ---------- */
class Content {
  constructor(store) { this.store = store; this.version = 1; this.cards = []; this.settings = Object.assign({}, DEFAULT_SETTINGS); this.assets = {}; }

  static fixed() {   // no database: the built-in defaults (used by the rules test)
    const c = new Content(null);
    c.cards = [SEED_CARDS[0]].concat(TEST_FILLERS, SEED_CARDS.slice(1)).map((s, i) => Object.assign({ id: i + 1, active: true, deleted: false, sort: i * 10 }, s));
    return c;
  }

  async load() {
    const st = this.store;
    if (!(await st.getSetting('seeded'))) {
      const now = Date.now();
      if (!(await st.get('SELECT id FROM cards LIMIT 1')))
        for (let i = 0; i < SEED_CARDS.length; i++) await this.insertCard(Object.assign({ active: true, sort: i * 10 }, SEED_CARDS[i]));
      await st.setSetting('seeded', String(now));
    }
    // upgrade: databases created before the lawyer existed get him once (and the deck stays 82 if the placeholders are untouched)
    if (!(await st.getSetting('seed_lawyer'))) {
      const has = await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [LAWYER.name]);
      if (!has) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, LAWYER));
        await st.run("UPDATE cards SET cnt=cnt-8 WHERE name=? AND cnt=24 AND deleted=0", ['تجريبي ٣']);
      }
      await st.setSetting('seed_lawyer', '1');
    }
    if (!(await st.getSetting('seed_shadow'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [SHADOW.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, SHADOW));
        await st.run("UPDATE cards SET cnt=cnt-3 WHERE name IN (?,?) AND cnt=25 AND deleted=0", ['تجريبي ١', 'تجريبي ٢']);
      }
      await st.setSetting('seed_shadow', '1');
    }
    if (!(await st.getSetting('seed_officer'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [OFFICER.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, OFFICER));
        await st.run("UPDATE cards SET cnt=cnt-3 WHERE name IN (?,?) AND cnt=22 AND deleted=0", ['تجريبي ١', 'تجريبي ٢']);
      }
      await st.setSetting('seed_officer', '1');
    }
    if (!(await st.getSetting('seed_pickpocket'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [PICKPOCKET.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, PICKPOCKET));
        await st.run("UPDATE cards SET cnt=cnt-3 WHERE name IN (?,?) AND cnt=19 AND deleted=0", ['تجريبي ١', 'تجريبي ٢']);
      }
      await st.setSetting('seed_pickpocket', '1');
    }
    if (!(await st.getSetting('seed_sparrow'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [SPARROW.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, SPARROW));
        await st.run("UPDATE cards SET cnt=cnt-3 WHERE name IN (?,?) AND cnt=16 AND deleted=0", ['تجريبي ١', 'تجريبي ٢']);
      }
      await st.setSetting('seed_sparrow', '1');
    }
    if (!(await st.getSetting('seed_accountant'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [ACCOUNTANT.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, ACCOUNTANT));
        await st.run("UPDATE cards SET cnt=cnt-3 WHERE name IN (?,?) AND cnt=13 AND deleted=0", ['تجريبي ١', 'تجريبي ٢']);
      }
      await st.setSetting('seed_accountant', '1');
    }
    if (!(await st.getSetting('seed_doctor'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [DOCTOR.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, DOCTOR));
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=10 AND deleted=0", ['تجريبي ١']);
        await st.run("UPDATE cards SET cnt=cnt-3 WHERE name=? AND cnt=10 AND deleted=0", ['تجريبي ٢']);
      }
      await st.setSetting('seed_doctor', '1');
    }
    if (!(await st.getSetting('seed_smuggler'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [SMUGGLER.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, SMUGGLER));
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=8 AND deleted=0", ['تجريبي ١']);
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=7 AND deleted=0", ['تجريبي ٢']);
      }
      await st.setSetting('seed_smuggler', '1');
    }
    if (!(await st.getSetting('seed_bomber'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [BOMBER.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, BOMBER));
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=6 AND deleted=0", ['تجريبي ١']);
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=5 AND deleted=0", ['تجريبي ٢']);
      }
      await st.setSetting('seed_bomber', '1');
    }
    if (!(await st.getSetting('seed_politician'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [POLITICIAN.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, POLITICIAN));
        await st.run("UPDATE cards SET cnt=cnt-4 WHERE name=? AND cnt=16 AND deleted=0", ['تجريبي ٣']);
      }
      await st.setSetting('seed_politician', '1');
    }
    if (!(await st.getSetting('seed_forger'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [FORGER.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, FORGER));
        await st.run("UPDATE cards SET cnt=cnt-6 WHERE name=? AND cnt=12 AND deleted=0", ['تجريبي ٣']);
      }
      await st.setSetting('seed_forger', '1');
    }
    if (!(await st.getSetting('seed_citykey'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [CITYKEY.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, CITYKEY));
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=4 AND deleted=0", ['تجريبي ١']);
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=6 AND deleted=0", ['تجريبي ٣']);
      }
      await st.setSetting('seed_citykey', '1');
    }
    if (!(await st.getSetting('seed_judge'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [JUDGE.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, JUDGE));
        await st.run("UPDATE cards SET cnt=cnt-1 WHERE name=? AND cnt=2 AND deleted=0", ['تجريبي ١']);
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=3 AND deleted=0", ['تجريبي ٢']);
        await st.run("UPDATE cards SET cnt=cnt-2 WHERE name=? AND cnt=4 AND deleted=0", ['تجريبي ٣']);
      }
      await st.setSetting('seed_judge', '1');
    }
    if (!(await st.getSetting('seed_elder'))) {
      if (!(await st.get("SELECT id FROM cards WHERE name=? AND deleted=0", [ELDER.name]))) {
        const max = await st.get('SELECT MAX(sort) m FROM cards');
        await this.insertCard(Object.assign({ active: true, sort: ((max && max.m) || 0) + 10 }, ELDER));
        await st.run("UPDATE cards SET cnt=0 WHERE name=? AND cnt=1 AND deleted=0", ['تجريبي ١']);
        await st.run("UPDATE cards SET cnt=0 WHERE name=? AND cnt=1 AND deleted=0", ['تجريبي ٢']);
        await st.run("UPDATE cards SET cnt=0 WHERE name=? AND cnt=2 AND deleted=0", ['تجريبي ٣']);
      }
      await st.setSetting('seed_elder', '1');
    }
    if (!(await st.getSetting('seed_nofiller'))) {   // the placeholder cards are gone from the game
      await st.run("UPDATE cards SET deleted=1, active=0 WHERE name IN (?,?,?)", ['تجريبي ١', 'تجريبي ٢', 'تجريبي ٣']);
      await st.setSetting('seed_nofiller', '1');
    }
    await this.reload();
    return this;
  }
  async reload() {
    const st = this.store;
    const rows = await st.all('SELECT * FROM cards WHERE deleted=0 ORDER BY sort, id');
    this.cards = rows.map(r => ({ id: r.id, name: r.name, symbol: r.symbol || '', color: r.color, cnt: r.cnt, descr: r.descr, penDescr: r.pen_descr, active: !!r.active, power: JSON.parse(r.power), penalty: JSON.parse(r.penalty), sort: r.sort, defaultImg: r.default_img || '', deleted: false }));
    let s = {}; try { s = JSON.parse((await st.getSetting('cfg')) || '{}'); } catch (e) {}
    this.settings = Object.assign({}, DEFAULT_SETTINGS, s);
    this.assets = {}; for (const a of await st.assetMeta()) this.assets[a.slot] = a.hash;
    this.version++;
  }
  async insertCard(c) {
    const now = Date.now();
    return this.store.insert('INSERT INTO cards(name,symbol,descr,pen_descr,cnt,active,color,power,penalty,sort,default_img,deleted,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?)',
      [c.name, c.symbol || '', c.descr, c.penDescr, c.cnt, c.active ? 1 : 0, c.color, JSON.stringify(c.power), JSON.stringify(c.penalty), c.sort, c.defaultImg || null, now, now]);
  }

  imgUrl(slot, def) { return this.assets[slot] ? '/a/' + slot + '?v=' + this.assets[slot] : def; }
  cardImg(c) { return this.imgUrl(cardSlot(c.id), c.defaultImg || ''); }
  images() { const o = {}; for (const k of Object.keys(IMAGE_SLOTS)) o[k] = this.imgUrl(k, IMAGE_SLOTS[k].def); return o; }

  // the copy a game plays with. Cards are numbered 0..n-1 in this order; hands, piles and claims use those numbers.
  snapshot() {
    const set = this.settings;
    const cards = this.cards.filter(c => c.active).map(c => ({
      up: c.power.some(o => o.op === 'immune' || o.op === 'victory'), jg: c.power.some(o => o.op === 'judge'), df: c.power.some(o => o.op === 'reflect' || o.op === 'guard' || o.op === 'judge' || o.op === 'elder'), id: c.id, name: c.name, symbol: c.symbol, color: c.color, cnt: c.cnt, descr: c.descr, img: this.cardImg(c),
      pen: c.penDescr || penText(c.penalty), power: c.power.map(o => Object.assign({}, o)), penalty: Object.assign({}, c.penalty)
    }));
    return {
      cards,
      set: { startCards: set.startCards, startInf: set.startInf, decideMs: set.decideSec * 1000, pickMs: set.pickSec * 1000, botAfterMs: set.botAfterSec * 1000, botNames: set.botNames.slice(), hint: set.hint },
      v: this.version
    };
  }
  // what the lobby needs before any game: pictures, the hint, the starting points
  publicConfig() {
    const s = this.settings;
    const cards = this.cards.filter(c => c.active && c.cnt > 0).map(c => ({ name: c.name, symbol: c.symbol, color: c.color, cnt: c.cnt, descr: c.descr, pen: c.penDescr || penText(c.penalty), img: this.cardImg(c) }));
    return { v: this.version, images: this.images(), hint: s.hint, startInf: s.startInf, startCards: s.startCards, cards };
  }
}

module.exports = { Content, OPS, TARGET_LABEL, IMAGE_SLOTS, DEFAULT_SETTINGS, SETTING_RANGE, SEED_CARDS, cleanCard, cleanSettings, cleanPower, cleanPenalty, penText, deckCheck, cardSlot, slotOk };
