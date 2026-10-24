'use strict';
// The Node server: static files, the API and the WebSocket, on top of core.js. (The Cloudflare version is worker.mjs.)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { openStore } = require('./storage-node');
const { createCore } = require('./core');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function main() {
  const store = await openStore();
  const core = await createCore(store);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (await core.handleApi(req, res, url)) return;
      let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html'; if (p === '/admin' || p === '/admin/') p = '/admin.html';
      const file = path.normalize(path.join(PUB, p));
      if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
        const ext = path.extname(file);
        const h = { 'content-type': MIME[ext] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
        h['cache-control'] = (ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest') ? 'no-cache' : 'public, max-age=86400';
        if (path.basename(file) === 'admin.html' || path.basename(file) === 'index.html') h['cross-origin-opener-policy'] = 'same-origin-allow-popups';
        res.writeHead(200, h); res.end(buf);
      });
    } catch (e) { console.error('http error', e); try { res.writeHead(500); res.end(); } catch (x) {} }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  wss.on('connection', (ws, req) => core.connection(ws, core.ipOf(req)));

  server.listen(PORT, () => console.log('ع المقلوب on :' + PORT + ' (' + store.kind + ')'));
  return { server, rooms: core.rooms };
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main };
