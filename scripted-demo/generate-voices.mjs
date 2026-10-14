// Voices for the SCRIPTED demo, using the approved agent voices and model (no new voices, no model change).
//   node scripted-demo/generate-voices.mjs                       DRY RUN: free GET checks + exact characters/cost
//   SCRIPTED_TTS_APPROVED=true node scripted-demo/generate-voices.mjs --go
//      PAID: one /text-to-speech/{voice}/with-timestamps request per missing line (pcm_24000), NO retries,
//      stops at the first failure; a line already generated with the identical request text is never re-billed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, requirePersonal } from '../server/config.mjs';
import { eleven } from '../server/elevenlabs.mjs';
import { ttsText, EMOTION_TAGS } from '../server/simulator/khalid.mjs';

const root = new URL('../', import.meta.url), P = (p) => fileURLToPath(new URL(p, root));
// --version=v2 -> scripted-demo/script-v2.json + production/scripted-demo/stems-v2/ (v1 files are never touched).
export const VERSION = (process.argv.find((a) => a.startsWith('--version=')) || '--version=v1').split('=')[1];
export const script = JSON.parse(readFileSync(P(VERSION === 'v1' ? 'scripted-demo/script.json' : `scripted-demo/script-${VERSION}.json`), 'utf8'));
const STEMS = P(VERSION === 'v1' ? 'production/scripted-demo/stems/' : `production/scripted-demo/stems-${VERSION}/`);
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]?.split(',').map(Number).filter(Boolean) || null;
export const MOHAMMED_TAGS = new Set(['[Warmly]', '[Seriously]', '[Empathetically]', '[Patiently]']);

// Exactly what is sent to ElevenLabs for each line (Khalid: the same tag mapping the recorder uses).
export function requestText(line) {
  const v = script.voices[line.speaker];
  if (line.speaker === 'mohammed') { if (!MOHAMMED_TAGS.has(line.tag)) throw Error(`unsupported_tag_line_${line.n}`); return `${line.tag} ${line.text}`; }
  if (line.khalidTag) return `${line.khalidTag} ${line.text}`; // v2 performance direction (approved per sample)
  return ttsText(line.text, line.emotion, v.model, EMOTION_TAGS);
}
const settingsOf = (l) => l.voiceSettings || script.voices[l.speaker].settings;
export const plan = () => script.lines.map((l) => { const text = requestText(l), vs = settingsOf(l); return { n: l.n, speaker: l.speaker, text, chars: [...text].length, settings: vs, hash: createHash('sha256').update(`${script.voices[l.speaker].voiceId}|${script.voices[l.speaker].model}|${text}${vs && l.voiceSettings ? '|' + JSON.stringify(vs) : ''}`).digest('hex').slice(0, 16) }; });
const stemBase = (n) => `${STEMS}line-${String(n).padStart(2, '0')}`;
const cached = (p) => existsSync(`${stemBase(p.n)}.json`) && JSON.parse(readFileSync(`${stemBase(p.n)}.json`, 'utf8')).hash === p.hash && existsSync(`${stemBase(p.n)}.pcm`);

async function checks(env) {
  requirePersonal(env);
  const get = async (p, ms = 15_000) => (await (await eleven(env, p, { signal: AbortSignal.timeout(ms) })).json());
  const problems = [];
  for (const [who, v] of Object.entries(script.voices)) { const voice = await get(`/voices/${encodeURIComponent(v.voiceId)}`); if (voice.voice_id !== v.voiceId) problems.push(`${who}_voice_not_accessible`); }
  // The agents endpoint can be slow (64 s observed 2026-10-13); allow 120 s for this read-only check.
  const agent = await get(`/convai/agents/${encodeURIComponent(env.ELEVENLABS_AGENT_ID)}?version_id=${encodeURIComponent(env.ELEVENLABS_VERSION_ID)}`, 120_000), t = agent.conversation_config?.tts || {}, m = script.voices.mohammed;
  if (t.voice_id !== m.voiceId || t.model_id !== m.model || t.stability !== m.settings.stability || t.similarity_boost !== m.settings.similarity_boost || t.speed !== m.settings.speed) problems.push('mohammed_voice_settings_differ_from_live_agent');
  if (env.KHALID_VOICE_ID !== script.voices.khalid.voiceId || env.KHALID_TTS_MODEL !== script.voices.khalid.model) problems.push('khalid_voice_or_model_differs_from_recorder');
  return problems;
}

