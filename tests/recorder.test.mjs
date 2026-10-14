// Server-side recorder: timeline, resampling, cue alignment, WAV output and bridge integration.
// Offline/mock tests only: they validate the recorder logic, not a real ElevenLabs session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRecorder, resample, wavFile, pcmToInt16 } from '../server/simulator/recorder.mjs';
import { SimulationSession } from '../server/simulator/session.mjs';
import { OPENING } from '../server/simulator/khalid.mjs';

const tone = (seconds, rate, value = 1000) => { const b = Buffer.alloc(Math.round(seconds * rate) * 2); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i); return b; };

test('resample keeps duration and WAV header is valid 16-bit mono', () => {
  const src = pcmToInt16(tone(1, 16000));
  const out = resample(src, 16000, 24000);
  assert.ok(Math.abs(out.length - 24000) <= 1);
  const wav = wavFile(out, 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), out.length * 2);
});

test('segments never overlap and cues come from actual sample positions', () => {
  let t = 1000; const r = new ConversationRecorder({ now: () => t, rate: 24000 });
  r.text('agent-1', 'agent', 'حياك الله');
  r.audio('agent', tone(2, 16000), 16000);          // arrives at 0 s, lasts 2 s
  t += 500; r.audio('agent', tone(1, 16000), 16000); // arrives during playback -> queued after it (2..3 s)
  t += 4000;                                          // 4.5 s since start: real gap before Khalid
  r.text('user-1', 'user', 'ألو', 'STRESSED');
  r.audio('user', tone(1.5, 16000), 16000);           // 4.5..6.0 s
  const { duration, transcript, unmatched } = r.build();
  assert.equal(duration, 6);
  assert.deepEqual(transcript.map((c) => [c.speaker, c.start, c.end]), [['agent', 0, 3], ['customer', 4.5, 6]]);
  assert.equal(transcript[1].emotion, 'STRESSED');
  assert.deepEqual(unmatched, { agent: 0, user: 0 });
});

test('audio without transcript is kept but not captioned; nothing recorded refuses to save', () => {
  const r = new ConversationRecorder({ now: () => 0 });
  assert.throws(() => r.save(mkdtempSync(join(tmpdir(), 'rec-')), 'x'), /nothing_recorded/);
  r.audio('agent', tone(1, 16000), 16000);
  const b = r.build();
  assert.equal(b.transcript.length, 0); assert.equal(b.duration, 1);
});

test('bridge integration: recorder captures real agent chunks and Khalid PCM with matching cues', async () => {
  let time = 0;
  const recorder = new ConversationRecorder({ now: () => time });
  const session = new SimulationSession({
    socket: { readyState: 1, send() {}, close() {} }, emit() {}, now: () => time, sleep: async () => {},
    timers: { setInterval: () => 1, clearInterval() {} }, recorder,
    reply: async () => ({ text: 'طيب', emotion: 'CONFUSED' }), tts: async () => tone(1, 16000),
  });
  session.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } });
  session.message({ type: 'agent_response', agent_response_event: { event_id: 1, agent_response: 'حياك الله، معك محمد' } });
  session.message({ type: 'audio', audio_event: { audio_base_64: tone(2, 16000).toString('base64') } });
  session.message({ type: 'agent_response_complete' });
  time = 3000; await session.acknowledge(session.awaiting);
  session.stop();
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const saved = recorder.save(dir, 'demo');
  const meta = JSON.parse(readFileSync(saved.json, 'utf8'));
  assert.deepEqual(meta.transcript.map((c) => [c.speaker, c.text, c.start, c.end]), [['agent', 'حياك الله، معك محمد', 0, 2], ['customer', OPENING, 3, 4]]);
  assert.equal(readFileSync(saved.wav).toString('ascii', 0, 4), 'RIFF');
  assert.equal(meta.duration, 4);
});

