import { useCallback, useEffect, useRef, useState } from 'react';

// SIMULATED conversation. No network calls, no ElevenLabs usage, no cost.
// Exposes the same shape as the live adapter (useLiveConversation) so the UI is identical:
//   { status, phase, isMuted, messages, error, start, end, toggleMute, getLevels, isSimulated }
//
// The script is fictional demo content (MOCK company). Agent lines follow the agent's tone rules.
const SCRIPT = [
  { role: 'agent', text: 'حياك الله، معك محمد، المساعد لشركة التأمين. كيف أقدر أخدمك؟', dur: 4.2 },
  { role: 'user', text: 'ألو، السلام عليكم! يا أخوي أنا توي صادم عند الإشارة، والله إني متقروش! ما أدري وش أسوي الحين!', dur: 3.6 },
  { role: 'agent', text: 'الحمد لله على سلامتك. فيه أحد مصاب؟', dur: 4.6 },
  { role: 'user', text: 'أنا بخير، وما فيه إصابات على حد علمي.', dur: 2.0 },
  { role: 'agent', text: 'أهم شي سلامتكم. أنت الحين في مكان آمن؟', dur: 5.2 },
  { role: 'user', text: 'أنا قريب من الإشارة، والطرف الثاني معصّب وأنا ما أدري وش أسوي!', dur: 3.4 },
  { role: 'agent', text: 'حقك تزعل، وأعتذر عن اللي صار. خلني أساعدك الحين خطوة بخطوة.', dur: 4.4 },
];
const THINK_SECONDS = 1.3;

export default function useSimulatedConversation() {
  const [status, setStatus] = useState('disconnected');   // disconnected | connecting | connected
  const [phase, setPhase] = useState('idle');             // idle | connecting | listening | thinking | speaking
  const [isMuted, setMuted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);

  const timers = useRef([]);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (fn, sec) => timers.current.push(setTimeout(fn, sec * 1000));
  const enter = setPhase;

  const runStep = useCallback((i) => {
    if (i >= SCRIPT.length) { setStatus('disconnected'); enter('idle'); return; }  // finite text preview
    const step = SCRIPT[i];
    if (step.role === 'agent') {
      enter('speaking');
      setMessages((m) => [...m, { id: i, role: 'agent', text: step.text }]);
      later(() => runStep(i + 1), step.dur);
    } else {
      enter('listening');
      later(() => {
        setMessages((m) => [...m, { id: i, role: 'user', text: step.text }]);
        enter('thinking');
        later(() => runStep(i + 1), THINK_SECONDS);
      }, step.dur);
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    clearTimers();
    setMessages([]);
    setStatus('connecting'); enter('connecting');
    later(() => { setStatus('connected'); runStep(0); }, 1.4);
  }, [runStep]);

  const end = useCallback(() => {
    clearTimers();
    setStatus('disconnected'); enter('idle');
  }, []);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  // Polled every animation frame by the orb.
  // Mock text has no audio: never fabricate a live amplitude meter.
  const getLevels = useCallback(() => ({ input: 0, output: 0, bass: 0, high: 0 }), []);

  useEffect(() => () => { clearTimers(); }, []);

  return {
    isSimulated: true,
    status, phase, isMuted, messages, error,
    start, end, toggleMute, getLevels,
  };
}
