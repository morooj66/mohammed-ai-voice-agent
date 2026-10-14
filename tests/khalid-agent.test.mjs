// KhalidAgentBrain with a fake WebSocket (offline). Validates protocol handling only — NOT a real ElevenLabs session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KhalidAgentBrain } from '../server/simulator/khalid-agent.mjs';

function fakeWS(script) {
  return class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = {}; FakeWS.last = this; queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    emit(t, data) { for (const f of this.listeners[t] || []) f(data === undefined ? {} : { data: JSON.stringify(data) }); }
    send(s) { const m = JSON.parse(s); this.sent.push(m); script(this, m); }
    close() { this.readyState = 3; }
  };
}
const URL_OK = 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=x&conversation_signature=y';
const agentReply = (ws, text) => ws.emit('message', { type: 'agent_response', agent_response_event: { event_id: 1, response_id: 'r', agent_response: text } });

test('opens, answers ping, sends opening as context, and returns validated Khalid JSON', async () => {
  const WS = fakeWS((ws, m) => {
    if (m.type === 'conversation_initiation_client_data') { ws.emit('message', { type: 'ping', ping_event: { event_id: 5 } }); ws.emit('message', { type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'conv-khalid' } }); }
    if (m.type === 'user_message') agentReply(ws, JSON.stringify({ text: 'الحمد لله ما فيه إصابات، بس الرجال الثاني معصّب.', emotion: 'STRESSED' }));
  });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS });
  await brain.open();
  assert.equal(brain.conversationId, 'conv-khalid');
  const ws = WS.last;
  assert.ok(ws.sent.some((m) => m.type === 'pong' && m.event_id === 5));
  assert.ok(ws.sent.some((m) => m.type === 'contextual_update' && m.text.includes('ألو')));
  const history = [{ id: 'agent-1', role: 'agent', text: 'حياك الله' }, { id: 'user-1', role: 'user', text: 'ألو' }, { id: 'agent-2', role: 'agent', text: 'فيه أحد مصاب؟' }];
  const reply = await brain.reply(history, 'STRESSED');
  assert.equal(brain.requestCount, 1);
  assert.equal(reply.emotion, 'STRESSED');
  const sent = JSON.parse(ws.sent.find((m) => m.type === 'user_message').text);
  assert.equal(sent.mohammed_said, 'حياك الله فيه أحد مصاب؟');
  brain.close();
});

test('only NEW Mohammed lines are sent on later turns', async () => {
  const WS = fakeWS((ws, m) => {
    if (m.type === 'conversation_initiation_client_data') ws.emit('message', { type: 'conversation_initiation_metadata' });
    if (m.type === 'user_message') agentReply(ws, JSON.stringify({ text: 'طيب وضّح لي وش أسوي؟', emotion: 'CONFUSED' }));
  });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS }); await brain.open();
  const h = [{ role: 'agent', text: 'أ' }];
  await brain.reply(h, 'STRESSED');
  h.push({ role: 'user', text: 'x' }, { role: 'agent', text: 'ب' });
  await brain.reply(h, 'CONFUSED');
  const msgs = WS.last.sent.filter((m) => m.type === 'user_message').map((m) => JSON.parse(m.text).mohammed_said);
  assert.deepEqual(msgs, ['أ', 'ب']);
  brain.close();
});

test('tools or audio from the Khalid agent fail closed; invalid JSON and digits are rejected', async () => {
  for (const [event, err] of [[{ type: 'client_tool_call', client_tool_call: {} }, /tool_forbidden/], [{ type: 'audio', audio_event: {} }, /text_only/]]) {
    const WS = fakeWS((ws, m) => {
      if (m.type === 'conversation_initiation_client_data') ws.emit('message', { type: 'conversation_initiation_metadata' });
      if (m.type === 'user_message') ws.emit('message', event);
    });
    const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS }); await brain.open();
    await assert.rejects(brain.reply([{ role: 'agent', text: 'أ' }], 'STRESSED'), err);
    brain.close();
  }
  for (const bad of ['not json', JSON.stringify({ text: 'رقمي 0500', emotion: 'STRESSED' })]) {
    const WS = fakeWS((ws, m) => {
      if (m.type === 'conversation_initiation_client_data') ws.emit('message', { type: 'conversation_initiation_metadata' });
      if (m.type === 'user_message') agentReply(ws, bad);
    });
    const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS }); await brain.open();
    await assert.rejects(brain.reply([{ role: 'agent', text: 'أ' }], 'STRESSED'), /invalid_khalid_reply|unsafe_khalid_reply/);
    brain.close();
  }
});

