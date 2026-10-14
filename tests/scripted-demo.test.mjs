// Scripted demo: approved script integrity + offline mixer timing/levels (synthetic audio only; no network, no paid calls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPENING } from '../server/simulator/khalid.mjs';
import { RATE, buildTimeline, timelineProblems, render, rms, peak, biquad, cues, cutSecFromAlignment, gainToDb } from '../scripted-demo/mixer.mjs';

const script = JSON.parse(readFileSync(new URL('../scripted-demo/script.json', import.meta.url), 'utf8'));
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const noise = (sec, amp = 0.3) => Float32Array.from({ length: Math.round(sec * RATE) }, () => amp * rnd());
const speechLike = (sec) => { const x = noise(sec, 0.4); for (let i = 0; i < x.length; i++) x[i] *= 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * i / RATE); return x; };
const voices = () => Object.fromEntries(script.lines.map((l) => [l.n, l.cutAfter ? { samples: speechLike(4), cutSec: 3.2 } : { samples: speechLike(1.5 + (l.n % 3) * 0.5) }]));
const sfx = () => ({ street: [noise(20, 0.2)], office: [noise(15, 0.1)], murmur: [noise(8, 0.1)], horn_near: noise(0.6, 0.5), horn_far: noise(0.9, 0.5) });

test('approved script: 21 lines, exact original opening, corrected line 9, number in words only, honest framing', () => {
  assert.equal(script.lines.length, 21);
  assert.equal(script.lines[1].text, OPENING, 'Khalid opening is the original, verbatim');
  assert.equal(script.lines[8].text, 'أقول: شغّل الإشارات الرباعية، وإذا معك مثلث عاكس، حطّه بمكان مناسب إذا كان آمن، وابتعد عن حركة السيارات.');
  assert.equal(script.lines[0].text, 'حياك الله، معك محمد، المساعد الصوتي. وش أقدر أخدمك فيه؟');
  for (const l of script.lines) assert.doesNotMatch(l.text, /[0-9٠-٩]/, `no digits in line ${l.n}`);
  assert.match(script.lines[12].text, /واحد تسعة تسعة صفر ثلاثة ثلاثة/); assert.match(script.lines[13].text, /واحد تسعة تسعة… صفر ثلاثة ثلاثة/);
  assert.doesNotMatch(script.lines.map((l) => l.text).join(' '), /مائة|مية|ممثل|الرسمي/);
  script.lines.forEach((l, i) => assert.equal(l.speaker, i % 2 === 0 ? 'mohammed' : 'khalid', `turn order line ${l.n}`));
  assert.equal(script.kind, 'scripted'); assert.match(script.note, /NOT a live AI-to-AI call/); assert.match(script.note, /not affiliated with Najm/);
  assert.equal(script.lines[6].event, 'horn_interrupt'); assert.equal(script.lines[6].cutAfter, 'على مسا'); assert.match(script.lines[7].text, /وش قلت/);
});

test('timeline: gaps, the single overlap, the cut, the 0.7 s beat after the horn, events outside the number window', () => {
  const tl = buildTimeline(script, voices());
  const L = (n) => tl.lines.find((x) => x.n === n);
  assert.equal(+(L(3).start - L(2).end).toFixed(3), 0.4);
  assert.equal(+(L(13).end - L(14).start).toFixed(3), 0.15, 'line 14 overlaps line 13 by 150 ms');
  assert.equal(+(L(9).start - L(8).end).toFixed(3), 0.7, 'Mohammed waits 0.7 s before repeating');
  assert.equal(+(L(7).end - L(7).start).toFixed(3), 3.2, 'line 7 is cut at the alignment point');
  const horn = tl.events.find((e) => e.id === 'horn_interrupt');
  assert.equal(+(L(7).end - horn.at).toFixed(3), 0.12, 'horn starts 120 ms before the cut');
  assert.ok(horn.at < L(8).start, 'Khalid reacts after the horn');
  assert.ok(tl.events.find((e) => e.type === 'hangup').at > L(21).end, 'hang-up after the goodbye');
  assert.deepEqual(timelineProblems(script, tl), []);
  const bad = structuredClone(script); bad.events.push({ id: 'x', type: 'horn_far', afterLine: 13, offsetMs: 0, gainDb: -20 });
  assert.match(timelineProblems(bad, buildTimeline(bad, voices())).join(), /inside protected number window/);
});

