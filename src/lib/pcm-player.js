export function decodePCM(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  if (!bytes.length || bytes.length % 2) throw Error('invalid_pcm');
  const view = new DataView(bytes.buffer), result = new Float32Array(bytes.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = view.getInt16(i * 2, true) / 32768;
  return result;
}
export class PCMPlayer {
  constructor(onState, Context = window.AudioContext || window.webkitAudioContext, onSchedule = () => {}) {
    this.context = new Context(); this.nextTime = 0; this.sources = new Set(); this.waiters = []; this.onSchedule = onSchedule;
    this.recordDestination = this.context.createMediaStreamDestination();
    this.onState = onState; this.closed = false; this.active = null;
    this.analysers = Object.fromEntries(['agent', 'user'].map(role => {
      const analyser = this.context.createAnalyser(); analyser.fftSize = 256; analyser.connect(this.context.destination);
      // The recording must receive exactly what is played; without this connection the capture is silent.
      analyser.connect(this.recordDestination);
      return [role, analyser];
    }));
  }
  async resume() { await this.context.resume(); if (this.context.state !== 'running') throw Error('audio_suspended'); }
  add(audio, format, role) {
    if (this.closed) return;
    if (this.context.state !== 'running') throw Error('audio_suspended');
    if (!/^pcm_(16000|22050|24000|44100|48000)$/.test(format) || !this.analysers[role]) throw Error('unsupported_format');
    const pcm = decodePCM(audio), rate = Number(format.slice(4));
    const buffer = this.context.createBuffer(1, pcm.length, rate); buffer.copyToChannel(pcm, 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.analysers[role]);
    const start = Math.max(this.context.currentTime + 0.02, this.nextTime);
    // Check the limit BEFORE mutating the schedule, so a rejected chunk leaves no stale state.
    if (start + buffer.duration - this.context.currentTime > 35) throw Error('audio_queue_limit');
    this.nextTime = start + buffer.duration;
    const entry = { source, role, start, end: this.nextTime }; this.sources.add(entry);
    this.onSchedule(role, start, this.nextTime);
    source.onended = () => {
      this.sources.delete(entry); source.disconnect();
      if (!this.sources.size) { this.onState(null); this.waiters.splice(0).forEach(resolve => resolve()); }
    };
    source.start(start);
  }
  levels(role) {
    if (this.closed) return { input: 0, output: 0, bass: 0, high: 0 };
    const active = [...this.sources].find(s => s.start <= this.context.currentTime && s.end > this.context.currentTime)?.role || null;
    if (active !== this.active) { this.active = active; this.onState(active); }
    const data = new Uint8Array(128); this.analysers[role].getByteTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((s, x) => s + ((x - 128) / 128) ** 2, 0) / data.length);
    return { input: 0, output: Math.min(1, rms * 3), bass: rms, high: rms };
  }
  drained() { return this.sources.size ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
  stopPlayback() {
    for (const { source } of this.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.waiters.splice(0).forEach(resolve => resolve());
    // Reset the schedule so audio added after a stop starts now, not at a stale future time.
    this.nextTime = 0; this.active = null; this.onState(null);
  }
  close() {
    if (this.closed) return; this.closed = true;
    this.stopPlayback();
    for (const a of Object.values(this.analysers)) a.disconnect();
    void this.context.close();
  }
}
