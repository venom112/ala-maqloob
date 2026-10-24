'use strict';
// The game engine. It runs on the server only: the server keeps the deck and every hand,
// and each player is sent just their own cards.
const { Content } = require('./content');
const { Memory, smart, dumb, analyze } = require('./bot');
const MIN = 3, MAX = 8;
const WAIT_GRACE_MS = 60000;    // a player who drops while the room is still filling is removed after this
const ABSENT_CLOSE_MS = 300000; // nobody connected for this long: the room is closed
// Cards, powers, penalties and the numbers (hand size, starting points, timers, bot names) come from the admin-edited
// content (content.js). A game plays with a snapshot taken when it starts, kept in this.cfg.

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// a card is a number: its place in cfg.cards. The deck holds cnt copies of each.
function buildDeck(cfg) { const d = []; cfg.cards.forEach((c, k) => { for (let n = 0; n < c.cnt; n++) d.push(k); }); return shuffle(d); }

class Room {
  constructor(code, cap, host, onEmpty, content) {
    this.content = content || (Room.defaultContent || (Room.defaultContent = Content.fixed()));
    this.cfg = this.content.snapshot();
    this.code = code; this.cap = cap; this.hostUid = host.uid; this.onEmpty = onEmpty;
    this.roster = [{ uid: host.uid, name: host.name }];
    this.status = 'waiting'; this.gameNo = 0; this.bots = false;
    this.conns = new Map();            // uid -> send(fn)
    this.timers = new Set(); this.token = 0;
    this.evSeq = 0; this.evs = [];
    this.pubT = null; this.closed = false;
    this.lastSeen = new Map(); this.absentAt = 0;
    this.tickT = setInterval(() => this.tick(), 2000);
    this.resetCards();
  }

