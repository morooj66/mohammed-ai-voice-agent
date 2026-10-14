// Post-call Mohammed version check: a recording must have run on the exact requested version_id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { versionCheck, recordingVersionProblems } from '../server/simulator/version-check.mjs';
import { buildFixture } from '../scripts/build-simulation-fixture.mjs';
import { trimDraft } from '../scripts/trim-draft.mjs';
import { exportVideoAllowed } from '../src/lib/video-export.js';
import { getPersona, callerConfig } from '../server/simulator/personas.mjs';

const V7 = 'agtvrsn_2601m4q3ygh9f15vpc31dab59gqw', V5 = 'agtvrsn_4601m4n4stvme2btdq2edkshj5ek';
const meta = (check) => ({ kind: 'recording', audioFile: 'x.wav', duration: 3, complete: true, caller: { id: 'khalid', nameAr: 'خالد' },
  ...(check ? { versionCheck: { mohammed: check } } : {}),
  transcript: [{ id: 0, speaker: 'agent', text: 'حياك الله', start: 0, end: 1 }, { id: 1, speaker: 'customer', text: 'ألو', start: 1.2, end: 2 }] });

test('versionCheck: match, mismatch, and missing actual version', () => {
  assert.deepEqual(versionCheck(V7, V7), { requested: V7, actual: V7, match: true, reason: 'match' });
  assert.equal(versionCheck(V7, V5).match, false); assert.equal(versionCheck(V7, V5).reason, 'version_mismatch');
  assert.equal(versionCheck(V7, null).reason, 'actual_version_unavailable');
  assert.equal(versionCheck('', '').match, false, 'nothing requested is never a match');
});

test('MATCHING version: approvable, valid, exportable once approved', () => {
  const m = meta(versionCheck(V7, V7));
  assert.deepEqual(recordingVersionProblems(m), []);
  const { fixture } = buildFixture(m, { id: 'sim-ok', approved: true, verifiedAt: '2026-10-12T00:00:00Z' });
  assert.equal(fixture.invalid, undefined); assert.equal(fixture.source.versionCheck.mohammed.match, true);
  assert.equal(exportVideoAllowed('?export=1', fixture), true);
});

test('MISMATCHED version: invalid, refused for approval, never exportable (draft or trimmed copy included)', () => {
  const m = meta(versionCheck(V7, V5));
  assert.match(recordingVersionProblems(m)[0], /version_mismatch: requested agtvrsn_2601.*actual agtvrsn_4601/);
  assert.throws(() => buildFixture(m, { id: 'sim-bad', approved: true }), /refused_invalid_recording/);
  const { fixture } = buildFixture(m, { id: 'draft-bad', approved: false });
  assert.equal(fixture.invalid, true); assert.match(fixture.label, /غير صالح/);
  for (const q of ['?export=1', '?export=draft']) assert.equal(exportVideoAllowed(q, fixture), false, q);
  const short = trimDraft(fixture, new Int16Array(30), 10, 1.1, 'draft-bad-short').fixture;
  assert.equal(exportVideoAllowed('?export=draft', short), false, 'a trimmed copy stays invalid');
});

test('recordings without a version check (made before it existed) cannot be approved', () => {
  assert.throws(() => buildFixture(meta(null), { id: 'sim-old', approved: true }), /predates the post-call check/);
});

test('Khalid scenario records Mohammed v7 via its own keys; the website pin is untouched', () => {
  const k = getPersona('khalid');
  assert.deepEqual({ ...k.mohammed }, { version: 'MOHAMMED_V7_VERSION_ID', hash: 'MOHAMMED_V7_AUDITED_SHA256' });
  const c = callerConfig({ ELEVENLABS_VERSION_ID: V5, MOHAMMED_V7_VERSION_ID: V7, MOHAMMED_V7_AUDITED_SHA256: 'h7' }, k);
  assert.equal(c.mohammedVersionId, V7);
  assert.match(readFileSync(new URL('../server/elevenlabs.mjs', import.meta.url), 'utf8'), /version_id: env\.ELEVENLABS_VERSION_ID/, 'website token still uses ELEVENLABS_VERSION_ID');
  const rec = readFileSync(new URL('../scripts/record-conversation.mjs', import.meta.url), 'utf8');
  assert.match(rec, /versionCheck\(runEnv\.ELEVENLABS_VERSION_ID, mohammedUsage\.versionId\)/);
  assert.match(rec, /sign\(\{ agent_id: env\.ELEVENLABS_AGENT_ID, version_id: runEnv\.ELEVENLABS_VERSION_ID \}\)/);
  assert.match(rec, /invalid: !checks\.mohammed\.match/);
});
