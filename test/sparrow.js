// The sparrow: shows one player's whole hand to the card's owner alone. Run: node test/sparrow.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const SP = 8;   // Fatwa 0, placeholders 1-3, lawyer 4, shadow 5, officer 6, pickpocket 7, sparrow 8
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  const sent = { a: [], b: [], c: [] };
  for (const u of ['a', 'b', 'c']) r.attach(u, m => sent[u].push(m));
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [SP, 1, 2]; r.hands[1] = o.b || [3, 0, 6]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  if (o.botA) r.roster[0].bot = true;
  return { r, sent };
}
(async () => {
  {
    const { r, sent } = mk(); r.doPlay(0, 0, SP); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    check('A sees B\'s whole hand', await until(() => r.body('a').peek && r.body('a').peek.of === 1), r.body('a').peek);
    const pk = r.body('a').peek;
    check('the cards shown are exactly B\'s', pk.cards.slice().sort().join() === '0,3,6', pk);
    await sleep(150);
    const everything = who => JSON.stringify(sent[who]);
    check('B does not receive the cards of the peek', !r.body('b').peek && sent.b.every(m => !m.peek));
    check('C does not receive them either', !r.body('c').peek && sent.c.every(m => !m.peek));
    const anyoneElse = ['b', 'c'].some(u => sent[u].some(m => m.g && JSON.stringify(m.g).includes('"cards":[0,3,6]')));
    check('nothing in the public state or events carries the cards', !anyoneElse && !JSON.stringify(r.evs).includes('0,3,6'));
    check('everyone does see that a peek happened (public line)', r.evs.some(e => e.k === 'power' && e.steps[0].op === 'peek'));
    await settle(r);
    check('hands are unchanged and nobody lost influence', r.hands[1].slice().sort().join() === '0,3,6' && r.inf.every(x => x === 3), { h: r.hands, inf: r.inf });
    r.doPlay(1, 0, 3);
    check('the private view is cleared when the next card is played', !r.body('a').peek);
    r.close();
  }
  {
    const { r } = mk({ a: [1, 2, 2] }); r.doPlay(0, 0, SP); r.decide(2, 'challenge'); await settle(r);
    check('lie caught: liar loses 1, power cancelled, nothing is shown', r.inf[0] === 2 && !r.body('a').peek && !r.body('b').peek);
    r.close();
  }
  {
    const { r } = mk(); r.doPlay(0, 0, SP); r.decide(2, 'challenge');
    await until(() => r.phase === 'target', 30000); r.pickCb(2);
    const ok = await until(() => r.body('a').peek && r.body('a').peek.of === 2); await settle(r);
    check('honest card challenged: challenger loses 1, A still sees the cards (C\'s)', ok && r.inf[2] === 2 && r.inf[0] === 3, r.inf);
    r.close();
  }
  {
    const { r } = mk({ b: [] }); r.doPlay(0, 0, SP); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1); await settle(r);
    check('victim with no cards: nothing to show', !r.body('a').peek && r.hands[1].length === 0);
    r.close();
  }
  {
    const { r } = mk({ botA: true }); r.doPlay(0, 0, SP); r.decide(1, 'pass'); r.decide(2, 'pass');
    check('a bot using the sparrow does not stall the game', await settle(r));
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
