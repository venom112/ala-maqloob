// The corrupt officer: defends against the shadow's swap. Run: node test/officer.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const SH = 5, OFF = 6, LAW = 4;   // Fatwa 0, placeholders 1-3, lawyer 4, shadow 5, officer 6
const cnt = (h, v) => h.filter(x => x === v).length;
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
// A plays an honest shadow, picks B and gives card 0 (a 1). Stops when B is asked whether to defend.
async function swapAttack(bHand) {
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = [SH, 1, 2]; r.hands[1] = bHand || [OFF, 3, 3]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
  await until(() => r.phase === 'target'); r.pickCb(1);
  await until(() => r.phase === 'give'); r.giveCb(0);
  const got = await until(() => r.phase === 'defend');
  return { r, got };
}
(async () => {
  {
    const { r, got } = await swapAttack();
    check('victim of a swap is offered the corrupt officer defence', got && r.defend.T === 1 && r.defend.c === OFF && r.defend.kind === 'swap' && r.body('b').g.defend.kind === 'swap');
    r.act('b', { a: 'defend', k: 0, cid: r.defend.id });
    check('the defence is a claim of the officer', r.phase === 'claim' && r.claim.c === OFF && r.claim.by === 1);
    r.decide(0, 'pass'); r.decide(2, 'pass'); await settle(r);
    check('real officer, unchallenged: swap blocked, cards protected', r.hands[0].join() === '1,2' && r.hands[1].join() === '3,3' && r.inf.every(x => x === 3), { h: r.hands, inf: r.inf });
    r.close();
  }
  {
    const { r } = await swapAttack();
    r.act('b', { a: 'defend', k: 1, cid: r.defend.id });   // bluff with a 3
    r.decide(0, 'pass'); r.decide(2, 'pass'); await settle(r);
    check('bluff nobody challenges: swap blocked', r.hands[0].join() === '1,2' && cnt(r.hands[1], OFF) === 1 && r.inf.every(x => x === 3), { h: r.hands, inf: r.inf });
    r.close();
  }
  {
    const { r } = await swapAttack();
    r.act('b', { a: 'defend', k: 1, cid: r.defend.id });
    r.decide(2, 'challenge'); await settle(r);
    check('bluff caught: B loses 1 and the swap happens', r.inf[1] === 2 && r.inf[0] === 3 && cnt(r.hands[0], 1) === 0 && r.hands[0].length === 2 && cnt(r.hands[1], 1) === 1, { h: r.hands, inf: r.inf });
    r.close();
  }
  {
    const { r } = await swapAttack();
    r.act('b', { a: 'defend', k: 0, cid: r.defend.id });
    r.decide(2, 'challenge'); await settle(r);
    check('real officer challenged: challenger loses 1, swap still blocked', r.inf[2] === 2 && r.hands[0].join() === '1,2', { h: r.hands, inf: r.inf });
    r.close();
  }
  {
    const { r } = await swapAttack();
    r.act('b', { a: 'defend', k: -1, cid: r.defend.id }); await settle(r);
    check('no defence: the swap happens', cnt(r.hands[0], 1) === 0 && cnt(r.hands[1], 1) === 1 && r.inf.every(x => x === 3), { h: r.hands });
    r.close();
  }
  {
    const { r } = await swapAttack([3, 3, 3]);
    r.act('b', { a: 'defend', k: 0, cid: r.defend.id }); r.decide(0, 'pass'); r.decide(2, 'pass'); await settle(r);
    check('a bluff works with any card, even with no officer in hand', r.hands[0].join() === '1,2', r.hands);
    r.close();
  }
  {
    // the lawyer does not stop a swap and the officer does not stop a Fatwa: each answers its own attack
    const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
    r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
    for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
    r.status = 'playing'; r.resetCards(); r.newGame();
    check('each attack has its own defender', r.defCard('steal') === LAW && r.defCard('swap') === OFF);
    r.close();
  }
  {
    const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
    r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
    for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
    r.status = 'playing'; r.resetCards(); r.newGame(); r.roster[1].bot = true;
    r.hands[0] = [SH, 1, 2]; r.hands[1] = [OFF, 3, 3]; r.turn = 0; r.drew = true; r.phase = 'act';
    r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1); await until(() => r.phase === 'give'); r.giveCb(0);
    check('a bot victim decides by himself and the game goes on', await settle(r), r.phase);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
