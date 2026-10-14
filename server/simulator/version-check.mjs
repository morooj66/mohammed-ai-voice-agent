// Post-call proof that a recording used the Mohammed version it requested (explicit version_id).
// A mismatch, or a missing actual version, makes the recording INVALID: never approved, never exported.
export function versionCheck(requested, actual) {
  const match = typeof requested === 'string' && requested.length > 0 && actual === requested;
  return { requested: requested || null, actual: actual || null, match,
    reason: match ? 'match' : actual ? 'version_mismatch' : 'actual_version_unavailable' };
}
// Problems that block approval/export. Recordings made before this check have no proof and are refused too.
export function recordingVersionProblems(meta) {
  const c = meta?.versionCheck?.mohammed;
  if (!c) return ['no Mohammed version check (recording predates the post-call check)'];
  if (c.match !== true) return [`Mohammed version ${c.reason}: requested ${c.requested}, actual ${c.actual}`];
  return [];
}
export const isInvalidRecording = (meta) => recordingVersionProblems(meta).length > 0;
