import { useEffect, useRef } from 'react';
import { VERT, FRAG } from './orbShader.js';

// Orb + surrounding audio-reactive waves.
// Props:
//   phase     : 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'
//   getLevels : () => ({ input, output, bass, high })  (all 0..1), polled every frame
//   muted     : boolean
// The component owns one requestAnimationFrame loop for both layers.

// Colour palettes. 'blue' reproduces the original orb exactly (Mohammed); 'magenta' is Khalid.
export const PALETTES = Object.freeze({
  blue: { deep: [0.035, 0.110, 0.360], blue: [0.160, 0.420, 1.000], turq: [0.180, 0.900, 0.840],
    waves: ['rgba(46, 230, 214,', 'rgba(41, 107, 255,', 'rgba(120, 200, 255,'] },
  magenta: { deep: [0.260, 0.040, 0.420], blue: [0.880, 0.200, 1.000], turq: [1.000, 0.560, 1.000],
    waves: ['rgba(255, 120, 220,', 'rgba(230, 46, 200,', 'rgba(255, 170, 235,'] },
});

const PHASE_WEIGHTS = {
  idle: { idle: 1, listen: 0, think: 0, speak: 0 },
  connecting: { idle: 0.4, listen: 0, think: 0.6, speak: 0 },
  listening: { idle: 0, listen: 1, think: 0, speak: 0 },
  thinking: { idle: 0, listen: 0, think: 1, speak: 0 },
  speaking: { idle: 0, listen: 0, think: 0, speak: 1 },
};

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
  return s;
}

function initGL(canvas) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: true });
  if (!gl) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const u = {};
  for (const n of ['uRes', 'uTime', 'uLevel', 'uBass', 'uHigh', 'uIdle', 'uListen', 'uThink', 'uSpeak', 'uMuted', 'uDeep', 'uBlue', 'uTurq']) {
    u[n] = gl.getUniformLocation(prog, n);
  }
  return { gl, u };
}

// Smooth toward a target with separate attack/release (audio-meter style).
const follow = (cur, target, dt, attack, release) => {
  const k = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt * k));
};

function drawWaves(ctx, w, h, s, t, colors = PALETTES.blue.waves) {
  // Three soft circular waveforms around the orb, reacting to the active audio.
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const base = Math.min(w, h) * 0.30;                 // matches orb radius in the shader
  const energy = s.level * (s.listen + s.speak);
  const layers = [
    { off: 0.085, amp: 0.020, freq: 6, speed: 0.55, color: colors[0], alpha: 0.38 },
    { off: 0.125, amp: 0.028, freq: 4, speed: -0.40, color: colors[1], alpha: 0.30 },
    { off: 0.170, amp: 0.034, freq: 3, speed: 0.30, color: colors[2], alpha: 0.18 },
  ];
  ctx.lineCap = 'round';
  for (const L of layers) {
    const r0 = base * (1 + L.off) + base * 0.03 * s.think * Math.sin(t * 1.2);
    const amp = base * L.amp * (0.25 + 2.2 * energy + 0.8 * s.bass * s.speak);
    const a = L.alpha * (0.55 + 1.0 * energy + 0.35 * s.think + 0.25 * s.idle);
    ctx.beginPath();
    const steps = 180;
    for (let i = 0; i <= steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      const n = Math.sin(th * L.freq + t * L.speed * 4)
        + 0.5 * Math.sin(th * (L.freq * 2 + 1) - t * L.speed * 6) * (0.3 + s.high)
        + 0.3 * Math.sin(th * 2 + t * 0.7);
      const r = r0 + amp * n;
      const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = `${L.color} ${Math.min(a, 0.85)})`;
    ctx.lineWidth = Math.max(1, base * 0.006);
    ctx.shadowColor = `${L.color} 0.6)`;
    ctx.shadowBlur = base * 0.06;
    ctx.stroke();
  }
}

export default function Orb({ phase, getLevels, muted, palette = 'blue' }) {
  const glRef = useRef(null);
  const waveRef = useRef(null);
  const fallbackRef = useRef(null);
  const propsRef = useRef({ phase, getLevels, muted, palette });
  propsRef.current = { phase, getLevels, muted, palette };

  useEffect(() => {
    const glCanvas = glRef.current, waveCanvas = waveRef.current;
    let glState = null;
    try { glState = initGL(glCanvas); } catch (e) { console.warn('WebGL unavailable, using CSS fallback', e); }
    if (!glState) fallbackRef.current?.classList.add('orb-fallback--on');
    const wctx = waveCanvas.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const s = { level: 0, bass: 0, high: 0, idle: 1, listen: 0, think: 0, speak: 0, muted: 0 };
    let raf = 0, last = performance.now(), t0 = last;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const c of [glCanvas, waveCanvas]) {
        const { width, height } = c.getBoundingClientRect();
        c.width = Math.max(1, Math.round(width * dpr));
        c.height = Math.max(1, Math.round(height * dpr));
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(glCanvas);

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const t = reduceMotion ? 0 : (now - t0) / 1000;
      const { phase: ph, getLevels: gl, muted: mu, palette: pal } = propsRef.current;
      const colors = PALETTES[pal] || PALETTES.blue;
      const lv = gl ? gl() : { input: 0, output: 0, bass: 0, high: 0 };
      const target = PHASE_WEIGHTS[ph] || PHASE_WEIGHTS.idle;
      // Pick the audio that matters for the current state.
      const raw = ph === 'speaking' ? lv.output : ph === 'listening' ? (mu ? 0 : lv.input) : 0;
      s.level = follow(s.level, raw, dt, 18, 5);
      s.bass = follow(s.bass, ph === 'speaking' ? lv.bass : 0, dt, 14, 4);
      s.high = follow(s.high, ph === 'speaking' ? lv.high : 0, dt, 14, 4);
      for (const k of ['idle', 'listen', 'think', 'speak']) s[k] = follow(s[k], target[k], dt, 4, 4);
      s.muted = follow(s.muted, mu ? 1 : 0, dt, 6, 6);

      if (glState) {
        const { gl: g, u } = glState;
        g.viewport(0, 0, glCanvas.width, glCanvas.height);
        g.clearColor(0, 0, 0, 0);
        g.clear(g.COLOR_BUFFER_BIT);
        g.uniform2f(u.uRes, glCanvas.width, glCanvas.height);
        g.uniform1f(u.uTime, t);
        g.uniform1f(u.uLevel, s.level);
        g.uniform1f(u.uBass, s.bass);
        g.uniform1f(u.uHigh, s.high);
        g.uniform1f(u.uIdle, s.idle);
        g.uniform1f(u.uListen, s.listen);
        g.uniform1f(u.uThink, s.think);
        g.uniform1f(u.uSpeak, s.speak);
        g.uniform1f(u.uMuted, s.muted);
        g.uniform3fv(u.uDeep, colors.deep);
        g.uniform3fv(u.uBlue, colors.blue);
        g.uniform3fv(u.uTurq, colors.turq);
        g.drawArrays(g.TRIANGLES, 0, 6);
      } else if (fallbackRef.current) {
        fallbackRef.current.style.transform = `scale(${1 + 0.08 * s.level})`;
      }
      drawWaves(wctx, waveCanvas.width, waveCanvas.height, s, t, colors.waves);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return (
    <div className={`orb orb--${palette}`} aria-hidden="true">
      <canvas ref={waveRef} className="orb__layer orb__waves" />
      <canvas ref={glRef} className="orb__layer orb__gl" />
      <div ref={fallbackRef} className="orb-fallback" />
    </div>
  );
}
