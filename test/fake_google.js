// A stand-in for Google's key server, for tests: it publishes a public key and signs ID tokens with the private one.
// The server runs its real verification code against it (GOOGLE_JWKS_URL points here).
const http = require('http');
const crypto = require('crypto');
async function startFake() {
  const mkKey = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const good = mkKey(), evil = mkKey();
  const jwk = Object.assign(good.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' }); r.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  function token(claims, opt) {
    opt = opt || {};
    const now = Math.floor(Date.now() / 1000);
    const body = Object.assign({ iss: 'https://accounts.google.com', aud: 'test-client', sub: '1', email_verified: true, iat: now, exp: now + 3600 }, claims);
    const head = { alg: 'RS256', typ: 'JWT', kid: 'k1' };
    const data = b(head) + '.' + b(body);
    const sig = crypto.sign('RSA-SHA256', Buffer.from(data), (opt.evilKey ? evil : good).privateKey).toString('base64url');
    return data + '.' + sig;
  }
  return { url: 'http://127.0.0.1:' + srv.address().port + '/certs', token, close: () => srv.close() };
}
module.exports = { startFake };
