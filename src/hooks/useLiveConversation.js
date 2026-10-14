import { useCallback, useEffect, useRef, useState } from 'react';
import { useConversation } from '@elevenlabs/react';

// LIVE adapter (ElevenLabs React SDK 1.17). Same shape as useSimulatedConversation.
// Must be rendered inside <ConversationProvider> (required by SDK 1.17).
//
// Auth flow: browser -> /api/conversation-token (local token server holds the API key)
//            -> { token } -> startSession({ conversationToken, connectionType: 'webrtc' }).
// The API key never reaches the browser.

const ERRORS = {
  mic_denied: 'لم يُسمح باستخدام الميكروفون. فعّل إذن الميكروفون للموقع من إعدادات المتصفح ثم حاول مرة ثانية.',
  mic_missing: 'ما لقينا ميكروفون متصل بالجهاز.',
  mic_unavailable: 'المتصفح لا يدعم الوصول للميكروفون هنا. افتح الصفحة على http://localhost أو https.',
  not_configured: 'الوضع المباشر غير مُعد: ملف ‎.env‎ ناقص (مفتاح ElevenLabs أو معرّف الوكيل).',
  auth_not_configured: 'إعدادات دخول العرض ناقصة في ملف ‎.env‎ (SESSION_SECRET بطول 32 حرفًا على الأقل، وDEMO_ACCESS_CODE بطول 16 حرفًا على الأقل).',
  server_down: 'تعذّر الاتصال بخادم العرض. حاول لاحقًا.',
  unauthorized: 'افتح الوصول برمز العرض الخاص أولًا.',
  needs_approval: 'المحادثات المباشرة غير مفعّلة لهذا العرض بعد.',
  rate_limited: 'وصل العرض إلى حد الجلسات. حاول لاحقًا.',
  upstream: 'تعذّر الحصول على توكن من ElevenLabs. تأكد من المفتاح وصلاحياته ومعرّف الوكيل.',
  connection: 'انقطع الاتصال مع الوكيل.',
  trial_used: 'استخدمت تجربتك المباشرة سابقًا — المحاكاة متاحة لك دائمًا.',
  trial_network_limit: 'وصلت التجارب المجانية من هذه الشبكة إلى حدّها اليوم. تقدر تشاهد المحاكاة أو تحاول لاحقًا.',
  trial_day_full: 'انتهت التجارب المجانية لهذا اليوم. شاهد المحاكاة أو عد غدًا.',
  trial_month_full: 'انتهت التجارب المجانية لهذا الشهر. تقدر تشاهد المحاكاة الكاملة.',
  trial_busy: 'محمد في مكالمة الآن، حاول بعد دقيقة.',
  bot_check_failed: 'تعذّر التحقق من المتصفح. حدّث الصفحة وحاول مرة ثانية.',
};
// Public 60-second trial (build flag): no access code; server quota + Turnstile; the call ends at 60 s.
export const PUBLIC_TRIAL = import.meta.env?.VITE_PUBLIC_TRIAL === 'true';
const TRIAL_CODES = ['trial_used', 'trial_network_limit', 'trial_day_full', 'trial_month_full', 'trial_busy', 'bot_check_failed'];
// Limits that make a new trial impossible for now: shown as a calm card with «شاهد المحاكاة», not as an error.
export const TRIAL_BLOCKED_CODES = ['trial_day_full', 'trial_month_full', 'trial_network_limit'];
// Public (production) wording: no setup details. Anything not caused by the visitor becomes "unavailable".
const PUBLIC_ERRORS = {
  mic_denied: ERRORS.mic_denied, mic_missing: ERRORS.mic_missing,
  mic_unavailable: 'المتصفح لا يدعم الوصول للميكروفون هنا. جرّب متصفحًا آخر.',
  unauthorized: ERRORS.unauthorized,
  rate_limited: 'وصلت المحادثة المباشرة إلى حدّها المسموح حاليًا. تقدر تشاهد المحادثة المسجّلة بدلًا منها.',
  unavailable: 'المحادثة المباشرة غير متاحة الآن. تقدر تشاهد المحادثة المسجّلة بدلًا منها.',
  trial_used: ERRORS.trial_used, trial_network_limit: ERRORS.trial_network_limit, trial_day_full: ERRORS.trial_day_full, trial_month_full: ERRORS.trial_month_full,
  trial_busy: ERRORS.trial_busy, bot_check_failed: ERRORS.bot_check_failed,
  connection: 'انتهت المكالمة أو انقطع الاتصال. قد يكون وقت الجلسة أو حدّ العرض انتهى.',
};
export function messageFor(code, dev = import.meta.env?.DEV === true) {
  if (dev) return ERRORS[code] || ERRORS.upstream;
  return PUBLIC_ERRORS[code] || PUBLIC_ERRORS.unavailable;
}

