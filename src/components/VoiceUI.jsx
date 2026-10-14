import { useEffect, useMemo, useRef, useState } from 'react';
import Orb from './Orb.jsx';
import Turnstile, { turnstileConfigured } from './Turnstile.jsx';

const PHASE_LABEL = {
  idle: 'جاهز للمحادثة',
  connecting: 'جارٍ الاتصال…',
  listening: 'أسمعك…',
  thinking: 'لحظة، أراجع طلبك…',
  speaking: 'محمد يتحدث',
};

const Icon = {
  mic: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /></svg>
  ),
  micOff: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1" /><path d="M19 11a7 7 0 0 1-11.6 5.3M5 11a7 7 0 0 0 .6 2.8M12 18v3M3 3l18 18" /></svg>
  ),
  phone: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></svg>
  ),
  end: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15.5c5-4.7 13-4.7 18 0l-2.2 2.6-3.6-1.4.1-2.6a12 12 0 0 0-6.6 0l.1 2.6-3.6 1.4Z" /></svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" /><path d="M8 9h8M8 12h5" /></svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
  ),
  shield: (
    <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 5 7v8c0 7 4.7 11.8 11 14 6.3-2.2 11-7 11-14V7L16 3Z" /><path d="M11 16.5l3.4 3.4L21.5 12" /></svg>
  ),
};

