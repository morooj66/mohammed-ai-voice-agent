// Offline multi-track mixer for the SCRIPTED demo (no network, no paid calls).
// Two separate acoustic worlds:
//   Khalid bus   = (Khalid voice + street bed + horns) -> mobile-phone band (300–3400 Hz), panned slightly left.
//   Mohammed bus = Mohammed voice -> headset (high-pass 90 Hz) + very low call-centre bed, panned slightly right.
// Voices are always clearly above the beds; the only intended exception is the horn that interrupts line 7.
// Lines 13–15 (the phone number) are protected: no events, beds ducked further.

export const RATE = 48000;
export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-12));

// ---------- audio helpers ----------
export function readWav16(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw Error('not_a_wav');
  let o = 12, ch = 0, rate = 0, bits = 0, data = null;
  while (o + 8 <= buffer.length) {
    const id = buffer.toString('ascii', o, o + 4), size = buffer.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = buffer.readUInt16LE(o + 10); rate = buffer.readUInt32LE(o + 12); bits = buffer.readUInt16LE(o + 22); }
    if (id === 'data') data = buffer.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  if (bits !== 16 || !data || !ch) throw Error('wav_must_be_16bit_pcm');
  const n = Math.floor(data.length / 2 / ch), out = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = data.readInt16LE((i * ch + c) * 2) / 32768;
  return { rate, channels: out };
}
export function pcm16ToFloat(buf) { const n = buf.length >> 1, f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768; return f; }
export function resample(x, from, to) {
  if (from === to) return Float32Array.from(x);
  const n = Math.floor(x.length * to / from), y = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), t = p - k; y[i] = (x[k] ?? 0) * (1 - t) + (x[k + 1] ?? x[k] ?? 0) * t; }
  return y;
}
export const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
export const peak = (x) => { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); return p; };

