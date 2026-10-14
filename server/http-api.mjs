import { loadConfig, fail } from './config.mjs';
import { createHmac, randomUUID } from 'node:crypto';
import { authenticate, originAllowed, equal, makeSession, limit, readJSON, send } from './security.mjs';
import { conversationToken } from './elevenlabs.mjs';
import { TRIAL, reserve, finish, verifyTurnstile, upstashStore, memoryStore, hasUsedTrial, trialBlocked } from './trial.mjs';
const devStore = memoryStore(); // local development only; Vercel always uses Upstash (fails closed without it)
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
// Live voice cost controls (each started session can last up to the agent's 180 s maximum).
// Checked cheapest/shortest window first, so a request refused by spacing does not use a visitor's daily slot.
export const LIVE_LIMITS = Object.freeze({ spacingSeconds: 190, perVisitorPerDay: 1, globalPerDay: 2, globalPerMonth: 20 });
// Visitor key: HMAC of the client IP (raw IPs are never stored in the rate-limit database).
export function visitorKey(req, env) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return createHmac('sha256', env.SESSION_SECRET).update(`visitor:${ip}`).digest('base64url').slice(0, 22);
}
// Anonymous visitor id: a random UUID in a signed HttpOnly cookie (400 days). Redis only ever sees an HMAC of it.
const VISITOR_COOKIE = 'trial_vid';
const sig = (id, env) => createHmac('sha256', env.SESSION_SECRET).update(`vid:${id}`).digest('base64url').slice(0, 32);
export function readVisitorId(req, env) {
  const raw = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${VISITOR_COOKIE}=`))?.slice(VISITOR_COOKIE.length + 1);
  const [id, mac] = (raw || '').split('.');
  return /^[0-9a-f-]{36}$/.test(id || '') && mac && equal(mac, sig(id, env)) ? id : null; // tampered/forged -> treated as new
}
function visitorIds(req, res, env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw fail('auth_not_configured');
  let id = readVisitorId(req, env);
  if (!id) {
    id = randomUUID();
    const secure = env.VERCEL === '1' || String(req.headers.origin || '').startsWith('https:');
    res.setHeader('Set-Cookie', `${VISITOR_COOKIE}=${id}.${sig(id, env)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TRIAL.visitorRecordDays * 86400}${secure ? '; Secure' : ''}`);
  }
  return { visitor: createHmac('sha256', env.SESSION_SECRET).update(`visitor-id:${id}`).digest('base64url').slice(0, 22), network: visitorKey(req, env) };
}
export function createHandler({ config = loadConfig, token = conversationToken, store: storeOverride, fetcher = fetch } = {}) {
  return async (req, res) => {
    try {
      const env = config();
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fail('method_not_allowed', 405); }
      if (!originAllowed(req, env)) throw fail('forbidden_origin', 403);
      const path = req.url.split('?')[0];
      // PUBLIC 60-second trial (no access code): Turnstile + server-side quota in Redis; ElevenLabs enforces 60 s.
      if (env.PUBLIC_TRIAL === 'true') {
        const store = storeOverride || (env.VERCEL === '1' || env.RATE_LIMIT_REDIS_URL ? upstashStore(env, fetcher) : devStore);
        const ids = visitorIds(req, res, env);
        if (path === '/api/trial-status') {
          const used = await hasUsedTrial(store, ids.visitor);
          const blocked = used ? null : await trialBlocked(store, ids.network); // read-only: no counter changes
          return send(res, 200, { used, seconds: TRIAL.seconds, ...(blocked ? { blocked } : {}) });
        }
        if (path === '/api/conversation-token') {
          const body = await readJSON(req);
          await verifyTurnstile(env, body.turnstile, clientIp(req), fetcher);
          const r = await reserve(store, ids);
          try { return send(res, 200, { token: await token(env), sessionId: r.sessionId, seconds: TRIAL.seconds }); }
          catch (e) { await r.rollback(); throw e; } // server-side failure: the visitor's trial is not consumed
        }
        if (path === '/api/trial-end') { const b = await readJSON(req); return send(res, 200, await finish(store, b.sessionId, { connected: b.connected === true })); }
        throw fail('not_found', 404);
      }
      if (path === '/api/login') {
        await limit(env, 'login', 10, 600);
        if (!env.DEMO_ACCESS_CODE || env.DEMO_ACCESS_CODE.length < 16) throw fail('auth_not_configured');
        const body = await readJSON(req);
        if (typeof body.code !== 'string' || !equal(body.code, env.DEMO_ACCESS_CODE)) throw fail('unauthorized', 401);
        const session = makeSession(env);
        const secure = env.VERCEL === '1' || req.headers.origin.startsWith('https:');
        res.setHeader('Set-Cookie', `demo_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secure ? '; Secure' : ''}`);
        return send(res, 200, { ok: true });
      }
      authenticate(req, env);
      if (path === '/api/conversation-token') {
        // Global maxima are intentionally small. Failed preflights consume an attempt, never credits.
        const L = LIVE_LIMITS;
        await limit(env, 'voice-spacing', 1, L.spacingSeconds);
        await limit(env, `voice-visitor:${visitorKey(req, env)}`, L.perVisitorPerDay, 86400);
        await limit(env, 'voice-day', L.globalPerDay, 86400);
        await limit(env, 'voice-month', L.globalPerMonth, 30 * 86400);
        return send(res, 200, { token: await token(env) });
      }
      throw fail('not_found', 404);
    } catch (e) { send(res, e.status || 503, { error: e.status ? e.message : 'service_unavailable' }); }
  };
}
