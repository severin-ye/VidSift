(function(root){
 'use strict';
 if(root.VidSiftErrors)return;
 const D=root.VidSiftDiagnostics;
 let taskId,queue=Promise.resolve();
 const contextId=root.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
 const fallbackKey=`vidsiftErrorFallback.${contextId}`;
 const fallbackPattern=/^vidsiftErrorFallback\.[\w-]+$/;
 function safeVisibleMessage(value){
  return String(value?.message||value||'Unknown error')
   .replace(/(?:[A-Z]:\\|\/(?:home|Users|tmp|var|mnt)\/)[^\r\n<>"']{0,300}?\.(?:mp3|m4a|wav|mp4|webm|ogg|flac|aac|mov|mkv|png|jpe?g|webp|srt|vtt)\b/gi,'[media file]')
   .replace(/(?:[A-Z]:\\|\/(?:home|Users|tmp|var|mnt)\/)[^\s<>"']+/gi,'[local path]')
   .replace(/[^\s/\\<>:"']+\.(?:mp3|m4a|wav|mp4|webm|ogg|flac|aac|mov|mkv|png|jpe?g|webp|srt|vtt)\b/gi,'[media file]');
 }
 async function pruneFallback(storage){
  if(typeof storage.remove!=='function')return;
  let snapshots;
  if(typeof storage.getKeys==='function'){
   const keys=(await storage.getKeys()).filter(key=>fallbackPattern.test(key));
   snapshots=keys.length?await storage.get(keys):{};
  }else snapshots=await storage.get(null);
  const entries=Object.entries(snapshots||{}).filter(([key])=>fallbackPattern.test(key)).map(([key,value])=>({key,at:Number(value?.errors?.at(-1)?.at)||0,bytes:new TextEncoder().encode(JSON.stringify({[key]:value})).length}));
  // Protect this context's just-persisted entry even when timestamps tie.
  entries.sort((a,b)=>(b.key===fallbackKey)-(a.key===fallbackKey)||b.at-a.at||a.key.localeCompare(b.key));
  let bytes=0,count=0;const remove=[];
  for(const entry of entries){if(entry.key===fallbackKey||(count<20&&bytes+entry.bytes<=512000)){count++;bytes+=entry.bytes;}else remove.push(entry.key);}
  if(remove.length)await storage.remove(remove);
 }
 function component(){
  const path=root.location?.pathname||'';
  const host=root.location?.hostname||'';
  return host===root.chrome?.runtime?.id?(path.split('/').pop()||'extension'):host.replace(/[^\w.-]/g,'').slice(0,80)||'extension';
 }
 function fallback(event){
  queue=queue.catch(()=>{}).then(async()=>{
   try{
    const storage=root.chrome?.storage?.local;
    if(!storage?.get||!storage?.set||!D)return false;
    const raw=(await storage.get(fallbackKey))[fallbackKey];
    const errors=Array.isArray(raw?.errors)?raw.errors:[];
    if(!errors.some(e=>e.id===event.id))errors.push(event);
    await storage.set({[fallbackKey]:{schema:1,errors:D.boundErrors(errors,20)}});
    // Cleanup failure must not misreport the successful durable write as lost.
    try{await pruneFallback(storage);}catch{}
    return true;
   }catch{return false;}
  });return queue;
 }
 async function report(message,metadata={}){
  try{
   if(!D)return false;
   let version='unknown';try{version=root.chrome?.runtime?.getManifest?.().version||version;}catch{}
   const event=D.errorEntry({...metadata,message:safeVisibleMessage(message),component:metadata.component||component()},version);
   const requestedTask=metadata.taskId||taskId;
   if(typeof requestedTask==='string'&&/^[\w.-]{1,100}$/.test(requestedTask))event.taskId=requestedTask;
   try{
    const reply=await root.chrome.runtime.sendMessage({type:'VIDSIFT_VISIBLE_ERROR',event});
    if(reply?.ok===true)return true;
   }catch{}
   // Fixed text only: never leak the transport failure or original error into console.
   root.console?.warn?.('[VidSift] Error log transport unavailable; saving local fallback.');
   return await fallback(event);
  }catch{return false;}
 }
 root.VidSiftErrors={setTask(id){taskId=typeof id==='string'&&/^[\w.-]{1,100}$/.test(id)?id:undefined;},report};
 function ownRuntime(source,stack=false){
  if(root.location?.hostname===root.chrome?.runtime?.id)return true;
  let origin;try{origin=root.chrome.runtime.getURL('');}catch{return false;}
  return typeof source==='string'&&typeof origin==='string'&&origin.startsWith('chrome-extension://')&&(stack?source.split(/\r?\n/).some(line=>line.trimStart().startsWith(origin)||line.trimStart().startsWith(`at ${origin}`)||line.includes(`(${origin}`)):source.startsWith(origin));
 }
 root.addEventListener?.('error',event=>{if(ownRuntime(event?.filename))void report(event?.message||'扩展运行错误',{category:'runtime'});});
 root.addEventListener?.('unhandledrejection',event=>{const reason=event?.reason;if(ownRuntime(reason?.stack,true))void report(typeof reason==='string'?reason:reason?.message||'扩展异步操作失败',{category:'runtime'});});
})(globalThis);
