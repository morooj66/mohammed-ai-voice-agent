import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({entryPoints:['src/hooks/useLiveConversation.js'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
  name:'offline-hook-harness',setup(b){
    b.onResolve({filter:/^(react|@elevenlabs\/react)$/},a=>({path:a.path,namespace:'fake'}));
    b.onLoad({filter:/.*/,namespace:'fake'},a=>({contents:a.path==='react'?`
      export const useCallback=f=>f;
      export const useRef=x=>({current:x});
      export const useState=x=>[x,v=>globalThis.__hook.states.push(v)];
      export const useEffect=f=>{globalThis.__hook.cleanups.push(f());};
    `:`export const useConversation=options=>{globalThis.__hook.callbacks=options;return globalThis.__hook.conversation;};`}));
  }
}]});
const {default:useLive} = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness(){
  let starts=0,ends=0,tracksStopped=0;
  const oldFetch=globalThis.fetch, oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const state={states:[],cleanups:[],conversation:{status:'disconnected',mode:'listening',startSession(){starts++;},endSession(){ends++;}}};
  globalThis.__hook=state;
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({token:'test-token'})});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){tracksStopped++;}}]})}}});
  const hook=useLive();
  return {hook,state,starts:()=>starts,ends:()=>ends,tracksStopped:()=>tracksStopped,restore(){state.cleanups.forEach(f=>f?.());globalThis.fetch=oldFetch;Object.defineProperty(globalThis,'navigator',oldNavigator);delete globalThis.__hook;}};
}
test('live adapter connects with documented SDK API, stops permission stream, and ends safely',async()=>{
  const h=harness();try{await h.hook.start();assert.equal(h.starts(),1);assert.equal(h.tracksStopped(),1);h.hook.end();assert.equal(h.ends(),1);}finally{h.restore();}
});
test('Stop during token fetch prevents late session creation',async()=>{
  const h=harness();try{let release,called;const fetched=new Promise(r=>called=r);globalThis.fetch=()=>{called();return new Promise(r=>release=r);};const starting=h.hook.start();await fetched;h.hook.end();release({ok:true,status:200,json:async()=>({token:'late'})});await starting;assert.equal(h.starts(),0);}finally{h.restore();}
});
test('SDK error callback ends session and can be handled without throwing',()=>{
  const h=harness();try{assert.doesNotThrow(()=>h.state.callbacks.onError('upstream'));assert.equal(h.ends(),1);}finally{h.restore();}
});
test('unauthorized token response never calls the provider; the permission probe stream is already stopped',async()=>{
  const h=harness();try{globalThis.fetch=async()=>({status:401});await h.hook.start();assert.equal(h.starts(),0);assert.equal(h.tracksStopped(),1,'probe stream stopped, nothing left open');}finally{h.restore();}
});
test('denied microphone never requests a token, so no rate-limited session is used',async()=>{
  const h=harness();try{let fetches=0;globalThis.fetch=async()=>{fetches++;return {ok:true,status:200,json:async()=>({token:'t'})};};
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{throw Object.assign(new Error('no'),{name:'NotAllowedError'});}}}});
    await h.hook.start();assert.equal(fetches,0);assert.equal(h.starts(),0);}finally{h.restore();}
});
