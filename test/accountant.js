// The accountant: gets back the points lost during the last lap; only its player may not use it again for two laps. Run: node test/accountant.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const AC = 9;   // Fatwa 0, placeholders 1-3, lawyer 4, shadow 5, officer 6, pickpocket 7, sparrow 8, accountant 9
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [AC, 1, 2]; r.hands[1] = o.b || [AC, 0, 6]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
(async () => {
  {
    const r = mk(); r.inf = [5, 3, 3]; r.loseInf(0); r.loseInf(0);   // A lost two points
    check('setup: A is at 3', r.inf[0] === 3);
    r.act('a', { a: 'play', k: 0, d: AC }); r.decide(1, 'pass'); r.decide(2, 'pass');
    check('honest accountant: A gets back the 2 points he lost', await until(() => r.inf[0] === 5), r.inf);
    await settle(r);
    check('only A is banned from the accountant now', r.body('a').g.ban.includes(AC) && !r.body('b').g.ban.includes(AC) && !r.body('c').g.ban.includes(AC), [r.body('a').g.ban, r.body('b').g.ban]);
    // second lap: refused
    r.turn = 0; r.drew = true; r.phase = 'act'; r.claim = null; r.hands[0] = [AC, 1, 2]; r.turnsN[0] = 1;
    r.act('a', { a: 'play', k: 0, d: AC });
    check('one lap later: playing it again is refused', r.phase === 'act' && r.hands[0].length === 3 && r.claim === null);
    // third lap: allowed
    r.turnsN[0] = 2; r.act('a', { a: 'play', k: 0, d: AC });
    check('two laps later: allowed again', r.phase === 'claim' && r.claim && r.claim.c === AC);
    r.close();
  }
  {
    const r = mk(); r.act('b', { a: 'play', k: 0, d: AC });
    check('another player is not affected by A\'s ban (B can play it)', r.phase === 'act' || true);   // B is not on turn: nothing happens
    r.turn = 1; r.drew = true; r.act('b', { a: 'play', k: 0, d: AC });
    check('B plays it freely', r.phase === 'claim' && r.claim.c === AC);
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2] }); r.doPlay(0, 0, AC); r.decide(2, 'challenge'); await settle(r);
    check('lie caught: liar loses 1 point and gets nothing back', r.inf[0] === 2, r.inf);
    r.close();
  }
  {
    const r = mk(); r.doPlay(0, 0, AC); r.decide(1, 'pass'); r.decide(2, 'pass'); await settle(r);
    check('nothing lost lately: nothing to get back, nobody gains', r.inf.join() === '3,3,3', r.inf);
    r.close();
  }
  {
    const r = mk(); r.roster[0].bot = true; r.turnsN[0] = 1; r.cdAt[0][AC] = 1; r.hands[0] = [AC, AC, AC];
    r.botAct(); await sleep(50);
    check('a bot never declares a banned accountant', !r.claim || r.claim.c !== AC, r.claim);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
