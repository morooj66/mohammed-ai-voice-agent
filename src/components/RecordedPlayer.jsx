import VoiceUI from './VoiceUI.jsx';
import useRecordedDemo from '../hooks/useRecordedDemo.js';
import { PUBLIC_CALLERS, resolveCaller } from '../lib/callers.js';
import { fixtureForCaller } from '../lib/caller-fixtures.js';
import { scriptedDemo } from '../lib/scripted-demo.js';
import { validateRecordingFixture } from '../lib/recording-fixture.js';

// «شاهد المحاكاة»: PRERECORDED playback only. Plays a local audio file with its timed transcript.
// It never calls the simulation server or any paid service (see tests/watch-simulation.test.mjs).
export default function RecordedPlayer({ fixture: given }) {
  const selected = typeof window === 'undefined' ? PUBLIC_CALLERS[0] : resolveCaller(window.location.search);
  // The approved real AI-to-AI recording stays the default; the scripted dramatization is shown only when asked
  // for (?demo=scripted) or when no approved real recording exists — always under its own 'scripted' label.
  const live = fixtureForCaller(selected.id);
  const wantScripted = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'scripted';
  const fixture = given ?? (scriptedDemo && (wantScripted || !validateRecordingFixture(live)) ? scriptedDemo : live);
  const callerName = fixture.caller?.nameAr || 'خالد';
  // Caller switch only on the public player (the private draft preview passes its own fixture).
  const callerSwitch = given || PUBLIC_CALLERS.length < 2 ? null : (
    <nav className="mode-switch" aria-label="المتصل في المحاكاة">
      {PUBLIC_CALLERS.map((c) => <a key={c.id} href={`?mode=recorded&caller=${c.id}`} aria-current={c.id === selected.id ? 'page' : undefined}>{c.nameAr}</a>)}
    </nav>);
  const recording = useRecordedDemo(fixture);
  const messages = recording.fixture.transcript.map((cue, id) => ({ id: cue.id ?? id, role: cue.speaker === 'agent' ? 'agent' : 'user', text: cue.text }));
  // getLevels / getKhalidLevels come from a real analyser on the recorded audio (see useRecordedDemo).
  return <VoiceUI key={fixture.id} convo={{ ...recording, messages, isRecorded: true, previewOnly: true, isSimulated: false, isMuted: false, callerName, callerSwitch }} />;
}
