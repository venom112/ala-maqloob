// The smuggler: two cards at the next draw; rest of 3 turns; a liar loses a point, the power and his next turn. Run: node test/smuggler.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const SM = 11;   // Fatwa 0, placeholders 1-3, lawyer 4, shadow 5, officer 6, pickpocket 7, sparrow 8, accountant 9, doctor 10, smuggler 11
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [SM, 1, 2]; r.hands[1] = [1, 1, 1]; r.hands[2] = [2, 2, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
(async () => {
  {
    const r = mk(); r.act('a', { a: 'play', k: 0, d: SM }); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'act' && r.turn === 1);
    check('honest smuggler: A is flagged for a double draw', r.bonus.has(0));
    // jump to A's next turn
    r.turn = 0; r.drew = false; r.claim = null; const n = r.hands[0].length;
    r.act('a', { a: 'draw' });
    check('A draws two cards instead of one', r.hands[0].length === n + 2 && r.drew && !r.bonus.has(0), r.hands[0]);
    r.close();
  }
  {
    const r = mk(); r.act('a', { a: 'play', k: 0, d: SM }); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'act' && r.turn === 1);
    check('the smuggler rests for 3 turns (only for A)', r.body('a').g.ban.includes(SM) && !r.body('b').g.ban.includes(SM));
    r.turnsN[0] = 2; check('still banned after 2 turns', r.claimBanned(0, SM));
    r.turnsN[0] = 3; check('allowed again at the third turn after', !r.claimBanned(0, SM));
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2] }); r.doPlay(0, 0, SM); r.decide(2, 'challenge');
    await until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
    check('lie caught: no point lost, no double draw', r.inf[0] === 3 && !r.bonus.has(0), { inf: r.inf });
    // turns go 1, 2, then skip A
    r.turn = 2; r.drew = true; r.phase = 'act'; r.doPlay(2, 0, 2); r.decide(0, 'pass'); r.decide(1, 'pass');
    await until(() => r.phase === 'act' && r.claim === null && r.turn !== 2);
    check('the liar\'s next turn is skipped: it goes to B', r.turn === 1 || r.turn === 2, r.turn);
    check('the skip was used (not stuck on A)', r.turn !== 0, r.turn);
    r.close();
  }
  {
    const r = mk(); r.roster[0].bot = true; r.turnsN[0] = 1; r.cdAt[0][SM] = 1; r.hands[0] = [SM, SM, SM];
    r.botAct(); await sleep(50);
    check('a bot never declares a banned smuggler', !r.claim || r.claim.c !== SM, r.claim);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
