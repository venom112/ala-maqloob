// The judge: played against any open action to cancel it (not the politician, which has no window). Run: node test/judge.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const JG = 16, KEY = 15, POL = 13;
function mk(a, b, c, inf) {
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = a; r.hands[1] = b; r.hands[2] = c; r.inf = inf || [3, 3, 3]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
(async () => {
  {
    const r = mk([0, 1, 2], [JG, 1, 2], [1, 2, 3]);
    check('the judge card exists and is a face-down card', r.cfg.cards[JG].power[0].op === 'judge' && !r.cfg.cards[JG].up);
    r.doPlay(0, 0, 0);
    check('B may judge, A (the actor) may not', r.canJudge(1) && !r.canJudge(0));
    r.act('a', { a: 'judge', k: 0, cid: r.claim.id });
    check('the actor cannot judge his own action', r.claim.by === 0 && !r.claim.def);
    r.act('b', { a: 'judge', k: 0, cid: r.claim.id });
    check('the judge is a nested claim by B', r.claim.by === 1 && r.claim.c === JG && !!r.claim.def && r.claim.pending.includes(0) && r.claim.pending.includes(2), r.claim);
    r.decide(0, 'pass'); r.decide(2, 'pass');
    check('honest unchallenged judge: the Fatwa is cancelled', await settle(r) && r.inf.join() === '3,3,3' && r.turn === 1, { inf: r.inf, turn: r.turn });
    check('everybody sees the judged event', r.evs.some(e => e.k === 'judge'));
    r.close();
  }
  {
    const r = mk([0, 1, 2], [1, 2, 3], [1, 2, 3]);
    r.doPlay(0, 0, 0); r.act('b', { a: 'judge', k: 0, cid: r.claim.id });
    r.decide(0, 'challenge'); r.decide(2, 'pass');
    check('a lying judge caught: B loses a point, the Fatwa goes on', await until(() => r.inf[1] === 2), r.inf);
    check('then the others still decide on the Fatwa (B cannot judge again)', await until(() => r.phase === 'claim' && !r.claim.def && r.claim.by === 0), { ph: r.phase, cl: r.claim });
    check('B still decides on the Fatwa but cannot judge again', r.claim.pending.includes(1) && !r.canJudge(1));
    r.decide(1, 'pass'); r.decide(2, 'pass');
    check('Fatwa then resolves normally (target picked by A)', await until(() => r.phase === 'target'), r.phase);
    r.close();
  }
  {
    const r = mk([0, 1, 2], [JG, 1, 2], [1, 2, 3]);
    r.doPlay(0, 0, 0); r.act('b', { a: 'judge', k: 0, cid: r.claim.id });
    r.decide(0, 'challenge'); r.decide(2, 'pass');
    check('honest judge challenged: the challenger loses a point and the Fatwa is cancelled', await settle(r) && r.inf.join() === '2,3,3', r.inf);
    r.close();
  }
  {
    const r = mk([KEY, 1, 2], [JG, 1, 2], [1, 2, 3], [10, 3, 3]);
    r.act('a', { a: 'play', k: 0, d: KEY });
    check('the city key is face up with no window at all: the judge cannot stop it', r.phase !== 'claim' && !r.canJudge(1));
    check('and A wins', await until(() => r.over === 0), r.over);
    r.close();
  }
  {
    const r = mk([POL, 1, 2], [JG, 1, 2], [1, 2, 3]);
    r.act('a', { a: 'play', k: 0, d: POL });
    check('the politician has no window: the judge cannot touch it', r.phase !== 'claim' && !r.canJudge(1));
    r.close();
  }
  {
    // defenders cannot be played under their own name on your own turn, but can be thrown away as another card
    const r = mk([JG, 4, 6], [1, 2, 3], [1, 2, 3]);
    r.act('a', { a: 'play', k: 0, d: JG }); check('judge cannot be declared as itself on your turn', r.phase === 'act' && r.hands[0].length === 3);
    r.act('a', { a: 'play', k: 1, d: 4 }); check('lawyer cannot be declared on your turn', r.phase === 'act' && r.hands[0].length === 3);
    r.act('a', { a: 'play', k: 2, d: 6 }); check('officer cannot be declared on your turn', r.phase === 'act' && r.hands[0].length === 3);
    r.act('a', { a: 'play', k: 0, d: 0 }); check('but the judge can be thrown away claiming another card', r.phase === 'claim' && r.claim.c === 0 && r.hands[0].length === 2);
    r.close();
  }
  {
    // no defender cancels another: nobody can judge a defence
    const r = mk([0, 1, 2], [4, 1, 2], [JG, 2, 3]);
    r.doPlay(0, 0, 0); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    await until(() => r.phase === 'defend'); r.act('b', { a: 'defend', k: 0, c: 4, cid: r.defend.id });
    check('a defence is a claim that the judge cannot touch', r.phase === 'claim' && !!r.claim.def && !r.canJudge(2));
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