export default function VoiceUI({ convo, accessForm }) {
  const { status, phase, isMuted, messages, error, start, end, toggleMute, getLevels } = convo;
  const [showTranscript, setShowTranscript] = useState(false);
  const [botToken, setBotToken] = useState(null), [botReset, setBotReset] = useState(0);
  const trialSeconds = convo.trialSeconds || null; // public 60-second trial (live mode only)
  const listRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const automated = convo.previewOnly ? !convo.singleParticipant : convo.isAutomated || convo.isSimulated;
  const callerName = convo.callerName || 'خالد'; // the simulated customer (Khalid by default)
  const active = status === 'connected' || status === 'connecting';
  useEffect(() => {
    if (!active) return;
    const began = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - began) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const connected = status === 'connected';
  const busy = status === 'connecting';
  const live = !convo.isRecorded && !automated && !convo.previewOnly && !convo.isSimulated;
  // No live trial possible right now (used, ended or a limit reached): the card with «شاهد المحاكاة» takes priority.
  const trialOver = Boolean(convo.trialSeconds && (convo.trialUsed || convo.trialEnded || convo.trialBlocked) && !connected && !busy);
  const locked = live && Boolean(accessForm); // live calls need the access code first (the server enforces it too)
  const caption = useMemo(() => convo.isRecorded
    ? (convo.playing && convo.cue ? { role: convo.cue.speaker === 'agent' ? 'agent' : 'user', text: convo.cue.text } : null)
    : messages[messages.length - 1], [convo.isRecorded, convo.playing, convo.cue, messages]);
  const captionOn = Boolean(caption && (connected || convo.isRecorded));

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, showTranscript]);

  return (
    <div className={`app app--${phase} ${showTranscript ? 'app--transcript' : ''} ${convo.exporting ? 'app--exporting' : ''} ${trialOver ? 'app--trial-over' : ''}`}>
      <div className="bg" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">{Icon.shield}</span>
          <div className="brand__text">
            <strong>محمد</strong>
            <span>المساعد الصوتي لتأمين المركبات</span>
          </div>
        </div>
        <div className="badges">
          {/* One badge that says what the visitor is looking at: live agent vs. written simulation vs. real AI-to-AI call. */}
          {convo.isRecorded && <span className="badge badge--sim">{!convo.available ? 'قيد الإعداد' : convo.fixture.kind === 'scripted' ? (convo.fixture.draft ? 'محاكاة مكتوبة — مسودة' : 'محاكاة صوتية مكتوبة') : convo.fixture.draft ? 'تسجيل تجريبي' : 'مكالمة آلية حقيقية'}</span>}
          {convo.isSimulated && <span className="badge badge--sim">نموذج نصي ثابت — بلا صوت</span>}
          {live && <span className="badge badge--sim">وكيل مباشر</span>}
        </div>
      </header>

      <main className="stage">
        <nav className="mode-switch" aria-label="وضع المحادثة">
          <a href="?mode=live" aria-current={!convo.isRecorded && !convo.isAutomated ? 'page' : undefined}>تحدث مع محمد</a>
          <a href="?mode=recorded" aria-current={convo.isRecorded ? 'page' : undefined}>شاهد المحاكاة</a>
        </nav>
        {convo.callerSwitch}
        {convo.isRecorded && <p className="demo-note">{!convo.available ? 'التسجيل قيد الإعداد.' : convo.fixture.kind === 'scripted' ? 'سيناريو مكتوب بأصوات الوكيلين — ليست مكالمة مباشرة.' : 'مكالمة آلية حقيقية بين وكيلَي المشروع.'}{convo.available && convo.fixture.draft ? ' (مسودة للتقييم الداخلي)' : ''}</p>}
        {live && <p className="demo-note">يطلب المتصفح إذن الميكروفون، ويُعالَج صوتك عبر ElevenLabs أثناء المكالمة. لا تشارك معلومات شخصية.{trialSeconds ? ' نحفظ معرّفًا عشوائيًا في متصفحك لنعرف إن كانت تجربتك المجانية قد استُخدمت.' : ''}{locked ? ' المحادثة المباشرة تتطلب رمز العرض الخاص.' : ''}</p>}
        {convo.previewOnly && !convo.isRecorded && <p className="demo-note">معاينة الواجهة فقط — المكالمات والميكروفون معطّلان. الحوار نصي مكتوب مسبقًا، بلا صوت أو تكلفة.</p>}
        {convo.isAutomated && <p className="demo-note">مولّد داخلي للمحادثة الآلية — مدفوع ومحمي برمز العرض، وغير معروض في الواجهة العامة</p>}
        {convo.isRecorded && <audio ref={convo.audioRef} src={convo.fixture.audioSrc || undefined} preload="none" aria-label="تسجيل المحادثة" />}
        <div className={automated ? 'orb-pair' : 'orb-single'}>
        <div className="participant participant--mohammed">
        <Orb phase={phase} getLevels={getLevels} muted={isMuted} />
        {automated && <span>محمد · {convo.isRecorded ? (phase === 'speaking' ? 'يتحدث' : convo.playing ? 'يستمع' : 'جاهز') : PHASE_LABEL[phase]}</span>}
        </div>
        {automated && <div className="participant participant--khalid">
          <Orb palette="magenta" phase={convo.khalidPhase || (phase === 'listening' ? 'speaking' : 'listening')} getLevels={convo.getKhalidLevels || getLevels} muted={false} />
          <span>{callerName} · {convo.khalidPhase === 'speaking' ? 'يتحدث' : convo.khalidPhase === 'thinking' ? 'يفكّر' : (connected || convo.playing) ? 'يستمع' : 'جاهز'}</span>
          {convo.emotion && <small>{({ STRESSED: 'متوتر', FRUSTRATED: 'منزعج', CONFUSED: 'محتار', CALMING_DOWN: 'بدأ يهدأ', RELIEVED: 'مرتاح' })[convo.emotion]}</small>}
        </div>}
        </div>
        <div className="session-meta"><span>{convo.isRecorded ? (convo.fixture?.kind === 'scripted' ? (convo.playing ? 'تشغيل المحاكاة' : 'المحاكاة متوقفة') : (convo.playing ? 'تشغيل التسجيل' : 'التسجيل متوقف')) : convo.isSimulated ? (connected ? 'المعاينة قيد التشغيل' : 'معاينة محلية') : connected ? 'متصل' : busy ? 'جارٍ الاتصال' : 'غير متصل'}</span> · <time>{convo.isRecorded ? `${Math.floor(convo.position / 60)}:${String(Math.floor(convo.position % 60)).padStart(2, '0')} / ${Math.floor(convo.duration / 60)}:${String(Math.floor(convo.duration % 60)).padStart(2, '0')}` : trialSeconds && (connected || busy) ? (() => { const left = Math.max(0, trialSeconds - elapsed); return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} متبقية`; })() : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}</time></div>

        <div className="status" role="status" aria-live="polite">
          <span className={`status__dot status__dot--${phase}`} />
          <span className="status__label">{convo.isRecorded ? (() => { const medium = convo.fixture?.kind === 'scripted' ? 'المحاكاة' : 'التسجيل'; const who = convo.cue?.speaker; return convo.playing ? (who === 'agent' ? `محمد يتحدث في ${medium}` : who === 'customer' ? `${callerName} يتحدث في ${medium}` : (medium === 'المحاكاة' ? 'المحاكاة تعمل' : 'التسجيل يعمل')) : (medium === 'المحاكاة' ? 'المحاكاة متوقفة' : 'التسجيل متوقف'); })() : PHASE_LABEL[phase]}</span>
          {isMuted && connected && <span className="status__muted">الميكروفون مكتوم</span>}
        </div>

        <p className={`caption ${captionOn ? 'caption--on' : ''}`} dir="rtl">
          {caption && (connected || convo.isRecorded) ? (
            <>
              <span className="caption__who">{caption.role === 'agent' ? 'محمد' : automated ? callerName : 'أنت'}</span>
              {caption.text}
            </>
          ) : (
            <span className="caption__hint">{convo.isRecorded ? (!convo.available ? 'التسجيل المعتمد قيد الإعداد' : convo.playing ? '' : convo.fixture?.kind === 'scripted' ? 'شغّل المحاكاة لمتابعة النص المتزامن' : 'شغّل التسجيل لمتابعة النص المتزامن') : convo.previewOnly ? 'اضغط «ابدأ المعاينة» لعرض حوار نصي تجريبي' : automated ? 'اضغط «ابدأ المحاكاة» لمشاهدة الحوار' : trialSeconds ? (convo.trialUsed || convo.trialEnded || convo.trialBlocked ? '' : 'تجربة مجانية لمدة 60 ثانية') : 'اضغط «ابدأ المحادثة» وتكلّم بشكل طبيعي'}</span>
          )}
        </p>

        {convo.canExport && <div className="export-bar"><button className="ctl" onClick={convo.exportVideo} disabled={!convo.available || convo.exporting}>تصدير فيديو</button><span role="status">{convo.exportStatus}</span></div>}
        {trialSeconds && convo.trialEnded && !connected && !busy && (
          <div className="trial-end" role="status"><span>انتهت التجربة المجانية — شكرًا لك</span><a className="ctl ctl--main" href="?mode=recorded">شاهد المحاكاة</a></div>
        )}
        {trialSeconds && convo.trialUsed && !convo.trialEnded && !connected && !busy && (
          <div className="trial-end" role="status"><span>استخدمت تجربتك المباشرة سابقًا — المحاكاة متاحة لك دائمًا</span><a className="ctl ctl--main" href="?mode=recorded">شاهد المحاكاة</a></div>
        )}
        {trialSeconds && convo.trialBlocked && !convo.trialUsed && !convo.trialEnded && !connected && !busy && (
          <div className="trial-end" role="status"><span>{convo.trialBlockedMessage}</span><a className="ctl ctl--main" href="?mode=recorded">شاهد المحاكاة</a></div>
        )}
        {(error || convo.error) && (
          <div className="alert" role="alert">
            <span>{error || convo.error}</span>
            {live && convo.errorCode && !String(convo.errorCode).startsWith('mic_') && convo.errorCode !== 'unauthorized' && <a href="?mode=recorded"> شاهد المحادثة المسجّلة</a>}
          </div>
        )}
      </main>

      {convo.isRecorded && <div className="recording-progress"><input aria-label="موضع التسجيل" type="range" min="0" max={convo.duration || 0} step="0.1" value={convo.position} onChange={e => convo.seek(Number(e.target.value))} disabled={!convo.available} /><div className="recorded-transcript" aria-live="polite">{convo.messages.length ? convo.messages.map(m => <p key={m.id} className={(convo.cue?.id ?? convo.fixture.transcript.indexOf(convo.cue)) === m.id ? 'recorded-transcript__active' : ''}><b>{m.role === 'agent' ? 'محمد' : callerName}</b> {m.text}</p>) : <p>التسجيل المعتمد قيد الإعداد</p>}</div></div>}

      <footer className="controls">
        {convo.recordingFiles && <><a className="ctl ctl--main" href={convo.recordingFiles.audioUrl} download={convo.recordingFiles.audioName}>تنزيل الصوت</a><a className="ctl" href={convo.recordingFiles.transcriptUrl} download={convo.recordingFiles.transcriptName}>تنزيل النص والتوقيت</a></>}
        {convo.isRecorded && <><button className="ctl" onClick={convo.play} disabled={!convo.available || convo.playing}>▶ تشغيل</button><button className="ctl" onClick={convo.pause} disabled={!convo.available || !convo.playing}>Ⅱ إيقاف مؤقت</button><button className="ctl" onClick={convo.replay} disabled={!convo.available}>⟲ إعادة</button><button className="ctl" onClick={convo.stop} disabled={!convo.available}>■ إيقاف</button></>}
        {!convo.isRecorded && <><button
          hidden={automated || convo.previewOnly}
          className={`ctl ctl--round ${isMuted ? 'ctl--active' : ''}`}
          onClick={toggleMute}
          disabled={!connected}
          aria-pressed={isMuted}
          aria-label={isMuted ? 'إلغاء كتم الميكروفون' : 'كتم الميكروفون'}
          title={isMuted ? 'إلغاء الكتم' : 'كتم'}
        >
          {isMuted ? Icon.micOff : Icon.mic}
        </button>

        {connected || busy ? (
          <button className="ctl ctl--main ctl--end" onClick={end} aria-label="إنهاء المحادثة">
            {Icon.end}<span>{automated ? 'إيقاف المحاكاة' : 'إنهاء المحادثة'}</span>
          </button>
        ) : (
          <button className="ctl ctl--main" onClick={trialSeconds ? () => { start(botToken); setBotReset((k) => k + 1); } : start} disabled={locked || (trialSeconds && (convo.trialUsed || convo.trialBlocked || (turnstileConfigured && !botToken)))} title={locked ? 'أدخل رمز العرض الخاص أولًا' : undefined} aria-label="ابدأ المحادثة">
            {Icon.phone}<span>{convo.previewOnly ? 'ابدأ المعاينة' : automated ? 'ابدأ المحاكاة' : 'ابدأ المحادثة'}</span>
          </button>
        )}

        <button
          className={`ctl ctl--round ${showTranscript ? 'ctl--active' : ''}`}
          onClick={() => setShowTranscript((v) => !v)}
          aria-expanded={showTranscript}
          aria-controls="transcript"
          aria-label="نص المحادثة"
          title="نص المحادثة"
        >
          {Icon.chat}
        </button></>}
      </footer>

      {!convo.isSimulated && !convo.isRecorded && !convo.previewOnly && !connected && !busy && accessForm}

      {trialSeconds && live && !convo.trialUsed && !convo.trialBlocked && <Turnstile onToken={setBotToken} resetKey={botReset} />}
      <p className="disclaimer">هذا مشروع تجريبي مستقل، ولا يتبع نجم أو أي شركة تأمين.</p>

      <aside id="transcript" className={`transcript ${showTranscript ? 'transcript--open' : ''}`} aria-hidden={!showTranscript} inert={showTranscript ? undefined : ''}>
        <div className="transcript__head">
          <h2>نص المحادثة</h2>
          <button className="ctl ctl--ghost" onClick={() => setShowTranscript(false)} aria-label="إغلاق">{Icon.close}</button>
        </div>
        <ol ref={listRef} className="transcript__list">
          {messages.length === 0 && <li className="transcript__empty">لا توجد رسائل بعد.</li>}
          {messages.map((m) => (
            <li key={m.id} className={`msg msg--${m.role}`}>
              <span className="msg__who">{m.role === 'agent' ? 'محمد' : automated ? callerName : 'أنت'}</span>
              <p>{m.text}</p>{m.recognized && <small>ما سمعه محمد: {m.recognized}</small>}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
