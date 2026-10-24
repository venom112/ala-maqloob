// Cloudflare version of the server: one Worker in front, and one Durable Object ("Hub") that is the whole game server
// (rooms, players, timers live in its memory; accounts, cards and pictures live in its SQLite). Static files come from ./public.
// Everything else is the same code as the Node server: core.js, game.js, admin.js, storage.js ...
import { DurableObject } from 'cloudflare:workers';
import { createCore } from './core.js';
import { makeStore } from './storage.js';
import { cfDb } from './cf-db.js';

const MAX_MSG = 4096;

// Makes a Cloudflare WebSocket look like the `ws` sockets core.js was written for.
function wrapSocket(server) {
  const on = { message: [], close: [], error: [], pong: [] };
  let closed = false;
  const fireClose = () => { if (closed) return; closed = true; w.readyState = 3; on.close.forEach(f => { try { f(); } catch (e) {} }); };
  const w = {
    readyState: 1,
    send(s) { if (w.readyState === 1) { try { server.send(s); } catch (e) { fireClose(); } } },
    close() { if (w.readyState === 1) { w.readyState = 2; try { server.close(1000, 'bye'); } catch (e) {} } },
    terminate() { try { server.close(1000, 'timeout'); } catch (e) {} fireClose(); },
    on(ev, f) { (on[ev] || (on[ev] = [])).push(f); return w; }
  };
  server.addEventListener('message', ev => {
    const d = ev.data;
    if (typeof d !== 'string' || d.length > MAX_MSG) { w.terminate(); return; }
    on.message.forEach(f => f(d));
  });
  server.addEventListener('close', fireClose);
  server.addEventListener('error', () => { on.error.forEach(f => f()); fireClose(); });
  return w;
}

// The slice of Node's request/response that admin.js and core.js use, over a fetch Request.
function nodeReq(method, headers, body) {
  const h = {};
  return {
    method, headers, socket: { remoteAddress: headers['x-forwarded-for'] || '' },
    on(ev, f) { h[ev] = f; if (ev === 'end') queueMicrotask(() => { if (h.data && body.length) h.data(body); if (h.end) h.end(); }); return this; },
    destroy() {}
  };
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // the code reads its settings from process.env (OWNER_EMAIL, GOOGLE_CLIENT_ID, SESSION_SECRET ...)
    for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') process.env[k] = v;
    process.env.PASS_SCHEME = 'pbkdf2';   // the same password scheme whatever node:crypto offers here
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.core = await createCore(await makeStore(cfDb(ctx.storage.sql)));
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (request.headers.get('Upgrade') === 'websocket') {
      if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      this.core.connection(wrapSocket(server), ip);
      return new Response(null, { status: 101, webSocket: client });
    }
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    headers['x-forwarded-for'] = ip;
    const body = request.method === 'GET' || request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
    let done; const out = new Promise(r => { done = r; });
    const res = {
      writeHead(code, h) { this.code = code; this.h = Object.assign({}, h); delete this.h['content-length']; },
      end(data) { done(new Response(data == null ? null : data, { status: this.code || 200, headers: this.h || {} })); }
    };
    let handled = false;
    try { handled = await this.core.handleApi(nodeReq(request.method, headers, body), res, url); }
    catch (e) { console.error('http error', e); return new Response('error', { status: 500 }); }
    return handled ? out : new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
}

const page = async (env, request, file, extra) => {
  const r = await env.ASSETS.fetch(new Request(new URL(file, request.url), { method: 'GET' }));
  const h = new Headers(r.headers);
  h.set('cache-control', 'no-cache'); h.set('x-content-type-options', 'nosniff'); h.set('referrer-policy', 'no-referrer');
  for (const k in extra || {}) h.set(k, extra[k]);
  return new Response(r.body, { status: r.status, headers: h });
};

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p === '/') return page(env, request, '/index.html', { 'cross-origin-opener-policy': 'same-origin-allow-popups' });
    if (p === '/admin' || p === '/admin/') return page(env, request, '/admin.html', { 'cross-origin-opener-policy': 'same-origin-allow-popups' });
    if (p === '/ws' || p === '/healthz' || p.startsWith('/api/') || p.startsWith('/a/')) return env.HUB.get(env.HUB.idFromName('main')).fetch(request);
    return env.ASSETS.fetch(request);
  }
};
