import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePCM, PCMPlayer } from '../src/lib/pcm-player.js';
import { upsertMessage, readEvents } from '../src/lib/transcript.js';
test('PCM signed little endian decodes accurately',()=> {
  const pcm=Buffer.alloc(6);pcm.writeInt16LE(-32768,0);pcm.writeInt16LE(0,2);pcm.writeInt16LE(16384,4);
  assert.deepEqual([...decodePCM(pcm.toString('base64'))],[-1,0,0.5]);assert.throws(()=>decodePCM('AA=='));
});
test('transcript corrections preserve order and distinct user messages',()=> {
  let m=upsertMessage([],{id:'a',text:'old'});m=upsertMessage(m,{id:'b',text:'second'});m=upsertMessage(m,{id:'a',text:'corrected'});
  assert.deepEqual(m.map(x=>x.text),['corrected','second']);
});
test('stream parser handles split Arabic UTF-8 and rejects truncated data',async()=> {
  const bytes=new TextEncoder().encode('{"text":"خالد"}\n');
  const stream=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const result=[];for await(const e of readEvents(stream))result.push(e);assert.deepEqual(result,[{text:'خالد'}]);
  await assert.rejects(async()=>{for await(const e of readEvents(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));c.close();}})))void e;},/truncated_stream/);
});
class Context {
  constructor(){this.currentTime=0;this.state='running';this.sources=[];}
  createAnalyser(){return {connect(){},disconnect(){},getByteTimeDomainData(d){d.fill(128);}};}
  createMediaStreamDestination(){return {stream:{getTracks(){return [{stop(){}}];}},disconnect(){}};}
  createBuffer(_,length,rate){return {duration:length/rate,copyToChannel(){}};}
  createBufferSource(){const s={connect(){},disconnect(){},start(){},stop(){s.stopped=true;}};this.sources.push(s);return s;}
  async resume(){} async close(){this.state='closed';}
}
test('audio queue waits for actual onended and closes all resources on Stop',async()=> {
  const player=new PCMPlayer(()=>{},Context);await player.resume();
  player.add(Buffer.alloc(640).toString('base64'),'pcm_16000','agent');
  let done=false;const drained=player.drained().then(()=>done=true);await Promise.resolve();assert.equal(done,false);
  player.context.sources[0].onended();await drained;assert.equal(done,true);
  player.add(Buffer.alloc(640).toString('base64'),'pcm_16000','user');player.close();
  assert.equal(player.context.sources[1].stopped,true);assert.equal(player.context.state,'closed');
});
test('suspended audio cannot silently consume a demo session',()=> {
  const player=new PCMPlayer(()=>{},Context);player.context.state='suspended';
  assert.throws(()=>player.add(Buffer.alloc(640).toString('base64'),'pcm_16000','agent'),/audio_suspended/);player.close();
});

import { RecordingCapture, recordingMimeType, transcriptBundle } from '../src/lib/recording-capture.js';
class FakeRecorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor(stream, options) { this.stream=stream; this.mimeType=options.mimeType; this.state='inactive'; this.events={}; }
  addEventListener(type, fn, opts={}) { (this.events[type] ||= []).push({fn,once:opts.once}); }
  emit(type, event={}) { for(const e of [...(this.events[type]||[])]) { e.fn(event); if(e.once) this.events[type]=this.events[type].filter(x=>x!==e); } }
  start() { this.state='recording'; }
  stop() { this.state='inactive'; this.emit('dataavailable',{data:new Blob(['sample'],{type:this.mimeType})}); queueMicrotask(()=>this.emit('stop')); }
}
test('recording capture aligns actual scheduled speaker audio with transcript and exports fixture metadata', async()=> {
  assert.equal(recordingMimeType(FakeRecorder),'audio/webm;codecs=opus');
  let time=10; const capture=new RecordingCapture({stream:{},context:{currentTime:time},Recorder:FakeRecorder,now:()=>time});
  capture.addTranscript({id:'agent-1',role:'agent',text:'actual agent transcript'});
  time=11.25;capture.schedule('agent',time,12.5);time=13;
  capture.addTranscript({id:'user-2',role:'user',text:'actual customer transcript'});
  time=13.5;capture.schedule('user',time,14.75);time=15;
  const result=await capture.stop();
  assert.equal(result.extension,'webm');assert.equal(result.blob.size>0,true);
  assert.deepEqual(result.transcript.map(x=>[x.speaker,x.start,x.end]),[['agent',1.25,2.5],['customer',3.5,4.75]]);
  const bundle=transcriptBundle(result,{recordingName:'demo.webm',consentConfirmed:true,verifiedAt:'2026-10-10'});
  assert.equal(bundle.audioSrc,'/recordings/demo.webm');assert.equal(bundle.transcript.length,2);
});
test('recording fails closed when no supported media recorder format exists',()=> {
  class Unsupported { static isTypeSupported(){return false;} }
  assert.throws(()=>new RecordingCapture({stream:{},context:{currentTime:0},Recorder:Unsupported}),/recording_not_supported/);
});
