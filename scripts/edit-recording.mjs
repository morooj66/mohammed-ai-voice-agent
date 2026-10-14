// OFFLINE edit of a finished recording: shorten silent pauses and, optionally, drop whole exchanges.
// No API calls, no audio generation. Output goes to recordings-raw/edited/ (git-ignored) for review.
//
//   node scripts/edit-recording.mjs recordings-raw/<name>.json                 # pauses only
//   node scripts/edit-recording.mjs recordings-raw/<name>.json --drop=5,6      # also drop lines 5 and 6
//   options: --max-gap=0.7  --keep-gap=0.45  (seconds)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editRecording, readWav, wavFile } from '../server/simulator/edit.mjs';

export function parseArgs(argv) {
  const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const drop = opt('drop') ? opt('drop').split(',').map((n) => Number(n.trim())) : [];
  const seconds = (v, fallback) => (v === undefined ? fallback : Number(v) * 1000);
  return { input: argv.find((a) => !a.startsWith('--')), drop,
    maxGapMs: seconds(opt('max-gap'), undefined), keepGapMs: seconds(opt('keep-gap'), undefined) };
}

function main(argv) {
  const { input, drop, maxGapMs, keepGapMs } = parseArgs(argv);
  if (!input) { console.log('Usage: node scripts/edit-recording.mjs recordings-raw/<name>.json [--drop=i,j] [--max-gap=0.7] [--keep-gap=0.45]'); process.exitCode = 2; return; }
  const metaPath = resolve(input), meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const { rate, samples } = readWav(readFileSync(join(dirname(metaPath), meta.audioFile)));
  const options = Object.fromEntries(Object.entries({ drop, maxGapMs, keepGapMs }).filter(([, v]) => v !== undefined));
  const edited = editRecording(samples, rate, meta.transcript, options);
  const name = `${basename(metaPath, '.json')}-edited`;
  const outDir = fileURLToPath(new URL('../recordings-raw/edited/', import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.wav`), wavFile(edited.samples, rate));
  const duration = Number((edited.samples.length / rate).toFixed(3));
  const out = { ...meta, audioFile: `${name}.wav`, duration, transcript: edited.cues,
    edit: { source: basename(metaPath), sourceDuration: meta.duration, sourceComplete: meta.complete === true, ...edited.log } };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`Edited: ${meta.duration}s -> ${duration}s · pauses removed ${edited.log.pauseSecondsRemoved}s (${edited.log.gapsShortened} cuts) · dropped ${edited.log.droppedLineIds.length} line(s) ${edited.log.droppedSeconds}s`);
  if (edited.log.gapsSkippedBecauseNotSilent.length) console.log(`Not shortened (not silent): ${edited.log.gapsSkippedBecauseNotSilent.join(', ')}`);
  edited.cues.forEach((c, i) => console.log(`  ${String(i).padStart(2)} ${c.speaker === 'agent' ? 'Mohammed' : 'Khalid  '} ${c.start.toFixed(2)}–${c.end.toFixed(2)}s`));
  console.log(`Saved recordings-raw/edited/${name}.{wav,json} (review before building a fixture).`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
}
