import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, PLAN, planFor, resolveCallerApproval, resolveRunAuthorization } from '../scripts/record-conversation.mjs';
import { getPersona } from '../server/simulator/personas.mjs';

test('Um Nasser recording is capped at 30 seconds and four exchanges without changing other personas', () => {
  const umPlan = planFor(getPersona('um_nasser'));
  assert.equal(umPlan.maxSeconds, 30);
  assert.equal(umPlan.maxUtterances, 8, 'four complete exchanges are at most eight speaker utterances');
  assert.equal(planFor(getPersona('khalid')), PLAN);
  assert.equal(planFor(getPersona('raj')), PLAN);
});

test('Um Nasser maximum usage estimate includes opening plus three bounded tagged replies', () => {
  const um = getPersona('um_nasser');
  const plan = planFor(um);
  assert.deepEqual(estimate('eleven_v4', um, plan), {
    khalidTtsCharacters: 1024, // new plain opening + tag (was 1023)
    mohammedMinutes: 0.5,
    khalidTextMessages: 3,
  });
  assert.deepEqual(estimate('eleven_v4_turbo'), {
    khalidTtsCharacters: 2007,
    mohammedMinutes: 2.5,
    khalidTextMessages: 7,
  }, 'existing Khalid estimate remains unchanged');
});

test('voice approval is a one-command override and is never persisted or inferred', () => {
  const um = getPersona('um_nasser');
  const env = { UM_NASSER_VOICE_APPROVED: 'false' };
  assert.equal(resolveCallerApproval(env, um, { go: false, processEnv: { UM_NASSER_VOICE_APPROVED: 'true' } }), env);
  assert.equal(resolveCallerApproval(env, um, { go: true, processEnv: {} }), env);
  assert.equal(resolveCallerApproval(env, um, { go: true, processEnv: { UM_NASSER_VOICE_APPROVED: 'true' } }).UM_NASSER_VOICE_APPROVED, 'true');
  assert.equal(resolveCallerApproval(env, getPersona('khalid'), { go: true, processEnv: { UM_NASSER_VOICE_APPROVED: 'true' } }), env,
    'Um Nasser approval cannot affect Khalid');
});

test('exact approved Mac command resolves both temporary approvals over a false .env value', () => {
  const um = getPersona('um_nasser');
  const localEnv = {
    KHALID_BRAIN: 'elevenlabs_agent',
    ELEVENLABS_AGENT_ID: 'mohammed-agent',
    UM_NASSER_AGENT_ID: 'um-agent',
    UM_NASSER_VERSION_ID: 'um-version',
    UM_NASSER_VOICE_ID: 'aYQAm4rWuigkeuRA5i92',
    UM_NASSER_VOICE_ACCESS_VERIFIED: 'true',
    UM_NASSER_VOICE_APPROVED: 'false',
    UM_NASSER_MOHAMMED_VERSION_ID: 'mohammed-version',
    UM_NASSER_MOHAMMED_AUDITED_SHA256: 'audited-hash',
  };
  const shellEnv = { RECORDING_APPROVED: 'true', UM_NASSER_VOICE_APPROVED: 'true' };
  const result = resolveRunAuthorization(localEnv, um, ['--caller=um_nasser', '--go'], shellEnv);
  assert.equal(result.go, true);
  assert.equal(result.caller.voiceApproved, true);
  assert.equal(result.callerProblems.some(problem => problem.includes('UM_NASSER_VOICE_APPROVED')), false);
  assert.equal(localEnv.UM_NASSER_VOICE_APPROVED, 'false', '.env-derived configuration is not mutated');

  const missingFlag = resolveRunAuthorization(localEnv, um, ['--caller=um_nasser', '--go'], { RECORDING_APPROVED: 'true' });
  assert.equal(missingFlag.caller.voiceApproved, false);
  assert.ok(missingFlag.callerProblems.some(problem => problem.includes('UM_NASSER_VOICE_APPROVED is not true')));
});
