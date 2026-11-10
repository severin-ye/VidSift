const {test}=require('node:test');
const assert=require('node:assert/strict');
const {NativeMediaClient}=require('../native-client.js');
function event(){const listeners=[];return {addListener:f=>listeners.push(f),emit:x=>listeners.forEach(f=>f(x))};}
function runtime(){const p={onMessage:event(),onDisconnect:event(),postMessage:m=>p.last=m,disconnect:()=>p.onDisconnect.emit()};return {p,connectNative:()=>p};}
test('Groq requests only descriptor and settings and discards cancelled late results',async()=>{
 const r=runtime(),c=new NativeMediaClient(r);let p=c.groqStatus();assert.equal(r.p.last.action,'groq_status');
 r.p.onMessage.emit({id:r.p.last.id,type:'result',result:{configured:true}});assert.deepEqual(await p,{configured:true});
 p=c.transcribeGroq({fingerprint:'hash',videoId:'123',secret:'never'},{model:'whisper-large-v3',timeoutSeconds:300});
 const id=r.p.last.id;assert.equal(r.p.last.action,'transcribe_groq');assert.equal(r.p.last.model,'whisper-large-v3');assert.equal(r.p.last.secret,undefined);
 c.cancel();await assert.rejects(p,/取消/);r.p.onMessage.emit({id,type:'result',result:{srt:'late'}});assert.equal(c.pending.size,0);c.close();
});
test('streams base64 chunks in order and resolves only final result',async()=>{
 const r=runtime(),c=new NativeMediaClient(r);const pending=c.readAsset('asset');const id=r.p.last.id;
 r.p.onMessage.emit({id,type:'chunk',sequence:0,data:'YWJj'});
 r.p.onMessage.emit({id,type:'chunk',sequence:1,data:'ZGVm'});
 r.p.onMessage.emit({id,type:'result',result:{name:'x.jpg',mime:'image/jpeg',size:6}});
 assert.deepEqual(await pending,{name:'x.jpg',mime:'image/jpeg',base64:'YWJjZGVm'});c.close();
});
test('out of order chunks and disconnect reject pending requests',async()=>{
 const r=runtime(),c=new NativeMediaClient(r);const pending=c.readAsset('asset');
 r.p.onMessage.emit({id:r.p.last.id,type:'chunk',sequence:2,data:'YWJj'});
 await assert.rejects(pending,/顺序/);
 const other=c.request('resolve',{url:'x'});r.p.onDisconnect.emit();await assert.rejects(other,/本机/);
});
test('PCM windows preserve metadata and reject invalid bounds before protocol request',async()=>{
 const r=runtime(),c=new NativeMediaClient(r);
 await assert.rejects(c.readPcmWindow('f',0,31),/30/);assert.equal(r.p.last,undefined);
 const pending=c.readPcmWindow('f',1,2);const id=r.p.last.id;
 r.p.onMessage.emit({id,type:'chunk',sequence:0,data:'AAAAAA=='});
 r.p.onMessage.emit({id,type:'result',result:{fingerprint:'f',start:1,duration:1/16000,sampleRate:16000,samples:1,size:4,encoding:'f32le'}});
 assert.equal((await pending).base64,'AAAAAA==');c.close();
});
test('PCM rejects oversized protocol chunks before accumulation',async()=>{
 const r=runtime(),c=new NativeMediaClient(r),pending=c.readPcmWindow('f',0,30);
 r.p.onMessage.emit({id:r.p.last.id,type:'chunk',sequence:0,data:'A'.repeat(349529)});
 await assert.rejects(pending,/上限/);c.close();
});
test('local cache reclaim and finish send fingerprint with explicit terminal status',async()=>{
 const r=runtime(),c=new NativeMediaClient(r),descriptor={fingerprint:'hash',videoId:'123'};
 let p=c.prepareLocalAudio(descriptor);assert.equal(r.p.last.action,'prepare_local_audio');assert.equal(r.p.last.videoId,'123');
 r.p.onMessage.emit({id:r.p.last.id,type:'result',result:descriptor});await p;
 p=c.finishLocalAudio(descriptor,'cancelled');assert.equal(r.p.last.status,'cancelled');
 r.p.onMessage.emit({id:r.p.last.id,type:'result',result:{finished:true}});await p;c.close();
});
