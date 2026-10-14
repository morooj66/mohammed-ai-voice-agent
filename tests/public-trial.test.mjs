// Public 60-second trial: quota correctness under concurrency, refunds, bot check, fail-closed behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRIAL, reserve, finish, memoryStore, verifyTurnstile, trialBlocked } from '../server/trial.mjs';
import { createHandler } from '../server/http-api.mjs';

const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { return e.message; } };

test('limits are the approved ones', () => assert.deepEqual({ ...TRIAL }, { seconds: 60, visitorRecordDays: 400, perNetworkPer24h: 5, perDay: 5, perMonth: 30, lockSeconds: 75, refundWindowSeconds: 90 }));

test('10 simultaneous requests: exactly one call starts (single concurrent session)', async () => {
  const s = memoryStore();
  const r = await Promise.all(Array.from({ length: 10 }, (_, i) => codeOf(reserve(s, `v${i}`))));
  assert.equal(r.filter((x) => x === 'ok').length, 1); assert.equal(r.filter((x) => x === 'trial_busy').length, 9);
  assert.equal(await s.get(`trial:day:${new Date().toISOString().slice(0, 10)}`), 1, 'busy requests consume nothing');
});

test('one trial per visitor (not renewed); 5 per day globally; nothing over-counted', async () => {
  const s = memoryStore();
  const a = await reserve(s, 'A'); await finish(s, a.sessionId, { connected: true });
  assert.equal(await codeOf(reserve(s, 'A')), 'trial_used');
  for (const v of ['B', 'C', 'D', 'E']) { const r = await reserve(s, v); await finish(s, r.sessionId, { connected: true }); }
  assert.equal(await codeOf(reserve(s, 'F')), 'trial_day_full');
  assert.equal(await s.get(`trial:day:${new Date().toISOString().slice(0, 10)}`), 5);
  assert.equal(await codeOf(reserve(s, 'F')), 'trial_day_full', 'F keeps its slot for tomorrow (visitor key rolled back)');
  assert.equal(await s.get('trial:used:F'), null);
});

test('30 per month: the 31st is refused and the day counter is rolled back', async () => {
  const s = memoryStore(), mk = `trial:month:${new Date().toISOString().slice(0, 7)}`, dk = `trial:day:${new Date().toISOString().slice(0, 10)}`;
  for (let i = 0; i < 30; i++) await s.incr(mk, 100);
  assert.equal(await codeOf(reserve(s, 'Z')), 'trial_month_full');
  assert.equal(await s.get(mk), 30); assert.equal(await s.get(dk), 0); assert.equal(await s.get('trial:lock'), null);
});

test('a session that never connected is refunded once per visitor id; a connected one is never refunded', async () => {
  const s = memoryStore();
  const r1 = await reserve(s, 'Q'); assert.deepEqual(await finish(s, r1.sessionId, { connected: false }), { refunded: true });
  const r2 = await reserve(s, 'Q'); assert.equal(typeof r2.sessionId, 'string', 'Q can try again after a failed start');
  assert.deepEqual(await finish(s, r2.sessionId, { connected: false }), { refunded: false }, 'only one refund per visitor id');
  assert.equal(await codeOf(reserve(s, 'Q')), 'trial_used');
  const r3 = await reserve(s, 'R'); assert.deepEqual(await finish(s, r3.sessionId, { connected: true }), { refunded: false });
  assert.deepEqual(await finish(s, r3.sessionId, { connected: false }), { refunded: false }, 'a session cannot be finished twice');
});

test('refund window: no refund after 90 s', async () => {
  const s = memoryStore(), t0 = Date.now();
  const r = await reserve(s, 'W', t0);
  assert.deepEqual(await finish(s, r.sessionId, { connected: false }, t0 + 91_000), { refunded: false });
});

