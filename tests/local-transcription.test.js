const {test}=require('node:test');
const assert=require('node:assert/strict');
const {LocalTranscription}=require('../local-transcription.js');
function setup(run){
 const db={}, listeners=[];const runtime={id:'extension',getURL:p=>'chrome-extension://extension/'+p,onMessage:{addListener:f=>listeners.push(f)},sendMessage:async m=>{if(m.action==='run')return run(m);return {ok:true};}};
 const storage={get:async k=>k===null?{...db}:({[k]:db[k]}),set:async v=>Object.assign(db,structuredClone(v))};
 const client={readPcmWindow:async(_,start,duration)=>({base64:Buffer.from(new Float32Array(Math.round(duration*16000)).fill(.05).buffer).toString('base64'),samples:Math.round(duration*16000),sampleRate:16000,encoding:'f32le',start,duration})};
 return {local:new LocalTranscription({runtime,storage,ensureOffscreen:async()=>{}}),db,listeners,client};
}
const descriptor={fingerprint:'abc',videoId:'v',duration:40,sampleRate:16000};
test('memory admission estimate rejects a budget too small for the selected model',async()=>{
 const s=setup(async()=>{throw Error('must reject before inference');});
 await assert.rejects(s.local.start({taskId:'budget',descriptor,client:s.client,model:'small',settings:{memoryBudgetMiB:512}}),/内存预估/);
});
test('parallel model cache requests respect the native host capacity',async()=>{
 let finish,peak=0,active=0;
 const s=setup(m=>new Promise(resolve=>{finish=()=>resolve({ok:true,taskId:m.taskId,requestId:m.requestId,processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[],chunks:[{text:'中文',timestamp:[0,m.duration]}]});}));
 s.client.modelFileInfo=async()=>{active++;peak=Math.max(peak,active);try{if(active>1)throw Error('native capacity reached');await new Promise(r=>setTimeout(r,10));return {size:1,sha256:'a'.repeat(64)};}finally{active--;}};
 const run=s.local.start({taskId:'bridge',descriptor:{...descriptor,duration:10},client:s.client});
 while(!finish)await new Promise(r=>setImmediate(r));
 const task=s.local.tasks.get('bridge'),listener=s.listeners[0];
 const replies=await Promise.all(['config.json','tokenizer.json','preprocessor_config.json'].map(file=>new Promise(resolve=>listener({target:'local-transcription',action:'model-info',taskId:'bridge',token:task.token,model:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8',file},{id:'extension',url:'chrome-extension://extension/offscreen.html'},resolve))));
 finish();await run;assert.ok(replies.every(r=>r.ok));assert.equal(peak,1);
});
test('absolute windows and persisted blocks are reused on retry',async()=>{
 let calls=0;const s=setup(async m=>{calls++;return {ok:true,taskId:m.taskId,requestId:m.requestId,chunks:[{text:'中文',timestamp:[0,m.duration]}],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]};});
 const args={taskId:'a',descriptor,client:s.client};const text=await s.local.start(args);assert.match(text,/00:00:20,000/);assert.equal(calls,2);await s.local.start({...args,taskId:'b'});assert.equal(calls,2);
});
test('cancel rejects running work and queued work waits for its terminal state',async()=>{
 let resolve;const s=setup(m=>new Promise(r=>{resolve=()=>r({ok:true,chunks:[],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]});}));
 const p=s.local.start({taskId:'a',descriptor,client:s.client});const rejected=assert.rejects(p,/取消/);while(!resolve)await new Promise(r=>setImmediate(r));s.local.cancel('a');resolve();await rejected;assert.equal(s.db['local-transcription-state'].status,'cancelled');
});
test('wrong sender and inactive model RPC cannot access native files',async()=>{
 const s=setup(async()=>{});const listener=s.listeners[0];let reply;
 assert.equal(listener({target:'local-transcription',action:'model-info',taskId:'bad'}, {id:'evil',url:'https://evil.test'},x=>reply=x),false);assert.equal(reply,undefined);
});
test('global queue prevents concurrent worker use and queued cancellation never runs',async()=>{
 let release,started=0;const s=setup(m=>{started++;return new Promise(r=>{release=()=>r({ok:true,taskId:m.taskId,requestId:m.requestId,chunks:[{text:'中文',timestamp:[0,m.duration]}],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]});});});
 const p=s.local.start({taskId:'a',descriptor:{...descriptor,duration:10},client:s.client});while(!release)await new Promise(r=>setImmediate(r));
 const q=s.local.start({taskId:'b',descriptor,client:s.client});const rejected=assert.rejects(q,/取消/);s.local.cancel('b');assert.equal(started,1);release();await p;await rejected;assert.equal(started,1);
});
test('silent audio has complete coverage without running a worker',async()=>{
 const s=setup(async()=>{throw Error('不应运行ASR');});s.client.readPcmWindow=async(_,start,duration)=>({base64:Buffer.alloc(duration*16000*4).toString('base64'),samples:duration*16000,sampleRate:16000,encoding:'f32le',start,duration});
 assert.equal(await s.local.start({taskId:'silent',descriptor,client:s.client}),'');const cache=Object.values(s.db).find(x=>x.blocks);assert.equal(Object.keys(cache.blocks).length,2);assert.equal(cache.blocks[1].status,'silent');
});
test('failed second window resumes only its missing block and source fingerprint isolates caches',async()=>{
 let calls=0,fail=true;const s=setup(async m=>{calls++;if(fail&&calls===2)return {ok:false,error:'转写失败'};return {ok:true,taskId:m.taskId,requestId:m.requestId,chunks:[{text:'中文',timestamp:[0,m.duration]}],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]};});
 await assert.rejects(s.local.start({taskId:'a',descriptor,client:s.client}),/失败/);fail=false;await s.local.start({taskId:'b',descriptor,client:s.client});assert.equal(calls,3);
 await s.local.start({taskId:'c',descriptor:{...descriptor,fingerprint:'other'},client:s.client});assert.equal(calls,5);
});
test('active model bridge rejects traversal and bounds chunk access',async()=>{
 let release,runMessage,nativeCalls=0;const s=setup(m=>new Promise(r=>{runMessage=m;release=()=>r({ok:true,taskId:m.taskId,requestId:m.requestId,chunks:[{text:'中文',timestamp:[0,m.duration]}],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]});}));s.client.modelFileInfo=async()=>{nativeCalls++;return {size:12};};
 const p=s.local.start({taskId:'a',descriptor:{...descriptor,duration:10},client:s.client});while(!release)await new Promise(r=>setImmediate(r));
 const sender={id:'extension',url:'chrome-extension://extension/offscreen.html'},message={target:'local-transcription',taskId:'a',token:runMessage.token,action:'model-info',model:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8',file:'../secret'};let reply;
 s.listeners[0](message,sender,x=>reply=x);assert.equal(reply.ok,false);assert.equal(nativeCalls,0);
 const result=await new Promise(r=>s.listeners[0]({...message,file:'config.json'},sender,r));assert.equal(result.ok,true);assert.equal(nativeCalls,1);
 s.listeners[0]({...message,action:'model-chunk',file:'config.json',offset:0,length:262145},sender,x=>reply=x);assert.equal(reply.ok,false);release();await p;
});

test('queued cancel settles immediately while C still waits behind A',async()=>{
 let release,started=[];const s=setup(m=>{started.push(m.taskId);if(m.taskId==='a')return new Promise(r=>{release=()=>r({ok:true,taskId:m.taskId,requestId:m.requestId,chunks:[{text:'A',timestamp:[0,m.duration]}],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]});});return {ok:true,taskId:m.taskId,requestId:m.requestId,chunks:[{text:'C',timestamp:[0,m.duration]}],processedSamples:m.samples,coverage:[{start:0,end:m.duration,samples:m.samples}],recoveryPlan:[],recoveryCoverage:[],noText:[]};});
 const a=s.local.start({taskId:'a',descriptor:{...descriptor,duration:10},client:s.client});while(!release)await new Promise(r=>setImmediate(r));
 const b=s.local.start({taskId:'b',descriptor,client:s.client});const settled=assert.rejects(b,/取消/);s.local.cancel('b');
 try{await Promise.race([settled,new Promise((_,reject)=>setTimeout(()=>reject(Error('queued cancellation exceeded 50ms')),50))]);const c=s.local.start({taskId:'c',descriptor:{...descriptor,fingerprint:'c',duration:10},client:s.client});await new Promise(r=>setTimeout(r,10));assert.deepEqual(started,['a']);release();await a;await c;assert.deepEqual(started,['a','c']);}finally{release();await a;await settled;}
});
