// Preview hardening: exact Vercel origins from server-side system variables; real-value leak scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { originAllowed, vercelOrigins } from '../server/security.mjs';
import { scan, secretValues, VERCEL_SECRET_NAMES } from '../scripts/check-secrets.mjs';

const VENV = { VERCEL: '1', VERCEL_URL: 'mohammed-voice-ai-abc123-moroojs-projects.vercel.app', VERCEL_BRANCH_URL: 'mohammed-voice-ai-git-main-moroojs-projects.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'mohammed-voice-ai.vercel.app' };
const req = (origin, extra = {}) => ({ headers: { origin, ...extra } });

test("origins: this project's exact Vercel addresses are allowed (from server-side system variables)", () => {
  assert.deepEqual(vercelOrigins(VENV), ['https://mohammed-voice-ai-abc123-moroojs-projects.vercel.app', 'https://mohammed-voice-ai-git-main-moroojs-projects.vercel.app', 'https://mohammed-voice-ai.vercel.app']);
  for (const o of vercelOrigins(VENV)) assert.equal(originAllowed(req(o), VENV), true, o);
});

test('origins: no wildcard, client headers cannot add an origin, unknown origins refused', () => {
  for (const o of ['https://evil.vercel.app', 'https://mohammed-voice-ai.vercel.app.evil.com', 'http://mohammed-voice-ai.vercel.app', 'https://other-project.vercel.app', '', undefined, 'null'])
    assert.equal(originAllowed(req(o), VENV), false, String(o));
  assert.equal(originAllowed(req('https://evil.vercel.app', { host: 'evil.vercel.app', 'x-forwarded-host': 'evil.vercel.app' }), VENV), false, 'Host / X-Forwarded-Host are ignored');
  assert.equal(originAllowed(req('https://mohammed-voice-ai.vercel.app', { 'sec-fetch-site': 'cross-site' }), VENV), false);
  assert.deepEqual(vercelOrigins({ ...VENV, VERCEL_URL: '*.vercel.app', VERCEL_BRANCH_URL: 'a b', VERCEL_PROJECT_PRODUCTION_URL: 'x/../y' }), [], 'malformed values are ignored, never widened');
  assert.deepEqual(vercelOrigins({ VERCEL_URL: 'x.vercel.app' }), [], 'only when actually running on Vercel');
  assert.equal(originAllowed(req('http://127.0.0.1:5173'), VENV), false, 'local dev origins are not allowed on Vercel');
  assert.equal(originAllowed(req('https://www.example.com'), { ...VENV, APP_ORIGINS: 'https://www.example.com' }), true, 'explicit APP_ORIGINS still work');
});

function fakeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'leakscan-'));
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text); }
  return root;
}

test('leak scan: the two new names are checked on Vercel, by their ACTUAL values', () => {
  assert.ok(VERCEL_SECRET_NAMES.includes('TURNSTILE_SECRET_KEY') && VERCEL_SECRET_NAMES.includes('RATE_LIMIT_REDIS_URL'));
  const env = { VERCEL: '1', TURNSTILE_SECRET_KEY: '0xSECRET_turnstile_value_123456', RATE_LIMIT_REDIS_URL: 'https://fake-redis-12345.upstash.io' };
  for (const leaked of [env.TURNSTILE_SECRET_KEY, env.RATE_LIMIT_REDIS_URL]) {
    const root = fakeProject({ 'dist/assets/app.js': `const x = "${leaked}";`, 'src/main.js': 'ok' });
    assert.deepEqual(scan(root, secretValues('', env)), ['dist/assets/app.js']);
  }
  const clean = fakeProject({ 'dist/assets/app.js': 'const siteKey = "0xPUBLIC_site_key_abcdef";', 'src/main.js': 'import.meta.env?.VITE_TURNSTILE_SITE_KEY' });
  assert.deepEqual(scan(clean, secretValues('TURNSTILE_SITE_KEY=0xPUBLIC_site_key_abcdef\n', env)), [], 'the public site key is allowed');
});

test('leak scan: local .env values incl. RATE_LIMIT_REDIS_URL are checked; the output never contains a secret', () => {
  const secret = 'https://local-redis-98765.upstash.io';
  const root = fakeProject({ 'dist/index.html': `<script>fetch("${secret}")</script>`, 'src/a.js': '' });
  assert.deepEqual(scan(root, secretValues(`RATE_LIMIT_REDIS_URL=${secret}\nTURNSTILE_SECRET_KEY=0xLOCAL_secret_value_xyz987\n`, {})), ['dist/index.html']);
  const cli = spawnSync(process.execPath, ['-e', `import('${new URL('../scripts/check-secrets.mjs', import.meta.url).href}').then(m=>{const f=m.scan(${JSON.stringify(root)}, m.secretValues(${JSON.stringify(`RATE_LIMIT_REDIS_URL=${secret}\n`)}, {}));console.error('FAIL:',f)})`], { encoding: 'utf8' });
  assert.match(cli.stderr, /dist\/index\.html/); assert.ok(!cli.stderr.includes(secret) && !cli.stdout.includes(secret), 'secret value never printed');
});
