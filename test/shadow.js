// The shadow: swaps a random card of a chosen player for a card of your choice. Run: node test/shadow.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const SH = 5;   // Fatwa 0, placeholders 1-3, lawyer 4, shadow 5
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [SH, 1, 2]; r.hands[1] = o.b || [3, 3, 3]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  if (o.fast) r.cfg.set.pickMs = 1300;
  r.cfg.set.decideMs = 300;   // the victim's defence window (the corrupt officer) closes quickly: these tests are about the swap itself
  if (o.botA) r.roster[0].bot = true;
  return r;
}
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
const cnt = (h, v) => h.filter(x => x === v).length;

(async () => {
  {
    const r = mk(); r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    check('after choosing the player, the card to give is asked for', await until(() => r.phase === 'give'));
    r.act('b', { a: 'give', k: 0, cid: r.claim.id }); r.act('a', { a: 'give', k: 0, cid: 999 });
    check('only the card owner can answer, with the right id', r.phase === 'give');
    r.act('a', { a: 'give', k: 7, cid: r.claim.id });
    check('an out-of-range card is ignored', r.phase === 'give');
    r.act('a', { a: 'give', k: 0, cid: r.claim.id });
    await settle(r);
    check('A gave his chosen card (1) and got one of B\'s (3)', cnt(r.hands[0], 1) === 0 && cnt(r.hands[0], 3) === 1 && r.hands[0].length === 2, r.hands);
    check('B received the card and lost a random one', cnt(r.hands[1], 1) === 1 && cnt(r.hands[1], 3) === 2 && r.hands[1].length === 3, r.hands);
    check('nobody lost influence', r.inf.every(x => x === 3), r.inf);
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2] });   // lie: plays card 1 and says shadow
    r.doPlay(0, 0, SH); r.decide(2, 'challenge'); await settle(r);
    check('lie caught: liar loses 1 and the power is cancelled (no swap)', r.inf[0] === 2 && r.inf[2] === 3 && cnt(r.hands[1], 3) === 3 && r.hands[0].length === 2, { inf: r.inf, h: r.hands });
    r.close();
  }
  {
    const r = mk(); r.doPlay(0, 0, SH); r.decide(2, 'challenge');
    await until(() => r.phase === 'target', 30000); r.pickCb(1);
    await until(() => r.phase === 'give'); r.giveCb(1); await settle(r);
    check('honest card challenged: challenger loses 1, the swap still happens', r.inf[2] === 2 && r.inf[0] === 3 && cnt(r.hands[0], 2) === 0 && cnt(r.hands[0], 3) === 1, { inf: r.inf, h: r.hands });
    r.close();
  }
  {
    const r = mk({ fast: true }); r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    const t0 = Date.now(); await until(() => r.phase === 'give'); await settle(r);
    check('no answer in time: a random card is given and the game goes on', Date.now() - t0 < 8000 && cnt(r.hands[0], 3) === 1 && r.hands[0].length === 2, r.hands);
    r.close();
  }
  {
    const r = mk({ botA: true }); r.hands[2] = [0, 0, 0];   // B and C hold different cards, so a swap is visible whoever he picks
    r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
    const ok = await settle(r);
    const all = r.hands.flat().sort().join();
    check('a bot plays the shadow by himself', ok && all === [1, 2, 3, 3, 3, 0, 0, 0].sort().join() && r.hands[0].length === 2 && (cnt(r.hands[0], 3) + cnt(r.hands[0], 0)) === 1, r.hands);
    r.close();
  }
  {
    const r = mk({ b: [] }); r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    await until(() => r.phase === 'give'); r.giveCb(0); await settle(r);
    check('victim with no cards: nothing is swapped, nobody is stuck', r.hands[0].length === 2 && r.hands[1].length === 0 && cnt(r.hands[0], 1) === 1, r.hands);
    r.close();
  }
  {
    const r = mk({ a: [SH] });   // plays his last card: nothing left to give
    r.doPlay(0, 0, SH); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1); await settle(r);
    check('player with an empty hand: no give step, game goes on', r.hands[0].length === 0 && r.hands[1].length === 3);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
