import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { fail } from './config.mjs';
export function equal(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}
// Vercel system variables (set by Vercel on the server for THIS project's deployment; never taken from the request).
// Exact hostnames only — no wildcard such as *.vercel.app.
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function vercelOrigins(env) {
  if (env.VERCEL !== '1') return [];
  return ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']
    .map((k) => String(env[k] || '').trim().toLowerCase()).filter((h) => HOST.test(h)).map((h) => `https://${h}`);
}
export function originAllowed(req, env) {
  const configured = (env.APP_ORIGINS || (env.VERCEL === '1' ? '' : 'http://127.0.0.1:5173,http://localhost:5173')).split(',').map((o) => o.trim()).filter(Boolean);
  const allowed = new Set([...configured, ...vercelOrigins(env)]);
  return typeof req.headers.origin === 'string' && allowed.has(req.headers.origin) && !['cross-site'].includes(req.headers['sec-fetch-site']);
}
function sign(s, env) { return createHmac('sha256', env.SESSION_SECRET).update(s).digest('base64url'); }
export function makeSession(env, now = Date.now()) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw fail('auth_not_configured');
  const payload = Buffer.from(JSON.stringify({ id: randomUUID(), exp: now + 30 * 60_000 })).toString('base64url');
  return `${payload}.${sign(payload, env)}`;
}
export function authenticate(req, env, now = Date.now()) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw fail('auth_not_configured');
  const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('demo_session='))?.slice(13);
  try {
    const [payload, sig] = (cookie || '').split('.');
    if (!equal(sig, sign(payload, env))) throw Error();
    const session = JSON.parse(Buffer.from(payload, 'base64url'));
    if (!session.id || !Number.isFinite(session.exp) || session.exp <= now) throw Error();
    return session;
  } catch { throw fail('unauthorized', 401); }
}
const buckets = new Map();
export async function limit(env, key, maximum, seconds, fetcher = fetch) {
  let count;
  if (env.VERCEL === '1' || env.RATE_LIMIT_REDIS_URL) {
    if (!env.RATE_LIMIT_REDIS_URL?.startsWith('https://') || !env.RATE_LIMIT_REDIS_TOKEN) throw fail('rate_limit_not_configured');
    // Atomic expiry + increment. Global fixed windows cap usage across instances.
    const r = await fetcher(env.RATE_LIMIT_REDIS_URL, { method: 'POST', headers: {
      Authorization: `Bearer ${env.RATE_LIMIT_REDIS_TOKEN}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", '1', `mohammed:${key}`, String(seconds)]), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw fail('rate_limit_unavailable');
    const data = await r.json();
    if (!Number.isInteger(data.result)) throw fail('rate_limit_unavailable');
    count = data.result;
  } else {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.expires <= now) buckets.delete(k);
    const bucket = buckets.get(key) || { count: 0, expires: now + seconds * 1000 };
    count = ++bucket.count; buckets.set(key, bucket);
  }
  if (count > maximum) throw fail('rate_limited', 429);
}
export async function readJSON(req, max = 4096) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('json_required', 415);
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > max) throw fail('body_too_large', 413);
    try { return JSON.parse(raw); } catch { throw fail('invalid_json', 400); }
  }
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > max) throw fail('body_too_large', 413); }
  try { return JSON.parse(raw); } catch { throw fail('invalid_json', 400); }
}
export function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
