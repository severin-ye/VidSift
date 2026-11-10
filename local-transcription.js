'use strict';
(function(root){
 const MODELS={base:{repo:'Xenova/whisper-base',revision:'64da57285918e20ea79ea5c88eed7197933abaa8'},small:{repo:'Xenova/whisper-small',revision:'2d67713f236afa48a18992566e7647f6ca848e13'}};
 const FILES=new Set(['config.json','generation_config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','added_tokens.json','vocab.json','merges.txt','normalizer.json','onnx/encoder_model_quantized.onnx','onnx/decoder_model_merged_quantized.onnx']);
 let queue=Promise.resolve();let serial=0;
 function modelKey(model){return Object.keys(MODELS).find(k=>k===model||MODELS[k].repo===model);}
 function validateModelRequest(model,revision,file){const k=modelKey(model);return !!(k&&MODELS[k].revision===revision&&FILES.has(file));}
 function isSilent(pcm){let sum=0;for(const sample of pcm)sum+=sample*sample;return Math.sqrt(sum/Math.max(1,pcm.length))<.00001;}
 function validateOutput(result,pcm,duration){
  if(result.processedSamples!==pcm.length)throw Error('转写窗口的解码样本数量不一致');
  if(!Array.isArray(result.chunks)||result.chunks.length>2000)throw Error('转写窗口缺少有效字幕块');
  for(const c of result.chunks){const t=c.timestamp;if(!Array.isArray(t)||!Number.isFinite(t[0])||!Number.isFinite(t[1])||t[0]<0||t[1]<t[0]||t[1]>duration+1||typeof c.text!=='string')throw Error('转写时间戳无效');}
  if(!Array.isArray(result.coverage)||result.coverage.length!==1||result.coverage[0].start!==0||Math.abs(result.coverage[0].end-duration)>.001||result.coverage[0].samples!==pcm.length)throw Error('转写窗口推理覆盖回执不完整');
  if(!Array.isArray(result.recoveryPlan)||!Array.isArray(result.recoveryCoverage)||!Array.isArray(result.noText))throw Error('转写复验覆盖回执缺失');
  for(const spans of [result.recoveryCoverage,result.noText])for(const span of spans)if(!Number.isFinite(span.start)||!Number.isFinite(span.end)||span.start<0||span.end<=span.start||span.end>duration+.001)throw Error('转写复验覆盖范围无效');
  if(Array.isArray(result.recoveryPlan))for(const gap of result.recoveryPlan){let cursor=gap.start;for(const span of result.recoveryCoverage.filter(r=>r.start>=gap.start-.001&&r.end<=gap.end+.001)){if(Math.abs(span.start-cursor)>.001||Math.abs(span.samples-(span.end-span.start)*16000)>1)throw Error('转写复验覆盖存在缺块');cursor=span.end;}if(Math.abs(cursor-gap.end)>.001)throw Error('转写复验覆盖存在缺块');}
  const text=result.chunks.map(c=>c.text).join('');if(text.length>20000||/(.{8,})\1{3,}/u.test(text))throw Error('转写出现异常重复文本');
  return result.chunks;
 }
 function stamp(sec){const ms=Math.round(sec*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
 class LocalTranscription {
  constructor({runtime,storage,ensureOffscreen}){this.runtime=runtime;this.storage=storage;this.ensureOffscreen=ensureOffscreen;this.tasks=new Map();this.modelQueue=Promise.resolve();runtime.onMessage.addListener((m,s,reply)=>this._modelMessage(m,s,reply));}
  _modelMessage(m,s,reply){
   if(m?.target!=='local-transcription'||s.id!==this.runtime.id||s.url!==this.runtime.getURL('offscreen.html'))return false;
   const task=this.tasks.get(m.taskId);if(!task||task.cancelled||!task.active||m.token!==task.token)return false;
   if(!validateModelRequest(task.model,m.revision,m.file)||m.model!==MODELS[task.model].repo||!['model-info','model-chunk'].includes(m.action)){reply({ok:false,error:'模型文件不在允许列表'});return false;}
   if(m.action==='model-chunk'&&(!Number.isSafeInteger(m.offset)||m.offset<0||!Number.isSafeInteger(m.length)||m.length<1||m.length>262144)){reply({ok:false,error:'模型分片范围无效'});return false;}
   const work=this.modelQueue.catch(()=>{}).then(()=>{this._check(task);return m.action==='model-info'?task.client.modelFileInfo(m.model,m.revision,m.file,text=>task.onProgress?.(text)):task.client.modelFileChunk(m.model,m.revision,m.file,m.offset,m.length);});
   this.modelQueue=work.catch(()=>{});
   work.then(result=>{if(!task.cancelled&&this.tasks.get(m.taskId)===task)reply({ok:true,result});else reply({ok:false,error:'任务已取消'});},e=>reply({ok:false,error:e.message}));return true;
  }
  cancel(taskId){const t=this.tasks.get(taskId);if(!t||t.cancelled)return;t.cancelled=true;t.abort();this.runtime.sendMessage({target:'offscreen-local',action:'cancel',taskId,token:t.token}).catch(()=>{});}
  async start(args){
   const {taskId,descriptor:d,signal}=args;if(!taskId||this.tasks.has(taskId))throw Error('本地转写任务ID无效或重复');
   const maxDuration=Math.min(21600,Number(args.settings?.maxDuration)||3600);
   if(!d?.fingerprint||!Number.isFinite(d.duration)||d.duration<=0||d.duration>maxDuration)throw Error(`本地音频时长无效或超过${Math.floor(maxDuration/60)}分钟限制`);
   const model=modelKey(args.model||'base');if(!model)throw Error('不支持的本地转写模型');
   let rejectAbort;const aborted=new Promise((_,r)=>{rejectAbort=r;});aborted.catch(()=>{});
   const task={...args,model,token:`${Date.now()}-${++serial}`,cancelled:false,active:false,abort:()=>rejectAbort(Error('本地转写已取消'))};this.tasks.set(taskId,task);
   const abort=()=>this.cancel(taskId);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   const previous=queue;let unlock;const gate=new Promise(r=>{unlock=r;});queue=previous.then(()=>gate);
   try{await Promise.race([previous,aborted]);if(task.cancelled)throw Error('本地转写已取消');task.active=true;await this._state(task,'running');return await Promise.race([this._run(task,d),aborted]);}
   catch(e){await this._state(task,task.cancelled?'cancelled':'failed',e.message);throw e;}
   finally{task.active=false;this.tasks.delete(taskId);signal?.removeEventListener('abort',abort);await this.runtime.sendMessage({target:'offscreen-local',action:'cancel',taskId,token:task.token}).catch(()=>{});unlock();}
  }
  async _state(t,status,error){await this.storage.set({'local-transcription-state':{taskId:t.taskId,fingerprint:t.descriptor.fingerprint,model:t.model,status,error:error||'',updatedAt:Date.now()}});}
  _check(t){if(t.cancelled||this.tasks.get(t.taskId)!==t)throw Error('本地转写已取消');}
  async _send(t,action,extra={}){this._check(t);const r=await this.runtime.sendMessage({target:'offscreen-local',action,taskId:t.taskId,token:t.token,...extra});this._check(t);if(!r?.ok)throw Error(r?.error||'本地转写工作线程未响应');return r;}
  async _run(t,d){
   // Admission estimate only: browser/ORT process memory cannot be hard-capped here.
   const weights=t.model==='small'?249105759:76908389,estimatedMiB=Math.ceil((weights*16+512*1048576)/1048576),budget=Number(t.settings?.memoryBudgetMiB)||6144;
   if(estimatedMiB>budget)throw Error(`所选模型的启动内存预估约${estimatedMiB}MiB，超过设置的${budget}MiB；请提高预估上限或选择较小模型`);
   if(t.device==='webgpu'){t.onProgress?.('本机WebGPU中文质量未通过，使用WASM转写');t.device='wasm';}
   await this.ensureOffscreen();this._check(t);const key=`local-transcription-cache:${d.fingerprint}:${t.model}:${MODELS[t.model].revision}`;
   const all=await this.storage.get(null);this._check(t);const now=Date.now();let used=0;const remove=[];
   for(const [k,v] of Object.entries(all||{}).filter(([k])=>k.startsWith('local-transcription-cache:')).sort((a,b)=>(b[1]?.updatedAt||0)-(a[1]?.updatedAt||0))){used+=JSON.stringify(v).length*2;const ttl=(v?.complete?Number(t.settings?.successTtlHours??1):Number(t.settings?.failureTtlHours??24))*3600000;if(now-(v?.updatedAt||0)>ttl||used>4*1024*1024)remove.push(k);}
   if(remove.length&&this.storage.remove)await this.storage.remove(remove);
   const cache=(all?.[key]?.format===2&&all?.[key]?.duration===d.duration&&!remove.includes(key))?all[key]:{format:2,duration:d.duration,blocks:{},updatedAt:now};const output=[];let index=0;
   for(let coreStart=0;coreStart<d.duration;coreStart+=20,index++){
    this._check(t);const coreEnd=Math.min(coreStart+20,d.duration);let block=cache.blocks[index];
    if(!block||block.start!==coreStart||block.end!==coreEnd||!Array.isArray(block.chunks)){
     const start=Math.max(0,coreStart-5),end=Math.min(d.duration,coreEnd+5),duration=end-start;
     t.onProgress?.(`正在本地转写：${Math.floor(coreStart)}–${Math.ceil(coreEnd)}秒 / ${Math.ceil(d.duration)}秒（${t.device==='webgpu'?'WebGPU':'WASM'}）`);
     const audio=await t.client.readPcmWindow(d.fingerprint,start,duration);this._check(t);
     const raw=Uint8Array.from(atob(audio.base64),c=>c.charCodeAt(0));const samples=Math.round(duration*16000);
     if(audio.encoding!=='f32le'||audio.sampleRate!==16000||audio.samples!==samples||raw.byteLength!==samples*4||Math.abs(audio.start-start)>.001||Math.abs(audio.duration-duration)>.001)throw Error('本地PCM窗口样本或时间范围不一致');
     const pcm=new Float32Array(raw.buffer);if(pcm.some(x=>!Number.isFinite(x)))throw Error('本地PCM包含无效样本');let chunks=[],inference=null;
     if(!isSilent(pcm)){
      const run=async device=>{const requestId=`${t.token}:${index}:${device}`;await this._send(t,'begin',{requestId,byteLength:raw.length});for(let offset=0;offset<raw.length;offset+=196608){let binary='';for(const x of raw.subarray(offset,offset+196608))binary+=String.fromCharCode(x);await this._send(t,'pcm',{requestId,offset,base64:btoa(binary)});}const result=await this._send(t,'run',{requestId,model:MODELS[t.model].repo,revision:MODELS[t.model].revision,device,duration,samples,threads:Math.max(1,Math.min(8,Number(t.settings?.threads)||4))});if(result.requestId!==requestId||result.taskId!==t.taskId)throw Error('本地转写回复与当前窗口不符');const validated=validateOutput(result,pcm,duration);inference={coverage:result.coverage,recoveryPlan:result.recoveryPlan||[],recoveryCoverage:result.recoveryCoverage,noText:result.noText};return validated;};
      if(t.device==='webgpu'){try{chunks=await run('webgpu');}catch(e){this._check(t);t.onProgress?.(`WebGPU转写未通过校验，改用WASM：${e.message}`);chunks=await run('wasm');}}else chunks=await run('wasm');
     }
     block={inference:inference||{coverage:[{start:0,end:duration,samples}],noText:[{start:0,end:duration}],recoveryCoverage:[],kind:'silent'},start:coreStart,end:coreEnd,status:isSilent(pcm)?'silent':'complete',chunks:chunks.filter(c=>{const midpoint=(c.timestamp[0]+c.timestamp[1])/2+start;return midpoint>=coreStart&&midpoint<coreEnd;}).map(c=>({text:c.text.trim(),start:Math.max(coreStart,c.timestamp[0]+start),end:Math.min(coreEnd,c.timestamp[1]+start)})).filter(c=>c.text&&c.end>c.start)};
     this._check(t);cache.blocks[index]=block;cache.updatedAt=Date.now();await this.storage.set({[key]:cache});this._check(t);
    }output.push(...block.chunks);
   }
   this._check(t);if(Object.keys(cache.blocks).length!==Math.ceil(d.duration/20))throw Error('本地转写窗口覆盖不完整');
   const srt=output.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');cache.complete=true;cache.updatedAt=Date.now();await this.storage.set({[key]:cache});await this._state(t,'completed');this._check(t);return srt;
  }
 }
 root.LocalTranscription=LocalTranscription;if(typeof module!=='undefined')module.exports={LocalTranscription,MODELS,validateModelRequest,validateOutput};
})(globalThis);
