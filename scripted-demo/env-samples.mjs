// Background-only listening samples (no voices, no network): Mohammed's call-centre and Khalid's street, 12 s each.
// Levels mirror the mix relations (horn vs street), lifted so the background itself is easy to judge.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RATE, readWav16, resample, normalizeRms, headset, phoneBand, hdBand, sliceClip, biquad, rms, stereoWav, dbToGain } from './mixer.mjs';
const P = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url)), SFX = P('production/scripted-demo/sfx/work/');
const mono = (f) => { const { rate, channels } = readWav16(readFileSync(SFX + f)); return resample(channels.length === 1 ? channels[0] : channels[0].map((v, i) => (v + channels[1][i]) / 2), rate, RATE); };
const clip = (c) => typeof c === 'string' ? mono(c) : c.start != null ? sliceClip(mono(c.file), c.start, c.end) : mono(c.file);
// 12 s window with the largest engine-rumble movement (a vehicle approaching and passing).
function busiest(x, sec = 12) { const lo = biquad(biquad(x, 'lowpass', 250), 'lowpass', 250), w = RATE / 2, e = [];
  for (let i = 0; i + w <= lo.length; i += w) e.push(rms(lo, i, i + w)); let best = 0, score = -1;
  for (let k = 0; k + sec * 2 <= e.length; k++) { const seg = e.slice(k, k + sec * 2), s = Math.max(...seg) / Math.max(1e-9, Math.min(...seg)); if (s > score) { score = s; best = k; } }
  return x.subarray(best * w, best * w + sec * RATE); }
const pan = (x, p) => { const l = Math.cos((p + 1) * Math.PI / 4), r = Math.sin((p + 1) * Math.PI / 4); return [x.map((v) => v * l), x.map((v) => v * r)]; };
const place = (dst, src, atSec, g) => { const s0 = Math.round(atSec * RATE); for (let i = 0; i < src.length && s0 + i < dst.length; i++) dst[s0 + i] += src[i] * g; };
const limit = (x, ceilDb = -2) => { let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v)); const g = pk > dbToGain(ceilDb) ? dbToGain(ceilDb) / pk : 1; return x.map((v) => v * g); };

export function khalidEnv(cfg, { version }) {
  let street;
  if (cfg.streetLayers) { // layered busy street (v2): base + busiest pass-by window, summed
    const parts = cfg.streetLayers.map((L) => normalizeRms(L.name.includes('passing') ? busiest(mono(L.sources[0])) : mono(L.sources[0]).subarray(5 * RATE, 17 * RATE), L.gainDb));
    street = normalizeRms(parts.reduce((acc, p) => acc.map((v, i) => v + (p[i] || 0)), new Float32Array(12 * RATE)), -26);
  } else street = normalizeRms(busiest(mono(cfg.street[0])), -26);
  const far = clip(cfg.horn_far), near = clip(cfg.horn_near);
  const out = Float32Array.from(street), voiceRef = -26 + 12; // in the mix the street sits 12 dB under the voice level
  const farGain = version === 'v2' ? -14 : -24;
  place(out, far, 3.0, dbToGain(voiceRef + farGain) / rms(far));
  place(out, near, 8.0, dbToGain(voiceRef + 0) / rms(near)); // the sudden horn: at voice level, as in line 7
  return limit(version === 'v2' ? hdBand(out) : phoneBand(out));
}
export function mohammedEnv(cfg) {
  const beds = cfg.office.map(mono), bed = normalizeRms(beds[0].subarray(RATE * 20, RATE * 32), -30);
  if (cfg.murmur?.length) { const m = normalizeRms(mono(cfg.murmur[0]).subarray(0, 12 * RATE), -34); for (let i = 0; i < bed.length && i < m.length; i++) bed[i] += m[i]; }
  return limit(headset(bed));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const v1 = { street: ['mixkit-2930.48k.wav'], office: ['mixkit-447.48k.wav'], murmur: ['mixkit-610.48k.wav'], horn_near: 'mixkit-718.48k.wav', horn_far: 'mixkit-720.48k.wav' };
  const v2 = JSON.parse(readFileSync(P('scripted-demo/script-v2.json'), 'utf8')).sfx;
  const dir = P('production/scripted-demo/out/env-samples/'); mkdirSync(dir, { recursive: true });
  const write = (name, x, p) => { const [l, r] = pan(x, p); writeFileSync(`${dir}${name}.wav`, stereoWav(l, r)); console.log(`${name}.wav · ${(x.length / RATE).toFixed(1)} s`); };
  write('v2-mohammed-call-centre', mohammedEnv(v2), 0.25);
  write('v2-khalid-street', khalidEnv(v2, { version: 'v2' }), -0.25);
  write('v1-khalid-street-for-comparison', khalidEnv(v1, { version: 'v1' }), -0.25);
  write('v1-mohammed-office-for-comparison', mohammedEnv(v1), 0.25);
}
