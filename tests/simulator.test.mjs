import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationSession, LIMITS, pcmRate } from '../server/simulator/session.mjs';
import { OPENING, validateReply } from '../server/simulator/khalid.mjs';
function harness(options={}) {
  let time=0, tick; const sent=[],events=[]; let closed=0;
  const session = new SimulationSession({ socket:{readyState:1,send:s=>sent.push(JSON.parse(s)),close:()=>closed++},
    emit:e=>events.push(e), now:()=>time, timers:{setInterval:f=>{tick=f; return 1;},clearInterval:()=>{}},sleep:async()=>{},
    reply:async history=>({text:history.at(-1).text.includes('مصاب')?'أنا بخير، ما فيه إصابات.':'طيب وضّح لي وش أسوي؟',emotion:'CONFUSED'}),
    tts:async()=>Buffer.alloc(640), ...options });
  session.message({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{user_input_audio_format:'pcm_16000',agent_output_audio_format:'pcm_16000'}});
  return {session,events,sent,closed:()=>closed,advance:ms=>{time+=ms;tick();}};
}
function agent(h,id=1,text='فيه أحد مصاب؟') {
  h.session.message({type:'agent_response',agent_response_event:{event_id:id,agent_response:text}});
  h.session.message({type:'audio',audio_event:{event_id:id,audio_base_64:Buffer.alloc(640).toString('base64')}});
  h.session.message({type:'agent_response_complete',agent_response_complete_event:{event_id:id}});
}
test('greeting waits for real completion AND playback ack, then sends PCM opening',async()=> {
  const h=harness(); agent(h); assert.equal(h.sent.length,0);
  const barrier=h.session.awaiting;
  assert.equal(await h.session.acknowledge('wrong'),false);
  await h.session.acknowledge(barrier);
  assert.equal(h.events.find(e=>e.role==='user'&&e.type==='transcript').text,OPENING);
  assert.equal(h.sent.filter(e=>e.user_audio_chunk).length,1);
  h.session.stop();
});
test('duplicate completion/ack does not produce duplicate Khalid turns',async()=> {
  const h=harness(); agent(h); const barrier=h.session.awaiting;
  h.session.message({type:'agent_response_complete'}); await h.session.acknowledge(barrier); await h.session.acknowledge(barrier);
  assert.equal(h.session.turns,2); h.session.stop();
});
test('later Khalid replies use actual Mohammed context, and correction updates in place',async()=> {
  const h=harness(); agent(h,1); await h.session.acknowledge(h.session.awaiting);
  h.session.message({type:'agent_response',agent_response_event:{event_id:2,agent_response:'أنت مصاب؟'}});
  h.session.message({type:'agent_response_correction',agent_response_correction_event:{event_id:2,corrected_agent_response:'فيه أحد مصاب؟'}});
  h.session.message({type:'audio',audio_event:{audio_base_64:Buffer.alloc(640).toString('base64')}});
  h.session.message({type:'agent_response_complete'}); await h.session.acknowledge(h.session.awaiting);
  assert.equal(h.session.history.at(-1).text,'أنا بخير، ما فيه إصابات.'); assert.equal(h.session.history.length,4); h.session.stop();
});
test('safety stop at twelve utterances including greeting; the default is 120 seconds',async()=> {
  const h=harness(); for(let i=1;i<=6;i++){agent(h,i);await h.session.acknowledge(h.session.awaiting);}
  assert.equal(LIMITS.duration,120_000); assert.equal(LIMITS.turns,12);
  assert.equal(h.session.turns,12); assert.equal(h.events.at(-1).reason,'turn_limit'); assert.equal(h.closed(),1);
  agent(h,7); assert.equal(h.session.turns,12);
});
test('two minute maximum and turn watchdog include pending operations',()=> {
  const h=harness();h.advance(LIMITS.duration);assert.equal(h.events.at(-1).reason,'duration_limit');
  const stalled=harness();stalled.advance(LIMITS.turnTimeout);assert.equal(stalled.events.at(-1).reason,'turn_timeout');
});
test('stop cancels pending generation and releases socket once',async()=> {
  let release; const h=harness({tts:()=>new Promise(r=>release=r)}); agent(h);
  const pending=h.session.acknowledge(h.session.awaiting); h.session.stop(); release(Buffer.alloc(640));await pending;
  assert.equal(h.sent.length,0); assert.equal(h.closed(),1); h.session.stop();assert.equal(h.closed(),1);
});
test('audio failure terminates without silent retry',async()=> {
  const h=harness({tts:async()=>{throw Error('failed');}});agent(h);await h.session.acknowledge(h.session.awaiting);
  assert.equal(h.events.at(-1).reason,'generation_or_audio_failed');
});
test('unsafe tool events, interruptions and missing audio stop session',()=> {
  for(const type of ['client_tool_call','mcp_tool_call','agent_tool_request','interruption','client_error']) {
    const h=harness();h.session.message({type});assert.equal(h.events.at(-1).reason,type);
  }
  const h=harness();h.session.message({type:'agent_response_complete'});assert.equal(h.events.at(-1).reason,'incomplete_agent_turn');
});
test('ping uses documented pong and silence does not invent transcripts',()=> {
  const h=harness();h.session.message({type:'ping',ping_event:{event_id:7}});assert.deepEqual(h.sent[0],{type:'pong',event_id:7});
  h.advance(1000);assert.ok(h.sent[1].user_audio_chunk);assert.equal(h.session.history.length,0);h.session.stop();
});
test('unsupported audio and unsafe LLM payloads fail closed; relief is gradual',()=> {
  assert.throws(()=>pcmRate('mp3_44100_128'));
  for(const reply of [{text:'رقمي 0500000000',emotion:'STRESSED'},{text:'ألو',emotion:'EXCITED'},{text:'[sighs] ألو',emotion:'STRESSED'}]) assert.throws(()=>validateReply(reply));
  assert.equal(validateReply({text:'طيب فهمت عليك',emotion:'RELIEVED'}).emotion,'CALMING_DOWN');
});

test('Khalid uses the approved exact Riyadh/Najdi opening', () => {
  assert.equal(OPENING, 'ألو، السلام عليكم! يا أخوي أنا توي صادم عند الإشارة، والله إني متقروش! ماني عارف وش أسوي الحين!');
});
