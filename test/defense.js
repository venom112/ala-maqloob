// The lawyer: defends against a steal (Fatwa) by reflecting it onto the attacker. Run: node test/defense.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const LAW = 4;   // Fatwa 0, three placeholders 1-3, lawyer 4

// A plays an honest Fatwa and picks B. Returns the room, stopped at the moment B is asked to defend.
async function attack(opts) {
  opts = opts || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = [0, 1, 2]; r.hands[1] = opts.bHand || [LAW, 1, 2]; r.hands[2] = [1, 2, 3]; r.turn = 0; r.drew = true; r.phase = 'act';
  if (opts.bBot) r.roster[1].bot = true;
  r.doPlay(0, 0, 0); r.decide(1, 'pass'); r.decide(2, 'pass');
  await until(() => r.phase === 'target'); r.pickCb(1);
  const got = await until(() => r.phase === 'defend');
  return { r, got };
}
const settle = r => until(() => r.phase === 'act' && r.turn !== 0 && r.claim === null);
const ids = r => JSON.stringify(r.inf);

(async () => {
  {
    const { r, got } = await attack();
    check('B is asked to defend when Fatwa is aimed at him', got && r.defend && r.defend.T === 1, r.phase);
    check('the defend window is part of the state sent to players', r.body('b').g.defend && r.body('b').g.defend.T === 1 && r.body('b').g.phase === 'defend');
    r.act('b', { a: 'defend', k: 0, cid: r.defend.id });
    check('the defence is a face-down claim of the lawyer', r.phase === 'claim' && r.claim.by === 1 && r.claim.c === LAW && r.claim.pending.includes(0) && r.claim.pending.includes(2), r.claim);
    r.decide(0, 'pass'); r.decide(2, 'pass');
    await settle(r);
    check('real lawyer, nobody challenges: attack reflected (A loses 1, B gains 1)', r.inf[0] === 2 && r.inf[1] === 4 && r.inf[2] === 3, ids(r));
    check('turn passes on after the attack', r.turn === 1 && r.claim === null);
    r.close();
  }
  {
    const { r } = await attack();
    r.act('b', { a: 'defend', k: 1, cid: r.defend.id });   // bluff: a card that is not the lawyer
    r.decide(0, 'pass'); r.decide(2, 'pass'); await settle(r);
    check('bluff nobody challenges: it works, attack reflected', r.inf[0] === 2 && r.inf[1] === 4, ids(r));
    r.close();
  }
  {
    const { r } = await attack();
    r.act('b', { a: 'defend', k: 1, cid: r.defend.id });
    r.decide(2, 'challenge'); await settle(r);
    check('bluff caught: B loses 1 to the bank AND the Fatwa hits him (A +1)', r.inf[1] === 1 && r.inf[0] === 4 && r.inf[2] === 3, ids(r));
    check('B lost the card he played; it is face down again', r.hands[1].length === 2 && !r.pile[r.pile.length - 1].rev);
    r.close();
  }
  {
    const { r } = await attack();
    r.act('b', { a: 'defend', k: 0, cid: r.defend.id });
    r.decide(2, 'challenge'); await settle(r);
    check('real lawyer challenged: challenger loses 1, attack still reflected', r.inf[2] === 2 && r.inf[0] === 2 && r.inf[1] === 4, ids(r));
    r.close();
  }
  {
    const { r } = await attack();
    r.act('b', { a: 'defend', k: -1, cid: r.defend.id }); await settle(r);
    check('no defence: Fatwa steals as usual', r.inf[0] === 4 && r.inf[1] === 2, ids(r));
    r.close();
  }
  {
    const { r } = await attack();
    check('a wrong window id is ignored', (r.act('b', { a: 'defend', k: 0, cid: 999 }), r.phase === 'defend'));
    check('only the victim can defend', (r.act('c', { a: 'defend', k: 0, cid: r.defend.id }), r.phase === 'defend'));
    r.cfg.set.decideMs = 1200;  // (the window was opened with the old value; wait it out below)
    r.close();
  }
  {
    const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
    r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
    for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
    r.status = 'playing'; r.resetCards(); r.newGame(); r.cfg.set.decideMs = 1500;
    r.hands[0] = [0, 1, 2]; r.hands[1] = [LAW, 1, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
    r.doPlay(0, 0, 0); r.decide(1, 'pass'); r.decide(2, 'pass');
    await until(() => r.phase === 'target'); r.pickCb(1);
    await until(() => r.phase === 'defend'); const t0 = Date.now();
    await settle(r);
    check('a player who does not answer is treated as not defending', r.inf[0] === 4 && r.inf[1] === 2 && Date.now() - t0 < 8000, ids(r));
    r.close();
  }
  {
    const { r } = await attack({ bBot: true });
    const ok = await settle(r);
    check('a bot victim decides by himself and the game goes on', ok && r.inf.reduce((a, b) => a + b, 0) >= 8, ids(r));
    r.close();
  }
  {
    // the victim leaves the game while he is being asked
    const { r } = await attack();
    r.leave('b'); const ok = await settle(r);
    check('victim leaves during the window: game continues, no stall', ok || r.over >= 0, r.phase);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
