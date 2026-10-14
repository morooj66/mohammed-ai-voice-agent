export function recordingMimeType(MediaRecorderCtor = globalThis.MediaRecorder) {
  if (!MediaRecorderCtor) return '';
  return ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorderCtor.isTypeSupported?.(type)) || '';
}

export class RecordingCapture {
  constructor({ stream, context, Recorder = globalThis.MediaRecorder, now = () => context.currentTime }) {
    const mimeType = recordingMimeType(Recorder);
    if (!mimeType) throw Error('recording_not_supported');
    this.mimeType = mimeType;
    this.origin = now();
    this.now = now;
    this.transcript = [];
    this.pending = null;
    this.parts = [];
    this.recorder = new Recorder(stream, { mimeType });
    this.recorder.addEventListener('dataavailable', event => { if (event.data?.size) this.parts.push(event.data); });
    this.recorder.start(1000);
  }
  addTranscript(event) {
    if (!['agent', 'user'].includes(event.role) || typeof event.id !== 'string' || typeof event.text !== 'string') return;
    const existing = this.transcript.find(cue => cue.id === event.id);
    if (existing) existing.text = event.text;
    else {
      const cue = { id: event.id, speaker: event.role === 'agent' ? 'agent' : 'customer', text: event.text, start: null, end: null };
      this.transcript.push(cue);
      this.pending = cue;
    }
  }
  schedule(role, start, end) {
    const speaker = role === 'agent' ? 'agent' : role === 'user' ? 'customer' : null;
    if (!speaker || !this.pending || this.pending.speaker !== speaker || !Number.isFinite(start) || !Number.isFinite(end)) return;
    const cue = this.pending;
    cue.start = Math.max(0, Math.min(cue.start ?? Infinity, start - this.origin));
    cue.end = Math.max(cue.end ?? 0, end - this.origin);
  }
  async stop() {
    const recorder = this.recorder;
    if (recorder.state !== 'inactive') await new Promise(resolve => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    });
    const blob = new Blob(this.parts, { type: this.mimeType });
    const ext = this.mimeType.includes('webm') ? 'webm' : 'm4a';
    const duration = Math.max(0, this.now() - this.origin);
    for (const track of this.recorder.stream?.getTracks?.() || []) track.stop();
    const transcript = this.transcript.filter(cue => cue.start !== null && cue.end !== null && cue.end > cue.start)
      .map(({ id, speaker, text, start, end }) => ({ id, speaker, text, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) }));
    return { blob, mimeType: this.mimeType, extension: ext, duration: Number(duration.toFixed(3)), transcript };
  }
}

export function transcriptBundle(capture, { recordingName, consentConfirmed, verifiedAt, completionReason = 'unknown' }) {
  return {
    kind: 'recording',
    audioSrc: `/recordings/${recordingName}`,
    consentConfirmed,
    verifiedAt,
    complete: completionReason === 'natural_end',
    completionReason,
    duration: capture.duration,
    transcript: capture.transcript,
  };
}
