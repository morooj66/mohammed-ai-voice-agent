// Public 60-second trial: server-side quota using only atomic Redis primitives (safe under concurrent requests).
//   1 concurrent call (lock, SET NX EX) · ONE trial per anonymous visitor (signed random cookie id; record kept 400 days,
//   never renewed) · soft network limit 5 per IP-hash per 24 h · 5 per day · 30 per month (INCR + rollback).
// Without user accounts, "one trial per person" cannot be guaranteed: a new browser/device/cleared cookies = new id.
// Stored data: HMACs only (of the random id, 400 days; of the IP, 24 h). No names, emails, raw IPs or fingerprints.
// A reservation is undone completely if any later step fails. ElevenLabs itself ends every call at 60 s
// (agent max_duration_seconds = 60) and allows one concurrent call, so the browser cannot extend a trial.
import { randomUUID } from 'node:crypto';
import { fail } from './config.mjs';

export const TRIAL = Object.freeze({ seconds: 60, visitorRecordDays: 400, perNetworkPer24h: 5, perDay: 5, perMonth: 30, lockSeconds: 75, refundWindowSeconds: 90 });
const VISITOR_TTL = TRIAL.visitorRecordDays * 86400;
export const usedKey = (visitor) => `trial:used:${visitor}`;
export async function hasUsedTrial(store, visitor) { return (await store.get(usedKey(visitor))) != null; }
const dayKey = (now) => `trial:day:${new Date(now).toISOString().slice(0, 10)}`;   // UTC calendar day
const monthKey = (now) => `trial:month:${new Date(now).toISOString().slice(0, 7)}`;

// Upstash REST (one command per request). Fails closed: any Redis problem refuses the trial.
export function upstashStore(env, fetcher = fetch) {
  if (!env.RATE_LIMIT_REDIS_URL?.startsWith('https://') || !env.RATE_LIMIT_REDIS_TOKEN) throw fail('rate_limit_not_configured');
  const cmd = async (...args) => {
    const r = await fetcher(env.RATE_LIMIT_REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.RATE_LIMIT_REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args.map(String)), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw fail('rate_limit_unavailable');
    const j = await r.json(); if (j.error) throw fail('rate_limit_unavailable'); return j.result;
  };
  return {
    setNX: async (k, v, ex) => (await cmd('SET', k, v, 'NX', 'EX', ex)) === 'OK',
    incr: async (k, ex) => { const n = await cmd('INCR', k); if (n === 1) await cmd('EXPIRE', k, ex); return n; },
    decr: (k) => cmd('DECR', k), get: (k) => cmd('GET', k), del: (k) => cmd('DEL', k),
  };
}
// In-memory store with the same semantics: local development and tests only (refused on Vercel).
export function memoryStore() {
  const m = new Map(), live = (k) => { const e = m.get(k); if (e && e.exp && e.exp <= Date.now()) { m.delete(k); return undefined; } return e; };
  return {
    setNX: async (k, v, ex) => { if (live(k)) return false; m.set(k, { v, exp: Date.now() + ex * 1000 }); return true; },
    incr: async (k, ex) => { const e = live(k) || { v: 0, exp: Date.now() + ex * 1000 }; e.v = Number(e.v) + 1; m.set(k, e); return e.v; },
    decr: async (k) => { const e = live(k); if (e) e.v = Number(e.v) - 1; return e ? e.v : 0; },
    get: async (k) => live(k)?.v ?? null, del: async (k) => { m.delete(k); return 1; },
  };
}

// ids = { visitor: HMAC of the signed random cookie id, network: HMAC of the IP }
export async function reserve(store, ids, now = Date.now(), limits = TRIAL) {
  const { visitor, network } = typeof ids === 'string' ? { visitor: ids, network: null } : ids;
  const sessionId = randomUUID(), lock = 'trial:lock', vKey = usedKey(visitor), nKey = network ? `trial:net:${network}` : null, d = dayKey(now), mo = monthKey(now);
  if (!(await store.setNX(lock, sessionId, TRIAL.lockSeconds))) throw fail('trial_busy', 429);
  const undo = [async () => { if ((await store.get(lock)) === sessionId) await store.del(lock); }];
  const rollback = async (code) => { for (const f of undo.reverse()) { try { await f(); } catch { /* best effort; keys expire */ } } throw fail(code, 429); };
  try {
    if (!(await store.setNX(vKey, sessionId, VISITOR_TTL))) return await rollback('trial_used');
    undo.push(() => store.del(vKey));
    if (nKey) { const n = await store.incr(nKey, 86400); undo.push(() => store.decr(nKey)); if (n > limits.perNetworkPer24h) return await rollback('trial_network_limit'); }
    const day = await store.incr(d, 2 * 86400); undo.push(() => store.decr(d));
    if (day > limits.perDay) return await rollback('trial_day_full');
    const month = await store.incr(mo, 40 * 86400); undo.push(() => store.decr(mo));
    if (month > limits.perMonth) return await rollback('trial_month_full');
    await store.setNX(`trial:s:${sessionId}`, JSON.stringify({ visitor, nKey, d, mo, at: now }), 300);
    return { sessionId, seconds: TRIAL.seconds, rollback: () => rollback('trial_unavailable').catch(() => {}) };
  } catch (e) { if (e.status === 429) throw e; await rollback('rate_limit_unavailable').catch(() => {}); throw fail('rate_limit_unavailable'); }
}

// Read-only availability check for the page (changes no counters): which limit, if any, would refuse a new trial
// right now. Lets the UI explain the situation before the visitor solves a bot check or grants the microphone.
export async function trialBlocked(store, network, now = Date.now(), limits = TRIAL) {
  const count = async (k) => Number(await store.get(k)) || 0;
  if (await count(monthKey(now)) >= limits.perMonth) return 'trial_month_full';
  if (await count(dayKey(now)) >= limits.perDay) return 'trial_day_full';
  if (network && await count(`trial:net:${network}`) >= limits.perNetworkPer24h) return 'trial_network_limit';
  return null;
}

// End of a trial. A session that never connected (e.g. browser/network failure) is refunded ONCE per visitor id
// and only within the refund window; ElevenLabs' own limits still bound the cost if a client lies about it.
export async function finish(store, sessionId, { connected }, now = Date.now()) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) throw fail('invalid_session', 400);
  const raw = await store.get(`trial:s:${sessionId}`); if (!raw) return { refunded: false };
  const s = JSON.parse(raw); await store.del(`trial:s:${sessionId}`);
  if ((await store.get('trial:lock')) === sessionId) await store.del('trial:lock');
  if (connected || now - s.at > TRIAL.refundWindowSeconds * 1000) return { refunded: false };
  if (!(await store.setNX(`trial:refund:${s.visitor}`, '1', VISITOR_TTL))) return { refunded: false };
  await store.del(usedKey(s.visitor)); if (s.nKey) await store.decr(s.nKey); await store.decr(s.d); await store.decr(s.mo);
  return { refunded: true };
}

// Cloudflare Turnstile server-side verification (the browser widget alone proves nothing).
export async function verifyTurnstile(env, token, ip, fetcher = fetch) {
  if (env.TURNSTILE_DISABLED === 'true' && env.VERCEL !== '1') return true;          // local development only
  if (!env.TURNSTILE_SECRET_KEY) throw fail('bot_check_not_configured');
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) throw fail('bot_check_failed', 403);
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) });
  const r = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
  const j = await r.json().catch(() => ({}));
  if (j.success !== true) throw fail('bot_check_failed', 403);
  return true;
}
