// Diagnostics hook on KhalidAgentBrain, with SYNTHETIC events only (fake WebSocket, offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KhalidAgentBrain } from '../server/simulator/khalid-agent.mjs';

const URL_OK = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=x&conversation_signature=y';
const SECRET_TEXT = 'PRIVATE-PROMPT-AND-MESSAGE-CONTENT';
function fakeWS(script) {
  return class FakeWS {
    constructor() { this.readyState = 0; this.sent = []; this.listeners = {}; FakeWS.last = this; queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    emit(t, data) { for (const f of this.listeners[t] || []) f(data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) }); }
    send(s) { const m = JSON.parse(s); this.sent.push(m); script(this, m); }
    close() { this.readyState = 3; }
  };
}
const init = (ws, m) => { if (m.type === 'conversation_initiation_client_data') { ws.emit('message', { type: 'ping', ping_event: { event_id: 1 } }); ws.emit('message', { type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: SECRET_TEXT } }); } };
const history = [{ role: 'agent', text: 'حياك الله' }, { role: 'agent', text: 'فيه أحد مصاب؟' }];

test('reports event TYPES only (no content), skips ping, and keeps the reply unchanged', async () => {
  const events = [];
  const WS = fakeWS((ws, m) => {
    init(ws, m);
    if (m.type === 'user_message') {
      ws.emit('message', { type: 'agent_chat_response_part', text_response_part: { text: SECRET_TEXT } });
      ws.emit('message', { type: 'agent_response', agent_response_event: { agent_response: JSON.stringify({ text: 'الحمد لله ما فيه إصابات، بس أنا متوتر.', emotion: 'STRESSED', done: false }) } });
    }
  });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS, onEvent: (t) => events.push(t) });
  await brain.open();
  const reply = await brain.reply(history, 'STRESSED');
  assert.equal(reply.emotion, 'STRESSED');                                    // behaviour unchanged
  assert.deepEqual(events, ['conversation_initiation_metadata', 'agent_chat_response_part', 'agent_response']);
  assert.ok(!events.join(' ').includes(SECRET_TEXT), 'no message content or ids leak into diagnostics');
  assert.ok(!events.includes('ping'));
  brain.close();
});

test('no-reply case: events before the timeout are visible; timeout and error code unchanged', async () => {
  const events = [];
  const WS = fakeWS((ws, m) => { init(ws, m); if (m.type === 'user_message') ws.emit('message', { type: 'internal_tentative_agent_response' }); });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS, timeoutMs: 30, onEvent: (t) => events.push(t) });
  await brain.open();
  await assert.rejects(brain.reply(history, 'STRESSED'), /khalid_agent_timeout/);
  assert.deepEqual(events, ['conversation_initiation_metadata', 'internal_tentative_agent_response']);
  brain.close();
});

test('agent_response_complete without agent_response fails the pending caller turn immediately', async () => {
  const events = [];
  const WS = fakeWS((ws, m) => {
    init(ws, m);
    if (m.type === 'user_message') ws.emit('message', { type: 'agent_response_complete' });
  });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS, timeoutMs: 10_000, onEvent: (t) => events.push(t) });
  await brain.open();
  const started = Date.now();
  await assert.rejects(brain.reply(history, 'STRESSED'), /khalid_agent_response_missing/);
  assert.ok(Date.now() - started < 1000, 'does not wait for the 10-second response timeout');
  assert.deepEqual(events, ['conversation_initiation_metadata', 'agent_response_complete']);
  brain.close();
});

test('unparseable or odd events are reported safely; a throwing hook never breaks the conversation', async () => {
  const events = [];
  const WS = fakeWS((ws, m) => { init(ws, m); if (m.type === 'user_message') { ws.emit('message', { type: `x${SECRET_TEXT}<script>`.repeat(3) }); ws.emit('message', { type: 'agent_response', agent_response_event: { agent_response: JSON.stringify({ text: 'طيب وش أسوي الحين؟', emotion: 'STRESSED' }) } }); } });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS, onEvent: (t) => { events.push(t); throw Error('hook failure'); } });
  await brain.open();
  assert.equal((await brain.reply(history, 'STRESSED')).emotion, 'STRESSED');
  assert.ok(events.every((t) => /^[A-Za-z0-9_]{1,48}$/.test(t)), 'types are sanitized and length-limited');
  WS.last.emit('message', 'not json');
  assert.equal(events.at(-1), 'unparseable_event');
  brain.close();
});

test('default behaviour without a hook is unchanged (20 s timeout) and the recorder wires types into the trace', () => {
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: fakeWS(() => {}) });
  assert.equal(brain.timeoutMs, 20_000);
  assert.equal(brain.onEvent, null);
  const runner = readFileSync(new URL('../scripts/record-conversation.mjs', import.meta.url), 'utf8');
  // Event names are per caller persona (`khalid_event_*` for Khalid, unchanged; `raj_event_*` for Raj).
  assert.match(runner, /mark\(`\$\{persona\.id\}_event_\$\{type\}`\)/);
  assert.match(runner, /mark\(`\$\{persona\.id\}_brain_\$\{type === 'agent_response' \? 'response' : 'response_complete'\}`\)/);
  assert.match(runner, /traceStarted = true/);
});
