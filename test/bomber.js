// The bomber: everyone else throws a card and draws another; a liar loses a point, the power and a card. Run: node test/bomber.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const BM = 12;
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [BM, 1, 2]; r.hands[1] = [1, 1, 1]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
(async () => {
  {
    const r = mk(); r.deck = [3, 3, 3, 3, 3, 3]; const d0 = r.deck.length;
    r.act('a', { a: 'play', k: 0, d: BM }); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'act' && r.turn === 1 && r.claim === null);
    check('B and C each swapped one card for another from the pile', r.hands[1].filter(x => x === 3).length === 1 && r.hands[2].filter(x => x === 3).length === 1 && r.hands[1].length === 3 && r.hands[2].length === 3, r.hands);
    check('the pile size is unchanged and A keeps his hand', r.deck.length === d0 && r.hands[0].length === 2 && r.inf.every(x => x === 3), { deck: r.deck.length, inf: r.inf });
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2, 5] }); r.doPlay(0, 0, BM); r.decide(2, 'challenge');
    await until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
    check('lie caught: A loses a point and a card, nobody else is touched', r.inf[0] === 2 && r.hands[0].length === 2 && r.hands[1].join() === '1,1,1' && r.hands[2].join() === '2,2,2', { inf: r.inf, h: r.hands });
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
