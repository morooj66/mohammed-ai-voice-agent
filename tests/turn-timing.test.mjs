// Turn-taking timing (offline, fake sockets/timers). Validates orchestration only — not a real session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationSession } from '../server/simulator/session.mjs';

function harness(options = {}) {
  const sent = [], events = [], calls = []; let timeout = null;
  const timers = { setInterval: () => 1, clearInterval() {}, setTimeout: (f) => { timeout = f; return 7; }, clearTimeout: () => { timeout = null; } };
  const session = new SimulationSession({
    socket: { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} }, emit: (e) => events.push(e), timers, sleep: async () => {},
    reply: async () => { calls.push('reply'); return { text: 'لا الحمد لله، ما فيه أحد مصاب', emotion: 'STRESSED' }; },
    tts: async () => { calls.push('tts'); return Buffer.alloc(640); }, ...options,
  });
  session.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } });
  return { session, sent, events, calls, fire: () => { const f = timeout; timeout = null; f?.(); } };
}
const agentTurn = (h, id, complete = true) => {
  h.session.message({ type: 'agent_response', agent_response_event: { event_id: id, agent_response: 'فيه أحد مصاب؟' } });
  h.session.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(640).toString('base64') } });
  if (complete) h.session.message({ type: 'agent_response_complete' });
};
const flush = () => new Promise((r) => setImmediate(r));

test('prefetch: Khalid prepares while Mohammed is still playing, but speaks only after the playback ack', async () => {
  const h = harness({ prefetch: true });
  agentTurn(h, 1); await flush();
  assert.deepEqual(h.calls, ['tts']);                                   // opening synthesized during playback
  assert.equal(h.sent.filter((m) => m.user_audio_chunk).length, 0);     // nothing spoken yet
  await h.session.acknowledge(h.session.awaiting);
  assert.equal(h.sent.filter((m) => m.user_audio_chunk).length, 1);
  agentTurn(h, 2); await flush();
  assert.deepEqual(h.calls, ['tts', 'reply', 'tts']);                   // reply + voice prepared before the ack
  await h.session.acknowledge(h.session.awaiting);
  assert.deepEqual(h.calls, ['tts', 'reply', 'tts']);                   // no second generation on ack
  h.session.stop();
});

test('prefetch never spends a generation when the next ack ends the session', async () => {
  const h = harness({ prefetch: true, limits: { duration: 90_000, turns: 1, turnTimeout: 35_000 } });
  agentTurn(h, 1); await flush();
  assert.deepEqual(h.calls, []);
  await h.session.acknowledge(h.session.awaiting);
  assert.equal(h.events.at(-1).reason, 'turn_limit');
});

test('late completion event: fallback completes the turn after quiet audio; the late event is ignored', async () => {
  const h = harness({ completionFallbackMs: 1500 });
  agentTurn(h, 1, false);
  assert.equal(h.session.awaiting, null);
  h.fire();                                                             // 1.5 s without new agent audio
  assert.ok(h.session.awaiting);
  assert.equal(h.events.find((e) => e.type === 'completion').source, 'fallback');
  const barrier = h.session.awaiting;
  h.session.message({ type: 'agent_response_complete' });               // arrives late: no duplicate turn
  assert.equal(h.session.awaiting, barrier);
  await h.session.acknowledge(barrier);
  assert.equal(h.session.turns, 2);
  h.session.stop();
});

test('fallback is fail-closed: more agent audio after it stops the session instead of talking over Mohammed', () => {
  const h = harness({ completionFallbackMs: 1500 });
  agentTurn(h, 1, false); h.fire();
  h.session.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(640).toString('base64') } });
  assert.equal(h.events.at(-1).reason, 'unexpected_audio');
});

test('caller completion without response text ends the pending turn with a specific incomplete reason', async () => {
  const h = harness({ prefetch: true, reply: async () => { throw Error('khalid_agent_response_missing'); } });
  agentTurn(h, 1); await h.session.acknowledge(h.session.awaiting); // opening
  agentTurn(h, 2); await flush();                                  // caller brain fails while Mohammed plays
  await h.session.acknowledge(h.session.awaiting);
  assert.equal(h.events.at(-1).type, 'stopped');
  assert.equal(h.events.at(-1).reason, 'caller_response_missing');
});

test('without the options, behaviour is unchanged (no timers, generation on ack)', async () => {
  const h = harness();
  agentTurn(h, 1); await flush();
  assert.deepEqual(h.calls, []);
  await h.session.acknowledge(h.session.awaiting);
  assert.deepEqual(h.calls, ['tts']);
  h.session.stop();
});

test('pre-generated opening: no TTS call during the conversation for the fixed opening; later lines are live', async () => {
  const pre = Buffer.alloc(960);
  const h = harness({ prefetch: true, openingAudio: { format: 'pcm_24000', audio: pre } });
  agentTurn(h, 1); await flush();
  assert.deepEqual(h.calls, []);                                         // opening already synthesized before the call
  await h.session.acknowledge(h.session.awaiting);
  assert.equal(h.sent.filter((m) => m.user_audio_chunk).length, 1);     // 24 kHz → 16 kHz, sent
  agentTurn(h, 2); await flush();
  assert.deepEqual(h.calls, ['reply', 'tts']);                          // Khalid's next line is generated live
  h.session.stop();
});

test('caller pacing uses 40 ms chunks, compensates timer overhead, and traces audio/ASR/first audio timing', async () => {
  const sent = [], events = [], trace = []; let time = 0;
  const session = new SimulationSession({
    socket: { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} }, emit: (e) => events.push(e),
    now: () => time, timers: { setInterval: () => 1, clearInterval() {} },
    sleep: async (ms) => { time += ms + 1; },
    openingAudio: { format: 'pcm_16000', audio: Buffer.alloc(3200) }, trailingSilenceMs: 0,
    onTrace: (name, data) => trace.push({ name, data }),
    reply: async () => ({ text: 'الحمد لله، ما فيه إصابات', emotion: 'STRESSED' }),
    tts: async () => Buffer.alloc(640),
  });
  session.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } });
  agentTurn({ session }, 1);
  await session.acknowledge(session.awaiting);
  const chunks = sent.filter((m) => m.user_audio_chunk).map((m) => Buffer.from(m.user_audio_chunk, 'base64'));
  assert.deepEqual(chunks.map((c) => c.length), [1280, 1280, 640]); // 40 ms, 40 ms, 20 ms; identical 100 ms PCM
  assert.equal(Buffer.concat(chunks).length, 3200);
  const audioEnd = trace.find((e) => e.name === 'caller_audio_complete').data;
  assert.equal(audioEnd.expectedAudioMs, 100);
  assert.equal(audioEnd.actualPacingMs, 101);
  assert.equal(audioEnd.pacingOverrunMs, 1); // per-sleep +1 ms does not accumulate across chunks
  time += 120;
  session.message({ type: 'user_transcript', user_transcription_event: { user_transcript: 'لا، الحمد لله' } });
  session.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(640).toString('base64') } });
  const asr = trace.find((e) => e.name === 'mohammed_asr_final').data;
  const firstAudio = trace.filter((e) => e.name === 'mohammed_first_audio').at(-1).data;
  assert.equal(asr.msSinceCallerAudioComplete, 120);
  assert.equal(firstAudio.msSinceAsrFinal, 0);
  assert.equal(firstAudio.msSinceCallerAudioComplete, 120);
  session.stop();
});
