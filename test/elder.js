// The elder: a defence that cancels any attack aimed at you, then you take a point from any player. Run: node test/elder.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const LAW = 4, OFF = 6, EL = 17, SHADOW = 5;
function mk(a, b, c, inf) {
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = a; r.hands[1] = b; r.hands[2] = c; r.inf = inf || [3, 3, 3]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
// A plays an honest card (Fatwa 0 = steal, shadow 5 = swap) and aims it at B; returns when B may defend
async function attack(r, card) {
  r.doPlay(0, 0, card); r.decide(1, 'pass'); r.decide(2, 'pass');
  await until(() => r.phase === 'target'); r.pickCb(1);
  return until(() => r.phase === 'defend');
}
(async () => {
  {
    const r = mk([0, 1, 2], [EL, 1, 2], [1, 2, 3]);
    check('the elder card is a face-down defender with 2 points of penalty', r.cfg.cards[EL].power[0].op === 'elder' && r.cfg.cards[EL].penalty.loss === 2 && r.isDefCard(EL) && r.cfg.cards[EL].cnt === 4);
    check('B is offered the lawyer and the elder against a steal', await attack(r, 0) && r.defend.opts.join() === LAW + ',' + EL, r.defend && r.defend.opts);
    r.act('b', { a: 'defend', k: 0, c: EL, cid: r.defend.id });
    check('B defends as the elder', r.phase === 'claim' && r.claim.c === EL && !!r.claim.def, r.claim);
    r.decide(0, 'pass'); r.decide(2, 'pass');
    check('a stood elder: he now picks a player to take a point from', await until(() => r.phase === 'target' && r.claim.by === 1 && r.targets.join() === '0,2'), { ph: r.phase, t: r.targets });
    r.act('b', { a: 'pick', tg: 2, cid: r.claim.id });
    check('the attack is cancelled (A keeps his point) and B takes one from C', await settle(r) && r.inf.join() === '3,4,2', r.inf);
    r.close();
  }
  {
    const r = mk([0, 1, 2], [EL, 1, 2], [1, 2, 3]);
    await attack(r, 0); r.act('b', { a: 'defend', k: 0, c: EL, cid: r.defend.id });
    r.decide(0, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.act('b', { a: 'pick', tg: 0, cid: r.claim.id });
    check('he may take the point from the attacker himself', await settle(r) && r.inf.join() === '2,4,3', r.inf);
    r.close();
  }
  {
    const r = mk([SHADOW, 1, 2], [EL, 1, 2], [1, 2, 3]);
    check('the elder also stops a swap', await attack(r, SHADOW) && r.defend.opts.join() === OFF + ',' + EL);
    const before = r.hands[1].slice();
    r.act('b', { a: 'defend', k: 0, c: EL, cid: r.defend.id }); r.decide(0, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.act('b', { a: 'pick', tg: 2, cid: r.claim.id });
    check('swap blocked, hands untouched, point taken', await settle(r) && r.inf.join() === '3,4,2' && r.hands[1].length === 2 && !r.hands[1].includes(5), { inf: r.inf, h: r.hands[1] });
    r.close();
  }
  {
    const r = mk([0, 1, 2], [1, 2, 3], [1, 2, 3]);
    await attack(r, 0); r.act('b', { a: 'defend', k: 0, c: EL, cid: r.defend.id });
    r.decide(0, 'challenge'); r.decide(2, 'pass');
    check('a lying elder caught: B loses 2 points and the attack hits him', await settle(r) && r.inf.join() === '4,0,3' || r.out[1], r.inf);
    r.close();
  }
  {
    const r = mk([0, 1, 2], [EL, 1, 2], [1, 2, 3]);
    await attack(r, 0); r.act('b', { a: 'defend', k: 0, c: EL, cid: r.defend.id });
    r.decide(0, 'challenge'); r.decide(2, 'pass');
    check('real elder challenged: the challenger loses a point, the attack is cancelled, B still takes a point', await until(() => r.phase === 'target' && r.claim.by === 1), r.phase);
    r.act('b', { a: 'pick', tg: 2, cid: r.claim.id });
    check('result', await settle(r) && r.inf.join() === '2,4,2', r.inf);
    r.close();
  }
  {
    const r = mk([0, 1, 2], [EL, 1, 2], [1, 2, 3]); r.roster[1].bot = true;
    await attack(r, 0);
    check('a bot holding the elder defends with it', await until(() => r.claim && r.claim.def && r.claim.c === EL, 8000), r.claim);
    r.decide(0, 'pass'); r.decide(2, 'pass');
    check('and the game goes on', await settle(r) && r.inf[1] === 4 && r.inf[0] + r.inf[2] === 5, r.inf);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
