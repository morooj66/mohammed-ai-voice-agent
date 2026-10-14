import { useEffect, useRef } from 'react';

// Cloudflare Turnstile (bot check for the public trial). The site key is public by design; the secret key stays on
// the server, which verifies every token. 'interaction-only' keeps it invisible unless a visitor must be checked.
const SITE_KEY = import.meta.env?.VITE_TURNSTILE_SITE_KEY || '';
export const turnstileConfigured = Boolean(SITE_KEY);
let loader;
const load = () => loader || (loader = new Promise((resolve, reject) => {
  if (window.turnstile) return resolve(window.turnstile);
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async = true;
  s.onload = () => resolve(window.turnstile); s.onerror = reject; document.head.append(s);
}));

export default function Turnstile({ onToken, resetKey = 0 }) {
  const box = useRef(null), id = useRef(null), cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    if (!SITE_KEY) return undefined;
    let alive = true;
    load().then((t) => {
      if (!alive || !box.current) return;
      id.current = t.render(box.current, { sitekey: SITE_KEY, theme: 'dark', appearance: 'interaction-only', language: 'ar',
        callback: (token) => cb.current(token), 'expired-callback': () => cb.current(null), 'error-callback': () => cb.current(null) });
    }).catch(() => cb.current(null));
    return () => { alive = false; try { window.turnstile?.remove(id.current); } catch { /* already removed */ } };
  }, []);
  // A Turnstile token is single-use: get a fresh one after every attempt.
  useEffect(() => { if (resetKey && id.current != null) { try { window.turnstile?.reset(id.current); } catch { /* ignore */ } cb.current(null); } }, [resetKey]);
  return SITE_KEY ? <div className="turnstile" ref={box} /> : null;
}
