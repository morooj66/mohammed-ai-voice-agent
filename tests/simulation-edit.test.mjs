import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dropCues, editRecording, readWav, shortenPauses, wavFile } from '../server/simulator/edit.mjs';
import { buildFixture, isRejected } from '../scripts/build-simulation-fixture.mjs';
import { pickVideoMime, extensionFor, exportVideoAllowed } from '../src/lib/video-export.js';

// Synthetic recording at 1 kHz: tones (non-zero) inside cues, exact silence between them.
const RATE = 1000;
const CUES = [
  { id: 0, speaker: 'customer', text: 'افتتاحية خالد', start: 0.5, end: 1.5 },
  { id: 1, speaker: 'agent', text: 'رد محمد الأول', start: 4.0, end: 5.0 },
  { id: 2, speaker: 'customer', text: 'سؤال خالد', start: 5.3, end: 6.3 },
  { id: 3, speaker: 'agent', text: 'رد محمد الأخير', start: 9.0, end: 10.0 },
];
function synth(cues = CUES, total = 12) {
  const s = new Int16Array(total * RATE);
  cues.forEach((c, k) => { for (let i = c.start * RATE; i < c.end * RATE; i++) s[i] = 1000 + k * 100 + (i % 7); });
  return s;
}
const slice = (s, c) => Array.from(s.subarray(Math.round(c.start * RATE), Math.round(c.end * RATE)));

test('pause shortening removes only silence and keeps every line sample-identical and in sync', () => {
  const src = synth();
  const out = shortenPauses(src, RATE, CUES);
  // lead 0.5 -> 0.3, gaps 2.5 and 2.7 -> 0.45, short gap 0.3 untouched, tail 2.0 -> 0.7
  assert.equal(out.samples.length / RATE, 12 - 0.2 - 2.05 - 2.25 - 1.3);
  out.cues.forEach((c, i) => {
    assert.equal(Number((c.end - c.start).toFixed(3)), Number((CUES[i].end - CUES[i].start).toFixed(3)), `line ${i} duration`);
    assert.deepEqual(slice(out.samples, c), slice(src, CUES[i]), `line ${i} audio identical at its new subtitle time`);
  });
  assert.equal(Number((out.cues[1].start - out.cues[0].end).toFixed(3)), 0.45);
  assert.equal(Number((out.cues[2].start - out.cues[1].end).toFixed(3)), 0.3);
  assert.deepEqual(out.skipped, []);
});

test('a gap containing sound is never cut', () => {
  const src = synth();
  for (let i = 2.0 * RATE; i < 2.1 * RATE; i++) src[i] = 3000; // e.g. a breath between lines 0 and 1
  const out = shortenPauses(src, RATE, CUES);
  assert.ok(out.skipped.includes('gap_after_line_0'));
  assert.equal(Number((out.cues[1].start - out.cues[0].end).toFixed(3)), 2.5);
});

test('dropping a whole exchange keeps alignment; misleading drops are refused', () => {
  const src = synth();
  const out = dropCues(src, RATE, CUES, [1, 2]);
  assert.deepEqual(out.cues.map((c) => c.id), [0, 3]);
  assert.deepEqual(slice(out.samples, out.cues[1]), slice(src, CUES[3]));
  assert.throws(() => dropCues(src, RATE, CUES, [1]), /misleading transition/);
  assert.throws(() => dropCues(src, RATE, CUES, [0]), /opening or closing/);
  assert.throws(() => dropCues(src, RATE, CUES, [3]), /opening or closing/);
});

test('editRecording logs what changed; WAV round-trip is lossless', () => {
  const src = synth();
  const out = editRecording(src, RATE, CUES, { drop: [1, 2] });
  assert.deepEqual(out.log.droppedLineIds, [1, 2]);
  assert.ok(out.log.pauseSecondsRemoved > 0);
  const back = readWav(wavFile(out.samples, RATE));
  assert.equal(back.rate, RATE);
  assert.deepEqual(Array.from(back.samples), Array.from(out.samples));
});

test('fixture builder: valid draft with honest edit note; rejected recordings are flagged', () => {
  const out = editRecording(synth(), RATE, CUES);
  const meta = { audioFile: 'x-edited.wav', duration: out.samples.length / RATE, transcript: out.cues,
    edit: { source: 'khalid-mohammed-2026-11-01T10-00-00-000Z.json', sourceComplete: true, ...out.log } };
  const { fixture } = buildFixture(meta, { id: 'draft-test', approved: false });
  assert.equal(fixture.draft, true);
  assert.equal(fixture.verifiedAt, 'UNAPPROVED-DRAFT');
  assert.match(fixture.provenance, /قُصّرت الفواصل الصامتة/);
  assert.equal(fixture.source.complete, true);
  assert.equal(isRejected('khalid-mohammed-2026-10-10T19-06-30-048Z-edited'), true);
  assert.equal(isRejected('khalid-mohammed-2026-11-01T10-00-00-000Z'), false);
});

test('video export prefers MP4 only when the browser reports support, else WebM; internal-only switch', () => {
  const fake = (ok) => ({ isTypeSupported: (t) => ok.some((p) => t.startsWith(p)) });
  assert.equal(pickVideoMime(fake(['video/mp4;codecs=avc1.42E01E', 'video/webm'])), 'video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  assert.equal(pickVideoMime(fake(['video/webm;codecs=vp9'])), 'video/webm;codecs=vp9,opus');
  assert.equal(pickVideoMime(fake([])), '');
  assert.equal(pickVideoMime(undefined), '');
  assert.equal(extensionFor('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(extensionFor('video/webm'), 'webm');
  assert.equal(exportVideoAllowed('?mode=recorded'), false);
  assert.equal(exportVideoAllowed('?mode=recorded&export=1'), true);
  const approved = { kind: 'recording', verifiedAt: '2026-10-11T00:00:00Z' };
  assert.equal(exportVideoAllowed('?export=1', approved), true);
  assert.equal(exportVideoAllowed('?export=1', { ...approved, draft: true }), false, 'draft/demo audio cannot be exported as an approved LinkedIn video');
  assert.equal(exportVideoAllowed('?export=1', { ...approved, verifiedAt: 'UNAPPROVED-DRAFT' }), false);
  assert.equal(exportVideoAllowed('?export=1', { kind: 'placeholder' }), false);
  assert.equal(exportVideoAllowed('?export=draft', { ...approved, draft: true, verifiedAt: 'UNAPPROVED-DRAFT' }), true, 'local draft review export');
  assert.equal(exportVideoAllowed('?export=draft', approved), false, 'draft mode never applies to approved recordings');
  assert.equal(exportVideoAllowed('?export=draft', { kind: 'placeholder', draft: true }), false);
});

test('Mohammed keeps the original blue orb; Khalid uses magenta', () => {
  const orb = readFileSync(new URL('../src/components/Orb.jsx', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/components/VoiceUI.jsx', import.meta.url), 'utf8');
  assert.match(orb, /blue: \{ deep: \[0\.035, 0\.110, 0\.360\], blue: \[0\.160, 0\.420, 1\.000\], turq: \[0\.180, 0\.900, 0\.840\]/);
  assert.match(orb, /palette = 'blue'/);
  assert.match(ui, /<Orb phase=\{phase\} getLevels=\{getLevels\} muted=\{isMuted\} \/>/); // Mohammed: default (blue)
  assert.match(ui, /<Orb palette="magenta"/);                                           // Khalid
});
