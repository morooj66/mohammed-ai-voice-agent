// Regression: prerecorded playback must be audible without Web Audio (orb levels come from decoded samples).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { levelsAt } from '../src/lib/audio-levels.js';

test('play() uses the <audio> element directly; the Web Audio graph is created only by the export', () => {
  const src = readFileSync(new URL('../src/hooks/useRecordedDemo.js', import.meta.url), 'utf8');
  const play = src.slice(src.indexOf('const play = useCallback'), src.indexOf('const pause = useCallback'));
  assert.doesNotMatch(play, /ensureGraph|createMediaElementSource|new Ctx|AudioContext/);
  assert.match(play, /audioRef\.current\.play\(\)/);
  const exportFn = src.slice(src.indexOf('const exportVideo = useCallback'));
  assert.match(exportFn, /ensureGraph\(\)/, 'export still captures the original audio');
  assert.equal((src.match(/ensureGraph\(\)/g) || []).length, 1, 'only one caller of ensureGraph (the export)');
  const measure = src.slice(src.indexOf('const measure = useCallback'), src.indexOf('const levelsFor'));
  assert.doesNotMatch(measure, /analyser/);
});

test('levelsAt: silence is zero, speech is non-zero, bounded 0..1, safe at the edges', () => {
  const rate = 24000, n = rate;
  const tone = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 200 * i) / rate));
  const silent = new Float32Array(n);
  assert.deepEqual(levelsAt(silent, rate, 0.5), { output: 0, bass: 0, high: 0 });
  const l = levelsAt(tone, rate, 0.5);
  for (const k of ['output', 'bass', 'high']) assert.ok(l[k] > 0 && l[k] <= 1, k);
  assert.ok(levelsAt(tone, rate, 999).output > 0, 'past the end reads the last window');
  assert.deepEqual(levelsAt(null, rate, 1), { output: 0, bass: 0, high: 0 });
  assert.deepEqual(levelsAt(tone, rate, NaN), { output: 0, bass: 0, high: 0 });
});

test('trimDraft keeps an unchanged prefix, only whole lines, and refuses a cut inside a line', async () => {
  const { trimDraft } = await import('../scripts/trim-draft.mjs');
  const fx = { id: 'draft-x', provenance: 'p', transcript: [{ id: 'a', speaker: 'agent', text: 'x', start: 0, end: 1 }, { id: 'b', speaker: 'customer', text: 'y', start: 1.5, end: 2.5 }] };
  const s = Int16Array.from({ length: 30 }, (_, i) => i + 1);
  const out = trimDraft(fx, s, 10, 1.2, 'draft-x-short');
  assert.deepEqual(Array.from(out.samples), Array.from(s.subarray(0, 12)));
  assert.deepEqual(out.fixture.transcript.map((c) => c.id), ['a']);
  assert.equal(out.fixture.duration, 1.2);
  assert.equal(out.fixture.audioSrc, '/recordings/draft-x-short.wav');
  assert.throws(() => trimDraft(fx, s, 10, 2.0, 'z'), /cut_inside_line:b/);
});
