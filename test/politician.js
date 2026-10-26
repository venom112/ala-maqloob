// The politician: played face up (no challenge), immune to every attack for two turns. Run: node test/politician.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const PO = 13, FA = 0;   // Fatwa 0 ... bomber 12, politician 13
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [PO, 1, 2]; r.hands[1] = o.b || [FA, 1, 1]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
const settle = r => until(() => r.phase === 'act' && r.claim === null && r.turn !== 0);
(async () => {
  {
    const r = mk(); r.act('a', { a: 'play', k: 0, d: PO });   // named as itself: played face up
    check('the politician named as itself is played face up (no challenge phase)', r.phase === 'resolve' && r.claim.c === PO && r.claim.pending.length === 0 && r.pile[r.pile.length - 1].rev === true, { ph: r.phase, c: r.claim && r.claim.c });
    await settle(r);
    check('A is immune now', r.isImmune(0) && r.body('b').g.imm[0] === 2 && !r.body('b').g.imm[1]);
    check('the card stays face up on the pile', r.pile[r.pile.length - 1].rev === true);
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2] }); r.act('a', { a: 'play', k: 0, d: PO });
    check('another card cannot be claimed as the politician', r.phase === 'act' && r.hands[0].length === 3);
    r.close();
  }
  {
    const r = mk(); r.act('a', { a: 'play', k: 0, d: PO }); await settle(r);
    // B plays a fatwa on A (honest): it must not hurt A
    r.turn = 1; r.drew = true; r.phase = 'act'; r.claim = null; r.doPlay(1, 0, FA); r.decide(0, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target', 15000); r.pickCb(0);
    await until(() => r.phase === 'act' && r.claim === null && r.turn !== 1, 30000);
    check('a steal against the immune player does nothing', r.inf.join() === '3,3,3', r.inf);
    check('everybody is told he was immune', r.evs.some(e => e.k === 'hit' && e.steps.some(s => s.imm && s.imm.includes(0))) );
    // immunity: still on during A's second lap, over after
    r.turnsN[0] = 2; check('still immune in the second lap', r.isImmune(0));
    r.turnsN[0] = 3; check('no longer immune after two laps', !r.isImmune(0));
    r.close();
  }
  {
    // the bot is value driven (it may bluff instead), but whenever it plays the politician it is face up, and it does so sometimes
    let ups = 0, wrong = 0;
    for (let n = 0; n < 12; n++) {
      const r = mk(); r.roster[0].bot = true; r.hands[0] = [PO, 1, 2]; r.botAct(); await sleep(60);
      const cl = r.claim;
      if (cl && cl.c === PO) { if (cl.pending.length === 0) ups++; else wrong++; } else if (!cl) ups++;
      r.close();
    }
    check('a bot sometimes plays the politician, always face up', ups > 0 && wrong === 0, { ups, wrong });
  }
  {
    const r = mk(); r.act('a', { a: 'play', k: 0, d: 0 });
    check('the politician can be thrown away face down as another card (bluff, no immunity)', r.phase === 'claim' && r.claim.c === 0 && !r.isImmune(0) && r.pile[r.pile.length - 1].rev === false, { ph: r.phase });
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