  /* ---------- plumbing ---------- */
  later(fn, ms) { const tk = this.token; const t = setTimeout(() => { this.timers.delete(t); if (tk === this.token && !this.closed) fn(); }, ms * (Room.speed || 1)); this.timers.add(t); }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers.clear(); this.token++; }
  E(kind, d) { d = d || {}; d.k = kind; d.id = ++this.evSeq; this.evs.push(d); if (this.evs.length > 30) this.evs.shift(); }
  idx(uid) { return this.roster.findIndex(r => r.uid === uid); }
  isBot(j) { return !!this.roster[j] && (!!this.roster[j].bot || !!this.roster[j].sub); }
  live() { return this.status === 'playing' && this.dealt; }
  alive() { const a = []; this.roster.forEach((p, i) => { if (!this.out[i]) a.push(i); }); return a; }
  nextAlive(i) { const n = this.roster.length; for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (!this.out[j]) return j; } return i; }

  body(uid) {
    const i = this.idx(uid);
    let g = null;
    if (this.status === 'playing') {
      g = {
        dealt: !!this.dealt, phase: this.phase, turn: this.turn, drew: !!this.drew, inf: this.inf, out: this.out, over: this.over,
        handN: this.hands.map(h => h.length), deckN: this.deck.length,
        pile: this.pile.slice(-3).map(c => ({ c: c.c, rev: !!c.rev, t: c.rev ? c.t : -1, rot: c.rot, dx: c.dx })),
        claim: this.claim ? { by: this.claim.by, c: this.claim.c, pending: this.claim.pending, total: this.claim.total, id: this.claim.id, up: !!this.claim.up, def: !!this.claim.def } : null,
        targets: this.phase === 'target' ? this.targets : [], defend: this.phase === 'defend' && this.defend ? { T: this.defend.T, P: this.defend.P, c: this.defend.c, opts: this.defend.opts, id: this.defend.id, kind: this.defend.kind } : null, ev: this.ev || '', evs: this.evs,
        lock: i >= 0 && this.inf ? [...new Set((this.hands[i] || []).filter(t => this.keyLocked(i, t)))] : [],
        imm: this.immuneTo ? this.roster.map((r, j) => this.isImmune(j)) : [],
        ban: i >= 0 && this.turnsN ? this.cfg.cards.map((c, x) => x).filter(x => this.claimBanned(i, x)) : [],
        cfg: { cards: this.cfg.cards.map(c => ({ df: this.isDefCard(this.cfg.cards.indexOf(c)), jg: !!c.jg, win: (c.power.find(o => o.op === 'victory') || { n: 0 }).n, up: !!c.up, name: c.name, symbol: c.symbol, color: c.color, descr: c.descr, img: c.img, pen: c.pen })), set: { startInf: this.cfg.set.startInf, decideMs: this.cfg.set.decideMs, pickMs: this.cfg.set.pickMs }, v: this.cfg.v }
      };
    }
    return {
      t: 'room', code: this.code, cap: this.cap, status: this.status, gameNo: this.gameNo, bots: this.bots,
      roster: this.roster.map(r => ({ name: r.name, bot: !!r.bot, sub: !!r.sub, gone: !!r.gone, host: r.uid === this.hostUid })),
      you: i, isHost: uid === this.hostUid, g, peek: this.peek && i >= 0 && this.peek.to === i ? { of: this.peek.of, cards: this.peek.cards, id: this.peek.id } : null, hand: i >= 0 && this.hands[i] && this.status === 'playing' ? this.hands[i] : []
    };
  }
  // send everyone their own view, at most once per tick
  publish() {
    if (this.pubT || this.closed) return;
    this.pubT = setTimeout(() => {
      this.pubT = null;
      for (const [uid, send] of this.conns) send(this.body(uid));
    }, 15);
  }
  touch() { this.publish(); this.schedule(); }

  /* ---------- people ---------- */
  seen(uid) { this.lastSeen.set(uid, Date.now()); }
  attach(uid, send) {
    this.conns.set(uid, send); this.seen(uid);
    const i = this.idx(uid);
    if (i >= 0 && this.roster[i].sub) this.restore(i);
    this.publish();
  }
  detach(uid, send) { if (this.conns.get(uid) === send) this.conns.delete(uid); }
  // every 2 seconds: who has gone quiet? A player cut off for 25 s gets a bot in his seat; when he is back the bot steps aside.
  tick() {
    if (this.closed) return;
    const now = Date.now();
    let anyoneThere = false;
    this.roster.forEach((r, i) => {
      if (r.bot || r.gone) return;
      const ago = now - (this.lastSeen.get(r.uid) || 0), here = ago < this.cfg.set.botAfterMs;   // every pong and message refreshes lastSeen, so this is 'heard from in the last 25 s'
      if (here) anyoneThere = true;
      if (this.status === 'playing') {
        if (!this.bots && !r.sub && !here && this.live() && this.over < 0) this.substitute(i);
        else if (r.sub && here) this.restore(i);
      } else if (this.status === 'waiting' && !here && ago > WAIT_GRACE_MS) this.leave(r.uid);
    });
    if (anyoneThere) this.absentAt = 0;
    else if (!this.absentAt) this.absentAt = now;
    else if (now - this.absentAt > ABSENT_CLOSE_MS) this.close('');
  }
  substitute(i) {
    const r = this.roster[i]; if (!r || r.sub || r.gone || this.out[i]) return;
    r.sub = true; this.ev = { k: 'sub', i };
    const cid = this.claimId;
    if (this.phase === 'claim' && this.claim && this.claim.pending.includes(i)) this.later(() => { if (cid === this.claimId && this.phase === 'claim' && this.isBot(i)) this.botDecide(i); }, 1200 + Math.random() * 1800);
    if (this.phase === 'target' && this.claim && this.claim.by === i && this.pickCb) { const t = this.targets, cb = this.pickCb; this.later(() => { if (this.pickCb === cb && this.isBot(i)) cb(this.botTarget(i, t)); }, 1500); }
    if (this.phase === 'give' && this.claim && this.claim.by === i && this.giveCb) { const cb = this.giveCb; this.later(() => { if (this.giveCb === cb && this.isBot(i)) cb(this.botGive(i)); }, 1500); }
    if (this.phase === 'defend' && this.defend && this.defend.T === i) { const did = this.defend.id; this.later(() => { if (this.phase === 'defend' && this.defend && this.defend.id === did && this.isBot(i)) this.botDefend(i); }, 1500); }
    this.touch();
  }
  restore(i) {
    const r = this.roster[i]; if (!r || !r.sub) return;
    r.sub = false; this.ev = { k: 'back', i }; this.touch();
  }
  add(user) {
    if (this.status !== 'waiting') return 'started';
    if (this.idx(user.uid) >= 0) return null;
    if (this.roster.length >= this.cap) return 'full';
    this.roster.push({ uid: user.uid, name: user.name });
    this.publish();
    return null;
  }
  humans() { return this.roster.filter(r => !r.bot && !r.gone); }
  leave(uid) {
    const i = this.idx(uid); if (i < 0 || this.closed) return;
    const send = this.conns.get(uid); this.conns.delete(uid);
    if (send) send({ t: 'left' });
    if (this.status === 'waiting') {
      if (uid === this.hostUid) return this.close('صاحب الغرفة قفل الغرفة.');
      this.roster.splice(i, 1); this.publish(); return;
    }
    if (this.bots) return this.close('');
    this.roster[i].gone = true;
    this.dropPlayer(i);
    const left = this.humans();
    if (!left.length) return this.close('');
    if (uid === this.hostUid) this.hostUid = left[0].uid;
    this.touch();
  }
  close(msg) {
    if (this.closed) return;
    this.closed = true; this.status = 'closed'; this.clearTimers();
    clearTimeout(this.pubT);
    clearInterval(this.tickT);
    for (const [, send] of this.conns) send({ t: 'closed', msg: msg || '' });
    this.conns.clear();
    if (this.onEmpty) this.onEmpty(this);
  }

  /* ---------- game ---------- */
  resetCards() {
    this.hands = []; this.inf = []; this.out = []; this.deck = []; this.pile = [];
    this.over = -1; this.ev = ''; this.turn = 0; this.phase = 'act'; this.drew = false; this.claim = null; this.claimId = (this.claimId || 0) + 1;
    this.targets = []; this.pickCb = null; this.dealt = false; this.skips = new Set(); this.defend = null; this.giveCb = null; this.peek = null; this.gid = (this.gid || 0) + 1;
    this.mem = new Memory(this.roster.length, this.cfg); this.initTrack();
  }
  // the accountant: points lost per player, and how many turns each player has taken
  initTrack() {
    const z = v => this.roster.map(() => v);
    this.curPlay = null; this.immuneTo = z(-1); this.bonus = new Set(); this.cdAt = this.roster.map(() => ({}));
    this.lseq = 0; this.lostLog = this.roster.map(() => []); this.prevStart = z(0); this.curStart = z(0); this.turnsN = z(0);
  }
  // cards with a rest time: the accountant every 2 turns, the smuggler every 3 (only the player who played it waits)
  cdOf(c) { const cd = this.cfg.cards[c]; if (!cd) return 0; return cd.power.some(o => o.op === 'smuggle') ? 3 : cd.power.some(o => o.op === 'regain') ? 2 : 0; }
  isUp(c) { const cd = this.cfg.cards[c]; return !!cd && cd.power.some(o => o.op === 'immune' || o.op === 'victory'); }
  // the city key: cannot be played with fewer points than it asks for
  winNeed(c) { const cd = this.cfg.cards[c], o = cd && cd.power.find(x => x.op === 'victory'); return o ? o.n : 0; }
  keyLocked(i, t) { const n = this.winNeed(t); return n > 0 && this.inf[i] < n; }
  playable(i) { return this.hands[i].some(t => !this.keyLocked(i, t)); }
  // after the draw: a hand of locked keys only means the turn is lost
  lockedTurn(i) {
    if (!this.hands[i].length || this.playable(i)) return false;
    this.ev = { k: 'locked', i }; this.turn = this.nextAlive(i); this.drew = false; return true;
  }   // played face up
  isImmune(j) { return this.immuneTo[j] >= 0 && this.turnsN[j] <= this.immuneTo[j]; }
  claimBanned(i, c) { const n = this.cdOf(c); if (!n) return false; const at = this.cdAt[i][c]; return at != null && this.turnsN[i] + 1 - at < n; }
  regainN(i) { return this.lostLog[i].filter(s => s > this.prevStart[i]).length; }
  start(uid) {
    if (this.status !== 'waiting' || uid !== this.hostUid) return 'denied';
    if (this.roster.length !== this.cap) return 'notfull';
    this.status = 'playing'; this.resetCards(); this.evs = []; this.publish();
    this.later(() => { this.newGame(); this.touch(); }, 600);
    return null;
  }
  startBots(user, n) {
    this.bots = true; this.cap = n;
    this.cfg = this.content.snapshot();
    const pool = this.cfg.set.botNames.filter(b => b !== user.name);
    for (let i = 0; i < n - 1; i++) this.roster.push({ uid: 'bot:' + i, name: pool[i], bot: true });
    this.status = 'playing'; this.resetCards(); this.publish();
    this.later(() => { this.newGame(); this.touch(); }, 600);
  }
  newGame() {
    const n = this.roster.length;
    this.cfg = this.content.snapshot();
    this.deck = buildDeck(this.cfg);
    this.hands = this.roster.map(() => { const h = []; for (let k = 0; k < this.cfg.set.startCards; k++) h.push(this.deck.pop()); return h; });
    this.inf = this.roster.map(() => this.cfg.set.startInf);
    this.out = this.roster.map(r => !!r.gone);
    this.pile = []; this.over = -1; this.ev = ''; this.turn = 0; this.phase = 'act'; this.drew = false; this.claim = null; this.claimId++;
    this.targets = []; this.pickCb = null; this.dealt = true; this.gameNo++; this.evs = []; this.skips = new Set(); this.defend = null; this.giveCb = null; this.peek = null; this.gid++;
    this.mem = new Memory(n, this.cfg); this.initTrack();
  }
  // after a game: the host plays again with whoever is still here; if a seat is empty the room waits for someone new
  again(uid) {
    if (uid !== this.hostUid || this.status !== 'playing' || this.over < 0) return;
    this.clearTimers();
    if (this.bots) { this.newGame(); this.touch(); return; }
    this.roster = this.roster.filter(r => !r.gone);
    this.resetCards(); this.evs = []; this.gameNo++;
    if (this.roster.length < this.cap) { this.status = 'waiting'; this.publish(); return; }
    this.status = 'waiting'; this.start(this.hostUid);
  }

  reshuffle() {
    const n = this.pile.length;
    if (n > 0) {
      this.pile.forEach(c => this.deck.push(c.t)); this.pile = []; this.mem.reshuffle();
      shuffle(this.deck); shuffle(this.deck);
      this.ev = { k: 'rs' };
      const m = Math.min(n, 6);
      setTimeout(() => { if (!this.closed) { this.E('shuffle', { n: m }); this.publish(); } }, 0);
    }
  }
  tryDraw(i) {
    if (!this.deck.length) this.reshuffle();
    if (!this.deck.length) return false;
    this.hands[i].push(this.deck.pop());
    if (!this.deck.length) this.reshuffle();
    return true;
  }
  doDraw(i) { if (this.drew) return false; if (!this.tryDraw(i)) return false; this.drew = true; if (this.bonus.has(i)) { this.bonus.delete(i); this.tryDraw(i); } return true; }
  canActFor(i) { return this.live() && this.over < 0 && this.phase === 'act' && this.turn === i && !this.out[i]; }
  actDraw(i) {
    if (this.drew) return;
    this.ev = '';
    if (!this.doDraw(i)) {
      if (!this.hands[i].length) { this.ev = { k: 'nocards', i }; this.turn = this.nextAlive(i); this.drew = false; }
      else { this.ev = { k: 'nodraw', i }; this.drew = true; this.lockedTurn(i); }
      this.touch(); return;
    }
    this.E('draw', { i }); this.lockedTurn(i); this.touch();
  }
  doPlay(i, k, claim, def) {
    if (!def) { this.turnsN[i]++; this.prevStart[i] = this.curStart[i]; this.curStart[i] = this.lseq; if (this.cdOf(claim)) this.cdAt[i][claim] = this.turnsN[i]; }
    const t = this.hands[i].splice(k, 1)[0];
    this.pile.push({ t, c: claim, rev: false, rot: Math.round((Math.random() * 2 - 1) * 14), dx: +((Math.random() * 2 - 1) * .8).toFixed(1) });
    let src = null;   // the forger: the card whose power it copies
    if (!def) {
      const pv = this.curPlay, c0 = this.cfg.cards[claim], isCopy = !!c0 && c0.power.some(o => o.op === 'copy');
      const pc = pv && this.cfg.cards[pv.c], pvCopy = !!pc && pc.power.some(o => o.op === 'copy');   // a forger cannot copy a forger
      if (isCopy && pv && pv.eff != null && !pv.up && !pv.canceled && !pvCopy) src = pv.eff;
      this.curPlay = { c: claim, eff: isCopy ? src : claim, up: this.isUp(claim), canceled: false };
    }
    if (!def && this.isUp(claim) && t === claim) {   // face up: everybody sees it, nobody can challenge it
      this.pile[this.pile.length - 1].rev = true; this.claimId++; this.peek = null;
      const cid = this.claimId;
      this.phase = 'resolve'; this.claim = { by: i, t, c: claim, pending: [], total: 0, id: cid, def: null, src: null };
      this.mem.gone(i, t, claim, true); this.ev = ''; this.E('play', { i, c: claim }); this.E('reveal', { t }); this.touch();
      this.later(() => { if (cid === this.claimId) this.execPower(this.claim, cid, () => this.afterPower(cid)); }, 1500);
      return;
    }
    this.phase = 'claim'; this.claimId++; this.peek = null;
    const cid = this.claimId, pend = [];
    this.roster.forEach((p, j) => { if (j !== i && !this.out[j]) pend.push(j); });
    this.claim = { by: i, t, c: claim, pending: pend, total: pend.length, id: cid, def: def || null, src };
    this.ev = '';
    this.E('play', { i, c: claim }); this.touch();
    this.armClaim();
  }
  // everybody still undecided on the open claim: bots decide after a while, humans pass when the time is up
  armClaim() {
    const cl = this.claim, cid = cl.id, humans = [];
    cl.pending.forEach(j => {
      if (this.isBot(j)) this.later(() => { if (cid === this.claimId && this.phase === 'claim' && this.isBot(j)) this.botDecide(j); }, 1200 + Math.random() * 3200);
      else humans.push(j);
    });
    if (humans.length) this.later(() => {
      if (cid !== this.claimId) return;
      humans.forEach(j => { if (this.phase === 'claim' && this.claim && this.claim.id === cid && this.claim.pending.includes(j)) this.decide(j, 'pass', true); });
    }, this.cfg.set.decideMs);
  }
  /* the judge: played by someone else while an action is open; if it stands the action is cancelled */
  judgeCard() { return this.cfg.cards.findIndex(c => c.power.some(o => o.op === 'judge')); }
  canJudge(j) {
    const cl = this.claim;
    return this.phase === 'claim' && !!cl && !cl.def && cl.by !== j && cl.pending.includes(j) && !this.out[j] && !(cl.judged && cl.judged.has(j)) && this.judgeCard() >= 0;
  }
  judgePlay(j, k) {
    if (!this.canJudge(j) || this.hands[j][k] == null) return;
    const parent = this.claim, gid = this.gid, jd = this.judgeCard();
    const cont = blocked => {
      if (gid !== this.gid || this.closed || this.over >= 0) return;
      this.claim = parent;
      if (blocked) {   // the action is cancelled: its card stays on the pile, face down
        this.phase = 'resolve'; if (!parent.up) this.mem.gone(parent.by, parent.t, parent.c, false);
        this.ev = { k: 'judged', A: parent.by, D: j }; this.touch();
        this.later(() => this.finishTurn(this.claimId), 1200);
        return;
      }
      (parent.judged || (parent.judged = new Set())).add(j);   // the judge was a lie: the action goes on, he cannot try again
      parent.pending = parent.pending.filter(x => !this.out[x]); this.claimId++; parent.id = this.claimId; this.ev = '';
      if (!parent.pending.length) { this.phase = 'resolve'; this.touch(); const cid = this.claimId; this.later(() => { if (cid === this.claimId) this.resolvePass(); }, 800); return; }
      this.phase = 'claim'; this.touch(); this.armClaim();
    };
    this.doPlay(j, k, jd, { A: parent.by, cont, kind: 'judge', n: 1 });
  }
  botDecide(j) {
    const cl = this.claim; if (!cl || !cl.pending.includes(j)) return;
    const jc = this.judgeCard(), k = jc >= 0 ? this.hands[j].indexOf(jc) : -1;
    if (k >= 0 && this.canJudge(j) && this.brain(j).judge && this.brain(j).judge(this.botCtx(j))) { this.judgePlay(j, k); return; }
    this.decide(j, !cl.up && this.brain(j).challenge(this.botCtx(j)) ? 'challenge' : 'pass');
  }
  decide(j, choice, auto) {
    const cl = this.claim;
    if (!cl || this.phase !== 'claim') return;
    const pi = cl.pending.indexOf(j); if (pi < 0) return;
    if (cl.up && choice === 'challenge') choice = 'pass';   // a face-up card cannot be challenged
    this.mem.rate(j, choice === 'challenge');
    if (choice === 'challenge') { this.resolveChallenge(j); return; }
    cl.pending.splice(pi, 1);
    this.E('pass', { j, by: cl.by, auto: !!auto });
    if (!cl.pending.length) {
      this.phase = 'resolve'; const cid = this.claimId;
      this.touch();
      this.later(() => { if (cid === this.claimId) this.resolvePass(); }, (this.isBot(j) || auto) ? 500 : 1200);
    } else this.touch();
  }
  loseInf(i) {
    this.inf[i]--; this.E('thud'); (this.lostLog[i] || (this.lostLog[i] = [])).push(++this.lseq);
    if (this.inf[i] > 0) { this.ev = { k: 'inf', i, n: this.inf[i] }; return; }
    this.out[i] = true; this.mem.clear(i);
    (this.hands[i] || []).forEach(c => this.deck.push(c)); shuffle(this.deck); this.hands[i] = [];
    this.ev = { k: 'out', i };
    const alive = this.alive();
    if (alive.length === 1) { this.finish(alive[0]); return; }
    this.E('victim', { i });
  }
  finish(w) { this.over = w; this.E('win', { w }); }
  // Who a step of a power hits. 'pick' is the player the claimer chose; 'random' is drawn once, when the power starts.
  victims(target, P, picked, others) {
    if (target === 'self') return [P];
    if (target === 'pick') return picked >= 0 ? [picked] : [];
    if (target === 'random') return others.length ? [others[Math.floor(Math.random() * others.length)]] : [];
    return others.slice();   // all_others
  }
  /* Cards that defend. An attack is a power step aimed at a victim: a steal is answered by the card with a 'reflect' step
     (the lawyer: the steal goes back to the attacker), a swap by the card with a 'guard' step (the corrupt officer: the swap is blocked). */
  defCard(kind) { const op = kind === 'swap' ? 'guard' : kind === 'take' ? 'elder' : 'reflect'; return this.cfg.cards.findIndex(c => c.power.some(o => o.op === op)); }
  // every card that may be claimed against this kind of attack: its own defender and the elder (who stops any attack)
  defCards(kind) { const op = kind === 'swap' ? 'guard' : kind === 'take' ? 'elder' : 'reflect', r = []; this.cfg.cards.forEach((c, i) => { if (c.power.some(o => o.op === op || o.op === 'elder')) r.push(i); }); return r; }
  // defenders (lawyer, officer, judge, elder) are only played in their own moment, never on your own turn under their name
  isDefCard(c) { const cd = this.cfg.cards[c]; return !!cd && cd.power.some(o => o.op === 'reflect' || o.op === 'guard' || o.op === 'judge' || o.op === 'elder'); }
  // P's attack has T as its victim. T may play a card face down and say it is the defender.
  // That claim goes through the normal challenge round. If it stands, the attack is stopped; if it was a lie,
  // the liar pays that card's penalty and the attack hits him. cont(true) = stopped, cont(false) = the attack goes on.
  defense(P, T, parent, cont, kind, n) {
    const d = this.defCard(kind), gid = this.gid;
    const resume = (blocked, how) => { if (gid !== this.gid || this.closed) return; this.claim = parent; this.phase = 'resolve'; this.defend = null; cont(blocked, how); };
    this.claimId++; const did = this.claimId;
    this.phase = 'defend'; this.defend = { T, P, c: d, opts: this.defCards(kind), id: did, resume, kind, n: n || 1 };
    this.E('attack', { P, T }); this.ev = { k: 'attack', P, T, kind }; this.touch();
    if (this.isBot(T)) this.later(() => { if (this.phase === 'defend' && this.defend && this.defend.id === did) this.botDefend(T); }, 1300 + Math.random() * 1500);
    else this.later(() => { if (this.phase === 'defend' && this.defend && this.defend.id === did) this.defendDecline(); }, this.cfg.set.decideMs);
  }
  defendDecline() { const df = this.defend; if (df) df.resume(false); }
  defendPlay(k, c) {
    const df = this.defend; if (!df || !this.hands[df.T] || this.hands[df.T][k] == null) return;
    const say = df.opts.includes(c) ? c : df.c;
    this.defend = null; this.doPlay(df.T, k, say, { A: df.P, cont: df.resume, kind: df.kind, n: df.n });
  }
  botDefend(T) {
    if (!this.defend) return;
    const d = this.brain(T).defend(this.botCtx(T));
    if (d.play != null) this.defendPlay(d.play, d.claim); else this.defendDecline();
  }
  // run one card's power: it is shown to everyone, then its steps happen one after the other
  execPower(cl, cid, done) {
    if (cl.def && this.cfg.cards[cl.c] && this.cfg.cards[cl.c].power.some(o => o.op === 'elder')) {   // the elder stood: the attack is cancelled, and he takes a point from anybody
      const T = cl.by, gid = this.gid;
      this.E('elder', { A: cl.def.A, D: T, c: cl.c }); this.touch();
      const fin = () => { if (gid === this.gid && cid === this.claimId && this.over < 0) cl.def.cont(true, 'elder'); };
      const cands = this.alive().filter(j => j !== T && !this.isImmune(j));
      this.later(() => {
        if (cid !== this.claimId) return;
        if (this.out[T] || !cands.length) return fin();
        const hit = tg => {
          this.phase = 'resolve'; this.targets = []; this.pickCb = null;
          this.applyStep({ op: 'steal', n: 1, T: [tg] }, T);
          this.E('hit', { steps: [{ op: 'steal', n: 1, T: [tg], P: T }] }); this.ev = { k: 'elderhit', P: T, T: tg }; this.touch();
          if (this.over < 0) this.later(fin, 1200);
        };
        if (this.isBot(T)) { hit(cands.slice().sort((a, b) => this.inf[b] - this.inf[a] || Math.random() - .5)[0]); return; }
        let picked = false; this.phase = 'target'; this.targets = cands;
        this.pickCb = tg => { if (picked || cid !== this.claimId || !cands.includes(tg)) return; picked = true; hit(tg); };
        this.touch();
        this.later(() => { if (this.pickCb) this.pickCb(cands[Math.floor(Math.random() * cands.length)]); }, this.cfg.set.pickMs);
      }, 1800);
      return;
    }
    if (cl.def) {   // a defence that stood: a steal goes back to the attacker, a swap is blocked
      this.E(cl.def.kind === 'judge' ? 'judge' : cl.def.kind === 'swap' ? 'block' : 'reflect', { A: cl.def.A, D: cl.by, c: cl.c }); this.touch();
      this.later(() => { if (cid === this.claimId) cl.def.cont(true); }, 2300);
      return;
    }
    const P = cl.by, card0 = this.cfg.cards[cl.c]; let card = card0, cp = null;
    if (card0 && card0.power.some(o => o.op === 'copy')) { if (cl.src != null && this.cfg.cards[cl.src]) { card = this.cfg.cards[cl.src]; cp = cl.src; } else card = { power: [] }; }
    const ops = ((card && card.power) || []).filter(o => o.op !== 'reflect' && o.op !== 'guard' && o.op !== 'copy' && o.op !== 'judge' && o.op !== 'elder');
    if (!ops.length || this.out[P]) { this.ev = { k: 'power', c: cl.c, P, none: true }; this.touch(); this.later(done, 900); return; }
    const others = this.alive().filter(j => j !== P);
    const needPick = ops.some(o => o.target === 'pick');
    const run = (picked, giveK) => {
      this.phase = 'resolve';
      const HARM = ['steal', 'inf_loss', 'take', 'swap', 'drop', 'skip', 'recycle', 'peek'];
      const plan = ops.map(o => {
        let T = this.victims(o.target, P, picked, others), imm = [];
        if (HARM.includes(o.op)) { imm = T.filter(x => x !== P && this.isImmune(x)); T = T.filter(x => !imm.includes(x)); }
        return { op: o.op, n: o.op === 'regain' ? this.regainN(P) : o.n, k: giveK, T, imm };
      });
      this.E('power', { c: cl.c, P, cp, steps: plan.map(p => ({ op: p.op, n: p.n, T: p.T })) });
      this.touch();
      const gid = this.gid;
      this.later(() => {
        if (cid !== this.claimId) return;
        this.ev = '';
        const execd = [];
        const finish = () => {
          if (gid !== this.gid) return;
          this.claim = cl;
          const e = this.ev;
          this.E('hit', { steps: execd });
          if (this.over < 0) this.ev = { k: 'power', c: cl.c, P, cp, steps: execd, e };
          this.touch();
          this.later(() => this.afterPower(this.claimId), 1000);
        };
        const steps = idx => {
          if (gid !== this.gid) return;
          if (idx >= plan.length || this.over >= 0) return finish();
          const p = plan[idx], q = p.T.slice();
          if (p.imm.length) execd.push({ op: p.op, n: p.n, T: [], imm: p.imm, P });
          const nextV = () => {
            if (gid !== this.gid) return;
            if (!q.length || this.over >= 0) return steps(idx + 1);
            const T = q.shift();
            if (this.out[T]) return nextV();
            const atk = p.op === 'steal' || (p.op === 'swap' && this.hands[P].length > 0) || p.op === 'take';
            if (atk && this.hands[T] && this.hands[T].length && this.defCards(p.op).length) {
              if (p.op === 'swap') {
                return this.defense(P, T, cl, blocked => {
                  if (blocked) execd.push({ op: 'swap', n: 1, T: [T], P, blocked: true });
                  else { const ok = this.applyStep({ op: 'swap', n: 1, k: p.k, T: [T] }, P); execd.push({ op: 'swap', n: 1, T: [T], P, fail: ok === false }); }
                  this.touch(); this.later(nextV, 900);
                }, 'swap');
              }
              if (p.op === 'take') {   // the pickpocket: only the elder stops it
                return this.defense(P, T, cl, blocked => {
                  if (blocked) execd.push({ op: 'take', n: 1, T: [], P, blocked: true });
                  else { const ok = this.applyStep({ op: 'take', n: 1, k: p.k, T: [T] }, P); execd.push({ op: 'take', n: 1, T: [T], P, fail: ok === false }); }
                  this.touch(); this.later(nextV, 900);
                }, 'take');
              }
              return this.defense(P, T, cl, (blocked, how) => {
                if (blocked && how === 'elder') execd.push({ op: 'steal', n: p.n, T: [], P, blocked: true });
                else if (blocked) { this.applyStep({ op: 'steal', n: p.n, T: [P] }, T); execd.push({ op: 'steal', n: p.n, T: [P], P: T, reflected: true }); }
                else { this.applyStep({ op: 'steal', n: p.n, T: [T] }, P); execd.push({ op: 'steal', n: p.n, T: [T], P }); }
                this.touch(); this.later(nextV, 900);
              }, 'steal', p.n);
            }
            const ok = this.applyStep({ op: p.op, n: p.n, k: p.k, T: [T] }, P); execd.push({ op: p.op, n: p.n, T: [T], P, fail: ok === false });
            nextV();
          };
          nextV();
        };
        steps(0);
      }, 1500);
    };
    // a swap also needs the card the player gives away: he picks it from his own hand
    const needGive = ops.some(o => o.op === 'swap') && this.hands[P].length > 0;
    const afterPick = picked => {
      if (!needGive) return run(picked, -1);
      const rndK = () => Math.floor(Math.random() * this.hands[P].length);
      if (this.isBot(P)) { this.later(() => { if (cid === this.claimId) run(picked, this.botGive(P)); }, 700); return; }
      let given = false;
      this.phase = 'give';
      this.giveCb = k => {
        if (given || cid !== this.claimId || !Number.isInteger(k) || k < 0 || k >= this.hands[P].length) return;
        given = true; this.giveCb = null; this.phase = 'resolve'; this.touch(); run(picked, k);
      };
      this.touch();
      this.later(() => { if (this.giveCb) this.giveCb(rndK()); }, this.cfg.set.pickMs);
    };
    if (!needPick) { afterPick(-1); return; }
    if (!others.length) { done(); return; }
    const rnd = () => others[Math.floor(Math.random() * others.length)];
    if (!this.isBot(P)) {
      let picked = false;
      this.phase = 'target'; this.targets = others;
      this.pickCb = tg => {
        if (picked || cid !== this.claimId || !others.includes(tg)) return;
        picked = true; this.pickCb = null; this.phase = 'resolve'; this.touch(); afterPick(tg);
      };
      this.touch();
      this.later(() => { if (this.pickCb) this.pickCb(rnd()); }, this.cfg.set.pickMs);
    } else this.later(() => { if (cid === this.claimId) afterPick(this.botTarget(P, others, ops)); }, 700);
  }
  applyStep(p, P) {
    for (const T of p.T) {
      if (this.over >= 0) return;
      if (this.out[T]) continue;
      if (p.op === 'steal' || p.op === 'inf_loss' || p.op === 'take' || p.op === 'swap') this.mem.attack(P, T);
      if (p.op === 'steal') { for (let k = 0; k < p.n && !this.out[T] && this.over < 0; k++) { this.inf[P]++; this.loseInf(T); } }
      else if (p.op === 'inf_loss') { for (let k = 0; k < p.n && !this.out[T] && this.over < 0; k++) this.loseInf(T); }
      else if (p.op === 'inf_gain') this.inf[T] += p.n;
      else if (p.op === 'draw') { for (let k = 0; k < p.n; k++) if (!this.tryDraw(T)) break; }
      else if (p.op === 'drop') {
        const H = this.hands[T].length;
        for (let k = 0; k < p.n && this.hands[T].length; k++) this.deck.push(this.hands[T].splice(Math.floor(Math.random() * this.hands[T].length), 1)[0]);
        shuffle(this.deck); this.mem.fuzz(T, H - this.hands[T].length, H);
      }
      else if (p.op === 'regain') { if (p.n > 0) { this.inf[T] += p.n; this.lostLog[T] = []; } }
      else if (p.op === 'recycle') {
        const H = this.hands[T].length; let k = 0;
        for (let q = 0; q < p.n && this.hands[T].length; q++) {
          if (!this.deck.length) this.reshuffle();
          if (!this.deck.length) break;
          const idx = Math.floor(Math.random() * this.hands[T].length), x = this.hands[T][idx];
          this.hands[T][idx] = this.deck.pop(); this.deck.push(x); shuffle(this.deck); k++;
        }
        if (k) this.mem.fuzz(T, k, H);
      }
      else if (p.op === 'victory') { if (this.inf[T] >= p.n) this.finish(T); else return false; }
      else if (p.op === 'immune') this.immuneTo[T] = this.turnsN[T] + p.n - 1;
      else if (p.op === 'smuggle') this.bonus.add(T);
      else if (p.op === 'skip') this.skips.add(T);
      else if (p.op === 'peek') {
        // only the player is told: the cards go into a private field that body() sends to him alone
        const theirs = this.hands[T];
        if (!theirs || !theirs.length) return false;
        this.peek = { to: P, of: T, cards: theirs.slice(), id: (this.peekSeq = (this.peekSeq || 0) + 1) };
        this.mem.peek(P, T, theirs.slice());   // the player's (or his bot's) memory
      }
      else if (p.op === 'take') {
        // n random cards leave the victim's hand and go to the player
        const theirs = this.hands[T], mine = this.hands[P];
        if (!theirs || !mine || !theirs.length) return false;
        for (let k = 0; k < p.n && theirs.length; k++) {
          const HT = theirs.length, HP = mine.length, x = theirs.splice(Math.floor(Math.random() * theirs.length), 1)[0];
          mine.push(x); this.mem.exchange(P, T, x, null, HT, HP);
        }
      }
      else if (p.op === 'swap') {
        // one random card of the victim goes to the player, the card he chose goes to the victim
        const mine = this.hands[P], theirs = this.hands[T];
        if (!mine || !theirs || !mine.length || !theirs.length) return false;
        const a = Number.isInteger(p.k) && p.k >= 0 && p.k < mine.length ? p.k : Math.floor(Math.random() * mine.length), b = Math.floor(Math.random() * theirs.length);
        const x = mine[a]; mine[a] = theirs[b]; theirs[b] = x;
        this.mem.exchange(P, T, mine[a], theirs[b], theirs.length, mine.length);
      }
    }
    return true;
  }
  finishTurn(cid) {
    if (cid !== this.claimId || this.over >= 0) return;
    const by = this.claim ? this.claim.by : this.turn;
    this.phase = 'act'; this.claim = null; this.drew = false; this.turn = this.nextAlive(by);
    // a player who was made to skip loses this one turn
    const skipped = [];
    for (let k = 0; k < this.roster.length && this.skips.has(this.turn); k++) { this.skips.delete(this.turn); skipped.push(this.turn); this.turn = this.nextAlive(this.turn); }
    if (skipped.length) { this.ev = { k: 'skipped', is: skipped }; this.E('skipped', { is: skipped }); }
    this.touch();
  }
  afterPower(cid) { this.later(() => this.finishTurn(cid), 600); }
  resolvePass() {
    const cl = this.claim, P = cl.by, cid = this.claimId;
    if (!cl.up) { this.mem.gone(P, cl.t, cl.c, false); this.ev = { k: 'allpass', P }; this.E('allpass', { P }); this.touch(); }
    this.later(() => { if (cid === this.claimId) this.execPower(cl, cid, () => this.afterPower(cid)); }, cl.up ? 600 : this.isBot(P) ? 900 : 2100);
  }
  // Challenge: the card is shown to everyone and goes back face down. Honest: the power happens, the challenger loses a point.
  // Lying: the liar pays the penalty of the card he claimed.
  resolveChallenge(j) {
    const cl = this.claim, P = cl.by, cid = this.claimId;
    this.phase = 'resolve'; this.ev = '';
    this.E('challenge', { j, P }); this.touch();
    this.later(() => {
      if (cid !== this.claimId) return;
      const c = this.pile[this.pile.length - 1]; if (c) c.rev = true;
      this.mem.gone(P, cl.t, cl.c, true);   // everyone has seen this card now
      this.E('reveal', { t: cl.t }); this.touch();
    }, 1900);
    this.later(() => {
      if (cid !== this.claimId) return;
      const c = this.pile[this.pile.length - 1]; if (c) c.rev = false;
      this.E('unreveal'); this.touch();
    }, 3500);
    this.later(() => {
      if (cid !== this.claimId) return;
      if (cl.t === cl.c) {
        this.E('honest', { j }); this.touch();
        this.later(() => {
          if (cid !== this.claimId) return;
          if (!this.out[j]) { this.loseInf(j); this.ev = { k: 'honest', j, e: this.ev }; }
          this.touch();
          if (this.over >= 0) return;
          this.later(() => { if (cid === this.claimId) this.execPower(cl, cid, () => this.afterPower(cid)); }, 1200);
        }, 450);
      } else {
        this.E('liar', { P, c: cl.c }); this.touch();
        this.later(() => {
          if (cid !== this.claimId) return;
          this.applyPenalty(cl.c, P, j); this.touch();
        }, 450);
        this.later(() => { if (cid !== this.claimId) return; if (cl.def) cl.def.cont(false); else this.finishTurn(cid); }, 2800);
      }
    }, 3900);
  }
  applyPenalty(c, P, j) {
    const d = this.cfg.cards[c].penalty;
    for (let k = 0; k < d.loss && !this.out[P] && this.over < 0; k++) this.loseInf(P);
    let last = this.ev;
    if (!this.out[P] && this.over < 0 && d.drop && this.hands[P].length) {
      const H = this.hands[P].length;
      for (let k = 0; k < d.drop && this.hands[P].length; k++) this.deck.push(this.hands[P].splice(Math.floor(Math.random() * this.hands[P].length), 1)[0]);
      shuffle(this.deck); this.mem.fuzz(P, H - this.hands[P].length, H);
    }
    if (d.gift && !this.out[j] && this.over < 0) this.inf[j] += d.gift;
    if (d.skip && !this.out[P] && this.over < 0) this.skips.add(P);
    if (d.reveal && !this.out[P] && this.over < 0) {   // the liar's hand is shown to everybody (the bots remember it)
      const cards = this.hands[P].slice(); this.E('showhand', { i: P, cards });
      this.roster.forEach((x, o) => { if (o !== P) this.mem.peek(o, P, cards.slice()); });
    }
    if (this.claim && !this.claim.def && this.curPlay) this.curPlay.canceled = true;
    this.ev = { k: 'liar', P, c, e: last };
  }
  // a player who left or dropped out: out of the game, cards back in the deck, everyone else plays on
  dropPlayer(i) {
    if (this.out[i] || !this.live()) return;
    this.inf[i] = 0; this.out[i] = true; this.mem.clear(i);
    (this.hands[i] || []).forEach(c => this.deck.push(c)); shuffle(this.deck); this.hands[i] = [];
    this.ev = { k: 'left', i };
    const alive = this.alive();
    if (this.over >= 0) { this.touch(); return; }
    if (alive.length <= 1) { if (alive.length === 1) this.finish(alive[0]); this.touch(); return; }
    if (this.phase === 'defend' && this.defend && this.defend.T === i) { this.defendDecline(); return; }
    if (this.phase === 'claim' && this.claim && this.claim.pending.includes(i)) { this.decide(i, 'pass', true); return; }
    if (this.phase === 'target' && this.claim && this.claim.by === i && this.pickCb) { this.pickCb(this.targets[0]); return; }
    if (this.phase === 'give' && this.claim && this.claim.by === i && this.giveCb) { this.giveCb(0); return; }
    if (this.phase === 'act' && this.turn === i) { this.turn = this.nextAlive(i); this.drew = false; }
    this.touch();
  }

  /* ---------- bots ---------- */
  schedule() {
    clearTimeout(this.apT);
    if (this.closed || !this.live() || this.over >= 0 || this.phase !== 'act' || !this.isBot(this.turn)) return;
    const tk = this.token;
    this.apT = setTimeout(() => { if (tk === this.token) this.botAct(); }, (900 + Math.random() * 700) * (Room.speed || 1));
  }
  botAct() {
    if (this.closed || !this.live() || this.over >= 0 || this.phase !== 'act') return;
    const i = this.turn; if (!this.isBot(i)) return;
    this.ev = '';
    const h = this.hands[i];
    if (!this.drew) {
      if (this.doDraw(i)) { this.E('draw', { i }); this.touch(); return; }
      this.drew = true;
    }
    if (!h.length) { this.ev = { k: 'nocards', i }; this.turn = this.nextAlive(i); this.drew = false; this.touch(); return; }
    if (this.lockedTurn(i)) { this.touch(); return; }
    const d = this.brain(i).play(this.botCtx(i));
    if (this.keyLocked(i, h[d.k])) { const ks = h.map((t, x) => x).filter(x => !this.keyLocked(i, h[x])); d.k = ks[Math.floor(Math.random() * ks.length)]; d.claim = h[d.k]; }
    { const real0 = h[d.k]; if (this.isUp(real0)) d.claim = real0; else if (this.isUp(d.claim)) d.claim = real0; }
    if (this.isDefCard(d.claim)) { const okc = this.cfg.cards.map((c, x) => x).filter(x => !this.isDefCard(x) && !this.isUp(x) && !this.claimBanned(i, x)); d.claim = okc[Math.floor(Math.random() * okc.length)]; }
    if (this.claimBanned(i, d.claim)) {   // the accountant is not allowed now: say the card's true power, or any allowed one
      const real = h[d.k], okc = this.cfg.cards.map((c, x) => x).filter(x => !this.claimBanned(i, x) && !this.isUp(x) && !this.isDefCard(x));
      d.claim = !this.claimBanned(i, real) ? real : okc[Math.floor(Math.random() * okc.length)];
    }
    this.doPlay(i, d.k, d.claim);
  }
  // 'smart' for every bot; roster[i].iq = 'dumb' gives the old random bot (used as a baseline in the tests)
  brain(i) { return this.roster[i] && this.roster[i].iq === 'dumb' ? dumb : smart; }
  // Everything a bot is allowed to know: its own hand, the public table, and what it has seen (the Sparrow) or what others have seen of it.
  botCtx(i) {
    const cl = this.claim, df = this.phase === 'defend' ? this.defend : null, mem = this.mem;
    return {
      me: i, n: this.roster.length, cards: this.cfg.cards, info: analyze(this.cfg),
      inf: this.inf.slice(), out: this.out.slice(), handN: this.hands.map(h => h.length), mine: (this.hands[i] || []).slice(), alive: this.alive(),
      claim: cl ? { by: cl.by, c: cl.c, total: cl.total, def: cl.def ? { A: cl.def.A, kind: cl.def.kind, n: cl.def.n || 1 } : null } : null,
      defend: df ? { P: df.P, T: df.T, c: df.c, opts: df.opts, kind: df.kind, n: df.n || 1 } : null,
      regain: this.regainN(i), copyEff: (this.curPlay && this.curPlay.eff != null && !this.curPlay.up && !this.curPlay.canceled) ? this.curPlay.eff : null, rd: (o, s) => mem.read(i, o, s), pub: mem.pub(), rnd: this.rnd || Math.random
    };
  }
  botTarget(i, cands, ops) {
    if (!ops) { const cl = this.claim, card = cl && this.cfg.cards[cl.c]; ops = ((card && card.power) || []).filter(o => o.op !== 'reflect' && o.op !== 'guard' && o.op !== 'elder' && o.op !== 'judge'); }
    const live = cands.filter(j => !this.isImmune(j)), t = this.brain(i).target(this.botCtx(i), ops, live.length ? live : cands);
    return cands.includes(t) ? t : cands[0];
  }
  botGive(i) {
    const k = this.brain(i).give(this.botCtx(i));
    return Number.isInteger(k) && k >= 0 && k < this.hands[i].length ? k : 0;
  }

  /* ---------- what a real player may ask for ---------- */
  act(uid, d) {
    const i = this.idx(uid);
    if (i < 0 || this.out[i] || !this.live() || !d) return;
    if (d.a === 'draw') { if (this.canActFor(i) && !this.drew) this.actDraw(i); }
    else if (d.a === 'play') {
      const k = Number(d.k); let c = Number(d.d);
      if (this.canActFor(i) && this.drew && Number.isInteger(k) && k >= 0 && this.hands[i][k] != null && Number.isInteger(c) && c >= 0 && c < this.cfg.cards.length) {
        const real = this.hands[i][k];
        if (this.keyLocked(i, real)) return;
        if (this.isUp(real)) c = real; else if (this.isUp(c)) return;   // a face-up card cannot be bluffed, and cannot be claimed with another card
        if (this.isDefCard(c)) return;   // a defender cannot be played as itself on your own turn (it can be thrown away as another card)
        if (!this.claimBanned(i, c)) this.doPlay(i, k, c);
      }
    }
    else if (d.a === 'decide') { if (this.claim && this.claim.id === d.cid) this.decide(i, d.ch === 'challenge' ? 'challenge' : 'pass'); }
    else if (d.a === 'defend') {
      if (this.phase === 'defend' && this.defend && this.defend.T === i && this.defend.id === d.cid) {
        const k = Number(d.k);
        if (k === -1) this.defendDecline(); else if (Number.isInteger(k) && k >= 0 && this.hands[i][k] != null) this.defendPlay(k, Number(d.c));
      }
    }
    else if (d.a === 'judge') { if (this.phase === 'claim' && this.claim && this.claim.id === d.cid) this.judgePlay(i, Number(d.k)); }
    else if (d.a === 'give') { if (this.phase === 'give' && this.claim && this.claim.by === i && this.claim.id === d.cid && this.giveCb) this.giveCb(Number(d.k)); }
    else if (d.a === 'pick') { if (this.phase === 'target' && this.claim && this.claim.by === i && this.claim.id === d.cid && this.pickCb) this.pickCb(Number(d.tg)); }
  }
}
module.exports = { Room, MIN, MAX };