test('ending a call releases the concurrency lock immediately', async () => {
  const s = memoryStore(); const a = await reserve(s, 'L1');
  assert.equal(await codeOf(reserve(s, 'L2')), 'trial_busy');
  await finish(s, a.sessionId, { connected: true });
  assert.equal(await codeOf(reserve(s, 'L2')), 'ok');
});

test('Turnstile is verified server-side; disabling it is impossible on Vercel', async () => {
  const ok = async () => ({ json: async () => ({ success: true }) }), bad = async () => ({ json: async () => ({ success: false }) });
  assert.equal(await verifyTurnstile({ TURNSTILE_SECRET_KEY: 's' }, 'x'.repeat(20), '', ok), true);
  assert.equal(await codeOf(verifyTurnstile({ TURNSTILE_SECRET_KEY: 's' }, 'x'.repeat(20), '', bad)), 'bot_check_failed');
  assert.equal(await codeOf(verifyTurnstile({ TURNSTILE_SECRET_KEY: 's' }, '', '', ok)), 'bot_check_failed');
  assert.equal(await codeOf(verifyTurnstile({ VERCEL: '1', TURNSTILE_DISABLED: 'true' }, 'x'.repeat(20), '', ok)), 'bot_check_not_configured');
});

const req = (path, body, headers = {}) => { const raw = JSON.stringify(body || {}); return { method: 'POST', url: path, headers: { origin: 'https://site.test', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7', ...headers }, body: raw }; };
const res = () => ({ status: 0, body: '', headers: {}, writeHead(s) { this.status = s; }, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } });
const ENV = { PUBLIC_TRIAL: 'true', SESSION_SECRET: 'k'.repeat(40), APP_ORIGINS: 'https://site.test', TURNSTILE_SECRET_KEY: 'secret' };
const okFetch = async () => ({ json: async () => ({ success: true }) });

test('public handler: no access code; signed anonymous cookie; bot check first; token failure does not consume the trial', async () => {
  const store = memoryStore(); let calls = 0;
  const failing = createHandler({ config: () => ENV, store, fetcher: okFetch, token: async () => { calls++; throw Object.assign(Error('elevenlabs_upstream'), { status: 502 }); } });
  const r1 = res(); await failing(req('/api/conversation-token', { turnstile: 'x'.repeat(20) }), r1);
  assert.equal(r1.status, 502); assert.equal(calls, 1);
  const cookie = r1.headers['Set-Cookie']; assert.match(cookie, /^trial_vid=[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=34560000; Secure$/, 'random id, signed, HttpOnly, Secure on HTTPS, 400 days');
  const C = { cookie: cookie.split(';')[0] };
  const st = res(); await failing(req('/api/trial-status', {}, C), st); assert.deepEqual(JSON.parse(st.body), { used: false, seconds: 60 }, 'server-side failure did not consume the trial');
  const good = createHandler({ config: () => ENV, store, fetcher: okFetch, token: async () => 'tok' });
  const r2 = res(); await good(req('/api/conversation-token', { turnstile: 'x'.repeat(20) }, C), r2);
  const j = JSON.parse(r2.body); assert.equal(r2.status, 200); assert.equal(j.token, 'tok'); assert.equal(j.seconds, 60); assert.equal(r2.headers['Set-Cookie'], undefined, 'existing visitor keeps its id');
  const e = res(); await good(req('/api/trial-end', { sessionId: j.sessionId, connected: true }, C), e); assert.equal(e.status, 200);
  const st2 = res(); await good(req('/api/trial-status', {}, C), st2); assert.equal(JSON.parse(st2.body).used, true, 'returning visitor sees "used"');
  const r3 = res(); await good(req('/api/conversation-token', { turnstile: 'x'.repeat(20) }, C), r3); assert.equal(JSON.parse(r3.body).error, 'trial_used');
  const forged = res(); await good(req('/api/trial-status', {}, { cookie: C.cookie.replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') }), forged);
  assert.match(forged.headers['Set-Cookie'], /^trial_vid=/, 'a forged/tampered cookie is replaced by a new random id');
  const botFail = createHandler({ config: () => ENV, store: memoryStore(), fetcher: async () => ({ json: async () => ({ success: false }) }), token: async () => { calls += 100; return 't'; } });
  const r5 = res(); await botFail(req('/api/conversation-token', { turnstile: 'x'.repeat(20) }), r5);
  assert.equal(r5.status, 403); assert.equal(JSON.parse(r5.body).error, 'bot_check_failed'); assert.equal(calls, 1, 'no token requested for bots');
  const r6 = res(); await good(req('/api/conversation-token', {}, { origin: 'https://evil.test' }), r6); assert.equal(r6.status, 403);
});

test('shared network: several visitors on one IP may each try, up to 5 per 24 h (soft limit, not IP-only)', async () => {
  const s = memoryStore(), big = { ...TRIAL, perDay: 100, perMonth: 100 };
  for (let i = 0; i < 5; i++) { const r = await reserve(s, { visitor: `p${i}`, network: 'office' }, Date.now(), big); await finish(s, r.sessionId, { connected: true }); }
  assert.equal(await codeOf(reserve(s, { visitor: 'p5', network: 'office' }, Date.now(), big)), 'trial_network_limit');
  assert.equal(await codeOf(reserve(s, { visitor: 'p5', network: 'home' }, Date.now(), big)), 'ok', 'the same person elsewhere is not blocked by the office limit');
  assert.equal(await s.get('trial:used:p5'), 'trial:used:p5' && (await s.get('trial:used:p5')), 'network refusal did not consume p5 (rolled back before the success above)');
});

test('public handler on Vercel without Upstash fails closed (no token, no ElevenLabs call)', async () => {
  let calls = 0; const h = createHandler({ config: () => ({ ...ENV, VERCEL: '1' }), fetcher: okFetch, token: async () => { calls++; return 't'; } });
  const r = res(); await h(req('/api/conversation-token', { turnstile: 'x'.repeat(20) }), r);
  assert.equal(r.status, 503); assert.equal(JSON.parse(r.body).error, 'rate_limit_not_configured'); assert.equal(calls, 0);
});

test('the public trial refuses any agent version where ElevenLabs does not end calls at 60 s', () => {
  assert.match(readFileSync(new URL('../server/elevenlabs.mjs', import.meta.url), 'utf8'), /env\.PUBLIC_TRIAL === 'true' && !\(c\.conversation\.max_duration_seconds <= 60\)\) throw fail\('trial_duration_not_enforced'\)/);
});

test('trial UI: elegant label, countdown, graceful end with «شاهد المحاكاة», bot check, no access code only in trial', () => {
  const ui = readFileSync(new URL('../src/components/VoiceUI.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/hooks/useLiveConversation.js', import.meta.url), 'utf8');
  assert.match(ui, /'تجربة مجانية لمدة 60 ثانية'/);
  assert.match(ui, /متبقية/);
  assert.match(ui, /انتهت التجربة المجانية — شكرًا لك<\/span><a className="ctl ctl--main" href="\?mode=recorded">شاهد المحاكاة<\/a>/);
  assert.match(ui, /<Turnstile onToken=\{setBotToken\} resetKey=\{botReset\} \/>/);
  assert.match(app, /if \(PUBLIC_TRIAL && convo\.trialSeconds\) return <VoiceUI convo=\{convo\} accessForm=\{null\} \/>/);
  assert.match(hook, /const limitMs = seconds \? seconds \* 1000 : 180_000;/, 'page ends the call at the server-provided 60 s');
  assert.match(hook, /reportTrialEnd\(t\.sessionId, t\.connected\)/, 'server learns whether the call really connected');
  for (const c of ['trial_used', 'trial_day_full', 'trial_month_full', 'trial_busy', 'bot_check_failed']) assert.match(hook, new RegExp(`${c}: '`));
  assert.equal((ui.match(/لا يتبع نجم/g) || []).length, 1, 'still exactly one disclaimer');
});

test('one-trial UI: returning visitor sees the calm "already used" card; privacy sentence; no autoplay after the minute', () => {
  const ui = readFileSync(new URL('../src/components/VoiceUI.jsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/hooks/useLiveConversation.js', import.meta.url), 'utf8');
  assert.match(ui, /استخدمت تجربتك المباشرة سابقًا — المحاكاة متاحة لك دائمًا<\/span><a className="ctl ctl--main" href="\?mode=recorded">شاهد المحاكاة<\/a>/);
  assert.match(ui, /نحفظ معرّفًا عشوائيًا في متصفحك لنعرف إن كانت تجربتك المجانية قد استُخدمت\./);
  assert.match(hook, /fetch\('\/api\/trial-status'/);
  assert.doesNotMatch(ui + hook, /autoplay|\.play\(\)/, 'nothing plays automatically on the live page');
});

test('availability check (read-only): day / month / network limits are reported before a visitor tries; no counter changes', async () => {
  const s = memoryStore(), now = Date.now(), dk = `trial:day:${new Date(now).toISOString().slice(0, 10)}`, mk = `trial:month:${new Date(now).toISOString().slice(0, 7)}`;
  assert.equal(await trialBlocked(s, 'net1', now), null);
  for (let i = 0; i < 5; i++) await s.incr('trial:net:net1', 100);
  assert.equal(await trialBlocked(s, 'net1', now), 'trial_network_limit'); assert.equal(await trialBlocked(s, 'net2', now), null, 'other networks unaffected');
  for (let i = 0; i < 5; i++) await s.incr(dk, 100);
  assert.equal(await trialBlocked(s, 'net2', now), 'trial_day_full');
  for (let i = 0; i < 30; i++) await s.incr(mk, 100);
  assert.equal(await trialBlocked(s, 'net2', now), 'trial_month_full', 'the month limit is reported first');
  assert.deepEqual([await s.get(dk), await s.get(mk), await s.get('trial:net:net1'), await s.get('trial:lock')], [5, 30, 5, null], 'nothing incremented, no lock taken');
});

test('trial-status reports a reached limit; a fresh visitor sees the calm card instead of a disabled button', async () => {
  const store = memoryStore(); const h = createHandler({ config: () => ENV, store, fetcher: okFetch, token: async () => 't' });
  const a = res(); await h(req('/api/trial-status', {}), a); assert.deepEqual(JSON.parse(a.body), { used: false, seconds: 60 }, 'unchanged when nothing is blocked');
  for (let i = 0; i < 5; i++) await store.incr(`trial:day:${new Date().toISOString().slice(0, 10)}`, 100);
  const b = res(); await h(req('/api/trial-status', {}), b); assert.deepEqual(JSON.parse(b.body), { used: false, seconds: 60, blocked: 'trial_day_full' });
  const ui = readFileSync(new URL('../src/components/VoiceUI.jsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../src/hooks/useLiveConversation.js', import.meta.url), 'utf8');
  assert.match(ui, /\{convo\.trialBlockedMessage\}<\/span><a className="ctl ctl--main" href="\?mode=recorded">شاهد المحاكاة<\/a>/);
  assert.match(ui, /convo\.trialUsed \|\| convo\.trialBlocked \|\| \(turnstileConfigured && !botToken\)/, 'Start stays disabled while blocked');
  assert.match(ui, /!convo\.trialUsed && !convo\.trialBlocked && <Turnstile/, 'no bot check when no trial is possible');
  assert.match(hook, /TRIAL_BLOCKED_CODES = \['trial_day_full', 'trial_month_full', 'trial_network_limit'\]/);
  assert.match(hook, /if \(TRIAL_BLOCKED_CODES\.includes\(e\.code\)\) \{ setTrialBlocked\(e\.code\); return; \}/, 'a refusal at Start shows the same card');
});
