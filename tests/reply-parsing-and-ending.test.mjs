// Regression tests (offline): Khalid reply parsing, dialect drift, and natural completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, KhalidAgentBrain } from '../server/simulator/khalid-agent.mjs';
import { validateReply } from '../server/simulator/khalid.mjs';
import { reviewTranscript } from '../server/simulator/realism.mjs';
import { SimulationSession } from '../server/simulator/session.mjs';
import { PLAN } from '../scripts/record-conversation.mjs';

const JSON_REPLY = '{"text":"تمام، أبقى بعيد عنه. بس أنا الحين في السيارة، وش أدور بالضبط؟ الورقة بتاعة التأمين وين تكون عادة؟","emotion":"STRESSED","done":false}';
// Exact raw agent output from the failed run.
const FAILED_RAW = `<retrieved-knowledge-base>\nNo documents retrieved for this message.\n</retrieved-knowledge-base>\n\n${JSON_REPLY}`;

test('parse: the exact failed reply now parses to the same validated reply', () => {
  const r = validateReply(parseReply(FAILED_RAW), 'STRESSED');
  assert.equal(r.emotion, 'STRESSED');
  assert.equal(r.done, false);
  assert.match(r.text, /^تمام، أبقى بعيد عنه/);
});

test('parse: plain JSON and fenced JSON still work unchanged', () => {
  assert.deepEqual(parseReply(JSON_REPLY), JSON.parse(JSON_REPLY));
  assert.deepEqual(parseReply('```json\n' + JSON_REPLY + '\n```'), JSON.parse(JSON_REPLY));
  assert.deepEqual(parseReply(`<retrieved-knowledge-base>\nNo documents retrieved for this message.\n</retrieved-knowledge-base>\n\`\`\`json\n${JSON_REPLY}\n\`\`\``), JSON.parse(JSON_REPLY));
});

test('parse: non-empty retrieval blocks, other prefixes and malformed replies are still rejected', () => {
  for (const bad of [
    `<retrieved-knowledge-base>\nSome retrieved document text\n</retrieved-knowledge-base>\n${JSON_REPLY}`,   // non-empty block
    `<retrieved-knowledge-base>\nNo documents retrieved for this message.\n</retrieved-knowledge-base>\nextra ${JSON_REPLY}`, // extra prefix
    `Sure! ${JSON_REPLY}`,                                                                                     // unexpected prefix
    `${JSON_REPLY}\n<retrieved-knowledge-base>\nNo documents retrieved for this message.\n</retrieved-knowledge-base>`, // block not at start
    '{"text":"ناقص"',                                                                                         // malformed JSON
    `${JSON_REPLY}${JSON_REPLY}`,                                                                              // two objects
  ]) assert.throws(() => parseReply(bad), undefined, bad.slice(0, 40));
  assert.throws(() => parseReply(undefined), /not_text/);
});

test('parse: text validation is unchanged after prefix removal (digits/symbols still rejected)', () => {
  const withDigits = FAILED_RAW.replace('وش أدور بالضبط؟', 'رقمي 0500');
  assert.throws(() => validateReply(parseReply(withDigits), 'STRESSED'), /unsafe_khalid_reply/);
});

test('dialect_drift flags «بتاع…» for both speakers and ignores Saudi forms', () => {
  const cues = [
    { id: 0, speaker: 'agent', text: 'اتصل على شركة التأمين بتاعتك.', start: 0, end: 2 },
    { id: 1, speaker: 'customer', text: 'الورقة بتاعة التأمين وين تكون؟', start: 2.3, end: 4 },
    { id: 2, speaker: 'agent', text: 'شوف الأوراق حقتك، وتأكد من شركة التأمين حقك.', start: 4.3, end: 6 },
  ];
  const drift = reviewTranscript(cues).issues.filter((i) => i.rule === 'dialect_drift');
  assert.deepEqual(drift.map((i) => i.id), [0, 1]);
  assert.match(drift[0].detail, /بتاعتك \(agent\) → حق/);
  assert.match(drift[1].detail, /بتاعة \(customer\)/);
});

