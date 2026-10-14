import { readFileSync } from 'node:fs';
export function loadConfig() {
  // Only explicit personal project secrets in Vercel; never use ambient local keys.
  if (process.env.VERCEL === '1' || (process.argv.includes('--hosted') && process.env.EXTERNAL_HOSTING_APPROVED === 'true')) return { ...process.env };
  try {
    return Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
      .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^['"]|['"]$/g, '')]));
  } catch { return {}; }
}
export function requirePersonal(env) {
  if (env.PERSONAL_PROJECT_CREDENTIALS !== 'true') throw Object.assign(new Error('personal_credentials_required'), { status: 503 });
}
export const fail = (code, status = 503) => Object.assign(new Error(code), { status });
export const GREETING = 'حياك الله، معك محمد، المساعد لشركة التأمين. كيف أقدر أخدمك؟';
