import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentCue, recordedDemoFixture, validateRecordingFixture } from '../lib/recording-fixture.js';
import { exportVideoAllowed, extensionFor, recordPlayback } from '../lib/video-export.js';
import { decodeForLevels, levelsAt } from '../lib/audio-levels.js';

export default function useRecordedDemo(fixture = recordedDemoFixture) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(fixture.duration || 0);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const available = validateRecordingFixture(fixture);
  // Video export is a local development tool only (removed from production builds).
  const canExport = import.meta.env?.DEV === true && typeof window !== 'undefined' && available && exportVideoAllowed(window.location.search, fixture);
  const cue = useMemo(() => currentCue(fixture.transcript, position), [fixture.transcript, position]);
  // Between lines of a recording nothing is being processed: show 'listening', never a 'processing…' label.
  const phase = !playing ? 'idle' : cue?.speaker === 'agent' ? 'speaking' : 'listening';
  const update = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setPosition(audio.currentTime || 0);
    if (Number.isFinite(audio.duration)) setDuration(audio.duration);
  }, []);
  // Real audio levels from the decoded recording at the element's current time. The level is routed
  // to the orb of whoever speaks in the current timed cue; between cues and when paused it is zero.
  // Playback is NOT routed through Web Audio: createMediaElementSource captures the element's output,
  // so a suspended/unsupported AudioContext made the recording silent while time and captions advanced.
  const levelsRef = useRef(null);
  useEffect(() => {
    if (!available || typeof window === 'undefined') return undefined;
    let cancelled = false;
    decodeForLevels(fixture.audioSrc).then((d) => { if (!cancelled) levelsRef.current = d; }).catch(() => {});
    return () => { cancelled = true; };
  }, [available, fixture.audioSrc]);
  // Web Audio graph: used ONLY by the internal video export (?export=1), never for normal playback.
  const graphRef = useRef(null);
  const cueRef = useRef(null);
  cueRef.current = cue;
  const ensureGraph = useCallback(() => {
    if (graphRef.current || !audioRef.current) return graphRef.current;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const context = new Ctx();
    const source = context.createMediaElementSource(audioRef.current); // allowed once per element
    const analyser = context.createAnalyser(); analyser.fftSize = 512;
    source.connect(analyser); analyser.connect(context.destination);
    graphRef.current = { context, analyser, time: new Uint8Array(analyser.fftSize), freq: new Uint8Array(analyser.frequencyBinCount) };
    return graphRef.current;
  }, []);
  const measure = useCallback(() => {
    const d = levelsRef.current, audio = audioRef.current;
    if (!d || !audio || audio.paused) return null;
    return levelsAt(d.samples, d.rate, audio.currentTime);
  }, []);
  const levelsFor = useCallback((speaker) => {
    const m = measure();
    if (!m || cueRef.current?.speaker !== speaker) return { input: 0, output: 0, bass: 0, high: 0 };
    return { input: 0, ...m };
  }, [measure]);
  const getLevels = useCallback(() => levelsFor('agent'), [levelsFor]);
  const getKhalidLevels = useCallback(() => levelsFor('customer'), [levelsFor]);
  useEffect(() => () => { graphRef.current?.context.close(); graphRef.current = null; }, []);

  const play = useCallback(async () => {
    if (!available || !audioRef.current) return;
    try {
      setError(null);
      const g = graphRef.current; // exists only after an export
      if (g && g.context.state !== 'running') g.context.resume().catch(() => {});
      await audioRef.current.play(); // direct element playback (keeps the user gesture; never gated on Web Audio)
    } catch { setPlaying(false); setError('تعذّر تشغيل التسجيل؛ أعد المحاولة.'); }
  }, [available]);
  const pause = useCallback(() => audioRef.current?.pause(), []);
  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause(); audio.currentTime = 0; setPosition(0); setPlaying(false);
  }, []);
  const replay = useCallback(async () => {
    if (!available || !audioRef.current) return;
    audioRef.current.currentTime = 0;
    setPosition(0);
    await play();
  }, [available, play]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnd = () => { setPlaying(false); setPosition(audio.duration || 0); };
    const onError = () => { setPlaying(false); setError('تعذّر تحميل ملف التسجيل.'); };
    audio.addEventListener('timeupdate', update); audio.addEventListener('loadedmetadata', update);
    audio.addEventListener('play', onPlay); audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnd); audio.addEventListener('error', onError);
    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', update); audio.removeEventListener('loadedmetadata', update);
      audio.removeEventListener('play', onPlay); audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnd); audio.removeEventListener('error', onError);
    };
  }, [update]);
  const seek = useCallback((seconds) => {
    if (!available || !audioRef.current || !Number.isFinite(seconds)) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, seconds)); update();
  }, [available, duration, update]);
  // Internal export (?export=1): records the tab video + the original audio from the analyser output.
  const exportVideo = useCallback(async () => {
    if (!canExport || !available || !audioRef.current || exporting) return;
    const audio = audioRef.current;
    const g = ensureGraph();
    if (!g) { setExportStatus('المتصفح لا يدعم تسجيل الصوت هنا.'); return; }
    const dest = g.context.createMediaStreamDestination();
    g.analyser.connect(dest);
    setExporting(true); setExportStatus('اختر «هذا التبويب» للمشاركة، ولا تغيّر حجم النافذة أثناء التصدير…');
    try {
      audio.pause(); audio.currentTime = 0; setPosition(0);
      const ended = new Promise((resolve) => audio.addEventListener('ended', resolve, { once: true }));
      const { blob, mime } = await recordPlayback({ audioTracks: dest.stream.getAudioTracks(), ended, tailMs: 150,
        play: async () => { if (g.context.state !== 'running') await g.context.resume(); await audio.play(); } });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${fixture.id || 'simulation'}.${extensionFor(mime)}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      setExportStatus(`تم التصدير: ${extensionFor(mime).toUpperCase()} (${mime})`);
    } catch (e) {
      audio.pause();
      setExportStatus(e?.name === 'NotAllowedError' ? 'أُلغيت مشاركة التبويب.' : `تعذّر التصدير: ${e?.message || 'unknown'}`);
    } finally { g.analyser.disconnect(dest); setExporting(false); }
  }, [available, canExport, exporting, ensureGraph, fixture.id]);
  const khalidPhase = !playing ? 'idle' : cue?.speaker === 'customer' ? 'speaking' : 'listening';
  return { fixture, audioRef, available, playing, position, duration, cue, phase, khalidPhase, error, play, pause, replay, stop, seek, getLevels, getKhalidLevels,
    canExport, exporting, exportStatus, exportVideo };
}
