import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OPENING } from './khalid.mjs';
import { resample, pcmToInt16 } from './recorder.mjs';
export const LIMITS = Object.freeze({ duration: 120_000, turns: 12, turnTimeout: 35_000 });
export function pcmRate(format) {
  if (!/^pcm_(16000|22050|24000|44100|48000)$/.test(format || '')) throw Error('unsupported_audio_format');
  return Number(format.slice(4));
}
// Transport-independent orchestration, tested with fake sockets/LLM/TTS and clocks.
export class SimulationSession {
  constructor({ socket, emit, reply, tts, now = Date.now, timers = globalThis, sleep = delay, limits = LIMITS, recorder = null, recordFormat = null, prefetch = false, completionFallbackMs = null, openingAudio = null, shapeAudio = null, trailingSilenceMs = 0, onTrace = null, opening = OPENING, callerId = 'khalid' }) {
    // recorder (optional): server-side capture of the audio that actually crosses the bridge.
    // opening: the caller persona's fixed first line (default: Khalid's, unchanged behaviour).
    Object.assign(this, { socket, emit, reply, tts, now, timers, sleep, limits, recorder, recordFormat, prefetch, completionFallbackMs, openingAudio, shapeAudio, trailingSilenceMs, onTrace, opening, callerId });
    // shapeAudio(pcm, rate): post-processing of caller PCM (loudness match, tail trim) before send/record.
    // trailingSilenceMs: paced 20 ms silence frames sent right after caller speech (genuine audio input), so the
    //   agent's end-of-turn detection starts immediately instead of waiting for the next 1 s heartbeat block.
    // Natural ending: when Khalid ends the call himself (done), the session stops after Mohammed's reply has played.
    this.khalidDone = false;
    // openingAudio (optional): the caller's FIXED opening, synthesized by the same TTS before the call starts
    //   ({ format, audio }). Used once for his first line; every later line is generated live.
    // prefetch: the caller prepares a reply (LLM + TTS) as soon as Mohammed's turn is complete, while
    //   Mohammed's audio is still playing; he still SPEAKS only after the playback acknowledgement.
    // completionFallbackMs: if agent_response_complete is late, treat the turn as complete after this
    //   much time without new agent audio (fail-closed: later agent audio still stops the session).
    // recordFormat (optional, e.g. 'pcm_24000'): Khalid is synthesized once at this higher rate for the
    // recording, then downsampled to the agent's input rate for sending. Same single TTS call, same cost.
    this.id = randomUUID(); this.started = now(); this.history = []; this.turns = 0;
    this.emotion = 'STRESSED'; this.closed = false; this.busy = false; this.awaiting = null;
    this.abort = new AbortController(); this.lastProgress = now(); this.audioMs = 0;
    this.heartbeat = timers.setInterval(() => this.tick(), 1000);
  }
  output(event) { if (!this.closed) this.emit(event); }
  trace(name, extra = {}) { try { this.onTrace?.(name, extra); } catch { /* observability must not break the session */ } }
  send(event) { if (!this.closed && this.socket.readyState === 1) this.socket.send(JSON.stringify(event)); }
  tick() {
    if (this.closed) return;
    if (this.now() - this.started >= this.limits.duration) return this.stop('duration_limit');
    if (this.now() - this.lastProgress >= this.limits.turnTimeout) return this.stop('turn_timeout');
    // Silence is input, not loopback. It lets server VAD finalize Khalid's recorded speech.
    if (this.inputFormat && !this.busy && !this.awaiting) this.send({ user_audio_chunk: Buffer.alloc(pcmRate(this.inputFormat) * 2).toString('base64') });
  }
  message(e) {
    if (this.closed) return;
    try {
      if (e.type === 'ping') return this.send({ type: 'pong', event_id: e.ping_event.event_id });
      if (e.type === 'conversation_initiation_metadata') {
        const m = e.conversation_initiation_metadata_event;
        pcmRate(m.user_input_audio_format); pcmRate(m.agent_output_audio_format);
        this.inputFormat = m.user_input_audio_format; this.outputFormat = m.agent_output_audio_format;
        this.output({ type: 'connected', sessionId: this.id }); return;
      }
      if (['client_tool_call', 'mcp_tool_call', 'agent_tool_request', 'guardrail_triggered', 'client_error', 'interruption'].includes(e.type)) return this.stop(e.type);
      if (e.type === 'agent_response' || e.type === 'agent_response_correction') {
        if (this.busy || this.awaiting) return this.stop('unexpected_agent_turn');
        const d = e.agent_response_event || e.agent_response_correction_event;
        const text = d.agent_response || d.corrected_agent_response;
        if (typeof text !== 'string' || text.length > 4000) return this.stop('invalid_transcript');
        this.trace('mohammed_response_text_event', { chars: text.length });
        const id = `agent-${d.event_id}`;
        const old = this.history.find(m => m.id === id);
        if (old) old.text = text;
        else {
          if (this.turns >= this.limits.turns) return this.stop('turn_limit');
          this.turns++; this.history.push({ id, role: 'agent', text });
        }
        this.currentId = id; this.lastProgress = this.now();
        this.recorder?.text(id, 'agent', text);
        this.output({ type: 'transcript', id, role: 'agent', text }); return;
      }
      if (e.type === 'user_transcript') {
        const d = e.user_transcription_event;
        this.asrFinalAt = this.now();
        this.trace('mohammed_asr_final', {
          msSinceCallerAudioComplete: this.callerAudioCompletedAt == null ? null : this.asrFinalAt - this.callerAudioCompletedAt,
          msSinceCallerTailSilenceEnd: this.callerTailSilenceEndedAt == null ? null : this.asrFinalAt - this.callerTailSilenceEndedAt,
        });
        this.output({ type: 'recognition', text: d.user_transcript }); return;
      }
      if (e.type === 'audio') {
        if (this.busy || this.awaiting || !this.outputFormat) return this.stop('unexpected_audio');
        const audio = e.audio_event.audio_base_64;
        const length = Buffer.from(audio, 'base64').length;
        if (!length || length % 2 || length > 2_000_000) return this.stop('invalid_audio');
        if (!this.agentAudioSeen) {
          this.agentAudioSeen = true;
          const firstAudioAt = this.now();
          this.trace('mohammed_first_audio', {
            msSinceAsrFinal: this.asrFinalAt == null ? null : firstAudioAt - this.asrFinalAt,
            msSinceCallerAudioComplete: this.callerAudioCompletedAt == null ? null : firstAudioAt - this.callerAudioCompletedAt,
          });
        }
        this.audioMs += length / (pcmRate(this.outputFormat) * 2) * 1000;
        if (this.audioMs > 30_000) return this.stop('audio_limit');
        this.lastProgress = this.now();
        this.recorder?.audio('agent', Buffer.from(audio, 'base64'), pcmRate(this.outputFormat));
        this.output({ type: 'audio', role: 'agent', audio, format: this.outputFormat });
        if (this.completionFallbackMs) {
          this.timers.clearTimeout?.(this.fallbackTimer);
          this.fallbackTimer = this.timers.setTimeout(() => this.complete('fallback'), this.completionFallbackMs);
        }
        return;
      }
      if (e.type === 'agent_response_complete') return this.complete('event');
    } catch { this.stop('protocol_error'); }
  }
  complete(source) {
    if (this.closed) return;
    this.timers.clearTimeout?.(this.fallbackTimer);
    if (this.busy || this.awaiting) return; // duplicate completion cannot generate another turn
    if (!this.currentId || !this.audioMs) return this.stop('incomplete_agent_turn');
    this.agentAudioSeen = false;
    this.awaiting = randomUUID(); this.lastProgress = this.now();
    this.output({ type: 'completion', source });
    // No prefetch when the next acknowledgement will end the session (no wasted paid generation).
    if (this.prefetch && this.turns < this.limits.turns && !this.khalidDone) { this.prepared = this.prepare(); this.prepared.catch(() => {}); }
    this.output({ type: 'playback_barrier', barrier: this.awaiting });
  }
  async prepare() {
    const line = this.turns === 1 ? { text: this.opening, emotion: 'STRESSED' } : await this.reply(this.history, this.emotion, this.abort.signal);
    if (this.turns === 1 && this.openingAudio) { const { format, audio } = this.openingAudio; this.openingAudio = null; return { line, genFormat: format, generated: audio }; }
    const genFormat = this.recorder && this.recordFormat ? this.recordFormat : this.inputFormat;
    let generated = await this.tts(line.text, genFormat, this.abort.signal, line.emotion);
    if (this.shapeAudio) generated = this.shapeAudio(generated, pcmRate(genFormat));
    return { line, genFormat, generated };
  }
  async acknowledge(barrier) {
    if (this.closed || !this.awaiting || barrier !== this.awaiting || this.busy) return false;
    this.awaiting = null; this.busy = true; this.lastProgress = this.now();
    if (this.khalidDone) { this.stop('natural_end'); return true; }
    if (this.turns >= this.limits.turns) { this.stop('turn_limit'); return true; }
    try {
      this.output({ type: 'state', role: 'user', phase: 'thinking' });
      const pending = this.prepared || this.prepare(); this.prepared = null;
      const { line, genFormat, generated } = await pending;
      if (this.closed) return true;
      this.emotion = line.emotion;
      const audio = genFormat === this.inputFormat ? generated
        : (s => Buffer.from(s.buffer, s.byteOffset, s.byteLength))(resample(pcmToInt16(generated), pcmRate(genFormat), pcmRate(this.inputFormat)));
      const id = `user-${this.turns}`;
      this.turns++; this.history.push({ id, role: 'user', text: line.text });
      this.output({ type: 'transcript', id, role: 'user', text: line.text, emotion: line.emotion });
      this.recorder?.text(id, 'user', line.text, line.emotion);
      this.recorder?.audio('user', generated, pcmRate(genFormat));
      this.output({ type: 'audio', role: 'user', audio: audio.toString('base64'), format: this.inputFormat });
      // 20 ms signed PCM frames paced in real time; no microphone or speaker loopback.
      // 40 ms chunks halve the number of paced WebSocket sends/sleeps versus 20 ms
      // frames while keeping the same PCM and a short real-time input buffer.
      const frameDurationMs = 40;
      const frameSize = Math.round(pcmRate(this.inputFormat) * frameDurationMs / 1000) * 2;
      const bytesPerSecond = pcmRate(this.inputFormat) * 2;
      const expectedAudioMs = audio.length / bytesPerSecond * 1000;
      const speechStartedAt = this.now();
      let pacingOrigin = speechStartedAt;
      this.trace('khalid_speech_input_start', { bytes: audio.length });
      for (let offset = 0; offset < audio.length && !this.closed; offset += frameSize) {
        this.send({ user_audio_chunk: audio.subarray(offset, offset + frameSize).toString('base64') });
        // Pace against audio duration, not a fixed full-chunk sleep (the last chunk may be short).
        // Absolute deadlines prevent ordinary timer wake-up overhead accumulating every chunk.
        const now = this.now();
        const audioEndMs = Math.min(expectedAudioMs, ((offset + Math.min(frameSize, audio.length - offset)) / bytesPerSecond) * 1000);
        let chunkEndAt = pacingOrigin + audioEndMs;
        // If the scheduler falls behind by a whole chunk, resume at real time instead of
        // flushing buffered speech in a burst. This preserves turn-taking safety.
        if (now - chunkEndAt >= frameDurationMs) {
          pacingOrigin = now - audioEndMs;
          chunkEndAt = now;
        }
        const waitMs = Math.max(0, chunkEndAt - now);
        if (waitMs) await this.sleep(waitMs, undefined, { signal: this.abort.signal });
        this.lastProgress = this.now();
      }
      if (this.closed) return true;
      this.callerAudioCompletedAt = this.now();
      const actualPacingMs = this.callerAudioCompletedAt - speechStartedAt;
      this.trace('khalid_speech_input_end', { expectedAudioMs: Number(expectedAudioMs.toFixed(1)), actualPacingMs: Number(actualPacingMs.toFixed(1)) });
      this.trace('caller_audio_complete', {
        callerId: this.callerId,
        expectedAudioMs: Number(expectedAudioMs.toFixed(1)),
        actualPacingMs: Number(actualPacingMs.toFixed(1)),
        pacingOverrunMs: Number((actualPacingMs - expectedAudioMs).toFixed(1)),
      });
      this.khalidDone = line.done === true;
      this.busy = false; this.currentId = null; this.audioMs = 0;
      if (this.turns >= this.limits.turns) { this.stop('turn_limit'); return true; }
      this.output({ type: 'state', role: 'agent', phase: 'thinking' });
      // Khalid's turn is closed first, so Mohammed may answer at any moment; silence stops as soon as he does.
      const tailFrameSize = Math.round(pcmRate(this.inputFormat) * 0.02) * 2;
      const silent = Buffer.alloc(tailFrameSize).toString('base64');
      const tailStartedAt = this.now();
      this.trace('khalid_tail_silence_start', { plannedMs: this.trailingSilenceMs, callerId: this.callerId });
      for (let ms = 0; ms < this.trailingSilenceMs && !this.closed && !this.currentId && !this.awaiting; ms += 20) {
        this.send({ user_audio_chunk: silent });
        await this.sleep(20, undefined, { signal: this.abort.signal });
      }
      this.callerTailSilenceEndedAt = this.now();
      this.trace('khalid_tail_silence_end', { actualMs: this.callerTailSilenceEndedAt - tailStartedAt, callerId: this.callerId });
    } catch (error) {
      if (!this.closed) {
        const code = typeof error?.message === 'string' ? error.message : 'unknown_error';
        this.trace('caller_reply_or_audio_failed', { callerId: this.callerId, code: code.slice(0, 64) });
        this.stop(code === 'khalid_agent_response_missing' ? 'caller_response_missing' : 'generation_or_audio_failed');
      }
    }
    return true;
  }
  stop(reason = 'user_stop') {
    if (this.closed) return;
    this.closed = true; this.abort.abort(); this.timers.clearInterval(this.heartbeat); this.timers.clearTimeout?.(this.fallbackTimer);
    try { this.socket.close(1000, 'demo stopped'); } catch { /* pending connection */ }
    this.emit({ type: 'stopped', reason, turns: this.turns });
  }
}
