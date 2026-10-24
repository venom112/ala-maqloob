'use strict';
// The bots' brain. Two parts:
//
//  Memory  - what everybody has legitimately seen so far. The Sparrow shows one player's whole hand to its owner;
//            that knowledge is kept (K[owner][subject]) and slowly fades when the hand changes: a card played, a card
//            stolen, a swap, a drop. It also keeps public statistics (who challenges often, who has been caught lying,
//            which revealed cards are out of the deck, who attacked whom).
//  smart   - the decisions: what to play and claim, whether to challenge, who to target, what to give in a swap,
//            whether to defend. Every decision is an expected-value estimate (in "influence points").
//
// A bot only ever receives a `ctx` built by Room.botCtx: its own hand, the public state, and the knowledge it is
// allowed to have. Other players' hidden cards are not in it, so a bot cannot cheat. (Memory.read refuses to hand out
// what a third party knows.)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ATTACK = ['steal', 'inf_loss', 'take', 'swap', 'drop', 'skip'];
const KILL = 2.5, WIN = 12;   // value of putting a player out; of ending the game

/* ---------- facts about the current card set ---------- */
const _an = new WeakMap();
function analyze(cfg) {
  let a = _an.get(cfg); if (a) return a;
  const cards = cfg.cards;
  a = {
    defSteal: cards.findIndex(c => c.power.some(o => o.op === 'reflect')),   // the card that answers a steal
    defSwap: cards.findIndex(c => c.power.some(o => o.op === 'guard')),      // the card that answers a swap
    ops: cards.map(c => c.power.filter(o => o.op !== 'reflect' && o.op !== 'guard' && o.op !== 'judge' && o.op !== 'elder')),
    isDef: cards.map(c => c.power.some(o => o.op === 'reflect' || o.op === 'guard' || o.op === 'judge' || o.op === 'elder')),
    total: cards.reduce((s, c) => s + c.cnt, 0)
  };
  _an.set(cfg, a); return a;
}

/* ---------- memory ---------- */
class Memory {
  constructor(n, cfg) {
    this.n = n; this.T = cfg.cards.length;
    // K[o][s] = what player o knows about the hand of player s: a list of {c: card, p: chance it is still there}
    this.K = Array.from({ length: n }, () => Array.from({ length: n }, () => []));
    this.pile = new Array(this.T).fill(0);              // revealed cards lying in the discard pile (until it is reshuffled)
    this.ch = new Array(n).fill(0); this.opp = new Array(n).fill(0);     // challenged / had the chance to
    this.rev = new Array(n).fill(0); this.lied = new Array(n).fill(0);   // times his card was revealed / it was a lie
    this.hostile = Array.from({ length: n }, () => new Array(n).fill(0));  // hostile[a][b]: times a attacked b
  }
  read(me, o, s) {
    if (o !== me && s !== me) throw new Error('a bot may only read what it knows, or what others know about it');
    return (this.K[o][s] || []).map(e => ({ c: e.c, p: e.p }));
  }
  pub() {
    const m = this;
    return {
      pile: m.pile.slice(),
      challengeRate: j => (m.ch[j] + 1) / (m.opp[j] + 6),
      honestRate: j => (m.rev[j] - m.lied[j] + 3) / (m.rev[j] + 4.3),
      hostile: (a, b) => m.hostile[a][b]
    };
  }
  _prune(l) { for (let i = l.length - 1; i >= 0; i--) if (l[i].p < .04) l.splice(i, 1); }
  _best(l, c) { let b = -1; l.forEach((e, i) => { if (e.c === c && (b < 0 || e.p > l[b].p)) b = i; }); return b; }
  _lose(o, s, c) { const l = this.K[o][s], b = this._best(l, c); if (b >= 0) l.splice(b, 1); }
  peek(P, T, cards) { this.K[P][T] = cards.map(c => ({ c, p: 1 })); }
  // n random cards left T's hand (it had H): everyone who knew it is now less sure
  fuzz(T, n, H) {
    if (!(n > 0)) return;
    const f = 1 - clamp(n / Math.max(1, H), 0, 1);
    for (let o = 0; o < this.n; o++) { const l = this.K[o][T]; l.forEach(e => { e.p *= f; }); this._prune(l); }
  }
  // P took `taken` from T and (swap) gave `given`. The two of them know exactly what moved; everyone else only that something did.
  exchange(P, T, taken, given, HT, HP) {
    this._lose(P, T, taken); if (given != null) this.K[P][T].push({ c: given, p: 1 });
    if (given != null) this._lose(T, P, given); this.K[T][P].push({ c: taken, p: 1 });
    for (let o = 0; o < this.n; o++) {
      if (o === P || o === T) continue;
      for (const [s, H] of [[T, HT], [P, HP]]) { const l = this.K[o][s]; l.forEach(e => { e.p *= 1 - 1 / Math.max(1, H); }); this._prune(l); }
    }
  }
  // a card left P's hand: its real face is known only if a challenge showed it; otherwise everyone assumes he played what he claimed
  gone(P, t, claim, revealed) {
    if (revealed) { this.pile[t]++; this.rev[P]++; if (t !== claim) this.lied[P]++; }
    const h = clamp((this.rev[P] - this.lied[P] + 3) / (this.rev[P] + 4.3), .05, .95);
    for (let o = 0; o < this.n; o++) {
      if (o === P) continue;
      if (revealed) this._lose(o, P, t);
      else { const l = this.K[o][P], b = this._best(l, claim); if (b >= 0) { l[b].p *= 1 - h; this._prune(l); } }
    }
  }
  clear(s) { for (let o = 0; o < this.n; o++) { this.K[o][s] = []; this.K[s][o] = []; } }
  reshuffle() { this.pile.fill(0); }
  rate(j, challenged) { this.opp[j]++; if (challenged) this.ch[j]++; }
  attack(a, b) { if (a !== b) this.hostile[a][b]++; }
}

