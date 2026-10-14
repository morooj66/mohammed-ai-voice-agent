// Replace this manifest only with a consented, genuinely recorded demo.
// Transcript text and speaker cues must come from that exact recording.
export const recordedDemoFixture = Object.freeze({
  id: 'riyadh-accident-placeholder-v1',
  label: 'تسجيل تجريبي قيد الإعداد',
  provenance: 'PLACEHOLDER — لا يوجد تسجيل صوتي أو نص محادثة حقيقي',
  kind: 'placeholder',
  audioSrc: null,
  duration: 0,
  transcript: Object.freeze([]),
});

export function currentCue(transcript, seconds) {
  return transcript.find((cue) => seconds >= cue.start && seconds < cue.end) ?? null;
}

// 'recording' = real AI-to-AI call; 'scripted' = written dramatization voiced with the agents' voices (labelled as such).
export const PLAYABLE_KINDS = Object.freeze(['recording', 'scripted']);
export function validateRecordingFixture(fixture) {
  if (!PLAYABLE_KINDS.includes(fixture.kind) || !/^\/recordings\/[a-zA-Z0-9._-]+\.(mp3|m4a|ogg|wav|webm)$/.test(fixture.audioSrc || '') || fixture.consentConfirmed !== true || !fixture.verifiedAt || !Array.isArray(fixture.transcript) || fixture.transcript.length === 0 || !(fixture.duration > 0)) return false;
  // Real recordings never overlap; a scripted dramatization may contain a deliberate short overlap (<= 0.3 s).
  const overlap = fixture.kind === 'scripted' ? 0.3 : 0;
  let end = 0;
  for (const cue of fixture.transcript) {
    if (!['agent', 'customer'].includes(cue.speaker) || typeof cue.text !== 'string' || !cue.text.trim() || !(cue.start >= end - overlap) || !(cue.end > cue.start) || cue.end > fixture.duration) return false;
    end = cue.end;
  }
  return true;
}
