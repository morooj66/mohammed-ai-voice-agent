import { fail } from '../config.mjs';
import { authenticate, originAllowed, readJSON, send, limit } from '../security.mjs';
import { eleven, preflight } from '../elevenlabs.mjs';
import { SimulationSession } from './session.mjs';
import { generateKhalid, speakKhalid } from './khalid.mjs';
import { ConversationRecorder } from './recorder.mjs';
import { KhalidAgentBrain } from './khalid-agent.mjs';
// Raw recordings stay outside the public site until reviewed and explicitly published.
const RAW_DIR = new URL('../../recordings-raw/', import.meta.url).pathname;
const sessions = new Map();
let reserving = false;
export async function simulationRoute(req, res, env) {
  try {
    if (req.method !== 'POST') throw fail('method_not_allowed', 405);
    if (!originAllowed(req, env)) throw fail('forbidden_origin', 403);
    const owner = authenticate(req, env).id;
    const path = req.url.split('?')[0];
    if (path === '/api/simulation/control') {
      const body = await readJSON(req);
      const entry = sessions.get(body.sessionId);
      if (!entry || entry.owner !== owner) throw fail('session_not_found', 404);
      if (body.action === 'stop') entry.session.stop();
      else if (body.action === 'played') void entry.session.acknowledge(body.barrier);
      else throw fail('invalid_action', 400);
      return send(res, 200, { ok: true });
    }
    if (path !== '/api/simulation/start') throw fail('not_found', 404);
    if (env.VERCEL === '1') throw fail('persistent_bridge_required');
    if (reserving || sessions.size) throw fail('session_busy', 409);
    reserving = true;
    let socket, brain = null;
    try {
      // Khalid's brain: 'elevenlabs_agent' (text-only private ElevenLabs agent, no extra provider) or Anthropic (default).
      const useAgentBrain = env.KHALID_BRAIN === 'elevenlabs_agent';
      if (!(useAgentBrain ? env.KHALID_AGENT_ID : env.ANTHROPIC_API_KEY) || !env.KHALID_VOICE_ID || env.KHALID_VOICE_APPROVED !== 'true') throw fail('khalid_not_configured');
      await limit(env, 'voice-start', 3, 86400);
      await limit(env, 'voice-spacing', 1, 190);
      const agent = await preflight(env, true);
      if (agent.conversation_config.tts.voice_id === env.KHALID_VOICE_ID) throw fail('distinct_voice_required');
      const p = new URLSearchParams({ agent_id: env.ELEVENLABS_AGENT_ID, version_id: env.ELEVENLABS_VERSION_ID });
      const { signed_url: url } = await (await eleven(env, `/convai/conversation/get-signed-url?${p}`)).json();
      const parsed = new URL(url);
      if (parsed.protocol !== 'wss:' || parsed.hostname !== 'api.elevenlabs.io') throw fail('invalid_upstream_url');
      if (useAgentBrain) {
        if (env.KHALID_AGENT_ID === env.ELEVENLABS_AGENT_ID) throw fail('distinct_agent_required');
        const k = new URLSearchParams({ agent_id: env.KHALID_AGENT_ID, ...(env.KHALID_VERSION_ID ? { version_id: env.KHALID_VERSION_ID } : {}) });
        const { signed_url: khalidUrl } = await (await eleven(env, `/convai/conversation/get-signed-url?${k}`)).json();
        brain = new KhalidAgentBrain({ signedUrl: khalidUrl });
        await brain.open();
      }
      if (res.destroyed) return;
      socket = new WebSocket(url);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const recorder = env.RECORD_SESSION === 'true' ? new ConversationRecorder() : null;
      const session = new SimulationSession({ socket, recorder, recordFormat: recorder ? 'pcm_24000' : null,
        emit: event => {
          if (!res.destroyed && !res.writableEnded) {
            const accepted = res.write(JSON.stringify(event) + '\n');
            if (!accepted && res.writableLength > 2_000_000 && event.type !== 'stopped') queueMicrotask(() => session.stop('slow_client'));
          }
          if (event.type === 'stopped') {
            if (recorder) {
              try {
                const name = `khalid-mohammed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
                const saved = recorder.save(RAW_DIR, name, { completionReason: event.reason });
                if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify({ type: 'recording_saved', file: name, duration: saved.duration, cues: saved.cues, reason: event.reason }) + '\n');
              } catch (e) { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify({ type: 'recording_failed', error: e.message }) + '\n'); }
            }
            brain?.close();
            sessions.delete(session.id); res.end();
          }
        },
        reply: (history, emotion, signal) => brain ? brain.reply(history, emotion, signal) : generateKhalid(env, history, emotion, signal),
        tts: (text, format, signal, emotion) => speakKhalid(env, text, format, signal, emotion),
      });
      sessions.set(session.id, { owner, session });
      // Expose control ID immediately so Stop can cancel a pending connection.
      session.output({ type: 'session', sessionId: session.id });
      socket.addEventListener('open', () => session.send({ type: 'conversation_initiation_client_data' }));
      socket.addEventListener('message', e => { try { session.message(JSON.parse(e.data)); } catch { session.stop('invalid_event'); } });
      socket.addEventListener('error', () => session.stop('connection_failed'));
      socket.addEventListener('close', () => session.stop('connection_closed'));
      res.on('close', () => session.stop('client_disconnected'));
    } catch (e) { brain?.close(); throw e; } finally { reserving = false; }
  } catch (e) { if (!res.headersSent) send(res, e.status || 503, { error: e.status ? e.message : 'service_unavailable' }); else res.end(); }
}