/* ---------- reading the situation ---------- */
const mineCount = (ctx, x) => ctx.mine.filter(c => c === x).length;
// chance that a random card nobody has shown me is of this type
function priors(ctx) {
  if (ctx._pr) return ctx._pr;
  const T = ctx.cards.length, un = [];
  for (let x = 0; x < T; x++) un[x] = ctx.cards[x].cnt - mineCount(ctx, x) - ctx.pub.pile[x];
  for (const j of ctx.alive) if (j !== ctx.me) for (const e of ctx.rd(ctx.me, j)) un[e.c] -= e.p;
  let U = 0; for (let x = 0; x < T; x++) { un[x] = Math.max(0, un[x]); U += un[x]; }
  return (ctx._pr = un.map(v => U > 0 ? v / U : 0));
}
// chance that `subject` holds at least one `x`, from what `owner` knows (extra: cards he had that have since been played)
function holdProb(ctx, owner, subject, x, extra) {
  let none = 1, mass = 0;
  for (const e of ctx.rd(owner, subject)) { mass += e.p; if (e.c === x) none *= 1 - e.p; }
  const slots = Math.max(0, ctx.handN[subject] + (extra || 0) - mass);
  const pr = owner === ctx.me ? priors(ctx)[x] : ctx.cards[x].cnt / ctx.info.total;
  const pu = 1 - Math.pow(1 - pr, slots);
  return 1 - none * (1 - pu);
}
const knownMass = (ctx, s) => ctx.rd(ctx.me, s).reduce((a, e) => a + e.p, 0);
const isAttack = (ctx, c) => ctx.info.ops[c].some(o => ATTACK.includes(o.op));

