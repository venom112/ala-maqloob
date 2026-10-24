// The city key: played face up, wins on the spot with 10+ points; with fewer it cannot be played. Run: node test/citykey.js
const { Room } = require('../game.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await sleep(40); } return false; }
const KEY = 15;
function mk(o) {
  o = o || {};
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {});
  r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = o.a || [KEY, 1, 2]; r.hands[1] = [1, 1, 1]; r.hands[2] = [2, 2, 2]; r.inf = o.inf || [10, 3, 3]; r.turn = 0; r.drew = true; r.phase = 'act';
  return r;
}
(async () => {
  {
    const r = mk(); r.act('a', { a: 'play', k: 0, d: 1 });
    check('with 10 points the key is played face up (no challenge) and wins', r.phase === 'resolve' && r.pile[r.pile.length - 1].rev === true && r.claim.pending.length === 0);
    check('A wins the game', await until(() => r.over === 0), r.over);
    check('everybody sees the win event', r.evs.some(e => e.k === 'win' && e.w === 0));
    r.close();
  }
  {
    const r = mk({ inf: [9, 3, 3] }); r.act('a', { a: 'play', k: 0, d: KEY });
    check('with 9 points the key cannot be played', r.phase === 'act' && r.hands[0].length === 3 && r.over < 0);
    check('the server tells A the key is locked', r.body('a').g.lock.includes(KEY) && r.body('a').g.lock.length === 1);
    r.act('a', { a: 'play', k: 1, d: KEY });
    check('another card cannot be claimed as the key', r.phase === 'act' && r.hands[0].length === 3);
    r.inf[0] = 10; check('the lock goes away at 10 points', r.body('a').g.lock.length === 0);
    r.close();
  }
  {
    const r = mk({ a: [KEY, KEY, KEY], inf: [4, 3, 3] }); r.drew = false;
    r.deck = [1, 1, KEY]; r.actDraw(0);
    check('only locked keys in hand: the turn passes', r.turn === 1 && r.drew === false && r.ev && r.ev.k === 'locked', { turn: r.turn, ev: r.ev });
    r.close();
  }
  {
    const r = mk({ a: [KEY, 1, 2] }); r.roster[0].bot = true; r.botAct(); await sleep(100);
    check('a bot with 10 points plays the key and wins', await until(() => r.over === 0, 8000), r.over);
    r.close();
  }
  {
    const r = mk({ a: [KEY, 1, 2], inf: [5, 3, 3] }); r.roster[0].bot = true; r.botAct(); await sleep(100);
    check('a bot with 5 points keeps the key (plays another card)', r.over < 0 && r.hands[0].includes(KEY) && r.hands[0].length === 2, r.hands[0]);
    r.close();
  }
  console.log(bad ? bad + ' FAILED' : 'ALL PASS'); process.exit(bad ? 1 : 0);
})();
