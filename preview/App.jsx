import { useEffect, useState } from 'react';
import RecordedPlayer from '../src/components/RecordedPlayer.jsx';
import { recordedDemoFixture } from '../src/lib/recording-fixture.js';

// Private static preview: prerecorded playback only (no live calls, no microphone, no API).
// LOCAL DEV ONLY: ?draft=<id> loads an unapproved draft from preview/draft-public/recordings/ (served by the
// preview `vite` dev server only; publicDir is disabled for builds, so drafts are never bundled or deployed).
const draftId = new URLSearchParams(window.location.search).get('draft');

export default function PreviewApp() {
  const [fixture, setFixture] = useState(recordedDemoFixture);
  useEffect(() => {
    if (!draftId || !/^draft-[A-Za-z0-9._-]+$/.test(draftId)) return;
    fetch(`/recordings/${draftId}.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((f) => { if (f) setFixture(f); }).catch(() => {});
  }, []);
  return <RecordedPlayer key={fixture.id} fixture={fixture} />;
}
