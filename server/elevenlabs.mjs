import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fail, requirePersonal, GREETING } from './config.mjs';
const approvedDocuments = JSON.parse(readFileSync(new URL('./approved-kb-manifest.json', import.meta.url), 'utf8'));
export const contentHash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
export const API = 'https://api.elevenlabs.io/v1';
export async function eleven(env, path, options = {}) {
  requirePersonal(env);
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_AGENT_ID) throw fail('not_configured');
  const r = await fetch(API + path, { ...options, headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, ...options.headers }, signal: options.signal || AbortSignal.timeout(15_000) });
  if (!r.ok) throw Object.assign(fail('elevenlabs_upstream', 502), { upstreamStatus: r.status });
  return r;
}
export function configHash(agent) {
  return createHash('sha256').update(JSON.stringify({ conversation_config: agent.conversation_config, platform_settings: agent.platform_settings, workflow: agent.workflow, procedures: agent.procedures })).digest('hex');
}
export async function preflight(env, simulation = false) {
  if (env.LIVE_SESSIONS_APPROVED !== 'true' || (simulation && env.SIMULATION_PAID_APPROVED !== 'true')) throw fail('needs_approval', 403);
  if (!env.ELEVENLABS_VERSION_ID || !env.AUDITED_AGENT_SHA256 || env.AGENT_SAFETY_REVIEWED !== 'true') throw fail('agent_review_required');
  const params = new URLSearchParams({ version_id: env.ELEVENLABS_VERSION_ID });
  const agent = await (await eleven(env, `/convai/agents/${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}?${params}`)).json();
  const c = agent.conversation_config;
  if (agent.version_id !== env.ELEVENLABS_VERSION_ID || configHash(agent) !== env.AUDITED_AGENT_SHA256) throw fail('agent_changed');
  if (agent.platform_settings?.auth?.enable_auth !== true || c?.agent?.first_message !== GREETING || !(c?.conversation?.max_duration_seconds > 0 && c.conversation.max_duration_seconds <= 180)) throw fail('unsafe_agent_configuration');
  // The public trial is only allowed on a version where ElevenLabs itself ends calls at 60 s.
  if (env.PUBLIC_TRIAL === 'true' && !(c.conversation.max_duration_seconds <= 60)) throw fail('trial_duration_not_enforced');
  // A separately reviewed hash covers the reviewed configuration (including KB references); document content is audited separately.
  // Refuse direct tool IDs and custom tools even after review. end_call is the only permitted tool.
  const prompt = c.agent.prompt || {};
  if (prompt.tool_ids?.length || (prompt.tools || []).some(t => t.type !== 'system' || t.name !== 'end_call')) throw fail('external_tools_forbidden');
  // Every agent carries a default workflow containing a single 'start' node (observed in the remote audit).
  // Only that default is allowed; any other node type (tools, transfers, sub-agents) is still refused.
  const nodes = Object.values(agent.workflow?.nodes || {});
  if (nodes.some(n => n?.type !== 'start') || Object.keys(agent.procedures || {}).length || c.agent.native_mcp_server_ids?.length) throw fail('external_workflow_forbidden');
  if (Object.entries(prompt.built_in_tools || {}).some(([name, value]) => value != null && name !== 'end_call')) throw fail('external_tools_forbidden');
  if (simulation && !c.conversation.client_events?.includes('agent_response_complete')) throw fail('completion_event_required');
  const documents = prompt.knowledge_base || [];
  if (documents.length !== 9 || new Set(documents.map(d => d.id)).size !== 9) throw fail('knowledge_base_incomplete');
  const hashes = await Promise.all(documents.map(async d => {
    let content = await (await eleven(env, `/convai/knowledge-base/${encodeURIComponent(d.id)}/content`)).text();
    try { const parsed = JSON.parse(content); if (typeof parsed === 'string') content = parsed; } catch {}
    return contentHash(content);
  }));
  if (JSON.stringify(hashes.sort()) !== JSON.stringify(approvedDocuments.map(d => d.sha256).sort())) throw fail('knowledge_base_content_changed');
  return agent;
}
export async function conversationToken(env) {
  await preflight(env);
  const p = new URLSearchParams({ agent_id: env.ELEVENLABS_AGENT_ID, version_id: env.ELEVENLABS_VERSION_ID });
  const body = await (await eleven(env, `/convai/conversation/token?${p}`)).json();
  if (typeof body.token !== 'string') throw fail('invalid_token', 502);
  return body.token;
}