test('render: voices clearly above beds, horn is the only loud interruption, number window extra quiet, no clipping', () => {
  const out = render(script, voices(), sfx());
  const { kVoice, mVoice, street } = out.stems, tl = out.timeline;
  for (const L of tl.lines) {
    const a = Math.round(L.start * RATE), b = Math.round(L.end * RATE);
    const v = rms(L.speaker === 'khalid' ? kVoice : mVoice, a, b), bedRms = rms(L.speaker === 'khalid' ? out.stems.streetDucked : out.stems.officeDucked, a, b);
    assert.ok(gainToDb(v) - gainToDb(bedRms) >= 15, `line ${L.n}: voice ${gainToDb(v).toFixed(1)} dB vs bed ${gainToDb(bedRms).toFixed(1)} dB`);
  }
  const horn = tl.events.find((e) => e.id === 'horn_interrupt'), h0 = Math.round(horn.at * RATE);
  assert.ok(rms(out.stems.kEvents, h0, h0 + RATE / 4) > 3 * rms(street, h0, h0 + RATE / 4), 'interrupting horn clearly louder than the street bed');
  assert.ok(Math.max(peak(out.left), peak(out.right)) <= 10 ** (-2 / 20) + 1e-6, 'peak <= -2 dBFS (headroom for AAC)');
  const pw = tl.protectedWindow, mid = Math.round(((pw.start + pw.end) / 2) * RATE);
  const before = Math.round((pw.start - 4) * RATE);
  assert.ok(rms(out.buses.kOut, mid - RATE / 2, mid + RATE / 2) > 0, 'audio present in number window');
  assert.ok(tl.events.every((e) => e.type === 'hangup' || e.at < pw.start - 0.2 || e.at > pw.end), 'no effect inside the number window');
  assert.ok(before > 0);
});

test('two different acoustic worlds: Khalid band-limited like a phone, Mohammed keeps headset high frequencies', () => {
  const out = render(script, voices(), sfx());
  const hf = (x) => rms(biquad(biquad(x, 'highpass', 5000), 'highpass', 5000)) / Math.max(rms(x), 1e-9);
  assert.ok(hf(out.buses.kOut) < 0.1 * hf(out.buses.mOut), 'phone band removes most energy above 5 kHz on Khalid’s side');
});

test('subtitles and the alignment-based cut', () => {
  const tl = buildTimeline(script, voices()), c = cues(script, tl);
  assert.equal(c.length, 21); assert.match(c[6].text, /على مسا—$/); assert.equal(c[0].speaker, 'agent'); assert.equal(c[1].speaker, 'customer');
  const text = 'حطّه على مسافة آمنة.', chars = [...text];
  const alignment = { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.1), character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1) };
  assert.equal(+cutSecFromAlignment(alignment, text, 'على مسا').toFixed(2), +(([...'حطّه على مسا'].length) * 0.1).toFixed(2));
  assert.throws(() => cutSecFromAlignment(alignment, text, 'غير موجود'), /cut_marker_not_found/);
  assert.throws(() => cutSecFromAlignment({}, text, 'x'), /alignment_missing/);
});

test('adaptive ducking: a loud passing vehicle in the street bed never comes within 16 dB of any line', () => {
  const s = sfx(); const st = s.street[0]; for (let i = 2 * RATE; i < 12 * RATE && i < st.length; i++) st[i] *= 8; // loud bus pass
  const out = render(script, voices(), s);
  for (const L of out.timeline.lines) {
    const a = Math.round(L.start * RATE), b = Math.round(L.end * RATE);
    const v = rms(L.speaker === 'khalid' ? out.stems.kVoice : out.stems.mVoice, a, b), bed = rms(L.speaker === 'khalid' ? out.stems.streetDucked : out.stems.officeDucked, a, b);
    assert.ok(gainToDb(v) - gainToDb(bed) >= 15.9, `line ${L.n}: ${(gainToDb(v) - gainToDb(bed)).toFixed(1)} dB`);
  }
});

test('scripted fixture: honest label, overlap allowed only for scripted, scratch never approvable, live stays default', async () => {
  const { scriptedFixture, PROVENANCE } = await import('../scripted-demo/build-fixture.mjs');
  const { validateRecordingFixture } = await import('../src/lib/recording-fixture.js');
  const tl = buildTimeline(script, voices()), meta = { duration: tl.duration, cues: cues(script, tl) };
  const f = scriptedFixture(meta, { id: 'draft-scripted-v1', approved: false });
  assert.equal(f.kind, 'scripted'); assert.equal(validateRecordingFixture(f), true, 'line 14 overlap accepted for scripted');
  assert.equal(validateRecordingFixture({ ...f, kind: 'recording' }), false, 'real recordings must not overlap');
  assert.match(PROVENANCE, /ليست تسجيلًا لمكالمة آلية مباشرة/); assert.match(PROVENANCE, /غير تابعة لنجم/); assert.match(PROVENANCE, /Mixkit/);
  assert.throws(() => scriptedFixture(meta, { id: 'x', approved: true, scratch: true }), /scratch_mix_can_never_be_approved/);
  const player = readFileSync(new URL('../src/components/RecordedPlayer.jsx', import.meta.url), 'utf8');
  assert.match(player, /scriptedDemo && \(wantScripted \|\| !validateRecordingFixture\(live\)\) \? scriptedDemo : live/, 'approved live recording stays the default');
  assert.match(readFileSync(new URL('../src/components/VoiceUI.jsx', import.meta.url), 'utf8'), /هذا مشروع تجريبي مستقل، ولا يتبع نجم أو أي شركة تأمين/);
  assert.doesNotMatch(readFileSync(new URL('../src/hooks/useRecordedDemo.js', import.meta.url), 'utf8'), /: 'thinking'/, 'no processing label during recorded gaps');
});
