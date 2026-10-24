// Admin test: Google sign-in checks, owner/admin permissions, bans, cards, pictures, settings, and the power engine.
// Run: NODE_PATH=/opt/npm-tools/node_modules node test/admin.js
const fs = require('fs'), os = require('os'), path = require('path');
const { startFake } = require('./fake_google');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (label, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + label, ok || extra === undefined ? '' : JSON.stringify(extra)); if (!ok) bad++; };
async function until(f, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(50); } return false; }

(async () => {
  const fake = await startFake();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ala-'));
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_JWKS_URL: fake.url, DB_PATH: path.join(dir, 't.db'), PORT: '3917', LOGIN_LIMIT: '1000' });
  const { main } = require('../server.js');
  const { server, rooms } = await main();
  const base = 'http://127.0.0.1:3917';
  const WebSocket = require('ws');

  const call = async (method, p, body, tok) => {
    const r = await fetch(base + '/api/admin/' + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { s: r.status, j: await r.json().catch(() => ({})) };
  };
  const login = async (email, claims, opt) => call('POST', 'login', { credential: fake.token(Object.assign({ email }, claims), opt) });

  /* ---- Google sign-in ---- */
  const o = await login('ana.wolfish@gmail.com');
  check('owner signs in with a valid Google token', o.s === 200 && o.j.owner === true && o.j.perms.length >= 9, o);
  const OWN = o.j.token;
  check('owner e-mail written with dots/case still matches (Gmail rules)', (await login('Ana.Wolfish+x@Gmail.com')).j.owner === true);
  check('wrong audience refused', (await login('ana.wolfish@gmail.com', { aud: 'other' })).s === 401);
  check('expired token refused', (await login('ana.wolfish@gmail.com', { exp: Math.floor(Date.now() / 1000) - 600 })).s === 401);
  check('token signed with another key refused', (await login('ana.wolfish@gmail.com', {}, { evilKey: true })).s === 401);
  check('unverified e-mail refused', (await login('ana.wolfish@gmail.com', { email_verified: false })).s === 401);
  check('wrong issuer refused', (await login('ana.wolfish@gmail.com', { iss: 'https://evil.example' })).s === 401);
  check('a stranger Google account is not an admin', (await login('stranger@gmail.com')).s === 403);
  check('garbage token refused', (await call('POST', 'login', { credential: 'a.b.c' })).s === 401);
  check('no token: API closed', (await call('GET', 'players')).s === 401);
  check('forged bearer refused', (await call('GET', 'players', undefined, 'x.y')).s === 401);

  /* ---- appointing an admin with limited permissions ---- */
  check('owner appoints an admin (players.view only)', (await call('PUT', 'admins', { email: 'bob@example.com', perms: ['players.view'] }, OWN)).s === 200);
  check('cannot appoint with no permission', (await call('PUT', 'admins', { email: 'x@example.com', perms: [] }, OWN)).s === 400);
  check('cannot appoint with an invented permission only', (await call('PUT', 'admins', { email: 'x@example.com', perms: ['everything'] }, OWN)).s === 400);
  check('owner e-mail cannot be edited as an admin', (await call('PUT', 'admins', { email: 'ana.wolfish@gmail.com', perms: ['players.view'] }, OWN)).s === 400);
  const bobL = await login('bob@example.com'); const BOB = bobL.j.token;
  check('appointed admin signs in with his perms only', bobL.s === 200 && bobL.j.owner === false && bobL.j.perms.join() === 'players.view', bobL.j);
  check('admin can list players', (await call('GET', 'players', undefined, BOB)).s === 200);
  check('admin cannot edit cards (no perm)', (await call('GET', 'cards', undefined, BOB)).s === 403);
  check('admin cannot see the audit log', (await call('GET', 'audit', undefined, BOB)).s === 403);
  check('admin cannot manage admins', (await call('GET', 'admins', undefined, BOB)).s === 403 && (await call('PUT', 'admins', { email: 'e@example.com', perms: ['players.view'] }, BOB)).s === 403);
  check('admin cannot change settings', (await call('PUT', 'settings', { startInf: 4 }, BOB)).s === 403);

  /* ---- players: sign in with Google ---- */
  { const o2 = () => new Promise(res => { const ws = new WebSocket('ws://127.0.0.1:3917/ws'); ws.msgs = []; ws.on('message', d => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws)); });
    const lst = (ws, t) => ws.msgs.filter(m => m.t === t).pop();
    const w = await o2(); const cred = fake.token({ email: 'gamer@gmail.com', name: 'Gamer Person' });
    w.send(JSON.stringify({ t: 'google', cred }));
    check('google: a new e-mail is asked for a player name', await until(() => lst(w, 'gname')) && lst(w, 'gname').suggest === 'Gamer Person');
    w.send(JSON.stringify({ t: 'google', cred, name: 'نجم' }));
    check('google: chosen name creates the account', await until(() => lst(w, 'authed')) && lst(w, 'authed').name === 'نجم' && lst(w, 'authed').admin === false);
    const w2 = await o2(); w2.send(JSON.stringify({ t: 'google', cred: fake.token({ email: 'gamer@gmail.com' }) }));
    check('google: the next time it signs straight in', await until(() => lst(w2, 'authed')) && lst(w2, 'authed').name === 'نجم');
    const w3 = await o2(); w3.send(JSON.stringify({ t: 'google', cred: fake.token({ email: 'x@gmail.com' }, { evilKey: true }) }));
    check('google: a forged token is refused', await until(() => lst(w3, 'err')) && lst(w3, 'err').code === 'google');
    const w4 = await o2(); w4.send(JSON.stringify({ t: 'google', cred: fake.token({ email: 'y@gmail.com' }), name: 'نجم' }));
    check('google: a taken name is refused', await until(() => lst(w4, 'gname')) && !!lst(w4, 'gname').msg);
    const w5 = await o2(); w5.send(JSON.stringify({ t: 'google', cred: fake.token({ email: 'ana.wolfish@gmail.com' }), name: 'الأونر' }));
    check('google: the owner e-mail gets the admin flag', await until(() => lst(w5, 'authed')) && lst(w5, 'authed').admin === true);
    [w, w2, w3, w4, w5].forEach(x => x.close()); }

  /* ---- players: register, ban, unban ---- */
  const open = () => new Promise(res => { const ws = new WebSocket('ws://127.0.0.1:3917/ws'); ws.msgs = []; ws.on('message', d => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws)); });
  const last = (ws, t) => ws.msgs.filter(m => m.t === t).pop();
  const ws1 = await open(); ws1.send(JSON.stringify({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name: 'سمير', pass: '1234' }));
  await until(() => last(ws1, 'authed'));
  const tok1 = last(ws1, 'authed').token;
  let pl = (await call('GET', 'players?q=' + encodeURIComponent('سمير'), undefined, OWN)).j;
  check('player is listed and online', pl.rows.length === 1 && pl.rows[0].online === true, pl);
  const uid = pl.rows[0].id;
  check('limited admin cannot ban', (await call('POST', 'players/' + uid + '/ban', { reason: 'x' }, BOB)).s === 403);
  check('owner bans (1 hour)', (await call('POST', 'players/' + uid + '/ban', { reason: 'شتيمة', hours: 1 }, OWN)).s === 200);
  check('banned player is told and disconnected', await until(() => last(ws1, 'banned') && ws1.readyState === 3), ws1.msgs.map(m => m.t));
  const ws2 = await open(); ws2.send(JSON.stringify({ t: 'login', name: 'سمير', pass: '1234' }));
  check('banned player cannot log in', await until(() => last(ws2, 'banned')) && !last(ws2, 'authed') && /شتيمة/.test(last(ws2, 'banned').msg), ws2.msgs);
  const ws3 = await open(); ws3.send(JSON.stringify({ t: 'resume', token: tok1 }));
  check('old session token is dead after the ban', await until(() => last(ws3, 'noauth') || last(ws3, 'banned')) && !last(ws3, 'authed'));
  check('unban', (await call('POST', 'players/' + uid + '/unban', undefined, OWN)).j.ok === true);
  const ws4 = await open(); ws4.send(JSON.stringify({ t: 'login', name: 'سمير', pass: '1234' }));
  check('after unban he logs in again', await until(() => last(ws4, 'authed')));
  check('a ban with an end time stops counting after it ends', await (async () => {
    await call('POST', 'players/' + uid + '/ban', { reason: 'قصير', hours: 0.0001 }, OWN); await sleep(500);
    const w = await open(); w.send(JSON.stringify({ t: 'login', name: 'سمير', pass: '1234' })); return until(() => last(w, 'authed'));
  })());
  check('rename to a taken name is refused', await (async () => {
    const w = await open(); w.send(JSON.stringify({ t: 'register', email: 'u' + Math.random().toString(36).slice(2) + '@t.com', name: 'منى', pass: '1234' })); await until(() => last(w, 'authed'));
    return (await call('POST', 'players/' + uid + '/rename', { name: 'منى' }, OWN)).s === 409;
  })());
  check('rename with markup refused', (await call('POST', 'players/' + uid + '/rename', { name: '<b>x</b>' }, OWN)).s === 400);
  check('owner resets a password; old password stops working', await (async () => {
    await call('POST', 'players/' + uid + '/password', { pass: 'newpass1' }, OWN);
    const a = await open(); a.send(JSON.stringify({ t: 'login', name: 'سمير', pass: '1234' })); await until(() => last(a, 'err'));
    const b = await open(); b.send(JSON.stringify({ t: 'login', name: 'سمير', pass: 'newpass1' }));
    return !!last(a, 'err') && await until(() => last(b, 'authed'));
  })());

  /* ---- permissions change takes effect at once ---- */
  check('owner grants ban permission', (await call('PUT', 'admins', { email: 'bob@example.com', perms: ['players.view', 'players.ban'] }, OWN)).s === 200);
  check('admin can now ban and unban', (await call('POST', 'players/' + uid + '/ban', { reason: 'x', hours: 1 }, BOB)).s === 200 && (await call('POST', 'players/' + uid + '/unban', undefined, BOB)).s === 200);
  check('admin removed: his token stops working at once', (await call('DELETE', 'admins/' + encodeURIComponent('bob@example.com'), undefined, OWN)).j.ok === true && (await call('GET', 'players', undefined, BOB)).s === 401);

  /* ---- cards ---- */
  let cards = (await call('GET', 'cards', undefined, OWN)).j.cards;
  check('10 starter cards (Fatwa, lawyer, shadow, officer, pickpocket, sparrow, accountant), each with its picture', cards.length === 15 && cards[14].name === 'العجوز' && cards[14].cnt === 4 && cards[14].img === '/img/elder.jpg' && cards[14].power[0].op === 'elder' && cards[14].penalty.loss === 2 && cards[13].name === 'القاضي' && cards[13].cnt === 5 && cards[13].img === '/img/judge.jpg' && cards[13].power[0].op === 'judge' && cards[13].penalty.loss === 1 && cards[12].name === 'مفتاح المدينة' && cards[12].cnt === 4 && cards[12].img === '/img/citykey.jpg' && cards[12].power[0].op === 'victory' && cards[12].power[0].n === 10 && cards[11].name === 'المُزوِّر' && cards[11].cnt === 6 && cards[11].img === '/img/forger.jpg' && cards[11].power[0].op === 'copy' && cards[11].penalty.reveal === 1 && cards[10].name === 'السياسي' && cards[10].cnt === 4 && cards[10].img === '/img/politician.jpg' && cards[10].power[0].op === 'immune' && cards[10].power[0].n === 2 && cards[9].name === 'المُفجِّر' && cards[9].cnt === 4 && cards[9].img === '/img/bomber.jpg' && cards[9].power[0].op === 'recycle' && cards[9].penalty.drop === 1 && cards[8].name === 'المُهرِّب' && cards[8].cnt === 4 && cards[8].img === '/img/smuggler.jpg' && cards[8].power[0].op === 'smuggle' && cards[8].penalty.skip === 1 && cards[7].name === 'طبيب العصابة' && cards[7].cnt === 5 && cards[7].img === '/img/doctor.jpg' && cards[6].name === 'المحاسب' && cards[6].cnt === 6 && cards[6].img === '/img/accountant.jpg' && cards[6].power[0].op === 'regain' && cards[5].name === 'العصفورة' && cards[5].cnt === 6 && cards[5].img === '/img/sparrow.jpg' && cards[5].power[0].op === 'peek' && cards[4].name === 'النشال' && cards[4].cnt === 6 && cards[4].img === '/img/pickpocket.jpg' && cards[4].power[0].op === 'take' && cards[3].name === 'الضابط الفاسد' && cards[3].cnt === 6 && cards[3].img === '/img/officer.jpg' && cards[3].power[0].op === 'guard' && cards[2].name === 'الظل' && cards[2].cnt === 6 && cards[2].img === '/img/shadow.jpg' && cards[2].power[0].op === 'swap' && cards[0].name === 'الفتوّة' && cards[0].cnt === 8 && cards[0].img === '/img/fatwa.jpg' && cards[1].name === 'المحامي' && cards[1].cnt === 8 && cards[1].img === '/img/lawyer.jpg' && cards[1].power[0].op === 'reflect', cards.map(c => c.name));
  check('deck is 82', cards.reduce((s, c) => s + c.cnt, 0) === 82);
  const newCard = { name: 'السنيد', symbol: '♠', color: '#224466', cnt: 6, descr: 'خد نقطة نفوذ ونط دور اللي بعدك.', penDescr: '', power: [{ op: 'inf_gain', n: 1, target: 'self' }, { op: 'skip', n: 1, target: 'random' }], penalty: { loss: 1, drop: 0, gift: 0 } };
  const mk = await call('POST', 'cards', newCard, OWN);
  check('owner adds a new card', mk.s === 200 && mk.j.id > 9, mk);
  check('bad power rejected', (await call('POST', 'cards', { ...newCard, power: [{ op: 'rm_rf', n: 1, target: 'self' }] }, OWN)).s === 400);
  check('target not allowed for the effect rejected', (await call('POST', 'cards', { ...newCard, power: [{ op: 'steal', n: 1, target: 'self' }] }, OWN)).s === 400);
  check('too many effects rejected', (await call('POST', 'cards', { ...newCard, power: [1, 2, 3, 4].map(() => ({ op: 'draw', n: 1, target: 'self' })) }, OWN)).s === 400);
  check('bad color rejected', (await call('POST', 'cards', { ...newCard, color: 'red' }, OWN)).s === 400);
  cards = (await call('GET', 'cards', undefined, OWN)).j.cards;
  const mine = cards.find(c => c.name === 'السنيد');
  check('new card saved; empty penalty text was written automatically', mine && mine.penDescr === 'يخسر نقطة نفوذ', mine);
  check('edit a card', (await call('PATCH', 'cards/' + mine.id, { cnt: 8, descr: 'وصف جديد' }, OWN)).s === 200 && (await call('GET', 'cards', undefined, OWN)).j.cards.find(c => c.id === mine.id).cnt === 8);
  check('a deck too small is refused', (await call('PATCH', 'cards/' + cards[1].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[2].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[3].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[4].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[5].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[6].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[7].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[8].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[9].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[10].id, { cnt: 0 }, OWN)).s === 200 && (await call('PATCH', 'cards/' + cards[11].id, { cnt: 0 }, OWN)).s === 400);
  await call('PATCH', 'cards/' + cards[1].id, { cnt: 8 }, OWN); await call('PATCH', 'cards/' + cards[2].id, { cnt: 6 }, OWN); await call('PATCH', 'cards/' + cards[3].id, { cnt: 6 }, OWN); await call('PATCH', 'cards/' + cards[4].id, { cnt: 6 }, OWN); await call('PATCH', 'cards/' + cards[5].id, { cnt: 6 }, OWN); await call('PATCH', 'cards/' + cards[6].id, { cnt: 6 }, OWN); await call('PATCH', 'cards/' + cards[7].id, { cnt: 5 }, OWN); await call('PATCH', 'cards/' + cards[8].id, { cnt: 4 }, OWN); await call('PATCH', 'cards/' + cards[9].id, { cnt: 4 }, OWN); await call('PATCH', 'cards/' + cards[10].id, { cnt: 4 }, OWN);
  const ids = (await call('GET', 'cards', undefined, OWN)).j.cards.map(c => c.id).reverse();
  check('reorder', (await call('POST', 'cards/reorder', { ids }, OWN)).s === 200 && (await call('GET', 'cards', undefined, OWN)).j.cards[0].id === ids[0]);
  await call('POST', 'cards/reorder', { ids: ids.slice().reverse() }, OWN);

  /* ---- accounts backup and restore ---- */
  {
    { const bb = await call('GET', 'backup', undefined, BOB); check('a limited admin cannot take the backup', bb.s === 403 || bb.s === 401, bb.s); }
    const bk = await call('GET', 'backup', undefined, OWN);
    check('the owner gets every account with its salted hash', bk.s === 200 && bk.j.users.length >= 1 && bk.j.users.every(u => u.name && u.name_key && u.salt && u.hash), bk.s);
    const n0 = bk.j.users.length, again = await call('POST', 'restore', bk.j, OWN);
    check('restoring a copy over the same accounts changes nothing', again.s === 200 && again.j.added === 0 && again.j.skipped === n0, again.j);
    const lst = await call('GET', 'players', undefined, OWN), victim = lst.j.rows[lst.j.rows.length - 1];
    check('a deleted account is removed', (await call('DELETE', 'players/' + victim.id, undefined, OWN)).s === 200);
    const back = await call('POST', 'restore', bk.j, OWN);
    check('the restore brings back exactly the missing one', back.s === 200 && back.j.added === 1 && back.j.skipped === n0 - 1, back.j);
    check('a limited admin cannot restore, bad files are refused', [401, 403].includes((await call('POST', 'restore', bk.j, BOB)).s) && (await call('POST', 'restore', { users: 5 }, OWN)).s === 400);
  }

  /* ---- pictures ---- */
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  check('upload the logo', (await call('PUT', 'assets/logo', { data: png.toString('base64') }, OWN)).s === 200);
  const cfg = await (await fetch(base + '/api/config')).json();
  check('config points to the uploaded logo', /^\/a\/logo\?v=/.test(cfg.images.logo) && cfg.images.back === '/img/back.jpg', cfg.images);
  const got = await fetch(base + cfg.images.logo);
  check('uploaded picture is served with its type', got.status === 200 && got.headers.get('content-type') === 'image/png' && Buffer.compare(Buffer.from(await got.arrayBuffer()), png) === 0);
  check('svg / html disguised as a picture refused', (await call('PUT', 'assets/logo', { data: Buffer.from('<svg onload=alert(1)/>').toString('base64') }, OWN)).s === 400);
  check('unknown slot refused', (await call('PUT', 'assets/evil', { data: png.toString('base64') }, OWN)).s === 404);
  check('picture for a card', (await call('PUT', 'assets/card-' + mine.id, { data: png.toString('base64') }, OWN)).s === 200 && (await call('GET', 'cards', undefined, OWN)).j.cards.find(c => c.id === mine.id).customImg === true);
  check('reset the logo to the original', (await call('DELETE', 'assets/logo', undefined, OWN)).j.ok === true && (await (await fetch(base + '/api/config')).json()).images.logo === '/img/logo.jpg');

  /* ---- settings, then a real game uses the edited content ---- */
  check('settings: out of range refused', (await call('PUT', 'settings', { startInf: 99 }, OWN)).s === 400);
  check('settings: too few bot names refused', (await call('PUT', 'settings', { botNames: ['أ', 'ب'] }, OWN)).s === 400);
  check('settings saved', (await call('PUT', 'settings', { startInf: 5, startCards: 2 }, OWN)).s === 200);
  const wsg = await open(); wsg.send(JSON.stringify({ t: 'login', name: 'منى', pass: '1234' })); await until(() => last(wsg, 'authed'));
  wsg.send(JSON.stringify({ t: 'bots', n: 3 }));
  await until(() => { const r = last(wsg, 'room'); return r && r.g && r.g.dealt; });
  const rm = last(wsg, 'room');
  check('the game uses the edited settings', rm.g.inf.every(x => x === 5) && rm.hand.length === 2 && rm.g.deckN === (82 + 8) - 6, { inf: rm.g.inf, hand: rm.hand.length, deckN: rm.g.deckN });
  check('the game includes the new card', rm.g.cfg.cards.length === 16 && rm.g.cfg.cards.some(c => c.name === 'السنيد' && c.img.startsWith('/a/card-')), rm.g.cfg.cards.map(c => c.name));

  /* ---- audit ---- */
  const au = (await call('GET', 'audit', undefined, OWN)).j;
  check('every admin action is in the audit log', au.total > 15 && au.rows.some(r => r.action === 'player.ban' && r.actor === 'ana.wolfish@gmail.com') && au.rows.some(r => r.action === 'card.create'), au.total);
  check('rooms list and close', (await call('GET', 'rooms', undefined, OWN)).j.rooms.length >= 1);

  /* ---- the power engine on its own ---- */
  const { Room } = require('../game.js'); const { Content } = require('../content.js');
  const cont = Content.fixed();
  cont.cards.push({ id: 19, name: 'ت', symbol: '', color: '#000000', cnt: 6, descr: 'x', penDescr: '', active: true, deleted: false, sort: 99, power: [{ op: 'inf_gain', n: 2, target: 'self' }, { op: 'skip', n: 1, target: 'all_others' }, { op: 'draw', n: 1, target: 'self' }, ], penalty: { loss: 0, drop: 0, gift: 0 } });
  const r = new Room('1', 3, { uid: 'a', name: 'A' }, () => {}, cont); r.add({ uid: 'b', name: 'B' }); r.add({ uid: 'c', name: 'C' });
  for (const u of ['a', 'b', 'c']) r.attach(u, () => {});
  r.status = 'playing'; r.resetCards(); r.newGame();
  r.hands[0] = [18, 1, 2]; r.turn = 0; r.drew = true; r.phase = 'act';
  r.doPlay(0, 0, 18); r.decide(1, 'pass'); r.decide(2, 'pass');
  await until(() => r.phase === 'act' && r.turn !== 0, 20000);
  check('engine: gain +2 happened', r.inf[0] === 5, r.inf);
  check('engine: draw happened (hand 2 -> 3)', r.hands[0].length === 3, r.hands[0]);
  check('engine: others were made to skip, so the turn came back to A', r.turn === 0, r.turn);
  r.close();

  console.log(bad ? bad + ' FAILED' : 'ALL PASS');
  fake.close(); server.close(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
