// match record: counted only for human-vs-human games; sounds editable
const { Room } = require('../game');
const { Content, cleanSound, DEFAULT_SOUNDS } = require('../content');
let fail = 0; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n, ok ? '' : JSON.stringify(x)); if (!ok) fail++; };
const calls = [];
const content = Content.fixed(); content.store = { addResult: async (u, w) => calls.push([u, w]) };
const mk = bots => { const r = new Room('T' + Math.random(), 3, { uid: 'u1', name: 'أ' }, () => {}, content); r.roster.push({ uid: 'u2', name: 'ب' }, bots ? { uid: 'bot:0', name: 'بوت', bot: true } : { uid: 'u3', name: 'ج' }); return r; };
let r = mk(false); r.finish(1); r.finish(1);
check('three humans: one result each, winner marked, once only', calls.length === 3 && calls.find(c => c[0] === 'u2')[1] === true && calls.filter(c => c[1]).length === 1, calls);
calls.length = 0; r = mk(true); r.finish(0);
check('bot seat is not recorded, humans are', calls.length === 2 && calls.every(c => c[0] !== 'bot:0'), calls);
calls.length = 0; r = mk(false); r.bots = true; r.finish(0);
check('practice room (vs bots) is not counted', calls.length === 0, calls);
check('every default sound passes the validator', Object.keys(DEFAULT_SOUNDS).every(k => !!cleanSound(DEFAULT_SOUNDS[k])), 0);
check('bad sounds are rejected', !cleanSound([{ k: 'x' }]) && !cleanSound('a') && !cleanSound([{ k: 't', f: 'a', d: 1, w: 'sine', v: .1 }]) && !cleanSound([]), 0);
check('snapshot carries a recipe per card', content.snapshot().cards.every(c => Array.isArray(c.snd) && c.snd.length), 0);
content.sounds[content.cards[4].id] = [{ k: 't', f: 300, d: .2, w: 'sine', v: .1, a: 0 }];
check('custom sound overrides the default', content.snapshot().cards[4].snd.length === 1 && content.snapshot().cards[5].snd.length > 1, 0);
setTimeout(() => { console.log(fail ? 'FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0); }, 50);
