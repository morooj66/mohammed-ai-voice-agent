// Public modes: 'live' (تحدث مع محمد, private access code) and 'recorded' (شاهد المحاكاة, prerecorded playback only).
// 'generate' is the INTERNAL live AI-to-AI generator (paid, access code) and is not linked from the interface.
// Legacy links (?mode=ai, ?mode=sim) open the prerecorded player, never a paid or scripted session.
// The public landing page is the prerecorded simulation (no access code). The protected live
// page opens only when a visitor explicitly chooses «تحدث مع محمد» (?mode=live).
export function resolveMode(search) {
  const mode = new URLSearchParams(search).get('mode');
  if (mode === 'live') return 'live';
  if (mode === 'generate') return 'generate';
  return 'recorded';
}
