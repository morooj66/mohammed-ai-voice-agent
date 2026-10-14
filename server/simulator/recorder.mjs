// Server-side conversation recorder for the AI-to-AI bridge.
//
// It records ONLY audio that actually crossed the bridge:
//   - 'agent': Mohammed's real ElevenLabs output chunks, placed at their arrival time
//   - 'user' : Khalid's synthesized PCM, placed at the moment it starts being sent to the agent
// Segments are laid on one timeline (never overlapping: a segment starts at
// max(arrival, end of previous audio)), which mirrors how the browser queues playback.
// Transcript cue times are derived from the sample positions, so subtitles match the audio exactly.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUTPUT_RATE = 24000;

// Loudness matching for Khalid's lines (run 3: his lines varied by 10 dB). Gain is computed on voiced 20 ms frames
// so pauses don't skew it; a peak ceiling prevents clipping. Returns a new PCM buffer.
export function normalizePcm(buffer, rate, { targetDbfs = -16, ceilingDbfs = -1 } = {}) {
  const s = pcmToInt16(buffer), w = Math.max(1, Math.round(rate / 50)); let e = 0, n = 0, peak = 1;
  for (let i = 0; i + w <= s.length; i += w) { let q = 0; for (let j = i; j < i + w; j++) q += s[j] * s[j]; if (Math.sqrt(q / w) > 183) { e += q; n += w; } }
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  if (!n) return buffer;
  const gain = Math.min(10 ** (targetDbfs / 20) * 32768 / Math.sqrt(e / n), 10 ** (ceilingDbfs / 20) * 32768 / peak);
  const out = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[i] * gain))), i * 2);
  return out;
}
// Cut trailing silence (keeps keepMs after the last voiced frame) so the agent's turn detection starts sooner.
export function trimTail(buffer, rate, keepMs = 150) {
  const s = pcmToInt16(buffer), w = Math.max(1, Math.round(rate / 50)); let last = -1;
  for (let i = 0; i + w <= s.length; i += w) { let q = 0; for (let j = i; j < i + w; j++) q += s[j] * s[j]; if (Math.sqrt(q / w) > 183) last = i + w; }
  if (last < 0) return buffer;
  const end = Math.min(s.length, last + Math.round(rate * keepMs / 1000));
  return buffer.subarray(0, end * 2);
}

export function resample(int16, fromRate, toRate) {
  if (fromRate === toRate) return int16;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(int16.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, int16.length - 1), f = pos - i0;
    out[i] = Math.round(int16[i0] * (1 - f) + int16[i1] * f);
  }
  return out;
}

export function pcmToInt16(buffer) {
  if (buffer.length % 2) throw Error('invalid_pcm');
  const out = new Int16Array(buffer.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buffer.readInt16LE(i * 2);
  return out;
}

export function wavFile(int16, rate) {
  const data = Buffer.alloc(int16.length * 2);
  for (let i = 0; i < int16.length; i++) data.writeInt16LE(int16[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export class ConversationRecorder {
  constructor({ now = Date.now, rate = OUTPUT_RATE } = {}) {
    this.now = now; this.rate = rate; this.t0 = null;
    this.segments = [];          // { role, startSample, samples: Int16Array, utterance }
    this.cursor = 0;             // end of the last placed audio, in samples
    this.utterances = [];        // { role, id, text, emotion }
    this.lastRole = null;
  }
  // Called when a transcript line exists for an utterance (agent text may arrive before/after its audio).
  text(id, role, text, emotion) {
    const existing = this.utterances.find((u) => u.id === id);
    if (existing) { existing.text = text; if (emotion) existing.emotion = emotion; return; }
    this.utterances.push({ id, role, text, emotion: emotion || null });
  }
  // Expressive audio tags such as "[Empathetically]" direct the voice but are not spoken words.
  static spoken(text) { return String(text).replace(/\[[A-Za-z][A-Za-z ,'-]{0,40}\]\s*/g, '').trim();
  }
  audio(role, pcmBuffer, inputRate) {
    if (!['agent', 'user'].includes(role) || !pcmBuffer?.length) return;
    const t = this.now();
    if (this.t0 === null) this.t0 = t;
    const samples = resample(pcmToInt16(pcmBuffer), inputRate, this.rate);
    const arrival = Math.round(((t - this.t0) / 1000) * this.rate);
    const startSample = Math.max(arrival, this.cursor);
    // A role change starts a new utterance group; consecutive chunks of one speaker belong together.
    if (role !== this.lastRole) { this.lastRole = role; this.groupIndex = (this.groupIndex ?? -1) + 1; }
    this.segments.push({ role, startSample, samples, group: this.groupIndex });
    this.cursor = startSample + samples.length;
  }
  // Build the mixed timeline + cues. Groups of each role are matched in order to that role's utterances.
  build() {
    const total = this.cursor;
    const mix = new Int16Array(total);
    for (const s of this.segments) mix.set(s.samples, s.startSample);
    const groups = new Map();
    for (const s of this.segments) {
      const g = groups.get(s.group) || { role: s.role, start: s.startSample, end: 0 };
      g.end = Math.max(g.end, s.startSample + s.samples.length);
      groups.set(s.group, g);
    }
    const ordered = [...groups.values()].sort((a, b) => a.start - b.start);
    const byRole = { agent: this.utterances.filter((u) => u.role === 'agent'), user: this.utterances.filter((u) => u.role === 'user') };
    const used = { agent: 0, user: 0 };
    const transcript = [];
    for (const g of ordered) {
      const u = byRole[g.role][used[g.role]++];
      if (!u) continue; // audio without a transcript line is kept in the audio but not captioned
      transcript.push({
        id: u.id, speaker: g.role === 'agent' ? 'agent' : 'customer', text: ConversationRecorder.spoken(u.text),
        ...(ConversationRecorder.spoken(u.text) !== u.text ? { raw: u.text } : {}),
        ...(u.emotion ? { emotion: u.emotion } : {}),
        start: Number((g.start / this.rate).toFixed(3)), end: Number((g.end / this.rate).toFixed(3)),
      });
    }
    const unmatched = { agent: byRole.agent.length - used.agent, user: byRole.user.length - used.user };
    return { mix, duration: Number((total / this.rate).toFixed(3)), transcript, unmatched };
  }
  save(dir, name, { completionReason = 'unknown', metadata = {} } = {}) {
    const { mix, duration, transcript, unmatched } = this.build();
    if (!mix.length) throw Error('nothing_recorded');
    mkdirSync(dir, { recursive: true });
    const wav = `${name}.wav`;
    writeFileSync(join(dir, wav), wavFile(mix, this.rate));
    const callerName = metadata.caller?.nameAr || metadata.caller?.name || metadata.caller?.id || 'simulated caller';
    const meta = { kind: 'recording', audioFile: wav, sampleRate: this.rate, duration, complete: completionReason === 'natural_end', completionReason, ...metadata, transcript, unmatchedTranscriptLines: unmatched,
      provenance: `Real AI-to-AI session: Mohammed = live ElevenLabs agent output; ${callerName} = simulated customer (fictional scenario).` };
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(meta, null, 2) + '\n');
    return { wav: join(dir, wav), json: join(dir, `${name}.json`), duration, cues: transcript.length, unmatched };
  }
}