test('recordFormat: Khalid is synthesized once at 24 kHz for the recording and downsampled to 16 kHz for sending', async () => {
  let time = 0; const formats = []; let sentBytes = 0;
  const recorder = new ConversationRecorder({ now: () => time });
  const session = new SimulationSession({
    socket: { readyState: 1, send(s) { const m = JSON.parse(s); if (m.user_audio_chunk) sentBytes += Buffer.from(m.user_audio_chunk, 'base64').length; }, close() {} },
    emit() {}, now: () => time, sleep: async () => {}, timers: { setInterval: () => 1, clearInterval() {} }, recorder, recordFormat: 'pcm_24000',
    reply: async () => ({ text: 'طيب', emotion: 'CONFUSED' }), tts: async (text, format) => { formats.push(format); return tone(1, 24000); },
  });
  session.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { user_input_audio_format: 'pcm_16000', agent_output_audio_format: 'pcm_16000' } });
  session.message({ type: 'agent_response', agent_response_event: { event_id: 1, agent_response: 'حياك الله' } });
  session.message({ type: 'audio', audio_event: { audio_base_64: tone(1, 16000).toString('base64') } });
  session.message({ type: 'agent_response_complete' });
  time = 1000; await session.acknowledge(session.awaiting);
  session.stop();
  assert.deepEqual(formats, ['pcm_24000']);           // one TTS call, at the recording rate
  assert.equal(sentBytes, 16000 * 2);                  // 1 s sent to the agent at its 16 kHz input rate
  const b = recorder.build();
  assert.deepEqual(b.transcript.map((c) => [c.speaker, c.start, c.end]), [['agent', 0, 1], ['customer', 1, 2]]);
});

test('audio tags are removed from the spoken transcript but kept as raw', () => {
  assert.equal(ConversationRecorder.spoken('[Empathetically] وعليكم السلام'), 'وعليكم السلام');
  assert.equal(ConversationRecorder.spoken('[stressed, slightly hurried] ألو'), 'ألو');
  const r = new ConversationRecorder({ now: () => 0 });
  r.text('agent-1', 'agent', '[Seriously] أول شي، فيه أحد مصاب؟');
  r.audio('agent', tone(1, 16000), 16000);
  const [cue] = r.build().transcript;
  assert.equal(cue.text, 'أول شي، فيه أحد مصاب؟'); assert.equal(cue.raw, '[Seriously] أول شي، فيه أحد مصاب؟');
});

test('WAV metadata marks safety-limited sessions incomplete and natural endings complete', () => {
  const r = new ConversationRecorder({ now: () => 0 });
  r.text('agent-1', 'agent', 'حياك الله'); r.audio('agent', tone(1, 16000), 16000);
  const dir = mkdtempSync(join(tmpdir(), 'rec-completion-'));
  const partial = r.save(dir, 'partial', { completionReason: 'duration_limit' });
  const complete = r.save(dir, 'complete', { completionReason: 'natural_end' });
  assert.equal(JSON.parse(readFileSync(partial.json, 'utf8')).complete, false);
  assert.equal(JSON.parse(readFileSync(partial.json, 'utf8')).completionReason, 'duration_limit');
  assert.equal(JSON.parse(readFileSync(complete.json, 'utf8')).complete, true);
});

test('recording metadata preserves agent versions and available provider usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-meta-'));
  const r = new ConversationRecorder({ now: () => 1 }); r.audio('agent', Buffer.alloc(640), 24000); r.text('a', 'agent', 'حياك');
  const saved = r.save(dir, 'meta', { completionReason: 'natural_end', metadata: {
    agents: { mohammed: { versionId: 'm-version' }, khalid: { versionId: 'k-version' } },
    apiUsage: { mohammed: { available: true, cost: 12 }, khalidTtsCharacters: 100 },
  } });
  const meta = JSON.parse(readFileSync(saved.json, 'utf8'));
  assert.equal(meta.agents.mohammed.versionId, 'm-version');
  assert.equal(meta.agents.khalid.versionId, 'k-version');
  assert.deepEqual(meta.apiUsage, { mohammed: { available: true, cost: 12 }, khalidTtsCharacters: 100 });
  rmSync(dir, { recursive: true, force: true });
});

test('recording provenance names the selected caller rather than always labeling Khalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caller-provenance-'));
  const r = new ConversationRecorder({ now: () => 1 }); r.audio('agent', Buffer.alloc(640), 24000);
  const saved = r.save(dir, 'um-nasser', { metadata: { caller: { id: 'um_nasser', nameAr: 'أم ناصر' } } });
  const meta = JSON.parse(readFileSync(saved.json, 'utf8'));
  assert.match(meta.provenance, /أم ناصر = simulated customer/);
  assert.doesNotMatch(meta.provenance, /Khalid/);
  rmSync(dir, { recursive: true, force: true });
});
