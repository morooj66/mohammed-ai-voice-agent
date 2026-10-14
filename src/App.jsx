import { useEffect, useState } from 'react';
import VoiceUI from './components/VoiceUI.jsx';
import RecordedPlayer from './components/RecordedPlayer.jsx';
import useAIConversation from './hooks/useAIConversation.js';
import useLiveConversation, { PUBLIC_TRIAL } from './hooks/useLiveConversation.js';
import { ConversationProvider } from '@elevenlabs/react';
import { resolveMode } from './lib/modes.js';


const MODE = resolveMode(typeof window === 'undefined' ? '' : window.location.search);

// UI hint only (not security): the real session is the HttpOnly cookie checked by the server.
// Mirrors the cookie's 30-minute lifetime; cleared whenever the server answers 'unauthorized'.
const UNLOCK_KEY = 'demo_unlocked_until';
const readUnlocked = () => { try { return Number(sessionStorage.getItem(UNLOCK_KEY)) > Date.now(); } catch { return false; } };
const writeUnlocked = (on) => { try { on ? sessionStorage.setItem(UNLOCK_KEY, String(Date.now() + 30 * 60_000)) : sessionStorage.removeItem(UNLOCK_KEY); } catch { /* storage unavailable */ } };

function useUnlock(convo) {
  const [unlocked, setUnlocked] = useState(readUnlocked);
  useEffect(() => { if (convo.errorCode === 'unauthorized') { writeUnlocked(false); setUnlocked(false); } }, [convo.errorCode]);
  return [unlocked, () => { writeUnlocked(true); setUnlocked(true); }];
}

function Protected({ convo }) {
  const [unlocked, unlock] = useUnlock(convo);
  // Public trial: no access code; the server protects it (Turnstile + Redis quota + 60 s enforced by ElevenLabs).
  if (PUBLIC_TRIAL && convo.trialSeconds) return <VoiceUI convo={convo} accessForm={null} />;
  return <VoiceUI convo={convo} accessForm={unlocked ? null : <AccessForm onUnlocked={unlock} />} />;
}
function LiveInner() { return <Protected convo={useLiveConversation()} />; }
function LiveApp() { return <ConversationProvider><LiveInner /></ConversationProvider>; }
function GenerateApp() { return <Protected convo={useAIConversation()} />; }
export default function App() { return MODE === 'recorded' ? <RecordedPlayer /> : MODE === 'generate' ? <GenerateApp /> : <LiveApp />; }

function AccessForm({ onUnlocked }) {
  const [accessCode, setAccessCode] = useState('');
  const [accessMessage, setAccessMessage] = useState('');
  async function unlock(e) {
    e.preventDefault();
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: accessCode }) });
      if (r.ok) { setAccessCode(''); onUnlocked?.(); return; }
      const dev = import.meta.env?.DEV === true;
      setAccessMessage(r.status === 503 ? (dev ? 'إعدادات الدخول ناقصة في ملف ‎.env‎ (SESSION_SECRET وDEMO_ACCESS_CODE).' : 'الدخول غير متاح الآن.')
        : r.status === 429 ? 'محاولات كثيرة؛ حاول بعد قليل.' : 'الرمز غير صحيح.');
    } catch { setAccessMessage('تعذّر الاتصال بخادم العرض.'); }
    setAccessCode('');
  }

  return (<form className="access-form" onSubmit={unlock}>
        <label htmlFor="access-code">رمز العرض الخاص</label>
        <input id="access-code" type="password" autoComplete="off" value={accessCode} onChange={e => setAccessCode(e.target.value)} required />
        <button className="ctl" type="submit">فتح الوصول</button>
        <span role="status">{accessMessage}</span>
      </form>);
}