async function ensureMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('mic_unavailable'), { code: 'mic_unavailable' });
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop()); // permission only; the SDK opens its own stream
  } catch (e) {
    const code = e?.name === 'NotAllowedError' ? 'mic_denied' : e?.name === 'NotFoundError' ? 'mic_missing' : 'mic_unavailable';
    throw Object.assign(new Error(code), { code });
  }
}

async function fetchToken(turnstile) {
  let r;
  try { r = await fetch('/api/conversation-token', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(turnstile ? { turnstile } : {}), signal: AbortSignal.timeout(60000) }); }
  catch { throw Object.assign(new Error('server_down'), { code: 'server_down' }); }
  if ([403, 429].includes(r.status)) { // public-trial quota / bot check: show the friendly message for that exact case
    const code = (await r.clone().json().catch(() => null))?.error;
    if (TRIAL_CODES.includes(code)) throw Object.assign(new Error(code), { code });
  }
  if (r.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
  if (r.status === 403) throw Object.assign(new Error('needs_approval'), { code: 'needs_approval' });
  if (r.status === 429) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
  if (r.status === 503) {
    const body = await r.json().catch(() => null);
    const code = body?.error === 'auth_not_configured' ? 'auth_not_configured' : 'not_configured';
    throw Object.assign(new Error(code), { code });
  }
  if (r.status === 502 || r.status === 504) {
    // Vite proxy returns 502/504 when the token server is not running.
    const body = await r.json().catch(() => null);
    throw Object.assign(new Error(body ? 'upstream' : 'server_down'), { code: body ? 'upstream' : 'server_down', detail: body });
  }
  if (!r.ok) throw Object.assign(new Error('upstream'), { code: 'upstream', detail: r.status });
  const { token, sessionId, seconds } = await r.json();
  if (!token) throw Object.assign(new Error('upstream'), { code: 'upstream' });
  return { token, sessionId: sessionId || null, seconds: seconds || null };
}
// Tells the server how a trial ended: a session that never connected is refunded (once per visitor per day).
function reportTrialEnd(sessionId, connected) {
  if (!sessionId) return;
  try { fetch('/api/trial-end', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, connected }) }).catch(() => {}); } catch { /* best effort */ }
}

const band = (data, from, to) => {
  if (!data || !data.length) return 0;
  let s = 0, n = 0;
  for (let i = from; i < Math.min(to, data.length); i++) { s += data[i]; n++; }
  return n ? s / n / 255 : 0;
};

