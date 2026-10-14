// Regression: every ElevenLabs agent has a default workflow with one 'start' node (seen in the
// remote audit). preflight must accept that default while still refusing any other node type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { configHash, preflight } from '../server/elevenlabs.mjs';
import { GREETING } from '../server/config.mjs';

const kb = new URL('../../sarj-agent-assessment/knowledge_base/', import.meta.url);
const documents = (() => { try { return readdirSync(kb).filter((x) => x.endsWith('.md')).map((name, i) => ({ id: `doc-${i}`, text: readFileSync(new URL(name, kb), 'utf8') })); } catch { return []; } })();

function fixture(workflow) {
  const agent = { version_id: 'v1', workflow, platform_settings: { auth: { enable_auth: true } }, conversation_config: { conversation: { max_duration_seconds: 180, client_events: ['audio', 'agent_response_complete'] }, agent: { first_message: GREETING, prompt: { knowledge_base: Array.from({ length: 9 }, (_, i) => ({ id: `doc-${i}` })) } } } };
  const env = { PERSONAL_PROJECT_CREDENTIALS: 'true', ELEVENLABS_API_KEY: 'fake-personal-test', ELEVENLABS_AGENT_ID: 'test', ELEVENLABS_VERSION_ID: 'v1', LIVE_SESSIONS_APPROVED: 'true', SIMULATION_PAID_APPROVED: 'true', AGENT_SAFETY_REVIEWED: 'true', AUDITED_AGENT_SHA256: configHash(agent) };
  return { agent, env };
}
const fakeFetch = (agent) => async (url) => url.includes('/agents/') ? { ok: true, json: async () => agent } : { ok: true, text: async () => documents.find((d) => url.includes(`/${d.id}/`)).text };

test('default single start node is accepted', { skip: !documents.length }, async () => {
  const old = globalThis.fetch;
  try {
    const { agent, env } = fixture({ nodes: { start_node: { type: 'start' } } });
    globalThis.fetch = fakeFetch(agent);
    assert.equal((await preflight(env, true)).version_id, 'v1');
  } finally { globalThis.fetch = old; }
});

test('any non-start workflow node is still refused', async () => {
  const old = globalThis.fetch;
  try {
    for (const type of ['subagent', 'phone_number', 'tool', undefined]) {
      const { agent, env } = fixture({ nodes: { start_node: { type: 'start' }, extra: { type } } });
      globalThis.fetch = fakeFetch(agent);
      await assert.rejects(preflight(env, true), /external_workflow_forbidden/);
    }
  } finally { globalThis.fetch = old; }
});
