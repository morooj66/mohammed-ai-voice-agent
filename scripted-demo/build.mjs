// Builds the scripted-demo mix offline (no network).
//   node scripted-demo/build.mjs --scratch   SCRATCH mix: real licensed SFX + stand-in voice clips cut from an existing
//                                            local recording (only to judge the two environments; never published).
//   node scripted-demo/build.mjs             FINAL mix from generated stems (production/scripted-demo/stems/line-NN.*).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RATE, readWav16, pcm16ToFloat, resample, render, stereoWav, cues, timelineProblems, rms, gainToDb, cutSecFromAlignment, sliceClip } from './mixer.mjs';

const root = new URL('../', import.meta.url), P = (p) => fileURLToPath(new URL(p, root));
const ARG = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const VERSION = ARG('version') || 'v1', BG_PREVIEW = process.argv.includes('--bg-preview');
const v1Script = JSON.parse(readFileSync(P('scripted-demo/script.json'), 'utf8'));
const vScript = VERSION === 'v1' ? v1Script : JSON.parse(readFileSync(P(`scripted-demo/script-${VERSION}.json`), 'utf8'));
// --bg-preview: the approved v1 lines, stems and timing with ONLY the backgrounds/mix of the chosen version.
const script = BG_PREVIEW ? { ...v1Script, events: vScript.events, mix: vScript.mix, sfx: vScript.sfx } : vScript;
const SFX = P('production/scripted-demo/sfx/work/'), OUT = P('production/scripted-demo/out/'), STEMS = P(VERSION === 'v1' || BG_PREVIEW ? 'production/scripted-demo/stems/' : `production/scripted-demo/stems-${VERSION}/`);
const mono = (f) => { const { rate, channels } = readWav16(readFileSync(SFX + f)); const m = channels.length === 1 ? channels[0] : channels[0].map((v, i) => (v + channels[1][i]) / 2); return resample(m, rate, RATE); };
export const SFX_CHOICE = { street: ['mixkit-2930.48k.wav', 'mixkit-2463.48k.wav'], office: ['mixkit-447.48k.wav'], murmur: ['mixkit-610.48k.wav'], horn_near: 'mixkit-718.48k.wav', horn_far: 'mixkit-720.48k.wav' };
const clip = (c) => typeof c === 'string' ? mono(c) : c.start != null ? sliceClip(mono(c.file), c.start, c.end) : mono(c.file);
const loadSfx = () => {
  if (!script.sfx) return { street: SFX_CHOICE.street.map(mono), office: SFX_CHOICE.office.map(mono), murmur: SFX_CHOICE.murmur.map(mono), horn_near: mono(SFX_CHOICE.horn_near), horn_far: mono(SFX_CHOICE.horn_far) };
  const c = script.sfx, out = { office: c.office.map(mono), murmur: (c.murmur || []).map(mono) };
  if (c.streetLayers) { out.streetLayers = c.streetLayers.map((L) => ({ sources: L.sources.map(mono), gainDb: L.gainDb })); out.street = out.streetLayers[0].sources; } else out.street = c.street.map(mono);
  for (const k of Object.keys(c)) if (k.startsWith('horn')) out[k] = clip(c[k]);
  return out;
};

function scratchVoices() {
  const src = 'recordings-raw/khalid-mohammed-2026-10-12T04-02-01-020Z';
  const meta = JSON.parse(readFileSync(P(`${src}.json`), 'utf8')), { rate, channels } = readWav16(readFileSync(P(`recordings-raw/${meta.audioFile}`)));
  const pool = { mohammed: meta.transcript.filter((c) => c.speaker === 'agent'), khalid: meta.transcript.filter((c) => c.speaker === 'customer') }, used = { mohammed: 0, khalid: 0 };
  return Object.fromEntries(script.lines.map((l) => {
    const c = pool[l.speaker][used[l.speaker]++ % pool[l.speaker].length];
    const s = resample(channels[0].subarray(Math.round(c.start * rate), Math.round(c.end * rate)), rate, RATE);
    return [l.n, l.cutAfter ? { samples: s, cutSec: 0.6 * s.length / RATE } : { samples: s }];
  }));
}
function finalVoices() {
  return Object.fromEntries(script.lines.map((l) => {
    const base = `${STEMS}line-${String(l.n).padStart(2, '0')}`;
    if (!existsSync(`${base}.pcm`)) throw Error(`missing_generated_stem_line_${l.n}`);
    const samples = resample(pcm16ToFloat(readFileSync(`${base}.pcm`)), 24000, RATE);
    if (!l.cutAfter) return [l.n, { samples }];
    const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    return [l.n, { samples, cutSec: cutSecFromAlignment(meta.alignment, meta.requestText, l.cutAfter) }];
  }));
}

export function levelReport(out) {
  return out.timeline.lines.map((L) => { const a = Math.round(L.start * RATE), b = Math.round(L.end * RATE);
    const v = rms(L.speaker === 'khalid' ? out.stems.kVoice : out.stems.mVoice, a, b), bed = rms(L.speaker === 'khalid' ? out.stems.streetDucked : out.stems.officeDucked, a, b);
    return { n: L.n, speaker: L.speaker, start: +L.start.toFixed(2), end: +L.end.toFixed(2), voiceOverBedDb: +(gainToDb(v) - gainToDb(bed)).toFixed(1) }; });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const scratch = process.argv.includes('--scratch'), voices = scratch ? scratchVoices() : finalVoices();
  const out = render(script, voices, loadSfx()), problems = timelineProblems(script, out.timeline);
  if (problems.length) throw Error(`timeline_problems: ${problems.join('; ')}`);
  if (['v1', 'v2'].includes(VERSION) && !scratch && !BG_PREVIEW && !process.argv.includes(`--allow-${VERSION}-rebuild`)) throw Error('v1_is_locked: use --allow-v1-rebuild (locked copy in production/scripted-demo/locked-v1/)');
  mkdirSync(OUT, { recursive: true });
  const name = scratch ? 'SCRATCH-environment-check' : BG_PREVIEW ? `bg-preview-${VERSION}-backgrounds-on-v1-voices` : `khalid-mohammed-scripted-${VERSION}`;
  writeFileSync(`${OUT}${name}.wav`, stereoWav(out.left, out.right));
  const report = levelReport(out);
  writeFileSync(`${OUT}${name}.json`, JSON.stringify({ kind: scratch ? 'scratch' : BG_PREVIEW ? 'bg-preview' : 'scripted', duration: +out.timeline.duration.toFixed(3), sfx: script.sfx || SFX_CHOICE, masterGainDb: +gainToDb(out.master).toFixed(2), cues: cues(script, out.timeline), events: out.timeline.events.map((e) => ({ id: e.id, at: +e.at.toFixed(3) })), protectedWindow: out.timeline.protectedWindow, levels: report }, null, 1));
  console.log(`${scratch ? 'SCRATCH (stand-in voices, not publishable)' : 'FINAL'} mix: ${name}.wav · ${out.timeline.duration.toFixed(1)} s · min voice-over-bed ${Math.min(...report.map((r) => r.voiceOverBedDb))} dB · events ${out.timeline.events.map((e) => `${e.id}@${e.at.toFixed(1)}s`).join(', ')}`);
}
