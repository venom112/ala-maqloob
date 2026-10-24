// The forger: copies the power of the card played just before; a liar's hand is shown to everybody. Run: node test/forger.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const FA = 0, DOC = 10, PO = 13, FG = 14;
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [FG, 1, 2]; r.hands[1] = o.b || [DOC, 1, 1]; r.hands[2] = [2, 2, 2]; r.turn = 1; r.drew = true; r.phase = 'act';
  return r;
}
const passAll = (r, who) => who.forEach(j => r.decide(j, 'pass'));
(async () => {
  {
    // B plays an honest doctor (+2), then A plays the forger: A gets +2 as well
    const r = mk(); r.doPlay(1, 0, DOC); passAll(r, [0, 2]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 2);
    check('setup: B got +2 from the doctor', r.inf[1] === 5, r.inf);
    r.turn = 0; r.drew = true; r.phase = 'act'; r.doPlay(0, 0, FG); passAll(r, [1, 2]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 1);
    check('forger copies the doctor: A gets +2', r.inf[0] === 5, r.inf);
    check('the event says which card was copied', r.evs.some(e => e.k === 'power' && e.cp === DOC));
    // a forger right after a forger copies nothing
    r.turn = 2; r.drew = true; r.phase = 'act'; r.hands[2] = [FG, 2, 2]; r.doPlay(2, 0, FG); passAll(r, [0, 1]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 0);
    check('a forger cannot copy a forger: nothing happens', r.inf[2] === 3, r.inf);
    r.close();
  }
  {
    const r = mk({ a: [FG, 1, 2], b: [FA, 1, 1] });   // first play of the game: nothing to copy
    r.turn = 0; r.doPlay(0, 0, FG); passAll(r, [1, 2]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 1);
    check('nothing to copy: nothing happens', r.inf.join() === '3,3,3');
    r.close();
  }
  {
    const r = mk({ b: [1, 1, 1] }); r.doPlay(1, 0, DOC); r.decide(2, 'challenge');   // B lies (claims doctor with a placeholder), caught
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 2);
    check('setup: the lie was caught (B lost a point)', r.inf[1] === 2, r.inf);
    r.turn = 0; r.drew = true; r.phase = 'act'; r.doPlay(0, 0, FG); passAll(r, [1, 2]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 1);
    check('a card that was caught lying cannot be copied', r.inf[0] === 3, r.inf);
    r.close();
  }
  {
    const r = mk({ a: [1, 2, 2], b: [DOC, 1, 1] }); r.doPlay(1, 0, DOC); passAll(r, [0, 2]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 2);
    r.turn = 0; r.drew = true; r.phase = 'act'; r.doPlay(0, 0, FG); r.decide(2, 'challenge');   // A bluffs the forger
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 1);
    const sh = r.evs.find(e => e.k === 'showhand');
    check('lie caught: the liar\'s hand is shown to everyone, no point lost, no copy', sh && sh.i === 0 && sh.cards.slice().sort().join() === '2,2' && r.inf[0] === 3, { sh, inf: r.inf });
    check('the bots now remember his hand', !!r.mem.read(1, 1, 0).length);
    r.close();
  }
  {
    const r = mk({ b: [PO, 1, 1] }); r.doPlay(1, 0, PO);   // face-up politician: not copyable
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 2);
    r.turn = 0; r.drew = true; r.phase = 'act'; r.doPlay(0, 0, FG); passAll(r, [1, 2]);
    await until(() => r.phase === 'act' && r.claim === null && r.turn === 1);
    check('a face-up card cannot be copied (no immunity for the forger)', !r.isImmune(0));
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