export default function useLiveConversation() {
  const [isMuted, setMuted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null); // lets the UI re-show the access form on 'unauthorized'
  const [awaitingAgent, setAwaitingAgent] = useState(false); // used to infer "thinking"
  const [starting, setStarting] = useState(false);
  const [trialEnded, setTrialEnded] = useState(false);
  const [trialUsed, setTrialUsed] = useState(false); // one live trial per anonymous visitor (server decides)
  const [trialBlocked, setTrialBlocked] = useState(null); // daily / monthly / network limit reached (server decides)
  useEffect(() => {
    if (!PUBLIC_TRIAL) return;
    fetch('/api/trial-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j?.used) setTrialUsed(true); else if (TRIAL_BLOCKED_CODES.includes(j?.blocked)) setTrialBlocked(j.blocked); }).catch(() => {});
  }, []);
  const trial = useRef({ sessionId: null, connected: false, reported: false });
  const finishTrial = () => { const t = trial.current; if (t.sessionId && !t.reported) { t.reported = true; reportTrialEnd(t.sessionId, t.connected); } };
  const endedByUser = useRef(false);
  const generation = useRef(0);
  const startLock = useRef(false);
  const timeout = useRef(null);
  const sequence = useRef(0);

  const conversation = useConversation({
    micMuted: isMuted,
    onConnect: () => { setStarting(false); trial.current.connected = true; if (PUBLIC_TRIAL) setTrialUsed(true); },
    onDisconnect: (details) => {
      clearTimeout(timeout.current); setStarting(false); startLock.current = false;
      setAwaitingAgent(false); finishTrial();
      if (details?.reason === 'error' && !endedByUser.current) { setError(messageFor('connection')); setErrorCode('connection'); }
    },
    onError: () => {
      setError(messageFor('connection')); setErrorCode('connection');
      convRef.current.endSession();
      setStarting(false); startLock.current = false;
    },
    onModeChange: ({ mode }) => { if (mode === 'speaking') setAwaitingAgent(false); },
    onMessage: ({ message, role, event_id }) => {
      if (!message) return;
      if (role === 'user') setAwaitingAgent(true);
      if (role === 'agent') setAwaitingAgent(false);
      setMessages((prev) => {
        const id = `${role}-${event_id ?? `local-${++sequence.current}`}`;
        const i = prev.findIndex((m) => m.id === id);
        if (i >= 0) { const copy = prev.slice(); copy[i] = { ...copy[i], text: message }; return copy; }
        return [...prev, { id, role, text: message }];
      });
    },
  });

  const { status, mode } = conversation;
  const connected = status === 'connected';

  const start = useCallback(async (turnstile) => {
    if (startLock.current || ['connected', 'connecting'].includes(convRef.current.status)) return;
    startLock.current = true;
    const attempt = ++generation.current;
    setError(null); setErrorCode(null); setMessages([]); setAwaitingAgent(false); setStarting(true);
    endedByUser.current = false; setTrialEnded(false); trial.current = { sessionId: null, connected: false, reported: false };
    try {
      // Microphone first: a denied/missing microphone must not use a rate-limited session.
      await ensureMicPermission();
      if (attempt !== generation.current) return;
      const { token: conversationToken, sessionId, seconds } = await fetchToken(turnstile);
      trial.current.sessionId = sessionId;
      if (attempt !== generation.current) { finishTrial(); return; }
      // Trial: the page ends the call at 60 s (ElevenLabs also ends it at 60 s server-side), then offers the simulation.
      const limitMs = seconds ? seconds * 1000 : 180_000;
      timeout.current = setTimeout(() => { if (seconds) { endedByUser.current = true; setTrialEnded(true); } convRef.current.endSession(); setStarting(false); }, limitMs);
      conversation.startSession({ conversationToken, connectionType: 'webrtc' });
    } catch (e) {
      // Never log upstream bodies, tokens or conversation data.
      if (attempt === generation.current) {
        if (e.code === 'trial_used') { setTrialUsed(true); return; } // shown as the calm 'already used' card, not an error
        if (TRIAL_BLOCKED_CODES.includes(e.code)) { setTrialBlocked(e.code); return; } // calm 'limit reached' card
        setError(messageFor(e.code || 'upstream')); setErrorCode(e.code || 'upstream');
      }
    } finally {
      if (attempt === generation.current) { setStarting(false); startLock.current = false; }
    }
  }, [conversation]);

  const end = useCallback(() => {
    endedByUser.current = true; ++generation.current;
    clearTimeout(timeout.current); startLock.current = false; setStarting(false);
    conversation.endSession(); finishTrial();
    setAwaitingAgent(false);
  }, [conversation]);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  // Polled every animation frame by the orb.
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const getLevels = useCallback(() => {
    const c = convRef.current;
    if (c.status !== 'connected') return { input: 0, output: 0, bass: 0, high: 0 };
    try {
      const out = c.getOutputByteFrequencyData();
      return {
        input: c.getInputVolume(),
        output: c.getOutputVolume(),
        bass: band(out, 0, 8),
        high: band(out, 24, 64),
      };
    } catch { return { input: 0, output: 0, bass: 0, high: 0 }; }
  }, []);

  useEffect(() => () => { ++generation.current; clearTimeout(timeout.current); try { convRef.current.endSession(); } catch { /* not started */ } }, []);

  let phase = 'idle';
  if (starting || status === 'connecting') phase = 'connecting';
  else if (connected) phase = mode === 'speaking' ? 'speaking' : awaitingAgent ? 'thinking' : 'listening';

  return {
    isSimulated: false,
    status: starting ? 'connecting' : status === 'disconnecting' ? 'disconnected' : status,
    phase, isMuted, messages, error, errorCode,
    start, end, toggleMute, getLevels,
    trialSeconds: PUBLIC_TRIAL ? 60 : null, trialEnded, trialUsed,
    trialBlocked, trialBlockedMessage: trialBlocked ? messageFor(trialBlocked) : null,
  };
}
