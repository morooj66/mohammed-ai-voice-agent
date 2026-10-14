// Khalid's "brain" as a private, TEXT-ONLY ElevenLabs agent (alternative to the Anthropic API).
//
// Why: avoids a second AI provider/account. Uses the existing ElevenLabs subscription.
// Protocol (documented WebSocket API): conversation_initiation_client_data -> contextual_update ->
// user_message (Mohammed's actual words) -> agent_response (Khalid's JSON reply). ping -> pong.
// The Khalid agent must be created with chat (text-only) mode ON, an EMPTY first message,
// no tools, and the prompt in khalid-agent-prompt.md. It never receives or produces audio here;
// Khalid's voice is still synthesized separately by speakKhalid (approved voice only).
import { fail } from '../config.mjs';
import { OPENING, validateReply } from './khalid.mjs';

// LLMs sometimes wrap JSON in a Markdown fence (observed in the first real run: ```json … ```).
// Accept exactly one JSON object, optionally fenced; anything else is still rejected.
// The platform may prefix the agent's output with an EMPTY retrieval notice even though Khalid has no KB
// (observed 2026-10-11, conv_1801m4n4…). Only that exact empty block, only at the very start, is removed;
// a non-empty retrieval block or any other prefix still fails the strict single-JSON-object parse.
const EMPTY_RETRIEVAL_PREFIX = /^<retrieved-knowledge-base>\s*No documents retrieved for this message\.\s*<\/retrieved-knowledge-base>\s*/;
export function parseReply(text) {
  if (typeof text !== 'string') throw Error('not_text');
  const body = text.trim().replace(EMPTY_RETRIEVAL_PREFIX, '');
  const m = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(m ? m[1] : body);
}

export class KhalidAgentBrain {
  // onEvent(type): optional diagnostics hook. Receives ONLY the event type string (never message content).
  // opening: the caller persona's fixed first line, given as context (default: Khalid's, unchanged behaviour).
  constructor({ signedUrl, WebSocketImpl = globalThis.WebSocket, timeoutMs = 20_000, onEvent = null, opening = OPENING }) {
    this.signedUrl = signedUrl; this.WS = WebSocketImpl; this.timeoutMs = timeoutMs; this.onEvent = onEvent; this.opening = opening;
    this.socket = null; this.waiter = null; this.closed = false; this.lastSentMohammed = 0;
    this.conversationId = null; this.requestCount = 0;
  }
  open() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.signedUrl);
      if (url.protocol !== 'wss:' || url.hostname !== 'api.elevenlabs.io') return reject(fail('invalid_upstream_url'));
      const ws = new this.WS(this.signedUrl); this.socket = ws;
      const timer = setTimeout(() => reject(fail('khalid_agent_connect_timeout', 504)), this.timeoutMs);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' })));
      ws.addEventListener('message', (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { this.report('unparseable_event'); return this.fault('khalid_agent_protocol'); }
        if (msg.type !== 'ping') this.report(typeof msg.type === 'string' ? msg.type : 'unknown_event');
        if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
        if (msg.type === 'conversation_initiation_metadata') {
          this.conversationId = msg.conversation_initiation_metadata_event?.conversation_id || null;
          clearTimeout(timer);
          // The opening is fixed and already spoken; give it to Khalid as context, not as a turn.
          ws.send(JSON.stringify({ type: 'contextual_update', text: `Your opening line, already said aloud to Mohammed: "${this.opening}". Continue from there.` }));
          return resolve();
        }
        if (['client_tool_call', 'agent_tool_request', 'mcp_tool_call'].includes(msg.type)) return this.fault('khalid_agent_tool_forbidden');
        if (msg.type === 'audio') return this.fault('khalid_agent_must_be_text_only');
        if (msg.type === 'agent_response' && this.waiter) {
          const text = msg.agent_response_event?.agent_response;
          const w = this.waiter; this.waiter = null; clearTimeout(w.timer);
          try { w.resolve(parseReply(text)); } catch { w.reject(fail('invalid_khalid_reply', 502)); }
        }
        // A completion marker without a response body is a failed text turn, not a reason
        // to leave the caller waiting for the full request timeout/session cap.
        if (msg.type === 'agent_response_complete' && this.waiter) this.fault('khalid_agent_response_missing');
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(fail('khalid_agent_connection_failed', 502)); this.fault('khalid_agent_connection_failed'); });
      ws.addEventListener('close', () => this.fault('khalid_agent_closed'));
    });
  }
  // Diagnostics never affect the conversation: a failing hook is ignored. Type names are length-limited.
  report(type) {
    try { this.onEvent?.(String(type).replace(/[^a-z0-9_]/gi, '').slice(0, 48) || 'unknown_event'); } catch { /* diagnostics only */ }
  }
  fault(code) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.reject(fail(code, 502)); }
  }
  // Same contract as generateKhalid(env, history, emotion, signal) -> { text, emotion }.
  async reply(history, emotion, signal) {
    if (this.closed || !this.socket || this.socket.readyState !== 1) throw fail('khalid_agent_unavailable', 502);
    if (this.waiter) throw fail('khalid_agent_busy', 409);
    // Send only Mohammed lines Khalid has not seen yet (actual agent transcript, treated as data).
    const fresh = history.filter((m) => m.role === 'agent').slice(this.lastSentMohammed);
    if (!fresh.length) throw fail('nothing_to_reply_to', 409);
    this.lastSentMohammed += fresh.length;
    this.requestCount++;
    const payload = { mohammed_said: fresh.map((m) => m.text).join(' '), your_current_emotion: emotion };
    const raw = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(fail('khalid_agent_timeout', 504)); }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
      signal?.addEventListener('abort', () => this.fault('aborted'), { once: true });
      this.socket.send(JSON.stringify({ type: 'user_message', text: JSON.stringify(payload) }));
    });
    // A single comforting response is not enough to make a newly crashed driver sound calm.
    // Keep the first three dynamic customer replies stressed; prompt-level readiness still governs after that.
    return validateReply(raw, emotion, { allowCalming: this.requestCount >= 4 });
  }
  close() {
    if (this.closed) return; this.closed = true; this.fault('closed');
    try { this.socket?.close(1000, 'demo stopped'); } catch { /* not open */ }
  }
}