test('non-ElevenLabs URLs are refused and silent agents time out', async () => {
  await assert.rejects(new KhalidAgentBrain({ signedUrl: 'wss://evil.example/x', WebSocketImpl: fakeWS(() => {}) }).open(), /invalid_upstream_url/);
  const WS = fakeWS((ws, m) => { if (m.type === 'conversation_initiation_client_data') ws.emit('message', { type: 'conversation_initiation_metadata' }); });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS, timeoutMs: 30 }); await brain.open();
  await assert.rejects(brain.reply([{ role: 'agent', text: 'أ' }], 'STRESSED'), /khalid_agent_timeout/);
  brain.close();
});

test('fenced JSON (```json … ```) from the agent is accepted; other wrappers are not', async () => {
  const { parseReply } = await import('../server/simulator/khalid-agent.mjs');
  const body = { text: 'الحمد لله ما فيه إصابات', emotion: 'STRESSED' };
  assert.deepEqual(parseReply('```json\n' + JSON.stringify(body, null, 2) + '\n```'), body);
  assert.deepEqual(parseReply('```\n' + JSON.stringify(body) + '\n```'), body);
  assert.throws(() => parseReply('Sure! ' + JSON.stringify(body)));
});

test('Khalid cannot calm down on his first reply to Mohammed reassurance', async () => {
  const WS = fakeWS((ws, m) => {
    if (m.type === 'conversation_initiation_client_data') ws.emit('message', { type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'conv-stress' } });
    if (m.type === 'user_message') agentReply(ws, JSON.stringify({ text: 'طيب فهمت، يعطيك العافية', emotion: 'RELIEVED', done: false }));
  });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS }); await brain.open();
  const reply = await brain.reply([{ role: 'agent', text: 'الحمد لله إنك بخير، أنا معك.' }], 'STRESSED');
  assert.equal(reply.emotion, 'STRESSED');
  brain.close();
});

test('Khalid cannot ease from stress until at least the fourth generated response', async () => {
  let generated = 0;
  const WS = fakeWS((ws, m) => {
    if (m.type === 'conversation_initiation_client_data') ws.emit('message', { type: 'conversation_initiation_metadata' });
    if (m.type === 'user_message') {
      generated++;
      agentReply(ws, JSON.stringify({ text: 'زين، فهمت وش أسوي الحين.', emotion: 'CALMING_DOWN' }));
    }
  });
  const brain = new KhalidAgentBrain({ signedUrl: URL_OK, WebSocketImpl: WS }); await brain.open();
  const history = [];
  for (let i = 1; i <= 4; i++) {
    history.push({ role: 'agent', text: `رد محمد ${i}` });
    const reply = await brain.reply(history, 'STRESSED');
    assert.equal(reply.emotion, i < 4 ? 'STRESSED' : 'CALMING_DOWN');
    history.push({ role: 'user', text: reply.text });
  }
  brain.close();
});

test('local proposal preserves verified published facts and requires a dynamic customer close', async () => {
  const { readFileSync } = await import('node:fs');
  const prompt = readFileSync(new URL('../server/simulator/khalid-agent-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /derived from verified published v3; local proposal only/);
  assert.match(prompt, /about 6\/10/);
  assert.match(prompt, /through at least your first three replies/);
  assert.match(prompt, /one reassuring response does not calm you/);
  assert.match(prompt, /through at least your first three replies/);
  assert.match(prompt, /Avoid dialect drift and unnatural forms/);
  assert.match(prompt, /never talk over him/i);
  assert.match(prompt, /Never jump straight to CALMING_DOWN or RELIEVED/);
  assert.match(prompt, /set done=true/);
  assert.doesNotMatch(prompt, /Both cars are stopped safely on the side|wants you to pay him money right now|You have a dashcam|You have active motor insurance/);
});
