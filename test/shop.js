// Shop test: coins, buying items, reactions in a game, packs paid for by hand (order -> admin approval), permissions.
// Run: NODE_PATH=/opt/npm-tools/node_modules node test/shop.js
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('./fake_google');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(40); } return false; }
(async () => {
  const fake = await startFake();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ala-'));
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_JWKS_URL: fake.url, DB_PATH: path.join(dir, 't.db'), PORT: '3918', LOGIN_LIMIT: '1000' });
  const { main } = require('../server.js'); await main();
  const base = 'http://127.0.0.1:3918', WebSocket = require('ws');
  const call = async (method, p, body, tok) => { const r = await fetch(base + '/api/admin/' + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const OWN = (await call('POST', 'login', { credential: fake.token({ email: 'ana.wolfish@gmail.com' }) })).j.token;
  const open = () => new Promise(res => { const ws = new WebSocket('ws://127.0.0.1:3918/ws'); ws.msgs = []; ws.on('message', d => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws)); });
  const last = (ws, t) => ws.msgs.filter(m => m.t === t).pop(), tx = (ws, m) => ws.send(JSON.stringify(m));
  const ws = await open(); tx(ws, { t: 'register', name: 'سمير', email: 'sam@example.com', pass: 'secret1' });
  check('player registers', await until(() => last(ws, 'authed')));
  tx(ws, { t: 'wallet' }); await until(() => last(ws, 'wallet'));
  let w = last(ws, 'wallet');
  check('new player: 0 coins, free items owned, paid ones not', w.coins === 0 && w.owned.length === 3 && w.items.length >= 11, w.owned);
  const paid = w.items.find(x => x.p === 30);
  tx(ws, { t: 'buy', id: paid.id }); await until(() => last(ws, 'wallet').bought);
  check('cannot buy without coins', last(ws, 'wallet').bought.ok === false && !last(ws, 'wallet').owned.includes(paid.id));

  /* admin: grant coins, buy, reactions */
  check('grant coins to the player', (await call('POST', 'shop/grant', { name: 'سمير', coins: 100 }, OWN)).j.coins === 100);
  check('grant to a missing player refused', (await call('POST', 'shop/grant', { name: 'مفيش', coins: 5 }, OWN)).s === 404);
  await until(() => last(ws, 'coins')); check('player is told his new balance', last(ws, 'coins').coins === 100);
  ws.msgs.length = 0; tx(ws, { t: 'buy', id: paid.id }); await until(() => last(ws, 'wallet') && last(ws, 'wallet').bought);
  w = last(ws, 'wallet'); check('buy: coins taken and item owned', w.bought.ok && w.coins === 70 && w.owned.includes(paid.id), w);
  ws.msgs.length = 0; tx(ws, { t: 'buy', id: paid.id }); await until(() => last(ws, 'wallet') && last(ws, 'wallet').bought);
  check('buying twice does not charge twice', last(ws, 'wallet').coins === 70 && last(ws, 'wallet').bought.ok === false);
  tx(ws, { t: 'bots', n: 3 }); check('bot room opens', await until(() => last(ws, 'room') && last(ws, 'room').g && last(ws, 'room').g.dealt));
  tx(ws, { t: 'react', id: w.items.find(x => x.p === 60).id }); await sleep(300);
  check('an item that is not owned does nothing', !(last(ws, 'room').g.evs || []).some(e => e.k === 'react'));
  tx(ws, { t: 'react', id: paid.id });
  check('an owned item is shown to the table', await until(() => ((last(ws, 'room').g || {}).evs || []).some(e => e.k === 'react' && e.it.id === paid.id && e.i === 0)));
  const n0 = ((last(ws, 'room').g || {}).evs || []).filter(e => e.k === 'react').length; tx(ws, { t: 'react', id: paid.id }); await sleep(300);
  check('spamming reactions is throttled', ((last(ws, 'room').g || {}).evs || []).filter(e => e.k === 'react').length === n0);

  /* packs and orders */
  const pk = w.packs[0];
  tx(ws, { t: 'order', pack: pk.id }); await until(() => last(ws, 'ordered'));
  const od = last(ws, 'ordered');
  check('order gives the payment details and a WhatsApp link', od.ok && od.pay === '01002540876' && od.wa === '01002540876' && /^https:\/\/wa\.me\/201002540876\?text=/.test(od.link), od);
  const L = await call('GET', 'shop/orders?status=pending', undefined, OWN);
  check('admin sees the pending order', L.j.orders.length === 1 && L.j.orders[0].uname === 'سمير');
  ws.msgs.length = 0;
  check('approve delivers the coins', (await call('POST', 'shop/orders/' + od.id + '/approve', {}, OWN)).s === 200 && await until(() => last(ws, 'coins') && last(ws, 'coins').coins === 70 + pk.c), last(ws, 'coins'));
  check('an order can be decided only once', (await call('POST', 'shop/orders/' + od.id + '/approve', {}, OWN)).s === 409 && (await call('POST', 'shop/orders/' + od.id + '/reject', {}, OWN)).s === 409);
  ws.msgs.length = 0; tx(ws, { t: 'order', pack: 99999 }); check('unknown pack refused', await until(() => last(ws, 'ordered') && last(ws, 'ordered').ok === false));
  for (let k = 0; k < 3; k++) { tx(ws, { t: 'order', pack: pk.id }); await sleep(120); }
  await sleep(300); check('only 3 open orders per player', (await call('GET', 'shop/orders?status=pending', undefined, OWN)).j.orders.length === 3);

  /* permissions */
  await call('PUT', 'admins', { email: 'bob@example.com', perms: ['players.view'] }, OWN);
  const BOB = (await call('POST', 'login', { credential: fake.token({ email: 'bob@example.com' }) })).j.token;
  check('an admin without the permission cannot touch the shop or orders', (await call('GET', 'shop', undefined, BOB)).s === 403 && (await call('GET', 'shop/orders', undefined, BOB)).s === 403 && (await call('POST', 'shop/grant', { name: 'سمير', coins: 5 }, BOB)).s === 403);
  check('players cannot use the admin API', (await fetch(base + '/api/admin/shop')).status === 401);
  check('owner can edit payment details', (await call('PUT', 'shop/config', { payNumber: '01111111111', winReward: 5 }, OWN)).s === 200 && (await call('GET', 'shop', undefined, OWN)).j.cfg.payNumber === '01111111111');
  check('bad config refused', (await call('PUT', 'shop/config', { payNumber: 'abc' }, OWN)).s === 400);
  const it = await call('POST', 'shop/items', { kind: 'image', name: 'صورة', price: 10 }, OWN);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  check('new item + picture upload', it.s === 200 && (await call('PUT', 'shop/items/' + it.j.id + '/media', { data: png.toString('base64') }, OWN)).s === 200 && (await fetch(base + '/a/shop-' + it.j.id)).headers.get('content-type') === 'image/png');
  check('a pack with no content refused', (await call('POST', 'shop/packs', { name: 'x', priceEgp: 10, coins: 0, items: [] }, OWN)).s === 400);
  check('new pack', (await call('POST', 'shop/packs', { name: 'جديد', priceEgp: 10, coins: 50, items: [it.j.id] }, OWN)).s === 200);
  check('delete an item', (await call('DELETE', 'shop/items/' + it.j.id, undefined, OWN)).s === 200);

  /* judge guard + win reward (unit) */
  const { Room } = require('../game'), { Content } = require('../content');
  const ct = Content.fixed(); let got = []; ct.store = { addResult: async () => {} }; ct.onWin = async u => got.push(u);
  const r = new Room('x1', 2, { uid: 'u1', name: 'A' }, () => {}, ct); r.add({ uid: 'u2', name: 'B' }); r.start('u1'); await sleep(50);
  r.finish(0); await sleep(20); check('only the winner earns coins', got.join() === 'u1', got);
  console.log(bad ? 'FAILED ' + bad : 'ALL PASS'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
