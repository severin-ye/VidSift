const {test}=require('node:test');const assert=require('node:assert/strict');
const {validateModelRequest,validateOutput}=require('../local-transcription.js');
const fs=require('node:fs'),vm=require('node:vm');
test('model cache accepts only pinned repositories revisions and exact file names',()=>{
 assert.equal(validateModelRequest('base','64da57285918e20ea79ea5c88eed7197933abaa8','onnx/encoder_model_quantized.onnx'),true);
 for(const file of ['../../secret','config.json?x=1','onnx/../config.json','https://evil/x'])assert.equal(validateModelRequest('base','64da57285918e20ea79ea5c88eed7197933abaa8',file),false);
 assert.equal(validateModelRequest('base','main','config.json'),false);
});

test('Whisper timestamp quantization clips a 25.2 second endpoint to a 25 second window',async()=>{
 const messages=[];const pipe=async()=>({chunks:[{text:'前文',timestamp:[0,22.8]},{text:'末句',timestamp:[22.8,25.2]}]});pipe.dispose=async()=>{};
 const T={env:{backends:{onnx:{wasm:{}}}},pipeline:async()=>pipe};
 const self={location:{href:'chrome-extension://extension/whisper-worker.js'},crossOriginIsolated:true,postMessage:m=>messages.push(m)};
 const code=fs.readFileSync(require.resolve('../whisper-worker.js'),'utf8').replace("import(new URL('lib/transformers-3.8.1.min.js',self.location.href).href)",'__import()');
 vm.runInNewContext(code,{self,URL,Response,Uint8Array,Float32Array,Number,Math,Map,Set,Error,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,__import:async()=>T});
 await self.onmessage({data:{action:'transcribe',taskId:'q',token:'t',requestId:'r',model:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8',device:'wasm',duration:25,samples:400000,pcm:new Float32Array(400000).fill(.05).buffer}});
 assert.equal(messages.at(-1).ok,true);assert.equal(messages.at(-1).chunks.at(-1).timestamp[1],25);
});

test('an unfinished Whisper endpoint is replaced by continuous short-window inference',async()=>{
 let calls=0;const messages=[];const pipe=async()=>({chunks:[{text:++calls===1?'未定时原稿':'短窗口播'+calls,timestamp:[0,null]}]});pipe.dispose=async()=>{};
 const T={env:{backends:{onnx:{wasm:{}}}},pipeline:async()=>pipe},self={location:{href:'chrome-extension://extension/whisper-worker.js'},crossOriginIsolated:true,postMessage:m=>messages.push(m)};
 const code=fs.readFileSync(require.resolve('../whisper-worker.js'),'utf8').replace("import(new URL('lib/transformers-3.8.1.min.js',self.location.href).href)",'__import()');
 vm.runInNewContext(code,{self,URL,Response,Uint8Array,Float32Array,Number,Math,Map,Set,Error,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,__import:async()=>T});
 await self.onmessage({data:{action:'transcribe',taskId:'null',token:'t',requestId:'r',model:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8',device:'wasm',duration:30,samples:480000,pcm:new Float32Array(480000).fill(.05).buffer}});
 assert.equal(messages.at(-1).ok,true);assert.equal(calls,4);assert.equal(messages.at(-1).chunks.length,3);assert.equal(messages.at(-1).chunks.at(-1).timestamp[1],30);assert.equal(messages.at(-1).chunks.some(c=>c.text==='未定时原稿'),false);
});
test('worker retries the entire uncovered tail, pins q8 and never allows remote model fetch',async()=>{
 const calls=[],messages=[];const pipe=async(pcm,options)=>{calls.push({samples:pcm.length,options});return calls.length===1?{chunks:[{text:'开头',timestamp:[0,2]}]}:{chunks:[{text:'结尾',timestamp:[0,pcm.length/16000]}]};};pipe.dispose=async()=>{};
 const T={env:{backends:{onnx:{wasm:{}}}},pipeline:async(_,model,options)=>{assert.equal(model,'Xenova/whisper-base');assert.equal(options.dtype,'q8');if(!T.env.allowLocalModels&&!T.env.allowRemoteModels)throw Error('Transformers guard: both sources disabled');return pipe;}};
 const self={location:{href:'chrome-extension://extension/whisper-worker.js'},crossOriginIsolated:true,postMessage:m=>messages.push(m)};
 const code=fs.readFileSync(require.resolve('../whisper-worker.js'),'utf8').replace("import(new URL('lib/transformers-3.8.1.min.js',self.location.href).href)",'__import()');
 vm.runInNewContext(code,{self,URL,Response,Uint8Array,Float32Array,Number,Math,Map,Set,Error,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,__import:async()=>T});
 await self.onmessage({data:{action:'transcribe',taskId:'a',token:'t',requestId:'r',model:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8',device:'wasm',duration:20,samples:320000,pcm:new Float32Array(320000).fill(.05).buffer}});
 assert.equal(calls.length,3);assert.equal(calls[1].samples,160000);assert.equal(calls[0].options.language,'chinese');assert.equal(messages[0].chunks.at(-1).timestamp[1],20);assert.equal(messages[0].recoveryCoverage[0].start,2);assert.equal(messages[0].recoveryCoverage[1].end,20);assert.match(T.env.backends.onnx.wasm.wasmPaths.wasm,/^chrome-extension:/);assert.equal(T.env.useBrowserCache,false);
});
test('offscreen rejects other extension pages and cancellation ignores late worker result',async()=>{
 let listener,worker;const replies=[];class FakeWorker{constructor(){worker=this;}postMessage(m){this.sent=m;}terminate(){this.terminated=true;}}
 const chrome={runtime:{id:'extension',getURL:p=>'chrome-extension://extension/'+p,onMessage:{addListener:f=>listener=f},sendMessage:async()=>({ok:true})}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../offscreen-local.js'),'utf8'),{chrome,Worker:FakeWorker,Uint8Array,Map,Number,Error,atob});
 const message={target:'offscreen-local',taskId:'a',token:'t',requestId:'r'};const sender={id:'extension'};
 assert.equal(listener({...message,action:'begin',byteLength:4},{id:'extension',url:'chrome-extension://extension/popup.html'},m=>replies.push(m)),false);assert.equal(replies.length,0);
 listener({...message,action:'begin',byteLength:4},sender,m=>replies.push(m));listener({...message,action:'pcm',offset:0,base64:'AAAAAA=='},sender,m=>replies.push(m));
 listener({...message,action:'run',samples:1},sender,m=>replies.push(m));listener({...message,action:'cancel'},sender,m=>replies.push(m));
 const count=replies.length;await worker.onmessage({data:{...message,ok:true,chunks:[{text:'迟到'}]}});assert.equal(replies.length,count);assert.equal(worker.terminated,true);assert.match(replies[count-2].error,/取消/);
});
test('missing processed samples and absent inference coverage fail closed',()=>{
 const pcm=new Float32Array(16000*10).fill(.05);
 assert.throws(()=>validateOutput({chunks:[]},pcm,10),/样本/);
 assert.throws(()=>validateOutput({processedSamples:pcm.length,chunks:[{text:'开头',timestamp:[0,1]}]},pcm,10),/覆盖/);
 assert.doesNotThrow(()=>validateOutput({processedSamples:pcm.length,chunks:[],coverage:[{start:0,end:10,samples:pcm.length}],recoveryPlan:[],recoveryCoverage:[],noText:[{start:0,end:10}]},new Float32Array(pcm.length),10));
});

async function runWorker(pcm,responses){
 const calls=[],messages=[],fetches=[];const pipe=async audio=>{calls.push(audio.length);return responses[calls.length-1];};pipe.dispose=async()=>{};
 const T={env:{backends:{onnx:{wasm:{}}}},pipeline:async()=>{if(!T.env.allowLocalModels&&!T.env.allowRemoteModels)throw Error('Transformers guard: both sources disabled');return pipe;}};
 const self={location:{href:'chrome-extension://extension/whisper-worker.js'},crossOriginIsolated:true,fetch:async r=>{fetches.push(r);return new Response('local');},postMessage:m=>messages.push(m)};
 const code=fs.readFileSync(require.resolve('../whisper-worker.js'),'utf8').replace("import(new URL('lib/transformers-3.8.1.min.js',self.location.href).href)",'__import()');
 vm.runInNewContext(code,{self,URL,Response,Uint8Array,Float32Array,Number,Math,Map,Set,Error,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,__import:async()=>T});
 await self.onmessage({data:{action:'transcribe',taskId:'a',token:'t',requestId:'r',model:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8',device:'wasm',duration:pcm.length/16000,samples:pcm.length,pcm:pcm.buffer}});
 return {calls,result:messages[0],self,fetches,T};
}
test('five seconds speech plus sine music can complete with an explicit no_text tail',async()=>{
 const pcm=new Float32Array(160000);for(let i=0;i<pcm.length;i++)pcm[i]=i<80000?.05:.1*Math.sin(2*Math.PI*440*i/16000);
 const {calls,result}=await runWorker(pcm,[{chunks:[{text:'口播',timestamp:[0,5]}]},{chunks:[]}]);
 assert.equal(result.ok,true);assert.deepEqual(calls,[160000,80000]);assert.equal(result.noText[0].start,5);assert.equal(result.noText[0].end,10);assert.doesNotThrow(()=>validateOutput(result,pcm,10));
});
test('first and final captions cannot hide an unverified middle interval',async()=>{
 const pcm=new Float32Array(480000).fill(.05);const {calls,result}=await runWorker(pcm,[{chunks:[{text:'首句',timestamp:[0,2]},{text:'尾句',timestamp:[20,30]}]},{chunks:[]},{chunks:[{text:'中间句',timestamp:[0,8]}]}]);
 assert.equal(result.ok,true);assert.deepEqual(calls,[480000,160000,128000]);assert.equal(result.recoveryCoverage[0].start,2);assert.equal(result.recoveryCoverage[0].end,12);assert.equal(result.recoveryCoverage[1].start,12);assert.equal(result.recoveryCoverage[1].end,20);assert.doesNotThrow(()=>validateOutput(result,pcm,30));
 const broken={...result,recoveryCoverage:result.recoveryCoverage.slice(1)};assert.throws(()=>validateOutput(broken,pcm,30),/缺块/);
});
test('fetch guard blocks all network cache fallbacks but permits packaged runtime files',async()=>{
 const {self,fetches,T}=await runWorker(new Float32Array(160000),[{chunks:[]},{chunks:[]}]);assert.equal(T.env.allowRemoteModels,true);assert.equal(T.env.allowLocalModels,false);
 for(const url of ['https://huggingface.co/Xenova/whisper-base/resolve/main/config.json','https://evil.test/code.js','chrome-extension://extension/private.json','blob:https://evil.test/a'])await assert.rejects(self.fetch(url),/缓存未命中/);
 await self.fetch('chrome-extension://extension/lib/ort-wasm-simd-threaded-3.8.1.jsep.wasm');assert.equal(fetches.length,1);
});


