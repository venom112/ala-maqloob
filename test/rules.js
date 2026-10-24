// Rules test: the challenge outcomes and the bot that takes over a cut-off player. Run: node test/rules.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, extra === undefined ? '' : extra); if (!ok) bad++; };
async function until(f, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(50); } return false; }
function mk() {
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  const sent = { a: [], b: [], c: [] };
  for (const u of ['a', 'b', 'c']) r.attach(u, m => sent[u].push(m));
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = [1, 2, 3]; r.turn = 0; r.drew = true; r.phase = 'act';
  return { r, sent };
}
(async () => {
  // honest claim, challenged by B: the card is shown then goes back face down, A loses nothing, B loses 1, the power happens
  {
    const { r } = mk(); r.hands[0] = [1, 2, 3];
    r.doPlay(0, 0, 1); r.decide(1, 'challenge');
    let shown = false, hiddenAgain = false;
    await until(() => { const top = r.pile[r.pile.length - 1]; if (top && top.rev) shown = true; if (shown && top && !top.rev) hiddenAgain = true; return r.phase === 'act' && r.turn !== 0; });
    check('honest: card revealed to everyone', shown);
    check('honest: card goes back face down', hiddenAgain && !r.pile[r.pile.length - 1].rev);
    check('honest: claimer keeps his points', r.inf[0] === 3, JSON.stringify(r.inf));
    check('honest: challenger loses 1 point', r.inf[1] === 2, JSON.stringify(r.inf));
    check('honest: the power was carried out', JSON.stringify(r.evs.map(e => e.k)).includes('honest'));
    r.close();
  }
  // lying about each card: each has its own penalty
  const exp = [
    ['Fatwa lie: loses 1', r => r.inf[0] === 2 && r.inf[1] === 3],
    ['card 1 lie: loses 2', r => r.inf[0] === 1 && r.inf[1] === 3],
    ['card 2 lie: loses 1 and throws a card away', r => r.inf[0] === 2 && r.hands[0].length === 1],
    ['card 3 lie: loses 1 and gives the challenger a point', r => r.inf[0] === 2 && r.inf[1] === 4]
  ];
  for (let c = 0; c < 4; c++) {
    const { r } = mk(); r.hands[0] = [(c + 1) % 4, 2, 3];
    r.doPlay(0, 0, c); r.decide(1, 'challenge');
    await until(() => r.phase === 'act' && r.turn !== 0);
    check('lie ' + exp[c][0], exp[c][1](r), JSON.stringify({ inf: r.inf, hand: r.hands[0].length }));
    check('lie ' + c + ': the card is face down again', !r.pile[r.pile.length - 1].rev);
    r.close();
  }
  // a player who is cut off is replaced by a bot after 25 s of silence, and gets his seat back when he returns
  {
    const { r, sent } = mk();
    r.turn = 0; r.phase = 'act'; r.drew = false;
    r.lastSeen.set('a', Date.now() - 20000);
    r.conns.set('b', () => {}); r.seen('b'); r.seen('c');
    r.conns.delete('a');
    await sleep(2500);
    check('20 s of silence: still the human', !r.roster[0].sub);
    r.lastSeen.set('a', Date.now() - 26000); r.tick();
    check('25 s of silence: a bot takes the seat', r.roster[0].sub === true && r.isBot(0));
    const moved = await until(() => r.turn !== 0 || r.phase !== 'act', 12000);
    check('the bot plays his turn so the game does not stall', moved, 'turn=' + r.turn + ' phase=' + r.phase);
    r.attach('a', () => {});
    check('player is back: the bot steps aside', r.roster[0].sub === false && !r.isBot(0));
    r.close();
  }
  console.log(bad ? 'SOME FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
