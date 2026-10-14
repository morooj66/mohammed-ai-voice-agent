import { useCallback, useEffect, useRef, useState } from 'react';
import { PCMPlayer } from '../lib/pcm-player.js';
import { RecordingCapture, transcriptBundle } from '../lib/recording-capture.js';
import { readEvents, upsertMessage } from '../lib/transcript.js';
const ZERO = { input: 0, output: 0, bass: 0, high: 0 };
export default function useAIConversation() {
  const [status, setStatus] = useState('disconnected');
  const [phase, setPhase] = useState('idle'); const [khalidPhase, setKhalidPhase] = useState('idle');
  const [emotion, setEmotion] = useState('STRESSED'); const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null); const [recordingFiles, setRecordingFiles] = useState(null); const run = useRef(null);
  const control = async (r, action, barrier) => {
    if (!r.sessionId) return;
    const response = await fetch('/api/simulation/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: r.sessionId, action, barrier }), keepalive: action === 'stop' });
    if (!response.ok && action !== 'stop') throw Error('control_failed');
  };
  const end = useCallback(() => {
    const r = run.current; run.current = null;
    if (r) { void control(r, 'stop').catch(() => {}); r.abort.abort(); clearTimeout(r.timer);
      if (r.capture && !r.captureSaved) { r.captureSaved = true; r.player.stopPlayback(); void r.capture.stop().then(result => {
        if (!result.blob.size || !result.transcript.length) return;
        const audioUrl = URL.createObjectURL(result.blob);
        const bundle = transcriptBundle(result, { recordingName: `khalid-mohammed-${new Date().toISOString().replace(/[:.]/g, '-')}.${result.extension}`, consentConfirmed: true, verifiedAt: new Date().toISOString().slice(0,10), completionReason: r.completionReason || 'user_stop' });
        const transcriptUrl = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], {type:'application/json'}));
        setRecordingFiles({ audioUrl, transcriptUrl, audioName: bundle.audioSrc.split('/').at(-1), transcriptName: 'transcript-timing.json' });
      }).catch(() => setError('تعذّر حفظ ملف التسجيل.')).finally(() => r.player.close()); }
      else r.player.close(); }
    setStatus('disconnected'); setPhase('idle'); setKhalidPhase('idle');
  }, []);
  const start = useCallback(async () => {
    if (run.current) return;
    setError(null); setRecordingFiles(null); setMessages([]); setStatus('connecting'); setPhase('connecting'); setEmotion('STRESSED');
    let r;
    try {
      const player = new PCMPlayer(role => {
        if (run.current !== r) return;
        setPhase(role === 'agent' ? 'speaking' : role === 'user' ? 'listening' : 'thinking');
        setKhalidPhase(role === 'user' ? 'speaking' : 'listening');
      }, undefined, (role, start, end) => r?.capture?.schedule(role, start, end));
      r = { player, abort: new AbortController() }; run.current = r;
      r.timer = setTimeout(end, 120_000);
      await player.resume();
      r.capture = new RecordingCapture({stream: player.recordDestination.stream, context: player.context});
      const response = await fetch('/api/simulation/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: r.abort.signal });
      if (!response.ok) throw Error((await response.json()).error || 'connection_failed');
      let stopped = false;
      for await (const event of readEvents(response.body)) {
        if (run.current !== r) break;
        if (event.sessionId) r.sessionId = event.sessionId;
        if (event.type === 'connected') { setStatus('connected'); setPhase('listening'); setKhalidPhase('listening'); }
        if (event.type === 'transcript') {
          setMessages(m => upsertMessage(m, { id: event.id, role: event.role, text: event.text }));
          r.capture?.addTranscript(event);
          if (event.emotion) setEmotion(event.emotion);
        }
        if (event.type === 'recognition') setMessages(m => {
          const last = [...m].reverse().find(x => x.role === 'user');
          return last ? upsertMessage(m, { ...last, recognized: event.text }) : m;
        });
        if (event.type === 'audio') player.add(event.audio, event.format, event.role);
        if (event.type === 'state' && event.phase === 'thinking') {
          if (event.role === 'user') { setKhalidPhase('thinking'); setPhase('listening'); }
          else { setPhase('thinking'); setKhalidPhase('listening'); }
        }
        if (event.type === 'playback_barrier') {
          await player.drained();
          if (run.current === r) await control(r, 'played', event.barrier);
        }
        if (event.type === 'stopped') {
          stopped = true;
          r.completionReason = event.reason;
          if (['turn_limit', 'duration_limit', 'natural_end'].includes(event.reason)) await player.drained();
          else if (event.reason !== 'user_stop') throw Error(event.reason);
          break;
        }
      }
      if (!stopped && run.current === r) throw Error('stream_ended');
    } catch (e) {
      if (e.name !== 'AbortError') setError(`تعذّر تشغيل المحاكاة أو توقّف الاتصال. تأكد من فتح الوصول واعتماد الإعدادات. (${e.message})`);
    } finally { if (run.current === r) end(); }
  }, [end]);
  useEffect(() => {
    const hide = () => { if (document.hidden) end(); };
    document.addEventListener('visibilitychange', hide);
    return () => { document.removeEventListener('visibilitychange', hide); end(); };
  }, [end]);
  const getLevels = useCallback(() => run.current?.player.levels('agent') || ZERO, []);
  const getKhalidLevels = useCallback(() => run.current?.player.levels('user') || ZERO, []);
  return { isAutomated: true, isSimulated: false, status, phase, khalidPhase, emotion, messages, error, start, end,
    isMuted: false, toggleMute() {}, getLevels, getKhalidLevels, recordingFiles };
}
