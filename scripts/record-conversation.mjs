// One genuine, bounded AI-to-AI recording: Mohammed (published ElevenLabs agent, real output)
// x Khalid (private text-only ElevenLabs agent for words + ElevenLabs TTS for voice).
// Uses the SAME server modules as the website bridge (preflight, KhalidAgentBrain, SimulationSession,
// ConversationRecorder). Nothing is scripted for Mohammed; only Khalid's first line is the fixed opening.
//
// DRY RUN by default: read-only checks + plan + estimate. No conversation, no audio, no credits.
// Khalid/Raj paid run requires BOTH: RECORDING_APPROVED=true and --go.
// Um Nasser additionally requires UM_NASSER_VOICE_APPROVED=true in that one shell command.
//   node scripts/record-conversation.mjs
//   RECORDING_APPROVED=true node scripts/record-conversation.mjs --go
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { eleven, preflight, configHash } from '../server/elevenlabs.mjs';
import { SimulationSession } from '../server/simulator/session.mjs';
import { ConversationRecorder } from '../server/simulator/recorder.mjs';
import { KhalidAgentBrain } from '../server/simulator/khalid-agent.mjs';
import { OPENING, KHALID_TTS_MODELS, speakKhalid, ttsText } from '../server/simulator/khalid.mjs';
import { versionCheck } from '../server/simulator/version-check.mjs';
import { reviewTranscript } from '../server/simulator/realism.mjs';
import { normalizePcm, trimTail } from '../server/simulator/recorder.mjs';
import { readPromptBody } from '../server/simulator/prompt-tools.mjs';
import { parseCallerArg, callerConfig, callerConfigProblems } from '../server/simulator/personas.mjs';

// Safety limits only (approved): the call normally ends naturally after Khalid closes it and Mohammed replies.
export const PLAN = Object.freeze({ maxSeconds: 150, maxUtterances: 16, trailingSilenceMs: 500, loudnessDbfs: -16,
  turnTimeoutMs: 35_000, recordFormat: 'pcm_24000', prefetch: true, completionFallbackMs: 2000,
  // Khalid's fixed opening is synthesized BEFORE any call opens; if TTS is slower than this, stop before Mohammed is billed.
  openingTtsMaxMs: 8000 });
// Um Nasser is deliberately shorter: four back-and-forth exchanges means at most
// eight speaker utterances (including her fixed opening and Mohammed's closing).
// Existing Khalid/Raj recording caps remain unchanged.
export function planFor(persona) {
  return persona?.id === 'um_nasser' ? Object.freeze({ ...PLAN, maxSeconds: 30, maxUtterances: 8 }) : PLAN;
}
export function participantLabel(role, persona) {
  return role === 'agent' ? 'Mohammed' : (persona?.nameAr || persona?.id || 'Caller');
}
export function resolveCallerApproval(env, persona, { go, processEnv = process.env } = {}) {
  // loadConfig intentionally reads the local .env as a whole; accept this one explicit
  // one-shot approval from the command environment without persisting it to .env.
  if (persona?.id === 'um_nasser' && go && processEnv.UM_NASSER_VOICE_APPROVED === 'true') {
    return { ...env, UM_NASSER_VOICE_APPROVED: 'true' };
  }
  return env;
}
export function resolveRunAuthorization(env, persona, args, processEnv = process.env) {
  const go = args.includes('--go') && processEnv.RECORDING_APPROVED === 'true';
  const callerEnv = resolveCallerApproval(env, persona, { go, processEnv });
  return { go, callerEnv, caller: callerConfig(callerEnv, persona), callerProblems: callerConfigProblems(callerEnv, persona, { go }) };
}
const RAW_DIR = fileURLToPath(new URL('../recordings-raw/', import.meta.url));

// Usage cap. With 16 total utterances, Khalid can make at most 7 dynamic replies after his fixed opening.
export function estimate(model, persona = null, plan = PLAN) {
  const maxLine = 'ا'.repeat(240);
  const maxKhalidReplies = Math.floor((plan.maxUtterances - 2) / 2);
  const opening = persona?.opening ?? OPENING, tags = persona?.tags;
  const openingTags = persona?.openingTags || tags;
  const dynamicMax = persona?.id === 'um_nasser'
    ? Math.max(...Object.keys(tags || {}).map(emotion => ttsText(maxLine, emotion, model, tags).length))
    : ttsText(maxLine, 'STRESSED', model, tags).length;
  const khalidTtsCharacters = ttsText(opening, 'STRESSED', model, openingTags).length
    + maxKhalidReplies * dynamicMax;
  return { khalidTtsCharacters, mohammedMinutes: plan.maxSeconds / 60, khalidTextMessages: maxKhalidReplies };
}