// RBJ biquad (direct form I), applied in place on a copy.
export function biquad(x, type, f0, q = 0.707, rate = RATE) {
  const w = 2 * Math.PI * f0 / rate, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2; const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else if (type === 'highpass') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  else throw Error(`unknown_filter:${type}`);
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
// Steep (8th-order) mobile-phone band so Khalid clearly sounds like a call from the street.
export const phoneBand = (x) => [3400, 3400, 3400, 3400].reduce((y, f) => biquad(y, 'lowpass', f), [300, 300].reduce((y, f) => biquad(y, 'highpass', f), x));
export const headset = (x) => biquad(x, 'highpass', 90);
// HD mobile-call band (VoLTE-like). v2 sends the street bed + horns through it so engine/tyre rumble survives
// (the 300 Hz phone high-pass turned v1's traffic into applause-like hiss). Khalid's voice keeps phoneBand.
export const hdBand = (x) => [7000, 7000].reduce((y, f) => biquad(y, 'lowpass', f), [100, 100].reduce((y, f) => biquad(y, 'highpass', f), x));
export const sliceClip = (x, startSec, endSec, fadeMs = 30) => { const a = Math.round(startSec * RATE), b = Math.round(endSec * RATE), f = Math.round(fadeMs / 1000 * RATE);
  return Float32Array.from(x.subarray(a, b), (v, i) => v * Math.min(1, i / f, (b - a - i) / f)); };

// Bed of the required length from one or more sources, crossfaded (no hard loop seams), starting at an offset.
export function bed(sources, length, { offset = 0, fade = Math.round(0.8 * RATE) } = {}) {
  const out = new Float32Array(length); let w = 0, s = 0, pos = Math.min(offset, Math.max(0, sources[0].length - 1));
  while (w < length) {
    const src = sources[s % sources.length], seg = src.subarray(pos);
    for (let i = 0; i < seg.length && w + i < length; i++) {
      const fin = w > 0 && i < fade ? i / fade : 1;
      out[w + i] = out[w + i] * (w > 0 && i < fade ? 1 - fin : 0) + seg[i] * fin;
    }
    w += Math.max(1, seg.length - fade); s++; pos = 0;
  }
  return out;
}
export const normalizeRms = (x, targetDb) => { const g = dbToGain(targetDb) / Math.max(rms(x), 1e-9); return x.map((v) => v * g); };
export function hangupTone(rate = RATE) { // three 425 Hz pips (local synthesis, no asset)
  const pip = Math.round(0.18 * rate), gap = Math.round(0.12 * rate), y = new Float32Array(3 * pip + 2 * gap);
  for (let k = 0; k < 3; k++) for (let i = 0; i < pip; i++) { const env = Math.min(1, i / 240, (pip - i) / 240); y[k * (pip + gap) + i] = 0.5 * env * Math.sin(2 * Math.PI * 425 * i / rate); }
  return y;
}

// ---------- timeline ----------
// voices[n] = { samples: Float32Array @RATE, cutSec?: number }. Returns line start/end (seconds) + event times.
export function buildTimeline(script, voices, { leadIn = 0.6, tail = 1.4 } = {}) {
  const lines = []; let prevEnd = leadIn;
  for (const l of script.lines) {
    const v = voices[l.n]; if (!v) throw Error(`missing_voice_line_${l.n}`);
    const dur = (v.cutSec ?? v.samples.length / RATE);
    const start = l.n === 1 ? leadIn : l.overlapMs ? prevEnd - l.overlapMs / 1000 : prevEnd + (l.gapMs ?? 350) / 1000;
    const end = start + dur; lines.push({ n: l.n, speaker: l.speaker, start, end, protected: !!l.protected }); prevEnd = end;
  }
  const byN = (n) => lines.find((x) => x.n === n);
  const events = script.events.map((e) => {
    if (e.atCutOfLine) { const L = byN(e.atCutOfLine); return { ...e, at: L.end - e.leadMs / 1000 }; }
    const L = byN(e.afterLine); return { ...e, at: L.end + (e.offsetMs ?? 0) / 1000 };
  });
  const duration = Math.max(...lines.map((l) => l.end), ...events.map((e) => e.at + 1)) + tail;
  const prot = lines.filter((l) => l.protected);
  const protectedWindow = prot.length ? { start: Math.min(...prot.map((l) => l.start)) - 1, end: Math.max(...prot.map((l) => l.end)) + 0.5 } : null;
  return { lines, events, duration, protectedWindow };
}
export function timelineProblems(script, tl) {
  const p = [];
  if (tl.protectedWindow) for (const e of tl.events) if (e.type !== 'hangup' && e.at > tl.protectedWindow.start - 0.2 && e.at < tl.protectedWindow.end) p.push(`event ${e.id} inside protected number window`);
  for (let i = 1; i < tl.lines.length; i++) { const L = tl.lines[i], P = tl.lines[i - 1], s = script.lines[i];
    if (!s.overlapMs && L.start < P.end - 1e-9) p.push(`line ${L.n} overlaps line ${P.n} without overlapMs`); }
  return p;
}

// ---------- render ----------
// sfx: { street: [Float32Array], office: [Float32Array], murmur: [Float32Array], horn_near, horn_far } (mono @RATE)
export function render(script, voices, sfx, { seed = 7 } = {}) {
  const m = script.mix, tl = buildTimeline(script, voices), N = Math.ceil(tl.duration * RATE);
  const kVoice = new Float32Array(N), mVoice = new Float32Array(N), kEvents = new Float32Array(N);
  const speaking = { khalid: new Uint8Array(N), mohammed: new Uint8Array(N) };
  for (const L of tl.lines) {
    const v = voices[L.n], len = Math.round((L.end - L.start) * RATE), s0 = Math.round(L.start * RATE);
    const voice = normalizeRms(v.samples.subarray(0, len), m.voiceTargetDbfs);
    const fade = Math.round(((m.cutFadeMs ?? 25) / 1000) * RATE); // v3: 120 ms fade under the horn (v1/v2: 25 ms)
    for (let i = 0; i < len && s0 + i < N; i++) {
      const g = v.cutSec != null && i > len - fade ? (len - i) / fade : 1;
      (L.speaker === 'khalid' ? kVoice : mVoice)[s0 + i] += voice[i] * g; speaking[L.speaker][s0 + i] = 1;
    }
  }
  for (const e of tl.events) {
    const clip = e.type === 'hangup' ? hangupTone() : sfx[e.type]; if (!clip) throw Error(`missing_sfx_${e.type}`);
    const s0 = Math.round(e.at * RATE), g = dbToGain(m.voiceTargetDbfs + e.gainDb) / Math.max(rms(clip), 1e-9) * (e.type === 'hangup' ? 1 : 1);
    const target = e.type === 'hangup' ? mVoice : kEvents; // hang-up tone is heard on Mohammed's line
    for (let i = 0; i < clip.length && s0 + i < N; i++) target[s0 + i] += clip[i] * g;
  }
  // Beds with ducking envelopes (smoothed), stronger inside the protected window.
  // v2: a busy street = continuous traffic base + pass-by layer played TOGETHER (sfx.streetLayers = [{ sources, gainDb }]).
  const street = sfx.streetLayers ? normalizeRms(sfx.streetLayers.reduce((acc, L, k) => { const b = normalizeRms(bed(L.sources, N, { offset: (seed * (7919 + k * 104729)) % Math.max(1, L.sources[0].length - RATE) }), L.gainDb);
      for (let i = 0; i < N; i++) acc[i] += b[i]; return acc; }, new Float32Array(N)), m.streetBedDb)
    : normalizeRms(bed(sfx.street, N, { offset: (seed * 7919) % Math.max(1, sfx.street[0].length - RATE) }), m.streetBedDb);
  const office = normalizeRms(bed(sfx.office, N, { offset: (seed * 104729) % Math.max(1, sfx.office[0].length - RATE) }), m.officeBedDb);
  const murmur = sfx.murmur?.length ? normalizeRms(bed(sfx.murmur, N, { offset: (seed * 1299709) % Math.max(1, sfx.murmur[0].length - RATE) }), m.officeBedDb - 4) : new Float32Array(N);
  const pw = tl.protectedWindow, duckEnv = (flags) => { const env = new Float32Array(N); let g = 1; const a = 1 - Math.exp(-1 / (0.08 * RATE));
    for (let i = 0; i < N; i++) { const inP = pw && i >= pw.start * RATE && i < pw.end * RATE; const t = dbToGain(-(flags[i] ? m.duckDb : 0) - (inP ? m.protectedExtraDuckDb : 0)); g += (t - g) * a; env[i] = g; } return env; };
  const kDuck = duckEnv(speaking.khalid), mDuck = duckEnv(speaking.mohammed);
  const kBus = new Float32Array(N), mBus = new Float32Array(N);
  const streetDucked = new Float32Array(N), officeDucked = new Float32Array(N);
  for (let i = 0; i < N; i++) { streetDucked[i] = street[i] * kDuck[i]; officeDucked[i] = (office[i] + murmur[i]) * mDuck[i]; }
  // Adaptive safety: real ambience varies (a bus passing). Inside any line where the bed would come within
  // minVoiceOverBedDb of the voice, lower the bed only as much as needed, with smooth 150 ms ramps.
  const minGap = m.minVoiceOverBedDb ?? 16, ramp = Math.round(0.15 * RATE);
  for (const L of tl.lines) {
    const a = Math.round(L.start * RATE), b = Math.min(N, Math.round(L.end * RATE));
    const [voice, bedArr] = L.speaker === 'khalid' ? [kVoice, streetDucked] : [mVoice, officeDucked];
    const need = (rms(voice, a, b) * dbToGain(-minGap)) / Math.max(rms(bedArr, a, b), 1e-9);
    if (need >= 1) continue;
    for (let i = Math.max(0, a - ramp); i < Math.min(N, b + ramp); i++) {
      const w = i < a ? (i - (a - ramp)) / ramp : i >= b ? 1 - (i - b) / ramp : 1;
      bedArr[i] *= 1 - (1 - need) * Math.max(0, Math.min(1, w));
    }
  }
  for (let i = 0; i < N; i++) { kBus[i] = kVoice[i] + streetDucked[i] + kEvents[i]; mBus[i] = mVoice[i] + officeDucked[i]; }
  let kOut;
  if (m.khalidBedBand === 'hd') { // v2: voice on the phone band as in v1; street + horns on the HD band
    const vOut = phoneBand(kVoice), bedIn = new Float32Array(N); for (let i = 0; i < N; i++) bedIn[i] = streetDucked[i] + kEvents[i];
    const bOut = hdBand(bedIn); kOut = new Float32Array(N); for (let i = 0; i < N; i++) kOut[i] = vOut[i] + bOut[i];
  } else kOut = phoneBand(kBus);
  const mOut = headset(mBus);
  // Constant-power pan to stereo, then a single master gain so the true peak stays <= -1 dBFS.
  const pan = (p) => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];
  const [kl, kr] = pan(m.khalidPan), [ml, mr] = pan(m.mohammedPan);
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) { L[i] = kOut[i] * kl + mOut[i] * ml; R[i] = kOut[i] * kr + mOut[i] * mr; }
  // -2 dBFS ceiling leaves room for AAC encoding overshoot (measured +1.4 dB on the scratch export).
  const pk = Math.max(peak(L), peak(R)), master = pk > dbToGain(-2) ? dbToGain(-2) / pk : 1;
  for (let i = 0; i < N; i++) { L[i] *= master; R[i] *= master; }
  return { left: L, right: R, timeline: tl, stems: { kVoice, mVoice, street, office, kEvents, streetDucked, officeDucked }, master, buses: { kOut, mOut } };
}

export function stereoWav(left, right, rate = RATE) {
  const n = left.length, data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), i * 4); data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), i * 4 + 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

// Subtitle cues for the player (seconds), using the approved on-screen text (line 7 shows the interrupted form).
export const cues = (script, tl) => tl.lines.map((L) => { const s = script.lines.find((x) => x.n === L.n);
  return { id: `line-${L.n}`, speaker: L.speaker === 'mohammed' ? 'agent' : 'customer', text: s.subtitle || s.text, start: +L.start.toFixed(3), end: +L.end.toFixed(3) }; });

// Cut point of a line from TTS character alignment: end time of the last character of `marker`.
export function cutSecFromAlignment(alignment, requestText, marker) {
  const chars = alignment?.characters, ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(ends) || chars.length !== ends.length) throw Error('alignment_missing');
  const joined = chars.join(''), i = joined.indexOf(marker);
  if (i < 0) throw Error('cut_marker_not_found_in_alignment');
  return ends[i + marker.length - 1];
}
