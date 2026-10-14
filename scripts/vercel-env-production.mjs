// Adds the PRODUCTION environment variables to the linked Vercel project (mohammed-voice-ai). Run it YOURSELF.
//   node scripts/vercel-env-production.mjs            DRY RUN: checks local values and prints the plan (names only)
//   node scripts/vercel-env-production.mjs --apply    sends each value to Vercel via STDIN (never argv, never printed)
// Same approved values as Preview, plus the fixed public origin. SESSION_SECRET is a NEW random value generated here,
// independent of Preview's. Preview is never touched. Adding variables does NOT deploy or publish anything.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.mjs';

export const PRODUCTION_ORIGIN = 'https://mohammed-voice-ai.vercel.app';
const env = loadConfig();
const TEST_TURNSTILE = /^[123]x0{20,}/;
// [name, value, sensitive] — sensitive = stored as a Vercel Secret (not readable again after saving).
export const PLAN = [
  ['ELEVENLABS_API_KEY', env.ELEVENLABS_API_KEY, true],
  ['SESSION_SECRET', randomBytes(48).toString('base64url'), true],     // Production-only, never equal to Preview's
  ['RATE_LIMIT_REDIS_URL', env.RATE_LIMIT_REDIS_URL, true],
  ['RATE_LIMIT_REDIS_TOKEN', env.RATE_LIMIT_REDIS_TOKEN, true],
  ['TURNSTILE_SECRET_KEY', env.TURNSTILE_SECRET_KEY, true],
  ['ELEVENLABS_AGENT_ID', env.ELEVENLABS_AGENT_ID, false],
  ['ELEVENLABS_VERSION_ID', env.MOHAMMED_WEB_VERSION_ID, false],          // the 60-second website version (…6501)
  ['AUDITED_AGENT_SHA256', env.MOHAMMED_WEB_AUDITED_SHA256, false],       // its audited configuration hash
  ['APP_ORIGINS', PRODUCTION_ORIGIN, false],                              // exact public origin (no wildcard)
  ['PUBLIC_TRIAL', 'true', false],
  ['LIVE_SESSIONS_APPROVED', 'true', false],
  ['AGENT_SAFETY_REVIEWED', 'true', false],
  ['PERSONAL_PROJECT_CREDENTIALS', 'true', false],
  ['VITE_PUBLIC_TRIAL', 'true', false],                                   // browser (public by design)
  ['VITE_TURNSTILE_SITE_KEY', env.TURNSTILE_SITE_KEY, false],             // browser (public by design)
];

export function problems(plan = PLAN) {
  const p = [], v = Object.fromEntries(plan.map(([n, val]) => [n, val]));
  for (const [n, val] of plan) if (!val) p.push(`${n}: missing locally`);
  if (!/^agtvrsn_6501/.test(v.ELEVENLABS_VERSION_ID || '')) p.push('ELEVENLABS_VERSION_ID is not the 60-second website version …6501');
  if (!/^[0-9a-f]{64}$/.test(v.AUDITED_AGENT_SHA256 || '')) p.push('AUDITED_AGENT_SHA256 malformed');
  if (!String(v.RATE_LIMIT_REDIS_URL || '').startsWith('https://')) p.push('RATE_LIMIT_REDIS_URL must start with https://');
  for (const n of ['TURNSTILE_SECRET_KEY', 'VITE_TURNSTILE_SITE_KEY']) if (TEST_TURNSTILE.test(v[n] || '')) p.push(`${n} is a Cloudflare TEST key — real keys required`);
  if ((v.SESSION_SECRET || '').length < 32) p.push('SESSION_SECRET too short');
  if (v.APP_ORIGINS !== PRODUCTION_ORIGIN) p.push('APP_ORIGINS must be exactly the production origin');
  return p;
}

const apply = process.argv.includes('--apply');
const issues = problems();
console.log(`Target: linked Vercel project · environment: PRODUCTION only · ${apply ? 'APPLY' : 'DRY RUN'} · no deployment`);
for (const [n, , s] of PLAN) console.log(`  ${n.padEnd(30)} ${s ? 'sensitive (secret)' : 'config'}`);
if (issues.length) { console.error(`STOPPED — fix first:\n  - ${issues.join('\n  - ')}`); process.exit(1); }
if (!apply) { console.log('DRY RUN — nothing sent. Run with --apply to add these to Production.'); process.exit(0); }
let failed = 0;
for (const [name, value, sensitive] of PLAN) {
  const r = spawnSync('npx', ['--yes', 'vercel@latest', 'env', 'add', name, 'production', sensitive ? '--sensitive' : '--no-sensitive', '--yes', '--non-interactive'],
    { input: value, stdio: ['pipe', 'ignore', 'ignore'] }); // CLI output suppressed: nothing about the value is ever shown
  console.log(`  ${name.padEnd(30)} ${r.status === 0 ? 'ADDED' : `FAILED (exit ${r.status}) — may already exist; check with: npx vercel env ls production`}`);
  if (r.status !== 0) failed++;
}
console.log(failed ? `${failed} variable(s) failed — nothing else changed.` : 'All Production variables added. Values were never printed. Nothing was deployed.');
process.exit(failed ? 1 : 0);