// ---- Natural completion (no scripted ending, no fabricated turns) ----
function harness(replies) {
  const events = [];
  const session = new SimulationSession({
    socket: { readyState: 1, send() {}, close() {} }, emit: (e) => events.push(e),
    timers: { setInterval: () => 1, clearInterval() {}, setTimeout: () => 7, clearTimeout() {} }, sleep: async () => {},
    reply: async () => replies.shift(), tts: async () => Buffer.alloc(640),
    limits: { duration: PLAN.maxSeconds * 1000, turns: PLAN.maxUtterances, turnTimeout: PLAN.turnTimeoutMs },
  });
  session.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } });
  return { session, events };
}
const mohammedTurn = async (h, id) => {
  h.session.message({ type: 'agent_response', agent_response_event: { event_id: id, agent_response: 'رد محمد الحقيقي' } });
  h.session.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(640).toString('base64') } });
  h.session.message({ type: 'agent_response_complete' });
  await h.session.acknowledge(h.session.awaiting);
};

test('gradual progression: early calm is held back, relief needs calm first, done needs calm', () => {
  assert.equal(validateReply({ text: 'طيب', emotion: 'CALMING_DOWN' }, 'STRESSED', { allowCalming: false }).emotion, 'STRESSED');
  assert.equal(validateReply({ text: 'طيب', emotion: 'RELIEVED', done: true }, 'STRESSED').emotion, 'CALMING_DOWN');
  assert.equal(validateReply({ text: 'طيب', emotion: 'STRESSED', done: true }, 'STRESSED').done, false);
  assert.equal(validateReply({ text: 'فهمت، الله يعطيك العافية', emotion: 'RELIEVED', done: true }, 'CALMING_DOWN').done, true);
});

test('brain: calming is only allowed from the fourth generated reply', async () => {
  const replies = ['STRESSED', 'CALMING_DOWN', 'CALMING_DOWN', 'CALMING_DOWN'];
  class WS { constructor() { this.readyState = 0; this.l = {}; queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); } emit(t, d) { for (const f of this.l[t] || []) f(d === undefined ? {} : { data: JSON.stringify(d) }); }
    send(s) { const m = JSON.parse(s); if (m.type === 'conversation_initiation_client_data') this.emit('message', { type: 'conversation_initiation_metadata' });
      if (m.type === 'user_message') this.emit('message', { type: 'agent_response', agent_response_event: { agent_response: JSON.stringify({ text: 'طيب وش أسوي؟', emotion: replies.shift() }) } }); }
    close() {} }
  const brain = new KhalidAgentBrain({ signedUrl: 'wss://api.elevenlabs.io/x', WebSocketImpl: WS });
  await brain.open();
  const got = [];
  for (let i = 1; i <= 4; i++) got.push((await brain.reply([{ role: 'agent', text: `سطر ${i}` }].concat(Array(i - 1).fill({ role: 'agent', text: 'x' })), 'STRESSED')).emotion);
  assert.deepEqual(got, ['STRESSED', 'STRESSED', 'STRESSED', 'CALMING_DOWN']);
  brain.close();
});

test('natural completion: full stress → calm → goodbye fits inside the approved caps and ends naturally', async () => {
  const h = harness([
    { text: 'ما فيه إصابات، بس وش أسوي الحين؟', emotion: 'STRESSED', done: false },
    { text: 'إيه تأميني ساري، بس الرجال معصّب.', emotion: 'STRESSED', done: false },
    { text: 'طيب، وين أبلغ؟', emotion: 'STRESSED', done: false },
    { text: 'زين، فهمت الخطوة الجاية.', emotion: 'CALMING_DOWN', done: false },
    { text: 'خلاص فهمت عليك، الله يعطيك العافية.', emotion: 'RELIEVED', done: true },
  ]);
  for (let id = 1; id <= 6; id++) await mohammedTurn(h, id); // greeting + 5 Mohammed answers, each followed by Khalid
  assert.equal(h.session.khalidDone, true);
  await mohammedTurn(h, 7);                                    // Mohammed's genuine closing reply
  assert.equal(h.events.at(-1).reason, 'natural_end');
  assert.ok(h.session.turns <= PLAN.maxUtterances, `${h.session.turns} utterances within cap ${PLAN.maxUtterances}`);
});

test('no fabricated ending: if Khalid never closes, the session stops on a cap, not "natural_end"', async () => {
  const h = harness(Array.from({ length: 10 }, () => ({ text: 'طيب وبعدين؟', emotion: 'STRESSED', done: false })));
  for (let id = 1; id <= 12 && !h.session.closed; id++) await mohammedTurn(h, id);
  const stop = h.events.findLast((e) => e.type === 'stopped');
  assert.equal(stop.reason, 'turn_limit');
  assert.notEqual(stop.reason, 'natural_end');
});
