import { createServer } from 'node:http';
import { loadConfig } from './config.mjs';
import { createHandler } from './http-api.mjs';
import { simulationRoute } from './simulator/routes.mjs';
import { hostingConfig, trustedProxy } from './hosting.mjs';
import { send } from './security.mjs';
const hosted = process.argv.includes('--hosted');
const binding = hostingConfig(loadConfig(), hosted, process.argv[2] || 8787);
const handler = createHandler();
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
  if (!trustedProxy(req, loadConfig(), hosted)) return send(res, 403, { error: 'forbidden_proxy' });
  if (req.url.startsWith('/api/simulation/')) return simulationRoute(req, res, loadConfig());
  return handler(req, res);
});
server.requestTimeout = 15_000;
server.listen(binding.port, binding.host, () => console.log(`Protected demo API started on port ${binding.port}; hosted=${hosted}. Live actions still require separate approval.`));