// What using a power is worth to its owner, in influence points (own point = 1, an opponent losing one = ~.5)
function opValue(o, nO, killable, nA) {
  const n = o.n, many = o.target === 'all_others' ? nO : 1;
  switch (o.op) {
    case 'steal': return 1.2 * n + (killable ? (nA === 2 ? WIN : 1) : 0);
    case 'inf_loss': return o.target === 'self' ? -n : .5 * n * many + (killable && o.target !== 'all_others' ? (nA === 2 ? WIN : .8) : 0);
    case 'inf_gain': return o.target === 'self' ? n : -.3 * n * many;
    case 'draw': return o.target === 'self' ? .35 * n : -.25 * n * many;
    case 'drop': return o.target === 'self' ? -.35 * n : .3 * n * many;
    case 'skip': return .3 * many;
    case 'take': return .45 * n;
    case 'swap': return .3;
    case 'peek': return .35;
    case 'smuggle': return .4;
    case 'immune': return .9;
    case 'recycle': return .15 * many;
  }
  return 0;
}
function powerValue(ctx, c) {
  const ops = ctx.info.ops[c];
  if (!ops.length) return ctx.info.isDef[c] ? -.1 : 0;   // a defender played on your own turn does nothing; a card without power too
  const nA = ctx.alive.length, nO = nA - 1;
  let v = 0;
  for (const o of ops) {
    if (o.op === 'regain') { v += ctx.regain || 0; continue; }
    if (o.op === 'victory') { v += ctx.inf[ctx.me] >= o.n ? WIN * 4 : 0; continue; }
    if (o.op === 'copy') { v += ctx.copyEff != null && ctx.copyEff !== c ? powerValue(ctx, ctx.copyEff) : 0; continue; }
    const killable = (o.op === 'steal' || o.op === 'inf_loss') && ctx.alive.some(j => j !== ctx.me && ctx.inf[j] <= o.n);
    v += opValue(o, nO, killable, nA);
  }
  return v;
}
// what keeping a card in the hand is worth: the answers to attacks are valuable to hold
function holdValue(ctx, x) { return ctx.info.isDef[x] ? (mineCount(ctx, x) >= 2 ? .25 : .7) : 0; }
const cardValue = (ctx, x) => Math.max(powerValue(ctx, x), holdValue(ctx, x));
function giveValue(ctx) { return ctx.mine.length ? Math.min(...ctx.mine.map(x => cardValue(ctx, x))) : 0; }
// the average worth of a card in the hand of `t`, as far as I know it
function meanHandValue(ctx, t) {
  const H = ctx.handN[t]; if (!H) return 0;
  const l = ctx.rd(ctx.me, t), pr = priors(ctx);
  let mass = 0, val = 0; for (const e of l) { mass += e.p; val += e.p * cardValue(ctx, e.c); }
  let pv = 0; for (let x = 0; x < pr.length; x++) pv += pr[x] * cardValue(ctx, x);
  return (val + Math.max(0, H - mass) * pv) / Math.max(H, mass);
}
// how much a claimed power would hurt me, spread over the players it may hit
function harmToMe(ctx, c) {
  const nO = Math.max(1, ctx.alive.length - 1); let h = 0;
  for (const o of ctx.info.ops[c]) {
    if (o.target === 'self') continue;
    const per = { steal: 1.2 * o.n, inf_loss: o.n, take: .4 * o.n, swap: .2, drop: .3 * o.n, skip: .3 }[o.op] || 0;
    h += o.target === 'all_others' ? per : per / nO;
  }
  return h;
}
// the chance that somebody challenges a claim of mine. Players who have seen my hand challenge a card they know I lack.
function claimRisk(ctx, c, boost) {
  let keep = 1;
  for (const j of ctx.alive) {
    if (j === ctx.me) continue;
    let q = ctx.pub.challengeRate(j) + (boost && boost[j] || 0);
    const seen = ctx.rd(j, ctx.me), mass = seen.reduce((s, e) => s + e.p, 0);
    if (mass >= .5) { const lieB = 1 - holdProb(ctx, j, ctx.me, c, 0); q = q + (1 - q) * lieB * lieB * .9; }
    else if (isAttack(ctx, c)) q *= 1.4;
    keep *= 1 - clamp(q, .02, .95);
  }
  return 1 - keep;
}

