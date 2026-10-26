// Room timers chosen at creation, the turn timer, filling seats with bots, and the politician's immunity counter. Run: node test/roomopts.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(30); } return false; }
const LAW = 4, PO = 13;
function mk(cap, opts) {
  const r = new Room('1', cap, { uid: 'a', name: 'A' }, () => {});
  if (opts) { r.opts = opts; r.applyOpts(); }
  return r;
}
function game(opts) {
  const r = mk(3, opts); r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame(); return r;
}
(async () => {
  {
    const r = game({ decideMs: 20000, pickMs: 30000, turnMs: 45000 });
    check('the chosen timers reach the game (and survive a new snapshot)', r.cfg.set.decideMs === 20000 && r.cfg.set.pickMs === 30000 && r.cfg.set.turnMs === 45000 && r.body('a').g.cfg.set.turnMs === 45000, r.cfg.set);
    r.close();
  }
  {
    const seen = new Set(); for (let k = 0; k < 40; k++) { const r = game(); seen.add(r.turn); r.close(); }
    check('the starting player is random', seen.size > 1, [...seen]);
    const r = game(); const t = r.turn; r.hands[1] = [0, 1, 2];
    r.leave('b');
    check('a player who leaves mid-game keeps his seat with a bot', r.roster[1].sub && r.roster[1].left && !r.roster[1].gone && !r.out[1] && r.hands[1].length === 3);
    r.seen('a'); r.seen('c'); r.tick();
    check('he stays a bot while away', r.roster[1].sub);
    r.attach('b', () => {}); r.tick();
    check('he gets the seat back when he returns', !r.roster[1].sub && !r.roster[1].left);
    r.close();
  }
  {
    Room.speed = .01;   // 1 s of game time = 10 ms
    const r = game({ decideMs: 15000, pickMs: 15000, turnMs: 15000 });
    r.hands[0] = [0, 1, 2]; r.turn = 0; r.drew = false; r.phase = 'act'; r.touch();
    check('a human who sits out his turn gets it played by the bot logic', await until(() => r.turn !== 0 || r.phase === 'claim'), { turn: r.turn, ph: r.phase });
    check('the table is told', r.evs.some(e => e.k === 'autoturn' && e.i === 0));
    r.close(); Room.speed = 1;
  }
  {
    const r = game({ decideMs: 15000, pickMs: 15000, turnMs: 0 }); Room.speed = .01;
    r.turn = 0; r.drew = false; r.phase = 'act'; r.touch(); await sleep(400);
    check('no turn timer when it is off', r.turn === 0 && r.drew === false);
    r.close(); Room.speed = 1;
  }
  {
    const r = mk(4);
    check('only the host fills the seats', r.fillBots('zzz') === 'denied' && r.roster.length === 1);
    r.fillBots('a');
    check('the empty seats become bots with different names', r.roster.length === 4 && r.roster.slice(1).every(x => x.bot) && new Set(r.roster.map(x => x.name)).size === 4, r.roster);
    r.close();
    const q = mk(4); q.fillBots('a');
    check('a human takes a bot seat when the room is full', q.add({ uid: 'n', name: 'N' }) === null && q.roster.length === 4 && q.roster.filter(x => x.bot).length === 2 && q.idx('n') >= 0);
    q.close();
  }
  {
    const r = game({ decideMs: 15000, pickMs: 15000, turnMs: 0 });
    r.hands[0] = [PO, 1, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
    r.act('a', { a: 'play', k: 0, d: PO });
    await until(() => r.isImmune(0));
    check('the politician: the counter shows 2 turns right after playing it', r.body('a').g.imm[0] === 2, r.body('a').g.imm);
    r.turnsN[0]++; check('and 1 after his next turn', r.body('a').g.imm[0] === 1);
    r.turnsN[0]++; check('and nothing after two laps', r.body('a').g.imm[0] === 0);
    r.close();
  }
  {
    // the lawyer's counter-attack cannot touch an immune attacker
    const r = game({ decideMs: 15000, pickMs: 15000, turnMs: 0 });
    r.hands[0] = [0, 1, 2]; r.hands[1] = [LAW, 1, 1]; r.turn = 0; r.drew = true; r.phase = 'act';
    r.immuneTo[0] = r.turnsN[0] + 5;
    r.doPlay(0, 0, 0); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    await until(() => r.phase === 'defend'); r.act('b', { a: 'defend', k: 0, c: LAW, cid: r.defend.id });
    r.decide(0, 'pass'); r.decide(2, 'pass');
    check('immune A is not hit by the reflected steal', await until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null) && r.inf.join() === '3,3,3', r.inf);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
