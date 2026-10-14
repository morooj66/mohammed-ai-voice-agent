// Regression tests for PCMPlayer defects found during takeover (2026-10-10):
// 1) analysers were never connected to recordDestination -> silent recordings
// 2) stopPlayback() kept a stale nextTime -> post-stop audio scheduled in the future
// 3) queue-limit check ran after mutating nextTime -> inconsistent schedule on rejection
import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMPlayer } from '../src/lib/pcm-player.js';

class Context {
  constructor() { this.currentTime = 0; this.state = 'running'; this.sources = []; this.analyserList = []; }
  createAnalyser() { const a = { targets: [], connect(t) { this.targets.push(t); }, disconnect() {}, getByteTimeDomainData(d) { d.fill(128); } }; this.analyserList.push(a); return a; }
  createMediaStreamDestination() { return { kind: 'record', stream: { getTracks() { return []; } }, disconnect() {} }; }
  get destination() { return { kind: 'speakers' }; }
  createBuffer(_, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
  createBufferSource() { const s = { connect() {}, disconnect() {}, start(t) { s.startAt = t; }, stop() { s.stopped = true; } }; this.sources.push(s); return s; }
  async resume() {} async close() { this.state = 'closed'; }
}
const chunk = (seconds) => Buffer.alloc(Math.round(16000 * seconds) * 2).toString('base64');

test('every analyser feeds BOTH the speakers and the recording destination', async () => {
  const player = new PCMPlayer(() => {}, Context); await player.resume();
  assert.equal(player.context.analyserList.length, 2);
  for (const a of player.context.analyserList) {
    assert.ok(a.targets.some((t) => t.kind === 'speakers'), 'analyser must reach the speakers');
    assert.ok(a.targets.includes(player.recordDestination), 'analyser must reach the recorder');
  }
  player.close();
});

test('stopPlayback resets the schedule so new audio starts now, not at a stale time', async () => {
  const player = new PCMPlayer(() => {}, Context); await player.resume();
  player.add(chunk(10), 'pcm_16000', 'agent');
  assert.ok(player.nextTime > 9);
  player.stopPlayback();
  assert.equal(player.nextTime, 0);
  player.add(chunk(0.5), 'pcm_16000', 'agent');
  const last = player.context.sources.at(-1);
  assert.ok(last.startAt < 1, `expected immediate start, got ${last.startAt}`);
  player.close();
});

test('a chunk rejected by the queue limit leaves the schedule unchanged', async () => {
  const player = new PCMPlayer(() => {}, Context); await player.resume();
  player.add(chunk(30), 'pcm_16000', 'agent');
  const before = player.nextTime;
  assert.throws(() => player.add(chunk(10), 'pcm_16000', 'agent'), /audio_queue_limit/);
  assert.equal(player.nextTime, before);
  assert.equal(player.sources.size, 1);
  player.close();
});
