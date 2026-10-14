// Build-time leak check: the ACTUAL secret values (from .env locally, from Vercel's environment on Vercel) must not
// appear in src/ or in the built files. Reports file names only — never a secret value.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Server-only secrets checked on Vercel (values read from the build environment).
export const VERCEL_SECRET_NAMES = Object.freeze(['ELEVENLABS_API_KEY', 'ANTHROPIC_API_KEY', 'SESSION_SECRET', 'DEMO_ACCESS_CODE',
  'RATE_LIMIT_REDIS_TOKEN', 'RATE_LIMIT_REDIS_URL', 'TURNSTILE_SECRET_KEY']);
// Public by design (allowed in the browser): never treated as a secret.
const PUBLIC_NAMES = new Set(['TURNSTILE_SITE_KEY', 'VITE_TURNSTILE_SITE_KEY']);
const LOCAL_SECRET_NAME = /^[A-Z0-9_]*(?:KEY|SECRET|TOKEN|ACCESS_CODE)$|^RATE_LIMIT_REDIS_URL$/;

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

export function secretValues(envText = '', processEnv = {}) {
  const values = envText.split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)).filter(Boolean)
    .filter(([, name]) => LOCAL_SECRET_NAME.test(name) && !PUBLIC_NAMES.has(name)).map(([, , v]) => v.replace(/^['"]|['"]$/g, ''));
  if (processEnv.VERCEL === '1') for (const n of VERCEL_SECRET_NAMES) if (processEnv[n]) values.push(String(processEnv[n]));
  return values.filter((v) => v.length >= 12);
}

export function scan(root, secrets) {
  const failures = [];
  const targets = [...(existsSync(`${root}/src`) ? files(`${root}/src`) : []), ...(existsSync(`${root}/dist`) ? files(`${root}/dist`) : []),
    ...(existsSync(`${root}/preview-dist`) ? files(`${root}/preview-dist`) : [])];
  for (const file of targets) {
    const text = readFileSync(file, 'utf8');
    if (secrets.some((s) => text.includes(s)) || /\bsk[-_](?:ant[-_])?[A-Za-z0-9_-]{24,}\b/.test(text)
      || /import\.meta\.env\??\.VITE_(?!TURNSTILE_SITE_KEY\b)\w*(?:KEY|SECRET|TOKEN)/.test(text)) failures.push(file.slice(root.length + 1));
  }
  // Private material must never reach the public build: draft/raw recordings, voice tests, exports.
  if (existsSync(`${root}/dist`)) for (const file of files(`${root}/dist`)) if (/draft-|recordings-raw|voice-tests|exports\/|\.trace\.json$/.test(file.slice(root.length + 1))) failures.push(`${file.slice(root.length + 1)} (private recording material)`);
  return failures;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = resolve(import.meta.dirname, '..');
  const failures = scan(root, secretValues(existsSync(`${root}/.env`) ? readFileSync(`${root}/.env`, 'utf8') : '', process.env));
  if (failures.length) { console.error('FAIL: possible secret exposure in files:', failures); process.exitCode = 1; }
  else console.log('PASS: no configured secret values or recognized private-key patterns in frontend/build.');
}
