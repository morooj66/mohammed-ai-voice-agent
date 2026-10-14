// Offline editing of a finished AI-to-AI recording (no API calls, no audio generation).
// 1. dropCues: optionally remove whole exchanges (explicit cue indices), refusing edits that would
//    create a misleading transition (two consecutive lines by the same speaker, or removing the
//    opening/closing line).
// 2. shortenPauses: shorten long SILENT gaps between lines. A gap is cut only if every removed
//    sample is below the silence threshold, so speech is never removed by pause shortening.
// Subtitle cues are re-timed from the exact same sample cut list, so audio and subtitles stay in sync.
import { wavFile } from './recorder.mjs';

export const EDIT_DEFAULTS = Object.freeze({ maxGapMs: 700, keepGapMs: 450, leadMs: 300, tailMs: 700, fadeMs: 5, silenceThreshold: 200 });

export function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw Error('not_a_wav');
  let offset = 12, rate = 0, channels = 0, bits = 0, data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), body = offset + 8;
    if (id === 'fmt ') { channels = buffer.readUInt16LE(body + 2); rate = buffer.readUInt32LE(body + 4); bits = buffer.readUInt16LE(body + 14); }
    if (id === 'data') data = buffer.subarray(body, body + size);
    offset = body + size + (size % 2);
  }
  if (!data || channels !== 1 || bits !== 16 || !rate) throw Error('unsupported_wav (expected mono 16-bit PCM)');
  const samples = new Int16Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
  return { rate, samples };
}
export { wavFile };

const toSample = (seconds, rate) => Math.round(seconds * rate);
const toSeconds = (sample, rate) => Number((sample / rate).toFixed(3));

function silent(samples, from, to, threshold) {
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i++) if (Math.abs(samples[i]) > threshold) return false;
  return true;
}

// Remove sorted, non-overlapping [a, b) sample intervals; short fades at each join avoid clicks.
function applyCuts(samples, intervals, rate, fadeMs) {
  const kept = [];
  let cursor = 0;
  for (const [a, b] of intervals) { if (a > cursor) kept.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (cursor < samples.length) kept.push([cursor, samples.length]);
  const out = new Int16Array(kept.reduce((n, [a, b]) => n + (b - a), 0));
  const fade = Math.max(1, toSample(fadeMs / 1000, rate));
  let w = 0;
  kept.forEach(([a, b], k) => {
    out.set(samples.subarray(a, b), w);
    const len = b - a;
    if (k > 0) for (let i = 0; i < Math.min(fade, len); i++) out[w + i] = Math.round(out[w + i] * (i / fade));
    if (k < kept.length - 1) for (let i = 0; i < Math.min(fade, len); i++) out[w + len - 1 - i] = Math.round(out[w + len - 1 - i] * (i / fade));
    w += len;
  });
  return out;
}

// New position of an original sample after the cuts (a point inside a cut maps to the cut start).
function mapSample(s, intervals) {
  let removed = 0;
  for (const [a, b] of intervals) { if (s >= b) removed += b - a; else if (s > a) { removed += s - a; break; } else break; }
  return s - removed;
}

function retime(cues, intervals, rate) {
  return cues.map((c) => ({ ...c, start: toSeconds(mapSample(toSample(c.start, rate), intervals), rate), end: toSeconds(mapSample(toSample(c.end, rate), intervals), rate) }));
}

export function dropCues(samples, rate, cues, drop = [], { fadeMs = EDIT_DEFAULTS.fadeMs } = {}) {
  const set = new Set(drop);
  for (const i of set) if (!Number.isInteger(i) || i < 0 || i >= cues.length) throw Error(`invalid_drop_index:${i}`);
  if (set.has(0) || set.has(cues.length - 1)) throw Error('refused: cannot drop the opening or closing line');
  const keptCues = cues.filter((_, i) => !set.has(i));
  for (let i = 1; i < keptCues.length; i++) {
    if (keptCues[i].speaker === keptCues[i - 1].speaker) throw Error(`refused: dropping would join two consecutive ${keptCues[i].speaker} lines (misleading transition) at kept line ${i}`);
  }
  // Each dropped run (lines i..j) is cut from the middle of the silence before it to the middle of the
  // silence after it, so both joins fall in silence and the kept lines' speech is never faded or trimmed.
  const mid = (a, b) => toSample((a + b) / 2, rate);
  const intervals = [];
  for (let i = 0; i < cues.length; i++) {
    if (!set.has(i)) continue;
    let j = i; while (set.has(j + 1)) j++;
    intervals.push([mid(cues[i - 1].end, cues[i].start), mid(cues[j].end, cues[j + 1].start)]);
    i = j;
  }
  return { samples: applyCuts(samples, intervals, rate, fadeMs), cues: retime(keptCues, intervals, rate), removedSamples: intervals.reduce((n, [a, b]) => n + b - a, 0), droppedIds: cues.filter((_, i) => set.has(i)).map((c) => c.id) };
}

export function shortenPauses(samples, rate, cues, options = {}) {
  const o = { ...EDIT_DEFAULTS, ...options };
  const intervals = [], skipped = [];
  const keepHalf = toSample(o.keepGapMs / 2000, rate);
  const tryCut = (a, b, label) => {
    if (b <= a) return;
    if (silent(samples, a, b, o.silenceThreshold)) intervals.push([a, b]);
    else skipped.push(label);
  };
  if (cues.length) tryCut(0, toSample(cues[0].start, rate) - toSample(o.leadMs / 1000, rate), 'lead');
  for (let i = 0; i + 1 < cues.length; i++) {
    const end = toSample(cues[i].end, rate), next = toSample(cues[i + 1].start, rate);
    if (next - end > toSample(o.maxGapMs / 1000, rate)) tryCut(end + keepHalf, next - keepHalf, `gap_after_line_${i}`);
  }
  if (cues.length) tryCut(toSample(cues.at(-1).end, rate) + toSample(o.tailMs / 1000, rate), samples.length, 'tail');
  intervals.sort((x, y) => x[0] - y[0]);
  return { samples: applyCuts(samples, intervals, rate, o.fadeMs), cues: retime(cues, intervals, rate), removedSamples: intervals.reduce((n, [a, b]) => n + b - a, 0), gapsShortened: intervals.length, skipped };
}

export function editRecording(samples, rate, cues, { drop = [], ...options } = {}) {
  const dropped = drop.length ? dropCues(samples, rate, cues, drop, options) : { samples, cues, removedSamples: 0, droppedIds: [] };
  const paused = shortenPauses(dropped.samples, rate, dropped.cues, options);
  return { samples: paused.samples, cues: paused.cues, log: {
    droppedLineIds: dropped.droppedIds, droppedSeconds: toSeconds(dropped.removedSamples, rate),
    pauseSecondsRemoved: toSeconds(paused.removedSamples, rate), gapsShortened: paused.gapsShortened,
    gapsSkippedBecauseNotSilent: paused.skipped, params: { ...EDIT_DEFAULTS, ...options },
  } };
}