async function main(argv) {
  const env = loadConfig(), p = plan(), todo = p.filter((x) => !cached(x) && (!ONLY || ONLY.includes(x.n)));
  if (ONLY) console.log(`ONLY lines ${ONLY.join(',')} (all other missing lines are left untouched)`);
  const problems = await checks(env);
  console.log(`CHECKS ${problems.length ? 'FAIL: ' + problems.join(', ') : 'PASS'} · Mohammed ${script.voices.mohammed.voiceId} + Khalid ${script.voices.khalid.voiceId} · model eleven_v4_turbo (same as live agent/recorder)`);
  const total = p.reduce((s, x) => s + x.chars, 0), pending = todo.reduce((s, x) => s + x.chars, 0);
  console.log(`LINES ${p.length} · characters total ${total} (Mohammed ${p.filter((x) => x.speaker === 'mohammed').reduce((s, x) => s + x.chars, 0)}, Khalid ${p.filter((x) => x.speaker === 'khalid').reduce((s, x) => s + x.chars, 0)}) · still to generate: ${todo.length} lines / ${pending} chars`);
  if (!argv.includes('--go')) return console.log('DRY RUN — nothing generated, no credits used.');
  if (process.env.SCRIPTED_TTS_APPROVED !== 'true') throw Error('requires_SCRIPTED_TTS_APPROVED_true');
  if (problems.length) throw Error('checks_failed_no_generation');
  const budget = Number(process.env.SCRIPTED_TTS_BUDGET);
  if (!(budget > 0)) throw Error('requires_SCRIPTED_TTS_BUDGET');
  if (pending > budget) throw Error(`pending_${pending}_chars_exceed_budget_${budget}`);
  mkdirSync(STEMS, { recursive: true });
  let charged = 0;
  for (const x of todo) {
    // Hard cap: worst case 1 credit/char for this line; a missing cost header counts as the worst case.
    if (charged + x.chars > budget) { console.log(`BUDGET STOP before line ${x.n}: used ${charged} + up to ${x.chars} > ${budget}`); break; }
    const v = script.voices[x.speaker];
    const vs = x.settings;
    const body = { text: x.text, model_id: v.model, language_code: 'ar', ...(vs ? { voice_settings: vs } : {}) };
    const r = await eleven(env, `/text-to-speech/${encodeURIComponent(v.voiceId)}/with-timestamps?output_format=pcm_24000`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const cost = Number(r.headers.get('character-cost')) || null, j = await r.json();
    const pcm = Buffer.from(j.audio_base64 || '', 'base64');
    if (!pcm.length || pcm.length % 2) throw Error(`invalid_audio_line_${x.n}_stopped_no_retry`);
    writeFileSync(`${stemBase(x.n)}.pcm`, pcm);
    writeFileSync(`${stemBase(x.n)}.json`, JSON.stringify({ n: x.n, speaker: x.speaker, hash: x.hash, requestText: x.text, seconds: pcm.length / 2 / 24000, characterCost: cost, alignment: j.alignment || null }, null, 1));
    charged += cost ?? x.chars; console.log(`line ${x.n} ✓ ${(pcm.length / 48000).toFixed(2)} s · character-cost ${cost ?? 'n/a'}`);
  }
  console.log(`DONE · credits used (API-reported; worst case where missing): ${charged} / budget ${budget} · lines still missing: ${plan().filter((y) => !cached(y)).map((y) => y.n).join(',') || 'none'}`);
}
if (fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2)).catch((e) => { console.error(`STOPPED: ${e.message}${e.upstreamStatus ? ` (HTTP ${e.upstreamStatus})` : ''}`); process.exitCode = 1; });
