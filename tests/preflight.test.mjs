import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { configHash, preflight } from '../server/elevenlabs.mjs';
import { GREETING } from '../server/config.mjs';
const kb=new URL('../../sarj-agent-assessment/knowledge_base/',import.meta.url);
// On Vercel the sibling assessment directory is absent. Read test-only synthetic copies
// from the manifest for config failures; content integrity success runs only locally.
const documents=(()=>{try{return readdirSync(kb).filter(x=>x.endsWith('.md')).map((name,i)=>({id:`doc-${i}`,text:readFileSync(new URL(name,kb),'utf8')}));}catch{return [];}})();
function fixture(){
  const agent={version_id:'v1',platform_settings:{auth:{enable_auth:true}},conversation_config:{conversation:{max_duration_seconds:180,client_events:['audio','agent_response_complete']},agent:{first_message:GREETING,prompt:{knowledge_base:Array.from({length:9},(_,i)=>({id:`doc-${i}`}))}}}};
  const env={PERSONAL_PROJECT_CREDENTIALS:'true',ELEVENLABS_API_KEY:'fake-personal-test',ELEVENLABS_AGENT_ID:'test',ELEVENLABS_VERSION_ID:'v1',LIVE_SESSIONS_APPROVED:'true',SIMULATION_PAID_APPROVED:'true',AGENT_SAFETY_REVIEWED:'true',AUDITED_AGENT_SHA256:configHash(agent)};
  return {agent,env};
}
test('configuration drift, auth removal, excessive duration and external tools block sessions',async()=>{
  const old=globalThis.fetch;
  try {
    for(const mutate of [a=>a.version_id='v2',a=>a.platform_settings.auth.enable_auth=false,a=>a.conversation_config.conversation.max_duration_seconds=600,a=>a.conversation_config.agent.prompt.tool_ids=['transfer'],a=>a.workflow={nodes:{transfer:{}}},a=>a.conversation_config.agent.prompt.built_in_tools={transfer_to_number:{}},a=>a.conversation_config.conversation.client_events=['audio'],a=>a.conversation_config.agent.prompt.knowledge_base=[]]){
      const {agent,env}=fixture();mutate(agent);env.AUDITED_AGENT_SHA256=configHash(agent);
      globalThis.fetch=async()=>({ok:true,json:async()=>agent});await assert.rejects(preflight(env,true));
    }
    const {agent,env}=fixture();agent.conversation_config.agent.first_message='changed';globalThis.fetch=async()=>({ok:true,json:async()=>agent});await assert.rejects(preflight(env,true),/agent_changed/);
  }finally{globalThis.fetch=old;}
});
test('nine approved document contents must match, not just attachment names',{skip:!documents.length},async()=>{
  const old=globalThis.fetch;try{
    const {agent,env}=fixture();
    globalThis.fetch=async url=>url.includes('/agents/')?{ok:true,json:async()=>agent}:{ok:true,text:async()=>documents.find(d=>url.includes(`/${d.id}/`)).text};
    assert.equal((await preflight(env,true)).version_id,'v1');
    globalThis.fetch=async url=>url.includes('/agents/')?{ok:true,json:async()=>agent}:{ok:true,text:async()=> 'tampered document'};
    await assert.rejects(preflight(env,true),/knowledge_base_content_changed/);
  }finally{globalThis.fetch=old;}
});
