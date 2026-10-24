'use strict';
// Verifies a "Sign in with Google" ID token on the server. The only thing that proves an e-mail address is Google's signature,
// so this is how the admin panel knows who is really at the other end. Nothing here trusts the browser:
// signature (RS256 against Google's published keys), audience (our client id), issuer, expiry and email_verified are all checked.

const JWKS_URL = () => process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let cache = { at: 0, ttl: 0, keys: null };

async function keys(force) {
  const now = Date.now();
  if (!force && cache.keys && now - cache.at < cache.ttl) return cache.keys;
  const r = await fetch(JWKS_URL(), { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  cache = { at: now, ttl: Math.min(Math.max(Number(m ? m[1] : 3600), 60), 86400) * 1000, keys: j.keys || [] };
  return cache.keys;
}
const b64 = s => Buffer.from(s, 'base64url');

// returns { email, name, sub } or throws Error with a short reason
async function verifyIdToken(token, clientId) {
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID مش متظبط على السيرفر.');
  if (typeof token !== 'string' || token.length > 4096) throw new Error('bad token');
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('bad token');
  let head, body;
  try { head = JSON.parse(b64(parts[0]).toString()); body = JSON.parse(b64(parts[1]).toString()); } catch (e) { throw new Error('bad token'); }
  if (head.alg !== 'RS256' || !head.kid) throw new Error('bad alg');
  let jwk = (await keys(false)).find(k => k.kid === head.kid);
  if (!jwk) jwk = (await keys(true)).find(k => k.kid === head.kid);   // Google rotates keys
  if (!jwk) throw new Error('unknown key');
  // Web Crypto, so it behaves the same on Node and on Cloudflare
  const subtle = globalThis.crypto.subtle;
  let ok = false;
  try {
    const key = await subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await subtle.verify('RSASSA-PKCS1-v1_5', key, b64(parts[2]), Buffer.from(parts[0] + '.' + parts[1]));
  } catch (e) { ok = false; }
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (body.aud !== clientId) throw new Error('wrong audience');
  if (!ISSUERS.includes(body.iss)) throw new Error('wrong issuer');
  if (!(body.exp > now - 30)) throw new Error('expired');
  if (body.iat && body.iat > now + 120) throw new Error('from the future');
  if (!body.email || body.email_verified !== true) throw new Error('e-mail not verified');
  return { email: String(body.email), name: String(body.name || ''), sub: String(body.sub || '') };
}

module.exports = { verifyIdToken };
