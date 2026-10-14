// Local video export for the prerecorded simulation (internal ?export=1 only; nothing is uploaded).
// Video: the current tab via getDisplayMedia (orbs + Arabic subtitles exactly as rendered).
// Audio: the ORIGINAL recording taken digitally from the page's audio graph (not the microphone).
// Format: MP4 (H.264 + AAC) when the browser's MediaRecorder supports it, otherwise WebM.

export const VIDEO_TYPES = Object.freeze([
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]);

export function pickVideoMime(Recorder = globalThis.MediaRecorder) {
  if (!Recorder?.isTypeSupported) return '';
  return VIDEO_TYPES.find((type) => Recorder.isTypeSupported(type)) || '';
}

export const extensionFor = (mime) => (mime.startsWith('video/mp4') ? 'mp4' : 'webm');

export function exportVideoAllowed(search, fixture) {
  const mode = new URLSearchParams(search).get('export');
  if (fixture?.invalid === true || fixture?.source?.versionCheck?.mohammed?.match === false) return false; // version-mismatched recording
  // ?export=draft: LOCAL review export of an UNAPPROVED draft (private preview only; never an approved video).
  const playable = fixture?.kind === 'recording' || fixture?.kind === 'scripted';
  if (mode === 'draft') return playable && fixture.draft === true;
  const requested = mode === '1';
  if (!requested) return false;
  if (fixture === undefined) return true;
  return playable && fixture.draft !== true
    && typeof fixture.verifiedAt === 'string' && fixture.verifiedAt.length > 0
    && fixture.verifiedAt !== 'UNAPPROVED-DRAFT';
}

// Records one full playback. `play` must start the audio from 0 and resolve when playback starts;
// `ended` resolves when the recording finishes. Returns { blob, mime }.
export async function recordPlayback({ audioTracks, play, ended, tailMs = 400,
  mediaDevices = globalThis.navigator?.mediaDevices, Recorder = globalThis.MediaRecorder }) {
  const mime = pickVideoMime(Recorder);
  if (!mime) throw Error('video_recording_not_supported');
  if (!mediaDevices?.getDisplayMedia) throw Error('screen_capture_not_supported');
  const screen = await mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
  const [video] = screen.getVideoTracks();
  // 1080p30 output even on a 2x (Retina) display; ignored where the browser cannot rescale.
  await video.applyConstraints?.({ width: 1920, height: 1080, frameRate: 30 }).catch(() => {});
  try {
    const recorder = new Recorder(new MediaStream([video, ...audioTracks]), { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
    const parts = [];
    recorder.addEventListener('dataavailable', (e) => { if (e.data?.size) parts.push(e.data); });
    const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
    recorder.start(1000);
    await play();
    await ended;
    await new Promise((resolve) => setTimeout(resolve, tailMs));
    recorder.stop();
    await stopped;
    return { blob: new Blob(parts, { type: recorder.mimeType || mime }), mime: recorder.mimeType || mime };
  } finally {
    screen.getTracks().forEach((t) => t.stop());
  }
}
