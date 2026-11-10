'use strict';
// This listener is independent of the legacy transcription listener.
(()=>{
 let active=null,worker=null;const pending=new Map();
 function clear(reason){worker?.terminate();worker=null;for(const p of pending.values())p({ok:false,error:reason});pending.clear();active=null;}
 function getWorker(){if(worker)return worker;worker=new Worker(chrome.runtime.getURL('whisper-worker.js'));
  worker.onmessage=async({data:m})=>{
   if(!active||m.taskId!==active.taskId||m.token!==active.token)return;
   if(m.action==='model-info'||m.action==='model-chunk'){
    const current=worker;let response;try{response=await chrome.runtime.sendMessage({...m,target:'local-transcription'});}catch(e){response={ok:false,error:e.message};}
    if(worker===current&&active?.token===m.token)current.postMessage({action:'model-response',rpcId:m.rpcId,taskId:m.taskId,token:m.token,...response});return;
   }
   const reply=pending.get(m.requestId);if(reply){pending.delete(m.requestId);reply(m);}
  };
  worker.onerror=e=>clear(e.message||'本地转写工作线程出错');return worker;
 }
 chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m?.target!=='offscreen-local'||s.id!==chrome.runtime.id||s.url!==undefined&&s.url!==chrome.runtime.getURL('background.js'))return false;
  if(typeof m.taskId!=='string'||typeof m.token!=='string')return false;
  if(m.action==='cancel'){if(active?.taskId===m.taskId&&active.token===m.token)clear('本地转写已取消');reply({ok:true});return false;}
  if(m.action==='begin'){
   if(active&&(active.taskId!==m.taskId||active.token!==m.token)){reply({ok:false,error:'已有本地转写任务正在运行'});return false;}
   if(!Number.isSafeInteger(m.byteLength)||m.byteLength<4||m.byteLength>30*16000*4){reply({ok:false,error:'PCM窗口超出范围'});return false;}
   active={taskId:m.taskId,token:m.token,requestId:m.requestId,buffer:new Uint8Array(m.byteLength),offset:0};reply({ok:true});return false;
  }
  if(!active||active.taskId!==m.taskId||active.token!==m.token||active.requestId!==m.requestId){reply({ok:false,error:'本地转写窗口已失效'});return false;}
  if(m.action==='pcm'){
   if(typeof m.base64!=='string'||m.base64.length>350000||m.offset!==active.offset){reply({ok:false,error:'PCM分片顺序或大小无效'});return false;}
   try{const raw=Uint8Array.from(atob(m.base64),c=>c.charCodeAt(0));if(active.offset+raw.length>active.buffer.length)throw Error('PCM分片越界');active.buffer.set(raw,active.offset);active.offset+=raw.length;reply({ok:true});}catch(e){reply({ok:false,error:e.message});}return false;
  }
  if(m.action==='run'){
   if(active.offset!==active.buffer.byteLength||m.samples*4!==active.buffer.byteLength||pending.size){reply({ok:false,error:'PCM窗口尚未完整接收或线程忙碌'});return false;}
   const buffer=active.buffer.buffer;pending.set(m.requestId,reply);getWorker().postMessage({...m,action:'transcribe',pcm:buffer},[buffer]);active.buffer=null;return true;
  }
  return false;
 });
})();
