import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { authenticate, makeSession, originAllowed, limit, readJSON } from '../server/security.mjs';
import { createHandler } from '../server/http-api.mjs';
import { preflight } from '../server/elevenlabs.mjs';
const env = { SESSION_SECRET: 's'.repeat(40), DEMO_ACCESS_CODE: 'p'.repeat(20), APP_ORIGINS: 'http://127.0.0.1:5173' };
const origin = 'http://127.0.0.1:5173';
function req(body = '{}', extra = {}) { return Object.assign(Readable.from([body]), { headers: { origin, 'content-type': 'application/json' }, method: 'POST', url: '/api/login' }, extra); }
function res() { return { headers: {}, setHeader(k,v) { this.headers[k]=v; }, writeHead(s,h) { this.status=s; Object.assign(this.headers,h); }, end(b) { this.body=JSON.parse(b); } }; }
test('signed sessions reject tampering, expiry and missing signing secret', () => {
  const cookie = makeSession(env, 1000); const request = { headers: { cookie: `demo_session=${cookie}` } };
  assert.ok(authenticate(request, env, 1001).id);
  assert.throws(() => authenticate(request, env, 1_900_000), /unauthorized/);
  assert.throws(() => authenticate({headers:{cookie:`demo_session=${cookie}x`}}, env, 1001));
  assert.throws(() => authenticate(request, {}), /auth_not_configured/);
});
test('origin guard rejects absent, hostile and cross-site origins', () => {
  assert.equal(originAllowed(req(), env), true);
  for (const headers of [{}, {origin:'https://evil.example'}, {origin,'sec-fetch-site':'cross-site'}]) assert.equal(originAllowed({headers}, env), false);
});
test('login sets HttpOnly cookie; token endpoint denies anonymous access without provider calls', async () => {
  let calls=0; const handler=createHandler({config:()=>env,token:async()=>{calls++;return 'opaque-short-lived-token';}});
  const login=res(); await handler(req(JSON.stringify({code:env.DEMO_ACCESS_CODE})),login);
  assert.equal(login.status,200); assert.match(login.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
  const denied=res(); await handler(req('{}',{url:'/api/conversation-token'}),denied); assert.equal(denied.status,401); assert.equal(calls,0);
  const token=res(); await handler(req('{}',{url:'/api/conversation-token',headers:{origin,'content-type':'application/json',cookie:login.headers['Set-Cookie']}}),token);
  assert.equal(token.status,200); assert.equal(calls,1); assert.deepEqual(token.body,{token:'opaque-short-lived-token'});
});
test('GET and cross-site requests fail before token issuance', async()=> {
  const handler=createHandler({config:()=>env,token:()=>{throw Error('must not call');}});
  for (const [r,status] of [[req('{}',{method:'GET'}),405],[req('{}',{headers:{origin:'https://evil.example'}}),403]]) {
    const response=res(); await handler(r,response); assert.equal(response.status,status);
  }
});
test('bounded JSON rejects oversized, malformed, and wrong content types',async()=> {
  await assert.rejects(readJSON(req('x'.repeat(5000))),/body_too_large/);
  await assert.rejects(readJSON(req('{')),/invalid_json/);
  await assert.rejects(readJSON(req('{}',{headers:{}})),/json_required/);
});
test('local rate limit bounds repeated requests; serverless fails closed without Redis',async()=> {
  const key=`test-${Date.now()}`; await limit({},key,1,60); await assert.rejects(limit({},key,1,60),/rate_limited/);
  await assert.rejects(limit({VERCEL:'1'},key,1,60),/rate_limit_not_configured/);
});
test('Redis rate limiter rejects outage and malformed results',async()=> {
  const config={VERCEL:'1',RATE_LIMIT_REDIS_URL:'https://redis.example',RATE_LIMIT_REDIS_TOKEN:'test'};
  await assert.rejects(limit(config,'test',1,60,async()=>({ok:false})),/rate_limit_unavailable/);
  await assert.rejects(limit(config,'test',1,60,async()=>({ok:true,json:async()=>({result:2})})),/rate_limited/);
});
test('paid services are disabled before any remote call',async()=> {
  await assert.rejects(preflight({}),/needs_approval/);
  await assert.rejects(preflight({LIVE_SESSIONS_APPROVED:'true'}),/agent_review_required/);
});

test('hosted binding requires explicit approval, HTTPS origins, durable quota and proxy secret', async()=> {
  const {hostingConfig,trustedProxy}=await import('../server/hosting.mjs');
  assert.deepEqual(hostingConfig({},false),{host:'127.0.0.1',port:8787});
  assert.throws(()=>hostingConfig({},true),/approval/);
  const hosted={EXTERNAL_HOSTING_APPROVED:'true',PERSONAL_PROJECT_CREDENTIALS:'true',APP_ORIGINS:'https://preview.example',SESSION_SECRET:'s'.repeat(32),BRIDGE_ORIGIN_SECRET:'b'.repeat(32),RATE_LIMIT_REDIS_URL:'https://redis.example',RATE_LIMIT_REDIS_TOKEN:'test'};
  assert.deepEqual(hostingConfig(hosted,true),{host:'0.0.0.0',port:10000});
  assert.equal(trustedProxy({headers:{}},hosted,true),false);
  assert.equal(trustedProxy({headers:{'x-origin-secret':hosted.BRIDGE_ORIGIN_SECRET}},hosted,true),true);
  assert.throws(()=>hostingConfig({...hosted,APP_ORIGINS:'http://public.example'},true),/incomplete/);
});
