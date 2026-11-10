'use strict';
const PINNED={'Xenova/whisper-base':'64da57285918e20ea79ea5c88eed7197933abaa8','Xenova/whisper-small':'2d67713f236afa48a18992566e7647f6ca848e13'};
const ALLOWED_FILES=new Set(['config.json','generation_config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','added_tokens.json','vocab.json','merges.txt','normalizer.json','onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx']);
const originalFetch=self.fetch?.bind(self);
let lastCacheFailure='';
self.fetch=async(request,options)=>{
 const url=new URL(typeof request==='string'?request:request.url,self.location.href),origin=new URL(self.location.href);
 const local=url.protocol===origin.protocol&&url.host===origin.host&&/^\/lib\/(?:ort-wasm-simd-threaded-3\.8\.1\.jsep\.(?:mjs|wasm)|transformers-3\.8\.1\.min\.js)$/.test(url.pathname)&&!url.search&&!url.hash;
 const safeBlob=url.protocol==='blob:'&&url.href.startsWith(`blob:${origin.protocol}//${origin.host}/`);
 if(!local&&!safeBlob)throw Error('共享模型缓存未命中或读取失败；浏览器网络回退已禁止'+(lastCacheFailure?'：'+lastCacheFailure:''));
 if(!originalFetch)throw Error('本地运行时fetch不可用');return originalFetch(request,options);
};
let task=null,pipeline=null,loadedKey='',rpcCounter=0;const requests=new Map();
function rpc(action,extra){const rpcId=++rpcCounter;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(rpcId);reject(Error('共享模型缓存读取超时'));},120000);requests.set(rpcId,{resolve,reject,timer});self.postMessage({action,rpcId,taskId:task.taskId,token:task.token,...extra});});}
async function cachedModel(request){
 const value=typeof request==='string'?request:request.url;
 if(!/^https?:/.test(value))return undefined;
 const url=new URL(value);const prefix=`/${task.model}/resolve/${task.revision}/`;
 if(url.protocol!=='https:'||url.hostname!=='huggingface.co'||!url.pathname.startsWith(prefix)||url.search||url.hash)throw Error('模型请求来源未获允许');
 const file=url.pathname.slice(prefix.length);if(!ALLOWED_FILES.has(file))throw Error('模型文件不在允许列表');
 const args={model:task.model,revision:task.revision,file};const info=await rpc('model-info',args);
 if(!Number.isSafeInteger(info.size)||info.size<1||info.size>350*1024*1024||!/^[a-f0-9]{64}$/i.test(info.sha256))throw Error('共享模型文件信息无效');
 const bytes=new Uint8Array(info.size);
 for(let offset=0;offset<info.size;offset+=262144){const length=Math.min(262144,info.size-offset),part=await rpc('model-chunk',{...args,offset,length});if(part.offset!==offset||part.totalSize!==info.size||part.size!==length||typeof part.base64!=='string'||part.base64.length>350000)throw Error('共享模型分片信息不一致');const raw=Uint8Array.from(atob(part.base64),c=>c.charCodeAt(0));if(raw.length!==length)throw Error('共享模型分片长度不一致');bytes.set(raw,offset);}
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');if(hash.toLowerCase()!==info.sha256.toLowerCase())throw Error('共享模型文件SHA256校验失败');
 return new Response(bytes,{headers:{'Content-Type':file.endsWith('.json')?'application/json':'application/octet-stream','Content-Length':String(bytes.length)}});
}
async function transcribe(m){
 if(task)throw Error('本地转写线程正忙');if(PINNED[m.model]!==m.revision||!['wasm','webgpu'].includes(m.device))throw Error('本地转写模型或设备无效');
 task=m;try{
  const pcm=new Float32Array(m.pcm);if(pcm.length!==m.samples||Math.abs(pcm.length/16000-m.duration)>.001||m.duration<=0||m.duration>30)throw Error('PCM解码样本数不符');
  const T=await import(new URL('lib/transformers-3.8.1.min.js',self.location.href).href);
  T.env.allowLocalModels=false;T.env.allowRemoteModels=true;T.env.useBrowserCache=false;T.env.useCustomCache=true;T.env.customCache={match:async request=>{try{return await cachedModel(request);}catch(error){lastCacheFailure=error.message;throw error;}},put:async()=>{}};
  // customCache is the only model transport; no fetch fallback is allowed.
  T.env.allowRemoteModels=true;
  const base=new URL('lib/',self.location.href);T.env.backends.onnx.wasm.wasmPaths={mjs:new URL('ort-wasm-simd-threaded-3.8.1.jsep.mjs',base).href,wasm:new URL('ort-wasm-simd-threaded-3.8.1.jsep.wasm',base).href};
  T.env.backends.onnx.wasm.numThreads=self.crossOriginIsolated?Math.max(1,Math.min(8,Math.floor(Number(m.threads)||4))):1;T.env.backends.onnx.wasm.proxy=false;
  const key=`${m.model}@${m.revision}:${m.device}`;if(loadedKey!==key){await pipeline?.dispose();pipeline=await T.pipeline('automatic-speech-recognition',m.model,{revision:m.revision,dtype:'q8',device:m.device==='wasm'?'wasm':'webgpu'});loadedKey=key;}
  const options={language:'chinese',task:'transcribe',return_timestamps:true,chunk_length_s:30,stride_length_s:0};
  const result=await pipeline(pcm,options);
  if(!Array.isArray(result.chunks))throw Error('本地模型未返回时间戳');
  let chunks=result.chunks.map(c=>({text:c.text,timestamp:c.timestamp}));
  function checked(raw,duration){if(!Array.isArray(raw))throw Error('短窗口复验未返回字幕块');return raw.map((c,index)=>{const t=c.timestamp,estimatedEnd=Array.isArray(t)&&t[1]===null&&index===raw.length-1,end=estimatedEnd?duration:t?.[1];if(typeof c.text!=='string'||!Array.isArray(t)||!Number.isFinite(t[0])||!Number.isFinite(end)||t[0]<0||t[0]>=duration||end<t[0]||end>duration+1)throw Error('本地模型时间戳无效：'+JSON.stringify(t)+'，窗口'+duration+'秒');return {text:c.text,timestamp:[t[0],Math.min(duration,end)],...(estimatedEnd?{estimatedEnd:true}:{})};});}
  chunks=checked(chunks,m.duration).filter(c=>!c.estimatedEnd);
  const recoveryPlan=[],recoveryCoverage=[],noText=[];let cursor=0;
  for(const c of chunks.filter(c=>c.text.trim()).slice().sort((a,b)=>a.timestamp[0]-b.timestamp[0])){if(c.timestamp[0]-cursor>2)recoveryPlan.push({start:cursor,end:c.timestamp[0]});cursor=Math.max(cursor,c.timestamp[1]);}
  if(m.duration-cursor>2)recoveryPlan.push({start:cursor,end:m.duration});
  // Revisit every uncovered interval once, continuously, in <=10s windows.
  // Empty successful inference means no_text, not proof that music was speech.
  for(const gap of recoveryPlan)for(let start=gap.start;start<gap.end;){const end=Math.min(start+10,gap.end),first=Math.round(start*16000),last=Math.round(end*16000),window=pcm.subarray(first,last);
   const retry=await pipeline(window,options),extra=checked(retry.chunks,window.length/16000);
   recoveryCoverage.push({start,end,samples:window.length});
   if(!extra.some(c=>c.text.trim()))noText.push({start,end});
   chunks.push(...extra.map(c=>({text:c.text,timestamp:[c.timestamp[0]+start,c.timestamp[1]+start]})));start=end;
  }
  chunks.sort((a,b)=>a.timestamp[0]-b.timestamp[0]);
  if(chunks.length>2000||JSON.stringify(chunks).length>200000)throw Error('本地转写输出超过单窗口限制');
  return {chunks,processedSamples:pcm.length,coverage:[{start:0,end:m.duration,samples:pcm.length}],recoveryPlan,recoveryCoverage,noText};
 }finally{task=null;}
}
self.onmessage=async({data:m})=>{
 if(m.action==='model-response'){const r=requests.get(m.rpcId);if(r&&task?.taskId===m.taskId&&task?.token===m.token){requests.delete(m.rpcId);clearTimeout(r.timer);if(m.ok)r.resolve(m.result);else r.reject(Error(m.error||'共享模型读取失败'));}return;}
 if(m.action!=='transcribe')return;
 try{const result=await transcribe(m);self.postMessage({ok:true,taskId:m.taskId,token:m.token,requestId:m.requestId,...result});}catch(e){self.postMessage({ok:false,taskId:m.taskId,token:m.token,requestId:m.requestId,error:e.message});}
};
