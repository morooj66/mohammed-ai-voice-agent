// Makes a SHORTER COPY of a local draft recording: samples [0, cut) copied unchanged, transcript cues
// kept only when they end before the cut. The source WAV/JSON are never modified; no network.
// Usage: node scripts/trim-draft.mjs <draft-id> <cut-seconds> <new-suffix>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readWav } from '../server/simulator/edit.mjs';
import { wavFile } from '../server/simulator/recorder.mjs';

export function trimDraft(fixture, samples, rate, cut, newId) {
  const end = Math.round(cut * rate);
  if (!(end > 0 && end <= samples.length)) throw Error('cut_outside_recording');
  const crossing = fixture.transcript.find((c) => c.start < cut && c.end > cut);
  if (crossing) throw Error(`cut_inside_line:${crossing.id}`); // never cut mid-sentence
  const transcript = fixture.transcript.filter((c) => c.end <= cut);
  return {
    samples: samples.subarray(0, end),
    fixture: { ...fixture, id: newId, audioSrc: `/recordings/${newId}.wav`, duration: end / rate, transcript,
      provenance: `${fixture.provenance} مقطع مختصر: من البداية حتى ${cut.toFixed(3)} ث (بعد انتهاء جملة محمد)، دون أي تعديل آخر.`,
      trim: { sourceId: fixture.id, cutSeconds: cut, keptLineIds: transcript.map((c) => c.id) } },
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const [id, cutArg, suffix] = process.argv.slice(2);
  const dir = new URL('../preview/draft-public/recordings/', import.meta.url);
  const newId = `${id}-${suffix}`;
  for (const ext of ['wav', 'json']) if (existsSync(new URL(`${newId}.${ext}`, dir))) throw Error(`refusing_to_overwrite:${newId}.${ext}`);
  const fixture = JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8'));
  const { samples, rate } = readWav(readFileSync(new URL(`${id}.wav`, dir)));
  const out = trimDraft(fixture, samples, rate, Number(cutArg), newId);
  writeFileSync(new URL(`${newId}.wav`, dir), wavFile(out.samples, rate));
  writeFileSync(new URL(`${newId}.json`, dir), `${JSON.stringify(out.fixture, null, 2)}\n`);
  console.log(`WROTE ${newId}.wav/.json · ${out.fixture.duration.toFixed(3)} s · lines ${out.fixture.trim.keptLineIds.join(', ')}`);
}