/* ---------- decisions ---------- */
const smart = {
  // play the judge (if I hold it) against the action that is open: always against a city key, often against an attack
  judge(ctx) {
    const cl = ctx.claim; if (!cl || cl.by === ctx.me) return false;
    const ops = ctx.info.ops[cl.c] || [];
    if (ops.some(o => o.op === 'victory')) return true;
    if (ops.some(o => ATTACK.includes(o.op) || o.op === 'recycle')) return ctx.rnd() < .5;
    return false;
  },
  // my turn: which card to play and what to say it is
  play(ctx) {
    const me = ctx.me, T = ctx.cards.length, seen = new Set();
    let best = null;
    ctx.mine.forEach((r, k) => {
      if (seen.has(r)) return; seen.add(r);
      const hold = holdValue(ctx, r);
      for (let c = 0; c < T; c++) {
        if (ctx.info.isDef[c]) continue;   // defenders cannot be played as themselves on my turn
        const V = powerValue(ctx, c), pc = claimRisk(ctx, c);
        let ev;
        if (c === r) ev = V + .6 * pc;   // honest: if he is challenged anyway, the challenger pays
        else {
          const pen = ctx.cards[c].penalty, cost = pen.loss + .3 * pen.drop + pen.gift;
          ev = (1 - pc) * V - pc * cost - (pen.loss >= ctx.inf[me] ? 30 : pen.loss + 1 >= ctx.inf[me] ? .5 : 0);
        }
        ev += -hold + (ctx.rnd() - .5) * .25;
        if (!best || ev > best.ev) best = { ev, k, claim: c };
      }
    });
    return best ? { k: best.k, claim: best.claim } : { k: 0, claim: ctx.mine[0] };
  },
  // somebody played a card: do I call it?
  challenge(ctx) {
    const cl = ctx.claim, P = cl.by, c = cl.c, me = ctx.me, pen = ctx.cards[c].penalty, nA = ctx.alive.length;
    // chance that he really had it: from what I know of his hand, the cards that are still out there, and how honest he has been
    const Pc = holdProb(ctx, me, P, c, 1), h = ctx.pub.honestRate(P), lam = .25;
    const den = h * Pc + (1 - h) * lam, pl = den > 0 ? 1 - h * Pc / den : 1;
    let gain = pen.loss + .3 * pen.drop + pen.gift + harmToMe(ctx, c);
    if (ctx.inf[P] <= pen.loss) gain += nA === 2 ? WIN : 1.5;   // the lie would put him out
    if (cl.def && cl.def.A === me) gain += cl.def.kind === 'swap' ? .3 : 1.5 * cl.def.n;   // knocking down a defence lets my attack through
    const risk = ctx.inf[me] <= 1 ? 8 : ctx.inf[me] === 2 ? 1.4 : 1;
    return pl * gain - (1 - pl) * risk + (ctx.rnd() - .5) * .3 > 0;
  },
  // I used a card with a 'pick' power: choose who it hits
  target(ctx, ops, cands) {
    const me = ctx.me, nA = ctx.alive.length, avg = ctx.alive.reduce((s, j) => s + ctx.inf[j], 0) / nA;
    let best = -1, bs = -1e9;
    for (const t of cands) {
      let s = 0;
      for (const o of ops) {
        if (o.target !== 'pick') continue;
        const n = o.n, kill = ctx.inf[t] <= n, lead = .25 * (ctx.inf[t] - avg);
        switch (o.op) {
          case 'steal': { const d = ctx.info.defSteal, r = d >= 0 && ctx.handN[t] > 0 ? holdProb(ctx, me, t, d, 0) : 0; s += n * (1 + lead) + (kill ? (nA === 2 ? WIN : KILL) : 0) - r * 2.4 * n; break; }
          case 'inf_loss': s += n * (.5 + lead) + (kill ? (nA === 2 ? WIN : KILL) : 0); break;
          case 'take': s += ctx.handN[t] ? .5 * meanHandValue(ctx, t) + .3 : -5; break;
          case 'swap': { const d = ctx.info.defSwap, r = d >= 0 && ctx.handN[t] > 0 ? holdProb(ctx, me, t, d, 0) : 0; s += ctx.handN[t] ? meanHandValue(ctx, t) - giveValue(ctx) - r : -5; break; }
          case 'peek': s += ctx.handN[t] ? .25 * ctx.handN[t] + .15 * ctx.inf[t] - (knownMass(ctx, t) >= .7 * ctx.handN[t] ? 1 : 0) : -5; break;
          case 'drop': s += ctx.handN[t] ? .3 * Math.min(n, ctx.handN[t]) : -2; break;
          case 'skip': s += .3 + .1 * ctx.inf[t]; break;
          case 'inf_gain': case 'draw': s -= .3 * ctx.inf[t]; break;
        }
      }
      s += .25 * ctx.pub.hostile(t, me) + (ctx.rnd() - .5) * .2;
      if (s > bs) { bs = s; best = t; }
    }
    return best;
  },
  // a swap: which of my cards goes to the victim (the one I need least)
  give(ctx) {
    let best = 0, bv = 1e9;
    ctx.mine.forEach((x, k) => { const v = cardValue(ctx, x) + ctx.rnd() * .05; if (v < bv) { bv = v; best = k; } });
    return best;
  },
  // I am attacked: answer with the real defender, bluff it, or take the hit
  defend(ctx) {
    const df = ctx.defend, me = ctx.me, mine = ctx.mine;
    for (const o of (df.opts || [df.c]).slice().reverse()) { const x = mine.indexOf(o); if (x >= 0) return { play: x, claim: o }; }
    if (!mine.length) return { decline: true };
    const steal = df.kind !== 'swap', n = df.n || 1;
    const hit = steal ? 1.5 * n : .35;                    // what the attack costs me (my point + his gain), in points
    const lethal = steal && ctx.inf[me] <= n;             // it would put me out
    const pen = ctx.cards[df.c].penalty, penV = pen.loss + .3 * pen.drop + pen.gift;
    const pc = claimRisk(ctx, df.c, { [df.P]: .2 });      // the attacker is the one most likely to call the bluff
    const decline = lethal ? -8 : -hit;
    const stands = hit, caught = (lethal ? -8 : -hit) - penV - (!lethal && pen.loss >= ctx.inf[me] ? 30 : 0);
    const bluff = (1 - pc) * stands + pc * caught;
    if (bluff > decline + .1 + (ctx.rnd() - .5) * .2) {
      let bi = 0, bv = 1e9; mine.forEach((x, i) => { const v = cardValue(ctx, x) + ctx.rnd() * .05; if (v < bv) { bv = v; bi = i; } });
      return { play: bi, claim: df.c };
    }
    return { decline: true };
  }
};

