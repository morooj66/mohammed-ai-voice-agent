// Orb levels for prerecorded playback, computed from decoded samples at the element's current time.
// Playback itself never goes through Web Audio, so the orbs can never make the recording silent.
export function levelsAt(samples, rate, seconds, windowSize = 512) {
  if (!samples?.length || !(rate > 0) || !Number.isFinite(seconds)) return { output: 0, bass: 0, high: 0 };
  const from = Math.max(0, Math.min(samples.length - windowSize, Math.floor(seconds * rate)));
  const to = Math.min(samples.length, from + windowSize);
  if (to - from < 2) return { output: 0, bass: 0, high: 0 };
  let sum = 0, smooth = 0, low = 0, diff = 0;
  for (let i = from; i < to; i++) {
    const v = samples[i];
    sum += v * v;
    smooth += (v - smooth) * 0.15; low += smooth * smooth; // one-pole low-pass ≈ bass energy
    if (i > from) diff += Math.abs(v - samples[i - 1]);      // sample-to-sample change ≈ high energy
  }
  const n = to - from, rms = Math.sqrt(sum / n);
  return { output: Math.min(1, rms * 3), bass: Math.min(1, Math.sqrt(low / n) * 4), high: Math.min(1, (diff / (n - 1)) * 6) };
}

// Decodes the recording once (same-origin file, already cached by the <audio> element). Mono mixdown.
export async function decodeForLevels(url, fetchImpl = globalThis.fetch) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!url || !Offline) return null;
  const data = await (await fetchImpl(url)).arrayBuffer();
  const buffer = await new Offline(1, 1, 24000).decodeAudioData(data);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buffer.numberOfChannels;
  }
  return { samples: mono, rate: buffer.sampleRate };
}
