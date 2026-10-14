// Khalid TTS timing + bounded retry, with SIMULATED delays/failures only (no network, no paid API).
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamDialoguePcm, streamWithOneRetry, TTS_TIMING } from '../server/simulator/khalid.mjs';

const err = (message, receivedAudio = false) => Object.assign(new Error(message), { receivedAudio });
const OPTS = { apiKey: 'test-only', voiceId: 'v', text: 'ألو', format: 'pcm_24000' };

// Fake Text-to-Dialogue socket: sends `chunks` audio messages every `gapMs`, then is_final (unless stall).
function fakeTTS({ firstDelayMs = 0, gapMs = 5, chunks = 2, final = true }) {
  return class FakeWS {
    constructor() { this.l = {}; setTimeout(() => this.emit('open'), 0); }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    emit(t, data) { for (const f of this.l[t] || []) f(data === undefined ? {} : { data: JSON.stringify(data) }); }
    send(s) {
      if (!JSON.parse(s).close_socket) return;
      for (let i = 0; i < chunks; i++) setTimeout(() => this.emit('message', { audio: Buffer.from([1, 0, 2, 0]).toString('base64') }), firstDelayMs + i * gapMs);
      if (final) setTimeout(() => this.emit('message', { is_final: true }), firstDelayMs + chunks * gapMs + 1);
    }
    close() {}
  };
}

test('approved budget fits inside the 35 s turn timeout', () => {
  assert.equal(TTS_TIMING.totalMs, 30_000);
  assert.ok(TTS_TIMING.firstAudioMs < TTS_TIMING.totalMs && TTS_TIMING.totalMs < 35_000);
});

test('stream: no audio at all -> tts_first_audio_timeout with receivedAudio=false', async () => {
  const WS = fakeTTS({ firstDelayMs: 200 });
  await assert.rejects(streamDialoguePcm({ ...OPTS, WebSocketImpl: WS, timeoutMs: 150, firstAudioTimeoutMs: 30 }),
    (e) => e.message === 'tts_first_audio_timeout' && e.receivedAudio === false);
});

test('stream: slow but already streaming audio is NOT cut by the first-audio timer; total timeout marks receivedAudio=true', async () => {
  const slowOk = await streamDialoguePcm({ ...OPTS, WebSocketImpl: fakeTTS({ firstDelayMs: 10, gapMs: 30, chunks: 3 }), timeoutMs: 300, firstAudioTimeoutMs: 20 });
  assert.equal(slowOk.length, 12); // 3 chunks x 4 bytes, delivered once
  await assert.rejects(streamDialoguePcm({ ...OPTS, WebSocketImpl: fakeTTS({ firstDelayMs: 5, chunks: 1, final: false }), timeoutMs: 60, firstAudioTimeoutMs: 30 }),
    (e) => e.message === 'tts_stream_timeout' && e.receivedAudio === true);
});

test('default stream behaviour unchanged when no first-audio timeout is given', async () => {
  const pcm = await streamDialoguePcm({ ...OPTS, WebSocketImpl: fakeTTS({ firstDelayMs: 40 }), timeoutMs: 500 });
  assert.equal(pcm.length, 8);
});

const timing = { totalMs: 1000, firstAudioMs: 300, minRetryMs: 200 };
function clock(start = 0) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }

test('retry: exactly ONE retry after a stalled (no-audio) attempt; the result is used once', async () => {
  const c = clock(); const calls = []; const retries = [];
  const stream = async (o) => { calls.push(o); if (calls.length === 1) { c.advance(300); throw err('tts_first_audio_timeout'); } return Buffer.from([7, 0]); };
  const pcm = await streamWithOneRetry(OPTS, { timing, now: c.now, stream, onRetry: (r) => retries.push(r) });
  assert.deepEqual([...pcm], [7, 0]);
  assert.equal(calls.length, 2);
  assert.deepEqual(retries, ['tts_first_audio_timeout']);
  assert.equal(calls[1].timeoutMs, 700); // remaining budget, never beyond the total
});

test('retry: never after audio was received, never for non-transient errors, never when aborted or out of budget', async () => {
  for (const [label, error, advance, aborted] of [
    ['partial audio', err('tts_stream_timeout', true), 300, false],
    ['partial audio closed', err('tts_stream_closed', true), 100, false],
    ['invalid audio', err('invalid_tts_audio'), 100, false],
    ['auth/approval', err('voice_approval_required'), 100, false],
    ['aborted', err('tts_stream_failed'), 100, true],
    ['budget too small', err('tts_first_audio_timeout'), 900, false],
  ]) {
    const c = clock(); let calls = 0;
    const ac = new AbortController(); if (aborted) ac.abort();
    const stream = async () => { calls++; c.advance(advance); throw error; };
    await assert.rejects(streamWithOneRetry({ ...OPTS, signal: ac.signal }, { timing, now: c.now, stream }), (e) => e === error, label);
    assert.equal(calls, 1, `${label}: no retry`);
  }
});

test('retry: a second failure is final (at most one retry)', async () => {
  const c = clock(); let calls = 0;
  const stream = async () => { calls++; c.advance(100); throw err('tts_stream_failed'); };
  await assert.rejects(streamWithOneRetry(OPTS, { timing, now: c.now, stream }), /tts_stream_failed/);
  assert.equal(calls, 2);
});
