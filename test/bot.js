// The smart bot: it remembers what it saw (Sparrow), uses it, never peeks at what it should not, and beats the old random bot.
// Run: node test/bot.js
const { Room } = require('../game.js');
const { Memory, smart, dumb } = require('../bot.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(20); } return false; }
Room.speed = .02;   // game timers run 50x faster
const FA = 0, LAW = 4, SH = 5, OFF = 6, PK = 7, SP = 8;   // card numbers: Fatwa, lawyer, shadow, officer, pickpocket, sparrow; 1-3 are the placeholder cards
const seeded = s => () => (s = (s * 16807) % 2147483647) / 2147483647;
const STEAL = [{ op: 'steal', n: 1, target: 'pick' }];

// 3 players, player 0 (A) is a bot. hands: a, b, c
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = (o.a || [FA, 1, 2]).slice(); r.hands[1] = (o.b || [3, 1, 2]).slice(); r.hands[2] = (o.c || [2, 2, 2]).slice();
  r.turn = 0; r.drew = true; r.phase = 'act'; r.roster[0].bot = true;
  if (o.inf) r.inf = o.inf.slice();
  return r;
}
const share = (n, f) => { let k = 0; for (let i = 0; i < n; i++) if (f(i)) k++; return k / n; };

(async () => {
  /* ---------- memory (unit) ---------- */
  {
    const cfg = new Room('9', 3, { uid: 'x', name: 'X' }, () => {}).cfg;
    const m = new Memory(3, cfg);
    m.peek(0, 1, [1, 2, 3]);
    check('peek: the viewer knows the hand, entries are certain', m.read(0, 0, 1).length === 3 && m.read(0, 0, 1).every(e => e.p === 1));
    let threw = false; try { m.read(0, 1, 2); } catch (e) { threw = true; }
    check('a bot cannot read what a third player knows', threw);
    check('but it can read what another player knows about it', (() => { m.peek(1, 0, [4]); return m.read(0, 1, 0).length === 1; })());
    m.gone(1, 1, 0, false);
    check('unrevealed play of a card he does not seem to hold: nothing changes', m.read(0, 0, 1).length === 3);
    m.gone(1, 2, 2, false);
    const e2 = m.read(0, 0, 1).find(e => e.c === 2);
    check('unrevealed play of a card I know he has: I am less sure he still has it', e2 && e2.p < .5 && e2.p > 0, e2);
    m.gone(1, 3, 3, true);
    check('revealed card: gone from his known hand, and counted in the pile', !m.read(0, 0, 1).some(e => e.c === 3) && m.pub().pile[3] === 1);
    check('revealed lie / honest are counted for honesty stats', m.pub().honestRate(1) > 0 && (m.gone(1, 1, 0, true), m.pub().honestRate(1) < .7));
    m.peek(0, 1, [1, 2, 3]); m.fuzz(1, 1, 3);
    check('a random card left his hand: everything I knew gets less certain', m.read(0, 0, 1).every(e => Math.abs(e.p - 2 / 3) < 1e-9));
    m.peek(0, 1, [1, 2, 3]); m.exchange(0, 1, 2, 7, 3, 3);
    const k = m.read(0, 0, 1);
    check('I took a card and gave one: I know exactly, and he now holds what I gave', !k.some(e => e.c === 2) && k.some(e => e.c === 7 && e.p === 1) && k.length === 3, k);
    check('the victim knows what was taken from him and what he got', m.read(1, 1, 0).some(e => e.c === 2 && e.p === 1));
    m.peek(0, 2, [5, 5]); m.exchange(1, 2, 5, null, 2, 3);
    check('a third player only knows that something moved: less sure, not zero', (() => { const l = m.read(0, 0, 2); return l.length === 2 && l[0].p < 1 && l[0].p > 0; })());
    m.clear(1);
    check('a player who goes out is forgotten', m.read(0, 0, 1).length === 0);
  }

  /* ---------- the Sparrow fills the memory (in the real game flow) ---------- */
  {
    const r = mk({ a: [SP, 1, 2], b: [3, FA, OFF], c: [2, 2, 2] });
    r.doPlay(0, 0, SP); r.decide(1, 'pass'); r.decide(2, 'pass');
    check('the bot (it plays the sparrow honestly) ends up knowing one hand exactly', await until(() => r.mem.read(0, 0, 1).length === 3 || r.mem.read(0, 0, 2).length === 3));
    const t = r.mem.read(0, 0, 1).length === 3 ? 1 : 2;
    check('what it knows is that player\'s real hand', r.mem.read(0, 0, t).map(e => e.c).sort().join() === r.hands[t].slice().sort().join(), [r.mem.read(0, 0, t), r.hands[t]]);
    check('and the victim\'s memory says the bot has seen him', r.mem.read(t, t, 0).length === 0 && r.mem.read(0, 0, t).length === 3);
    r.close();
  }
  {
    // after the peek the peeked player plays a card nobody challenges: the bot is now less sure about that card
    const r = mk({ a: [SP, 1, 2], b: [3, FA, OFF], c: [2, 2, 2] });
    r.mem.peek(0, 1, [3, FA, OFF]);
    r.doPlay(1, 1, FA); r.decide(0, 'pass'); r.decide(2, 'pass');
    check('he claimed the fatwa and nobody called it: I now doubt he still holds it', await until(() => { const e = r.mem.read(0, 0, 1).find(x => x.c === FA); return !e || e.p < .5; }));
    r.close();
  }
  {
    const r = mk({ a: [SP, 1, 2], b: [3, FA, OFF], c: [2, 2, 2] });
    r.mem.peek(0, 1, [3, FA, OFF]);
    r.doPlay(1, 1, FA); r.decide(2, 'challenge');
    check('a challenge shows the card: it is struck from what I know', await until(() => !r.mem.read(0, 0, 1).some(e => e.c === FA) && r.mem.pub().pile[FA] === 1, 15000), r.mem.read(0, 0, 1));
    r.close();
  }

  /* ---------- using what it saw: choosing a target ---------- */
  {
    const r = mk({ a: [FA, 1, 2], b: [LAW, 1, 2], c: [1, 1, 1] });
    r.mem.peek(0, 1, [LAW, 1, 2]); r.mem.peek(0, 2, [1, 1, 1]);
    const ctx = r.botCtx(0);
    const toC = share(300, () => smart.target(ctx, STEAL, [1, 2]) === 2);
    check('it steals from the one it saw has no lawyer (' + toC.toFixed(2) + ')', toC > .95);
    const r2 = mk({ a: [FA, 1, 2], b: [LAW, 1, 2], c: [1, 1, 1] });
    const blind = share(300, () => smart.target(r2.botCtx(0), STEAL, [1, 2]) === 2);
    check('without a peek it has no reason to prefer either (' + blind.toFixed(2) + ')', blind > .25 && blind < .75);
    r.close(); r2.close();
  }
  {
    const r = mk({ inf: [3, 1, 3] });
    const kill = share(300, () => smart.target(r.botCtx(0), STEAL, [1, 2]) === 1);
    check('it goes for the player who can be put out with one steal (' + kill.toFixed(2) + ')', kill > .9);
    r.close();
  }
  {
    const r = mk({ c: [] });
    const toEmpty = share(300, () => smart.target(r.botCtx(0), STEAL, [1, 2]) === 2);
    check('a player with no cards cannot defend: it prefers him as a steal target (' + toEmpty.toFixed(2) + ')', toEmpty > .8);
    r.close();
  }
  {
    const r = mk({ a: [SH, 1, 1] }); r.mem.peek(0, 1, [FA, FA, SP]); r.mem.peek(0, 2, [1, 1, 1]);
    const SWAP = [{ op: 'swap', n: 1, target: 'pick' }], TAKE = [{ op: 'take', n: 1, target: 'pick' }];
    const s1 = share(200, () => smart.target(r.botCtx(0), SWAP, [1, 2]) === 1), s2 = share(200, () => smart.target(r.botCtx(0), TAKE, [1, 2]) === 1);
    check('shadow / pickpocket: it takes from the hand it saw is full of good cards (' + s1.toFixed(2) + ', ' + s2.toFixed(2) + ')', s1 > .9 && s2 > .9);
    check('the card it gives away in a swap is its least useful one', (() => { const rr = mk({ a: [LAW, FA, 1] }); const g = smart.give(rr.botCtx(0)); rr.close(); return rr.hands[0][g] === 1; })());
    r.close();
  }
  {
    const r = mk({ a: [PK, FA, 1] });
    const SPAR = [{ op: 'peek', n: 1, target: 'pick' }];
    r.mem.peek(0, 1, [3, 3, 3]);
    const toC = share(200, () => smart.target(r.botCtx(0), SPAR, [1, 2]) === 2);
    check('with the sparrow it looks at a hand it does not already know (' + toC.toFixed(2) + ')', toC > .9);
    r.close();
  }

  /* ---------- using what it saw: challenging ---------- */
  {
    const known = mk({ b: [3, 1, 2, 2] }); known.mem.peek(0, 1, [1, 2, 3]);   // I saw his hand [1,2,3]; he has drawn one card since
    known.doPlay(1, 0, FA);                                                      // he plays a card and says: fatwa
    const blind = mk({ b: [3, 1, 2, 2] }); blind.doPlay(1, 0, FA);
    const kc = known.botCtx(0), bc = blind.botCtx(0);
    const rk = share(400, () => smart.challenge(kc)), rb = share(400, () => smart.challenge(bc));
    check('he claims a fatwa that was not in the hand I saw: I call it (' + rk.toFixed(2) + ' vs ' + rb.toFixed(2) + ' when I know nothing)', rk > .8 && rb < .2);
    const honest = mk({ b: [3, 1, 2, 2] }); honest.mem.peek(0, 1, [1, 2, 3]); honest.doPlay(1, 0, 3);
    const hr = share(400, () => smart.challenge(honest.botCtx(0)));
    check('he claims a card I saw him hold: I let it pass (' + hr.toFixed(2) + ')', hr < .1);
    known.close(); blind.close(); honest.close();
  }
  {
    // every copy of the sparrow is accounted for: the claim can only be a lie
    const r = mk({ a: [SP, 1, 2], b: [3, 1, 2, 2] }); r.doPlay(1, 0, SP);
    const ctx = r.botCtx(0); ctx.cards = ctx.cards.map((c, i) => i === SP ? Object.assign({}, c, { cnt: 1 }) : c);   // an edited deck with a single sparrow, in my hand
    check('the only copy is in my hand: a claim of it is a sure lie, I always call it', share(400, () => smart.challenge(ctx)) === 1);
    const r1 = mk({ a: [SP, 1, 2], b: [3, 1, 2, 2], inf: [1, 3, 3] }); r1.doPlay(1, 0, SP);
    const c1 = r1.botCtx(0); c1.cards = c1.cards.map((c, i) => i === SP ? Object.assign({}, c, { cnt: 1 }) : c);
    check('even on my last point a sure lie is worth calling (nothing to lose)', share(200, () => smart.challenge(c1)) === 1);
    const r2 = mk({ b: [3, 1, 2, 2], inf: [1, 3, 3] }); r2.doPlay(1, 0, FA);
    check('on my last point I do not gamble on a normal claim', share(400, () => smart.challenge(r2.botCtx(0))) === 0);
    r.close(); r1.close(); r2.close();
  }
  {
    // the lie would put the liar out
    const r = mk({ b: [3, 1, 2, 2], inf: [3, 1, 3] }); r.doPlay(1, 0, FA);
    const lowP = share(400, () => smart.challenge(r.botCtx(0)));
    const r2 = mk({ b: [3, 1, 2, 2] }); r2.doPlay(1, 0, FA);
    const normal = share(400, () => smart.challenge(r2.botCtx(0)));
    check('a claim from someone on his last point is called more often (' + lowP.toFixed(2) + ' vs ' + normal.toFixed(2) + ')', lowP > normal + .2);
    r.close(); r2.close();
  }

  /* ---------- defending ---------- */
  const attacked = (o, kind, att) => {
    const r = mk(o); r.phase = 'defend'; r.defend = { T: 1, P: 0, c: kind === 'swap' ? OFF : LAW, id: 99, kind, n: 1, resume() {} };
    if (att) att(r); return r;
  };
  {
    const r = attacked({ b: [LAW, 1, 2] }, 'steal');
    const d = smart.defend(r.botCtx(1));
    check('holding the lawyer against a steal: plays it', d.play === 0, d);
    const r2 = attacked({ b: [OFF, 1, 2] }, 'swap'); const d2 = smart.defend(r2.botCtx(1));
    check('holding the officer against a swap: plays it', d2.play === 0, d2);
    r.close(); r2.close();
  }
  {
    const r = attacked({ b: [1, 2, 3], inf: [3, 1, 3] }, 'steal');
    check('the steal would put it out: it always tries a bluff', share(200, () => smart.defend(r.botCtx(1)).play != null) > .95);
    const r2 = attacked({ b: [1, 2, 3] }, 'steal', rr => rr.mem.peek(0, 1, [1, 2, 3]));
    const free = attacked({ b: [1, 2, 3] }, 'steal');
    const seen = share(200, () => smart.defend(r2.botCtx(1)).play != null), unseen = share(200, () => smart.defend(free.botCtx(1)).play != null);
    check('it will not bluff a defence in front of the attacker who has seen its hand (' + seen.toFixed(2) + ' vs ' + unseen.toFixed(2) + ' when nobody has)', seen < .1 && unseen > .5);
    const r3 = attacked({ b: [1, 2, 3] }, 'swap');
    check('a swap costs little: it does not risk a point to bluff against it', share(200, () => smart.defend(r3.botCtx(1)).play != null) < .2);
    const r4 = attacked({ b: [LAW, 1, 2] }, 'steal'); r4.mem.peek(0, 1, [3, 3, 3]);
    check('when bluffing it throws away its least useful card', (() => { const rr = attacked({ b: [FA, LAW === 4 ? 4 : 4, 1], inf: [3, 1, 3] }, 'steal'); rr.hands[1] = [FA, OFF, 1]; const d = smart.defend(rr.botCtx(1)); rr.close(); return d.play === 2; })());
    r.close(); r2.close(); free.close(); r3.close(); r4.close();
  }

  /* ---------- using what it knows about who has seen it ---------- */
  {
    const open = mk({ a: [1, 2, 3] }), watched = mk({ a: [1, 2, 3] });
    watched.mem.peek(1, 0, [1, 2, 3]); watched.mem.peek(2, 0, [1, 2, 3]);   // both others have seen my hand
    const bluff = rr => share(300, () => { const ctx = rr.botCtx(0), d = smart.play(ctx); return d.claim !== ctx.mine[d.k]; });
    const bo = bluff(open), bw = bluff(watched);
    check('it bluffs more when nobody has seen its hand (' + bo.toFixed(2) + ') than when two players have (' + bw.toFixed(2) + ')', bo > bw + .25 && bw < .1);
    const strong = mk({ a: [FA, LAW, 1] }); const sctx = strong.botCtx(0);
    check('with a fatwa in hand it plays it honestly most of the time', share(300, () => { const d = smart.play(sctx); return sctx.mine[d.k] === FA && d.claim === FA; }) > .6);
    const sure = mk({ a: [1, 2, 3], inf: [1, 3, 3] }); const uctx = sure.botCtx(0);
    check('on its last point it never bluffs a card whose penalty would put it out', share(300, () => { const d = smart.play(uctx); return d.claim !== uctx.mine[d.k] && uctx.cards[d.claim].penalty.loss >= 1; }) === 0);
    open.close(); watched.close(); strong.close(); sure.close();
  }

  /* ---------- end to end: the real flow uses the knowledge ---------- */
  {
    let toC = 0, N = 10, ok = true;
    for (let g = 0; g < N; g++) {
      const r = mk({ a: [FA, 1, 2], b: [LAW, 1, 2], c: [1, 1, 1] });
      r.mem.peek(0, 1, [LAW, 1, 2]); r.mem.peek(0, 2, [1, 1, 1]);
      r.doPlay(0, 0, FA); r.decide(1, 'pass'); r.decide(2, 'pass');
      ok = await until(() => r.inf[0] === 4, 15000) && ok;
      if (r.inf[2] === 2) toC++;
      r.close();
    }
    check('a bot that saw who has the lawyer steals from the other player, ' + toC + ' times of ' + N, ok && toC >= 9);
  }

  /* ---------- it cannot cheat ---------- */
  {
    // two worlds that look the same to player 0 (same public state, same peek) but where the others hold different cards
    const world = (b, c, t) => { const r = mk({ a: [FA, 1, 8, 2], b, c }); r.mem.peek(0, 1, [3, 1, 2]); r.doPlay(1, 0, FA); r.hands[1].push(t); return r; };
    const w1 = world([3, 1, 2, 2], [2, 2, 2], 0), w2 = world([7, 7, 8, 4], [0, 4, 5], 5);
    const same = JSON.stringify(w1.botCtx(0)) === JSON.stringify(w2.botCtx(0));
    check('what the bot is handed is identical in both worlds (no hidden cards in it)', same);
    const run = (r, f) => { const ctx = r.botCtx(0); ctx.rnd = seeded(7); return JSON.stringify(f(ctx)); };
    check('challenge decision identical', run(w1, c => smart.challenge(c)) === run(w2, c => smart.challenge(c)));
    check('play decision identical', run(w1, c => smart.play(c)) === run(w2, c => smart.play(c)));
    check('target decision identical', run(w1, c => smart.target(c, STEAL, [1, 2])) === run(w2, c => smart.target(c, STEAL, [1, 2])));
    check('give decision identical', run(w1, c => smart.give(c)) === run(w2, c => smart.give(c)));
    let threw = false; try { w1.botCtx(0).rd(1, 2); } catch (e) { threw = true; }
    check('the handed-over memory refuses to show what two other players know', threw);
    w1.close(); w2.close();
  }

  /* ---------- whole games ---------- */
  const mkGame = (n, iqs) => {
    const r = new Room('s', n, { uid: 'u0', name: 'P0' }, () => {});
    for (let i = 1; i < n; i++) r.add({ uid: 'u' + i, name: 'P' + i });
    r.roster.forEach((x, i) => { x.bot = true; x.iq = iqs[i]; });
    r.status = 'playing'; r.resetCards(); r.newGame(); r.touch();
    return r;
  };
  const runGames = (list, limit) => Promise.all(list.map(r => new Promise(res => {
    // -1: still going when time ran out (healing cards make random-bot games very long); -2: nothing happened for 10 s (a real stall)
    const t0 = Date.now(); let seq = -1, seqAt = t0;
    const iv = setInterval(() => {
      if (r.evSeq !== seq) { seq = r.evSeq; seqAt = Date.now(); }
      if (r.over >= 0) { clearInterval(iv); res(r.over); r.close(); }
      else if (Date.now() - seqAt > 10000) { clearInterval(iv); res(-2); r.close(); }
      else if (Date.now() - t0 > limit) { clearInterval(iv); res(-1); r.close(); }
    }, 50);
  })));
  {
    const N = 60, n = 4, iqs = [], games = [];
    for (let g = 0; g < N; g++) { const q = Array(n).fill('dumb'); q[g % n] = 'smart'; iqs.push(q); games.push(mkGame(n, q)); }
    const winners = await runGames(games, 100000);
    const stalls = winners.filter(w => w === -2).length, ended = winners.filter(w => w >= 0).length, smartWins = winners.filter((w, g) => w >= 0 && iqs[g][w] === 'smart').length;
    check('60 games, one smart bot against three random ones: none gets stuck', stalls === 0, { stalls });
    check('the smart bot wins far more than its fair share of 25%: ' + smartWins + '/' + ended, smartWins / Math.max(1, ended) > .45, { smartWins });
  }
  {
    const sizes = [3, 3, 3, 4, 4, 5, 6, 8, 8], games = sizes.map(n => mkGame(n, Array(n).fill('smart')));
    const winners = await runGames(games, 100000);
    // the healing cards (doctor, accountant) make games between careful bots long, so some are still going when the time budget ends: that is fine, a stall (-2) is not
    check('smart bots only, 3 to 8 players: no game stalls (some are still going when time ends: healing and immunity make careful bots slow)', winners.every(w => w !== -2), winners);
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
