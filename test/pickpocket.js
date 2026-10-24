// The pickpocket: steals a random card from a chosen player's hand. Run: node test/pickpocket.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const PK = 7;   // Fatwa 0, placeholders 1-3, lawyer 4, shadow 5, officer 6, pickpocket 7
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [PK, 1, 2]; r.hands[1] = o.b || [3, 3, 0]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  if (o.botA) r.roster[0].bot = true;
  return r;
}
(async () => {
  {
    const r = mk(); r.doPlay(0, 0, PK); r.decide(1, 'pass'); r.decide(2, 'pass');
    check('the player is asked whom to rob', await until(() => r.phase === 'target') && r.targets.join() === '1,2');
    r.pickCb(1); await settle(r);
    check('A has one more card, B one less, the card came from B\'s hand', r.hands[0].length === 3 && r.hands[1].length === 2 && [...r.hands[0], ...r.hands[1]].sort().join() === [1, 2, 3, 3, 0].sort().join(), r.hands);
    check('nobody lost influence', r.inf.every(x => x === 3), r.inf);
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2] }); r.doPlay(0, 0, PK); r.decide(2, 'challenge'); await settle(r);
    check('lie caught: liar loses 1 and the power is cancelled', r.inf[0] === 2 && r.hands[1].length === 3 && r.hands[0].length === 2, { inf: r.inf, h: r.hands });
    r.close();
  }
  {
    const r = mk(); r.doPlay(0, 0, PK); r.decide(2, 'challenge');
    await until(() => r.phase === 'target', 30000); r.pickCb(1); await settle(r);
    check('honest card challenged: challenger loses 1, he still robs', r.inf[2] === 2 && r.inf[0] === 3 && r.hands[0].length === 3 && r.hands[1].length === 2, { inf: r.inf, h: r.hands });
    r.close();
  }
  {
    const r = mk({ b: [] }); r.doPlay(0, 0, PK); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1); await settle(r);
    check('victim with an empty hand: nothing to take, game goes on', r.hands[0].length === 2 && r.hands[1].length === 0);
    r.close();
  }
  {
    const r = mk({ botA: true }); r.doPlay(0, 0, PK); r.decide(1, 'pass'); r.decide(2, 'pass');
    const ok = await settle(r);
    check('a bot pickpocket picks a victim by himself', ok && r.hands.reduce((s, h) => s + h.length, 0) === 8 && r.hands[0].length === 3, r.hands);
    r.close();
  }
  {
    const r = mk(); r.cfg.set.pickMs = 1200; r.doPlay(0, 0, PK); r.decide(1, 'pass'); r.decide(2, 'pass');
    const ok = await settle(r);
    check('no choice in time: a victim is picked at random', ok && r.hands[0].length === 3, r.hands);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
