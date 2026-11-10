(function(root){
 'use strict';
 const KEY='vidsiftTaskDiagnostics',MAX_TASKS=20,MAX_EVENTS=120,MAX_CHARS=240000;
 const numeric=new Set(['elapsedMs','duration','bytes','originalBytes','outputBytes','audioCandidateCount','selectedSourceBytes','selectedSourceBitrate','attachmentIndex','cardCount','addedCardCount','audioReadyState','subtitleCount','imageCount','sourceTabId','targetTabId','count']);
 const flags=new Set(['trackedCardPresent','busy','hasAudio','hasHTMLAudio','hasImage','hasTokenCount','playEnabled','runEnabled','promptFilled','accepted','cancelled','active','ready','hasSubtitle','generating','hasResponse','hasTranscript','ok']);
 const words=new Set(['platform','mime','category','errorName','state','subtitleStatus','audioSourceKind','attachedState','component','phase','reasonCategory','nativeVersion']);
 function category(error){const s=String(error?.message||error||'');return /取消|已关闭|已改变|已切换/.test(s)?'cancelled':/超时|timeout/i.test(s)?'timeout':/连接|connect/i.test(s)?'connection':/权限|permission/i.test(s)?'permission':/字幕|转写/.test(s)?'transcription':/附件|上传/.test(s)?'upload':'operation_failed';}
 function cancelReason(value){const s=String(value||'');return /标签页.*关闭|页面.*关闭/.test(s)?'source_closed':/作品.*改变|视频.*切换/.test(s)?'source_changed':/离开/.test(s)?'source_left':/扩展.*取消/.test(s)?'user_cancel':/应答|传输/.test(s)?'transfer_failed':'cancelled';}
 function details(value={}){
  const out={};for(const [k,v]of Object.entries(value||{})){
   if(numeric.has(k)&&Number.isFinite(v)&&v>=0)out[k]=v;
   else if(flags.has(k)&&typeof v==='boolean')out[k]=v;
   else if(words.has(k)&&typeof v==='string'&&/^[\w .:/+-]{1,96}$/.test(v)&&!v.includes('://'))out[k]=v;
   else if(['playControlLabels','runControlLabels'].includes(k)&&Array.isArray(v))out[k]=v.filter(s=>typeof s==='string'&&/^(?:play|pause|播放|暂停|run|运行|stop|停止)/i.test(s)&&!/[\\/]|https?:|@|\.m4a|\.mp3|\.wav/i.test(s)).slice(0,4).map(s=>s.slice(0,80));
  }return out;
 }
 function create(storage,{version='unknown',now=()=>Date.now()}={}){
  let queue=Promise.resolve();
  function update(fn){queue=queue.catch(()=>{}).then(async()=>{
   if(!storage?.get||!storage?.set)return false;
   const raw=(await storage.get(KEY))[KEY];const state={schema:1,tasks:Array.isArray(raw?.tasks)?raw.tasks.slice(-MAX_TASKS):[]};
   const changed=fn(state);if(changed===false)return false;
   for(const task of state.tasks){const events=task.events||[];task.events=events.length>MAX_EVENTS?[...events.slice(0,4),...events.slice(-(MAX_EVENTS-4))]:events;}
   state.tasks=state.tasks.slice(-MAX_TASKS);while(state.tasks.length>1&&JSON.stringify(state).length>MAX_CHARS)state.tasks.shift();
   while(state.tasks.length&&JSON.stringify(state).length>MAX_CHARS&&state.tasks[0].events.length>1)state.tasks[0].events.shift();
   await storage.set({[KEY]:state});return true;
  }).catch(()=>false);return queue;}
  function begin(id,metadata={},clickId){return update(state=>{
   if(typeof id!=='string'||!/^[\w.-]{1,100}$/.test(id))return false;
   let task=state.tasks.find(t=>t.taskId===id||t.clickId===id);
   if(!task&&clickId)task=state.tasks.find(t=>t.taskId===clickId);
   if(!task){task={taskId:id,startedAt:now(),events:[]};state.tasks.push(task);}
   if(!task.clickId||clickId)task.taskId=id;if(clickId)task.clickId=clickId;task.version=version;
   if(Number.isInteger(metadata.sourceTabId))task.sourceTabId=metadata.sourceTabId;
   if(['bilibili','youtube','douyin'].includes(metadata.platform))task.platform=metadata.platform;
   if(typeof metadata.videoId==='string'&&/^[\w-]{1,80}$/.test(metadata.videoId))task.videoId=metadata.videoId;
   return true;
  });}
  function record(id,stage,value={},senderTab){const at=now();return update(state=>{
   if(typeof stage!=='string'||!/^[a-z][a-z0-9_.-]{0,70}$/.test(stage))return false;
   const task=state.tasks.find(t=>t.taskId===id||t.clickId===id);if(!task)return false;
   if(senderTab!==undefined&&senderTab!==task.sourceTabId&&!task.targetTabIds?.includes(senderTab))return false;
   const safe=details(value),last=task.events.at(-1);if(stage==='native.progress'&&last?.stage===stage&&JSON.stringify(last.details)===JSON.stringify(safe)&&at-last.at<10000)return false;
   if(Number.isInteger(safe.targetTabId)){task.targetTabIds??=[];if(!task.targetTabIds.includes(safe.targetTabId))task.targetTabIds.push(safe.targetTabId);task.targetTabIds=task.targetTabIds.slice(-4);}
   task.updatedAt=at;task.events.push({at,elapsedMs:Math.max(0,at-task.startedAt),stage,details:safe});
   return true;
  });}
  return {begin,record,flush:()=>queue};
 }
 const api={KEY,create,details,category,cancelReason};root.VidSiftDiagnostics=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
