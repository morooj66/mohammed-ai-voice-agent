import { recordedDemoFixture } from './recording-fixture.js';
import { approvedRecordings } from './approved-recording.js';
import { CALLERS } from './callers.js';

// Each caller has its own recording; a missing recording shows THAT caller's placeholder, never another caller's.
export function fixtureForCaller(callerId, recordings = approvedRecordings) {
  const caller = CALLERS.find((c) => c.id === callerId) || CALLERS[0];
  return recordings[caller.id] ?? { ...recordedDemoFixture, id: `${recordedDemoFixture.id}-${caller.id}`, caller: { id: caller.id, nameAr: caller.nameAr } };
}
