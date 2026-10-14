// Step A launch guards: cost limits, visitor privacy, public wording, private-file exclusion, UI gating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIVE_LIMITS, visitorKey } from '../server/http-api.mjs';
import { PUBLIC_CALLERS } from '../src/lib/callers.js';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('live voice limits: spacing first, then 1/visitor/day, 2/day and 20/month globally', () => {
  assert.deepEqual({ ...LIVE_LIMITS }, { spacingSeconds: 190, perVisitorPerDay: 1, globalPerDay: 2, globalPerMonth: 20 });
  const src = read('server/http-api.mjs');
  const priv = src.slice(src.indexOf("if (path === '/api/login')")); // private (access-code) path
  const order = ['voice-spacing', 'voice-visitor:', "'voice-day'", "'voice-month'", 'token(env)'].map((k) => priv.indexOf(k));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'limits run in order, all before the token');
});

test('visitor key is an HMAC (no raw IP stored), stable per IP and different across IPs', () => {
  const env = { SESSION_SECRET: 'x'.repeat(40) };
  const req = (ip) => ({ headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
  assert.equal(visitorKey(req('203.0.113.7'), env), visitorKey(req('203.0.113.7'), env));
  assert.notEqual(visitorKey(req('203.0.113.7'), env), visitorKey(req('203.0.113.8'), env));
  assert.doesNotMatch(visitorKey(req('203.0.113.7'), env), /203|113/);
});

test('production error wording hides setup details and points to the recording', () => {
  const src = read('src/hooks/useLiveConversation.js');
  const publicBlock = src.slice(src.indexOf('const PUBLIC_ERRORS'), src.indexOf('export function messageFor'));
  assert.doesNotMatch(publicBlock, /\.env|SESSION_SECRET|ElevenLabs|توكن|مفتاح/);
  assert.match(publicBlock, /unavailable: 'المحادثة المباشرة غير متاحة الآن/);
  assert.match(src, /await ensureMicPermission\(\);[\s\S]*?= await fetchToken\(turnstile\);/, 'microphone before token');
  assert.match(read('src/App.jsx'), /dev \? 'إعدادات الدخول ناقصة/);
});

test('UI: start disabled until unlocked, disclaimer + privacy note, Khalid-only selector, export dev-only', () => {
  const ui = read('src/components/VoiceUI.jsx');
  assert.match(ui, /disabled=\{locked \|\| \(trialSeconds && \(convo\.trialUsed \|\| convo\.trialBlocked \|\| \(turnstileConfigured && !botToken\)\)\)\}/);
  assert.match(ui, /className="disclaimer">هذا مشروع تجريبي مستقل، ولا يتبع نجم أو أي شركة تأمين.<\/p>/);
  assert.equal((ui.match(/لا يتبع نجم/g) || []).length, 1, 'the disclaimer appears exactly once');
  assert.match(ui, /يُعالَج صوتك عبر ElevenLabs/, "live-mode privacy note kept");
  assert.deepEqual(PUBLIC_CALLERS.map((c) => c.id), ['khalid']);
  assert.match(read('src/hooks/useRecordedDemo.js'), /const canExport = import\.meta\.env\?\.DEV === true &&/);
});

test('Vercel: private folders are never uploaded; build does not depend on them; dist guard exists', () => {
  const ignore = read('.vercelignore').split(/\r?\n/);
  for (const p of ['recordings-raw', 'preview', 'preview-dist', 'exports', 'docs', 'tests', '.env', '.env.*']) assert.ok(ignore.includes(p), p);
  assert.equal(JSON.parse(read('vercel.json')).buildCommand, 'npm run build && node scripts/check-secrets.mjs');
  assert.match(read('scripts/check-secrets.mjs'), /private recording material/);
});