async function main(args) {
  const env = loadConfig();
  // Caller persona: --caller=khalid (default, unchanged behaviour) or --caller=raj. Mohammed is always the same.
  const persona = parseCallerArg(args);
  const { go, callerEnv, caller, callerProblems } = resolveRunAuthorization(env, persona, args);
  const Name = persona.id[0].toUpperCase() + persona.id.slice(1);
  const plan = planFor(persona);
  const model = persona.id === 'khalid' ? (KHALID_TTS_MODELS.includes(env.KHALID_TTS_MODEL) ? env.KHALID_TTS_MODEL : 'eleven_flash_v2_5') : persona.ttsModel;
  const problems = [];
  if (env.AGENT_SAFETY_REVIEWED !== 'true') problems.push('AGENT_SAFETY_REVIEWED is not true');
  problems.push(...callerProblems);
  if (model !== persona.ttsModel) problems.push(`${persona.id}: TTS model is not the approved model`);
  if (problems.length && !caller.agentId) { console.log(`Caller: ${persona.id}\nBLOCKED:\n- ` + problems.join('\n- ')); process.exitCode = 2; return; }
  // Paid-session flags are granted in memory only for an explicitly approved run (or for the read-only preflight).
  // Mohammed's version for THIS scenario (Khalid: ELEVENLABS_VERSION_ID/AUDITED_AGENT_SHA256 as before; Raj: his own pin).
  const runEnv = { ...env, ELEVENLABS_VERSION_ID: caller.mohammedVersionId, AUDITED_AGENT_SHA256: caller.mohammedHash, LIVE_SESSIONS_APPROVED: 'true', SIMULATION_PAID_APPROVED: 'true' };

  const agent = await preflight(runEnv, true); // read-only: version, hash, auth, KB content, tools, events
  if (agent.conversation_config.tts.voice_id === caller.voiceId) problems.push(`${Name} voice equals Mohammed voice`);
  // The caller is pinned like Mohammed (its *_VERSION_ID is set only after a read-only audit PASS).
  const khalid = await (await eleven(env, `/convai/agents/${encodeURIComponent(caller.agentId)}${caller.versionId ? `?version_id=${encodeURIComponent(caller.versionId)}` : ''}`)).json();
  if (caller.versionId && khalid.version_id !== caller.versionId) problems.push(`pinned ${Name} version not returned`);
  const kc = khalid.conversation_config, kp = kc.agent.prompt;
  if (kc.conversation?.text_only !== true || kc.agent.first_message || khalid.platform_settings?.auth?.enable_auth !== true
    || (kp.tool_ids || []).length || (kp.tools || []).length || (kp.knowledge_base || []).length) problems.push(`${Name} agent is not private/text-only/tool-free`);
  const localPrompt = readPromptBody(new URL(`../server/simulator/${persona.promptFile}`, import.meta.url));
  if (kp.prompt !== localPrompt) problems.push(`published ${Name} prompt does not match local prepared proposal`);
  if (persona.id === 'um_nasser' && kp.llm !== 'claude-haiku-4-5') problems.push('Um Nasser caller LLM differs from audited setup');

  const est = estimate(model, persona, plan);
  console.log(`Mohammed: ${agent.version_id} (preflight PASS) · ${Name} agent: ${khalid.version_id} (text-only, auth ON)`);
  console.log(`${Name} voice: ${caller.voiceId || '-'} · TTS model: ${model} · recording: ${PLAN.recordFormat}`);
  console.log(`Safety caps: <= ${plan.maxSeconds}s, <= ${plan.maxUtterances} utterances${persona.id === 'um_nasser' ? ' (4 caller–Mohammed exchanges maximum)' : ''} · Usage cap: ${Name} TTS <= ${est.khalidTtsCharacters} tagged chars, Mohammed <= ${est.mohammedMinutes} call min, ${Name} brain <= ${est.khalidTextMessages} text messages`);
  if (problems.length) { console.log('BLOCKED:\n- ' + problems.join('\n- ')); process.exitCode = 2; return; }
  if (!go) { console.log('DRY RUN — no conversation started, no audio generated.'); return; }

  const sign = async (q) => {
    const { signed_url: url } = await (await eleven(env, `/convai/conversation/get-signed-url?${new URLSearchParams(q)}`)).json();
    const u = new URL(url); if (u.protocol !== 'wss:' || u.hostname !== 'api.elevenlabs.io') throw Error('invalid_upstream_url');
    return url;
  };
  // speakKhalid is the shared caller TTS; it reads the caller's voice through these keys (Khalid: unchanged values).
  const ttsEnv = { ...env, KHALID_TTS_MODEL: model, KHALID_VOICE_ID: caller.voiceId, KHALID_VOICE_APPROVED: caller.voiceApproved ? 'true' : 'false', SIMULATION_PAID_APPROVED: 'true' };
  const tOpen = Date.now();
  const shape = (pcm, rate) => normalizePcm(trimTail(pcm, rate), rate, { targetDbfs: PLAN.loudnessDbfs });
  let openingAudio;
  try {
    openingAudio = await speakKhalid(ttsEnv, persona.opening, plan.recordFormat, AbortSignal.timeout(30_000), 'STRESSED', { tags: persona.openingTags });
  } catch (error) {
    const status = Number.isInteger(error.upstreamStatus) ? ` HTTP ${error.upstreamStatus}` : '';
    console.error(persona.id === 'um_nasser'
      ? `STOPPED before conversation: Grandma Aurora / eleven_v4 opening was rejected or unavailable${status}; no Mohammed session was opened and no retry was made.`
      : `STOPPED before conversation: opening TTS failed${status}; no call was opened.`);
    process.exitCode = 3;
    return;
  }
  const openingPcm = shape(openingAudio, 24000);
  const openingMs = Date.now() - tOpen;
  console.log(`Opening TTS (${model}): ${openingMs} ms`);
  if (openingMs > PLAN.openingTtsMaxMs) { console.log(`STOPPED before any call: TTS latency ${openingMs} ms > ${PLAN.openingTtsMaxMs} ms (live turns would have long pauses).`); process.exitCode = 3; return; }
  // Diagnostics: Khalid agent event TYPES with timestamps only (no content). Before the call starts,
  // times are relative to the Khalid connection; afterwards they use the main trace clock.
  const khalidEvents = []; const tBrain = Date.now(); let traceStarted = false, mark = null;
  const brain = new KhalidAgentBrain({ signedUrl: await sign({ agent_id: caller.agentId, version_id: caller.versionId }), opening: persona.opening,
    onEvent: (type) => {
      if (traceStarted) {
        mark(`${persona.id}_event_${type}`);
        if (type === 'agent_response' || type === 'agent_response_complete') mark(`${persona.id}_brain_${type === 'agent_response' ? 'response' : 'response_complete'}`);
      } else khalidEvents.push({ ms: Date.now() - tBrain, what: `${persona.id}_event_${type}` });
    } });
  await brain.open();
  const socket = new WebSocket(await sign({ agent_id: env.ELEVENLABS_AGENT_ID, version_id: runEnv.ELEVENLABS_VERSION_ID }));
  const recorder = new ConversationRecorder();
  // Timing trace (event types + ms only; no audio, no secrets) to diagnose gaps between turns.
  const t0 = Date.now(), trace = [{ ms: 0, what: 'opening_tts_ms_before_call', value: openingMs }];
  mark = (what, extra) => trace.push({ ms: Date.now() - t0, what, ...extra });
  trace.push(...khalidEvents.map((e) => ({ ...e, ms: e.ms - (t0 - tBrain), beforeCall: true }))); traceStarted = true;
  const timed = (what, fn) => async (...a) => { mark(`${what}_start`); try { return await fn(...a); } finally { mark(`${what}_end`); } };
  let playEnd = 0; // simulated listener: acknowledges each agent turn after its audio would have finished playing
  let mohammedConversationId = null;
  const done = new Promise((resolve) => {
    const session = new SimulationSession({
      socket, recorder, recordFormat: plan.recordFormat, prefetch: plan.prefetch, completionFallbackMs: plan.completionFallbackMs, opening: persona.opening, callerId: persona.id,
      openingAudio: { format: PLAN.recordFormat, audio: openingPcm }, shapeAudio: shape, trailingSilenceMs: PLAN.trailingSilenceMs,
      limits: { duration: plan.maxSeconds * 1000, turns: plan.maxUtterances, turnTimeout: plan.turnTimeoutMs },
      onTrace: (what, extra) => mark(what, extra),
      reply: timed(`${persona.id}_brain`, (history, emotion, signal) => brain.reply(history, emotion, signal)),
      tts: timed(`${persona.id}_tts`, (text, format, signal, emotion) => speakKhalid(ttsEnv, text, format, signal, emotion, { tags: persona.tags, onRetry: (reason) => mark(`${persona.id}_tts_retry`, { reason }) })),
      emit: (event) => {
        if (event.type === 'completion') mark('completion', { source: event.source });
        if (event.type === 'transcript') console.log(`${participantLabel(event.role, persona)}: ${event.text}${event.emotion ? `  [${event.emotion}]` : ''}`);
        if (event.type === 'audio' && event.role === 'agent') {
          const ms = Buffer.from(event.audio, 'base64').length / (Number(event.format.slice(4)) * 2) * 1000;
          playEnd = Math.max(playEnd, Date.now()) + ms;
        }
        if (event.type === 'playback_barrier') mark('barrier', { waitMs: Math.max(0, playEnd - Date.now()) + 300 });
        if (event.type === 'playback_barrier') setTimeout(() => void session.acknowledge(event.barrier), Math.max(0, playEnd - Date.now()) + 300);
        if (event.type === 'stopped') { brain.close(); resolve(event); }
      },
    });
    socket.addEventListener('open', () => session.send({ type: 'conversation_initiation_client_data' }));
    socket.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); if (m.type === 'conversation_initiation_metadata') mohammedConversationId = m.conversation_initiation_metadata_event?.conversation_id || null; if (m.type !== 'ping') mark(`upstream_${m.type}`); session.message(m); } catch { session.stop('invalid_event'); } });
    socket.addEventListener('error', () => session.stop('connection_failed'));
    socket.addEventListener('close', () => session.stop('connection_closed'));
    process.on('SIGINT', () => session.stop('user_stop'));
  });
  const stopped = await done;
  const recording = recorder.build();
  const actualTtsCharacters = recording.transcript.filter((line) => line.speaker === 'customer')
    .reduce((n, line) => n + ttsText(line.text, line.emotion || 'STRESSED', model, persona.tags).length, 0);
  const readUsage = async (conversationId) => {
    if (!conversationId) return { available: false, reason: 'conversation_id_unavailable' };
    try {
      const detail = await (await eleven(env, `/convai/conversations/${encodeURIComponent(conversationId)}`)).json();
      const charge = detail.metadata?.charging || {};
      return { available: true, status: detail.status, conversationId, versionId: detail.version_id || null,
        durationSeconds: detail.metadata?.call_duration_secs ?? null, cost: detail.metadata?.cost ?? null,
        costFiat: detail.metadata?.cost_fiat ?? null,
        charging: Object.fromEntries(['tier', 'dev_discount', 'is_burst', 'llm_price', 'llm_charge', 'call_charge', 'platform_charge', 'free_minutes_consumed', 'free_llm_dollars_consumed'].filter((k) => charge[k] !== undefined).map((k) => [k, charge[k]])) };
    } catch (e) { return { available: false, conversationId, reason: e.message }; }
  };
  // One read-only billing lookup per agent, with no retry. Missing provider usage remains explicit.
  const [mohammedUsage, khalidUsage] = await Promise.all([readUsage(mohammedConversationId), readUsage(brain.conversationId)]);
  const name = `${persona.filePrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const agents = { mohammed: { agentId: env.ELEVENLABS_AGENT_ID, versionId: agent.version_id, configHash: configHash(agent) },
    [persona.id]: { agentId: caller.agentId, versionId: khalid.version_id, configHash: configHash(khalid) } };
  const apiUsage = { mohammed: mohammedUsage, [`${persona.id}TextAgent`]: khalidUsage, [`${persona.id}TextMessages`]: brain.requestCount,
    [`${persona.id}TtsCharacters`]: actualTtsCharacters, billingNote: 'Provider charges are read once from conversation details. TTS character count is measured locally; missing billing fields remain null.' };
  // Post-call proof: the conversation must have run on the exact Mohammed version requested (explicit version_id).
  const checks = { mohammed: versionCheck(runEnv.ELEVENLABS_VERSION_ID, mohammedUsage.versionId) };
  const saved = recorder.save(RAW_DIR, name, { completionReason: stopped.reason, metadata: { caller: { id: persona.id, nameAr: persona.nameAr }, agents, [`${persona.id}Voice`]: { voiceId: caller.voiceId, model }, apiUsage, versionCheck: checks, invalid: !checks.mohammed.match } });
  console.log(checks.mohammed.match ? `VERSION CHECK PASS · Mohammed ran ${checks.mohammed.actual}` : `INVALID RECORDING · Mohammed ${checks.mohammed.reason}: requested ${checks.mohammed.requested}, actual ${checks.mohammed.actual} · cannot be approved or exported`);
  const review = reviewTranscript(recording.transcript, { opening: persona.opening, profile: persona.realism, sympathyAllowance: persona.sympathyAllowance });
  console.log(`Realism review: ${review.issues.length} issue(s), max gap ${review.maxGap}s`); for (const i of review.issues) console.log(`  - ${i.rule}: ${i.detail}`);
  writeFileSync(`${RAW_DIR}${name}.trace.json`, JSON.stringify({ stopped, trace, review, agents, apiUsage, versionCheck: checks }, null, 1) + '\n');
  console.log(`${stopped.reason === 'natural_end' ? 'COMPLETE' : 'INCOMPLETE'}: ${stopped.reason} after ${stopped.turns} utterances · saved ${saved.wav} (${saved.duration}s, ${saved.cues} cues, unmatched ${JSON.stringify(saved.unmatched)})`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2)).catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
