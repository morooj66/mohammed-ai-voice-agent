// Scripted-demo deterministic frame renderer for the local preview (throwaway Chrome, loopback only, app code untouched).
// A virtual clock drives requestAnimationFrame/performance.now; for each frame n the <audio> element is seeked to
// n/30 s so subtitles, speaker indicators and orb levels follow the ORIGINAL recording's time exactly.
import { mkdirSync, writeFileSync } from 'node:fs';
const [URL_, OUT, FPS_ = '30'] = process.argv.slice(2); const FPS = Number(FPS_);
mkdirSync(`${OUT}/frames`, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); if (targets.some((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('exception:', m.params.exceptionDetails.exception?.description?.slice(0, 200)); };
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (m.result?.exceptionDetails) throw Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)); return m.result.result.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  let vt = 0; const q = new Map(); let nid = 1;
  performance.now = () => vt;
  window.requestAnimationFrame = (cb) => { const i = nid++; q.set(i, cb); return i; };
  window.cancelAnimationFrame = (i) => q.delete(i);
  window.__clock = { set: (ms) => { vt = ms; }, tick: () => { const cbs = [...q.values()]; q.clear(); for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } } } };
})();` });
await send('Page.navigate', { url: URL_ }); await sleep(3000);
const vp = JSON.parse(await ev('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})'));
if (vp.w !== 1920 || vp.h !== 1080 || vp.dpr !== 1) { console.log('ABORT viewport', vp); process.exit(1); }
const duration = await ev(`(async () => {
  // The app's own export look (same selectors as .app--exporting in src/styles.css; a class would be reset by React).
  const st = document.createElement('style'); st.textContent = '.controls, .mode-switch, .recording-progress, .export-bar, .alert { display: none !important; }'; document.head.append(st);
  const a = document.querySelector('audio'); a.preload = 'auto'; a.load();
  await new Promise((r) => { if (a.readyState >= 4) r(); else a.addEventListener('canplaythrough', r, { once: true }); });
  Object.defineProperty(a, 'paused', { get: () => false });                // levels/phase as during playback
  a.dispatchEvent(new Event('play'));                                       // the hook's own 'playing' state
  await new Promise((r) => setTimeout(r, 1500));                            // decoded copy for orb levels
  for (let i = 0; i < 30; i++) { __clock.set(i * 1000 / 30); __clock.tick(); } // warm-up: orbs settle in idle, t<0
  return a.duration; })()`);
const N = Math.round(duration * FPS);
console.log(`rendering ${N} frames at ${FPS} fps for ${duration} s`);
const t0 = Date.now(), checks = [];
for (let n = 0; n < N; n++) {
  const info = await ev(`(async () => {
    const a = document.querySelector('audio'), t = ${n} / ${FPS};
    __clock.set(1000 + t * 1000);
    if (Math.abs(a.currentTime - t) > 1e-6) { const s = new Promise((r) => a.addEventListener('seeked', r, { once: true })); a.currentTime = t; await s; }
    a.dispatchEvent(new Event('timeupdate'));
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    __clock.tick();
    await new Promise((r) => setTimeout(r, 0));
    return ${n % 150 === 0} ? JSON.stringify({ t, ct: a.currentTime, caption: document.querySelector('.caption, [class*=caption]')?.innerText?.slice(0, 50) || null, status: document.body.innerText.match(/\\d:\\d\\d \\/ \\d:\\d\\d/)?.[0] }) : null; })()`);
  if (info) checks.push(JSON.parse(info));
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 }, captureBeyondViewport: false });
  writeFileSync(`${OUT}/frames/${String(n).padStart(5, '0')}.jpg`, Buffer.from(shot.result.data, 'base64'));
  if (n % 300 === 0) console.log(`frame ${n}/${N} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
writeFileSync(`${OUT}/render.json`, JSON.stringify({ fps: FPS, frames: N, duration, checks }));
console.log(JSON.stringify({ frames: N, seconds: (Date.now() - t0) / 1000, checks: checks.slice(0, 12) }));
await send('Browser.close').catch(() => {}); process.exit(0);
