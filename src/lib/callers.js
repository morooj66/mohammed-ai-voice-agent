// Callers shown in «شاهد المحاكاة». Must match server/simulator/personas.mjs (checked by tests).
// Khalid is the default; each caller has its own independent approved recording.
export const CALLERS = Object.freeze([
  Object.freeze({ id: 'khalid', nameAr: 'خالد' }),
  Object.freeze({ id: 'raj', nameAr: 'راج' }),
]);
// Launch scope: only Khalid is offered in the public selector (Raj has no approved recording yet).
export const PUBLIC_CALLERS = Object.freeze(CALLERS.filter((c) => c.id === 'khalid'));
export const DEFAULT_CALLER_ID = 'khalid';
export function resolveCaller(search) {
  const id = new URLSearchParams(search).get('caller');
  return CALLERS.find((c) => c.id === id) || CALLERS.find((c) => c.id === DEFAULT_CALLER_ID);
}
