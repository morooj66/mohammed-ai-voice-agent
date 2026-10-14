import { equal } from './security.mjs';
export function hostingConfig(env, hosted, localPort = 8787) {
  if (hosted) {
    if (env.EXTERNAL_HOSTING_APPROVED !== 'true' || env.PERSONAL_PROJECT_CREDENTIALS !== 'true') throw Error('External hosting requires owner approval and personal project configuration');
    if (!env.APP_ORIGINS?.split(',').every(o => /^https:\/\/[^/]+$/.test(o)) || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.BRIDGE_ORIGIN_SECRET || env.BRIDGE_ORIGIN_SECRET.length < 32 || !env.RATE_LIMIT_REDIS_URL?.startsWith('https://') || !env.RATE_LIMIT_REDIS_TOKEN) throw Error('Hosted bridge security configuration is incomplete');
  }
  const port = Number(hosted ? env.PORT || 10000 : localPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid listen port');
  return { host: hosted ? '0.0.0.0' : '127.0.0.1', port };
}
export function trustedProxy(req, env, hosted) {
  return !hosted || (env.BRIDGE_ORIGIN_SECRET?.length >= 32 && equal(req.headers['x-origin-secret'], env.BRIDGE_ORIGIN_SECRET));
}