// The old bots, kept as a baseline for the tests and for a weaker opponent: random picks, flat odds.
const dumb = {
  play(ctx) {
    const h = ctx.mine, T = ctx.cards.length, k = Math.floor(ctx.rnd() * h.length), real = h[k];
    let claim = real;
    if (ctx.rnd() < .35) { if (real !== 0 && ctx.rnd() < .6) claim = 0; else claim = (real + 1 + Math.floor(ctx.rnd() * (T - 1))) % T; }
    return { k, claim };
  },
  challenge(ctx) { return ctx.rnd() < Math.min(.18, .5 / Math.max(1, ctx.claim.total)); },
  target(ctx, ops, cands) { return cands[Math.floor(ctx.rnd() * cands.length)]; },
  give(ctx) { return Math.floor(ctx.rnd() * ctx.mine.length); },
  defend(ctx) {
    const h = ctx.mine; let k = -1, cc = ctx.defend.c;
    for (const o of (ctx.defend.opts || [cc]).slice().reverse()) { const x = h.indexOf(o); if (x >= 0) { k = x; cc = o; break; } }
    if (k >= 0 && ctx.rnd() < .85) return { play: k, claim: cc };
    if (h.length && ctx.rnd() < .25) return { play: Math.floor(ctx.rnd() * h.length) };
    return { decline: true };
  }
};

module.exports = { Memory, smart, dumb, analyze };
