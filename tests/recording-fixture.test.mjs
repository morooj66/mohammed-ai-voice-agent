import test from 'node:test';
import assert from 'node:assert/strict';
import { currentCue, recordedDemoFixture, validateRecordingFixture } from '../src/lib/recording-fixture.js';

test('recorded demo remains an explicit empty placeholder until a genuine fixture is provided', () => {
  assert.equal(recordedDemoFixture.kind, 'placeholder');
  assert.equal(recordedDemoFixture.audioSrc, null);
  assert.deepEqual(recordedDemoFixture.transcript, []);
  assert.match(recordedDemoFixture.provenance, /PLACEHOLDER/);
  assert.equal(validateRecordingFixture(recordedDemoFixture), false);
});

test('only audio recordings with aligned, ordered transcript cues are playable', () => {
  const fixture = { kind: 'recording', audioSrc: '/recordings/consented-demo.mp3', consentConfirmed: true, verifiedAt: '2026-10-10', duration: 6, transcript: [
    { id: 1, speaker: 'customer', text: 'verified customer line', start: 0, end: 2 },
    { id: 2, speaker: 'agent', text: 'verified agent line', start: 2, end: 6 },
  ] };
  assert.equal(validateRecordingFixture(fixture), true);
  assert.equal(currentCue(fixture.transcript, 0.5).id, 1);
  assert.equal(currentCue(fixture.transcript, 2).id, 2);
  assert.equal(currentCue(fixture.transcript, 6), null);
  assert.equal(validateRecordingFixture({ ...fixture, transcript: [...fixture.transcript].reverse() }), false);
  assert.equal(validateRecordingFixture({ ...fixture, audioSrc: 'https://third-party.invalid/audio.mp3' }), false);
  assert.equal(validateRecordingFixture({ ...fixture, consentConfirmed: false }), false);
});
