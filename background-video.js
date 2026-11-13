'use strict';
// Imported after background.js's legacy helpers. Existing Bilibili task paths remain intact.
const _targetCompletions=new Map();
const _targetSourceTabs=new Map();
const _targetDiagnostics=new Map();
function recordTargetPhase(task,tab,phase){
 if(task.cancelled)return;
 diagnoseTask(task,'target.'+phase,{targetTabId:tab.id,active:tab.active===true});
 const record={taskId:task.id,sourceTabId:task.tabId,targetTabId:tab.id,phase,at:Date.now(),
  extensionVersion:chrome.runtime.getManifest?.().version||'unknown',observedActive:tab.active===true};
 _targetDiagnostics.set(task.id,record);if(_targetDiagnostics.size>20)_targetDiagnostics.delete(_targetDiagnostics.keys().next().value);
 chrome.storage?.local?.set({vidsiftLastTargetDiagnostic:record}).catch(()=>{});
}
function recordTargetCancellation(task){
 diagnoseTask(task,'task.cancelled',{category:'cancelled',reasonCategory:VidSiftDiagnostics.cancelReason(task.cancelReason)});
 const previous=_targetDiagnostics.get(task.id)||{taskId:task.id,sourceTabId:task.tabId,targetTabId:task.targetTabId};
 const record={...previous,phase:'cancelled',at:Date.now(),cancelReason:task.cancelReason,sourceKey:task.source.key,currentSourceKey:task.cancelSourceKey??null,extensionVersion:chrome.runtime.getManifest?.().version||'unknown'};
 _targetDiagnostics.set(task.id,record);chrome.storage?.local?.set({vidsiftLastTargetDiagnostic:record}).catch(()=>{});
}
async function verifySourceChange(task){
 if(task.sourceClosed)return;
 // SPA notifications can arrive late; only the current top-level tab URL may
 // cancel the task, never an event's old URL or a mere change of focused tab.
 const current=await chrome.tabs.get(task.tabId);
 if(_videoWorkflow.tasks.get(task.tabId)!==task||task.cancelled)return;
 const source=VidSiftPlatforms.identify(current.url||'');
 if(source?.key!==task.source.key){task.cancelSourceKey=source?.key||null;_videoWorkflow.cancel(task.tabId,source?'原视频页当前作品已改变，已停止发送旧作品':'原视频页当前网址已离开该作品，已停止发送');}
}
function waitForTarget(task,tabId){
 task.targetTabId=tabId;_targetSourceTabs.set(tabId,task.tabId);
 diagnoseTask(task,'target.registered',{targetTabId:tabId});
 return new Promise((resolve,reject)=>{
  // Only active target jobs keep the worker alive; ordinary popup ports do not.
  const pulse=setInterval(()=>{chrome.runtime.getPlatformInfo?.().catch(()=>{});},20000);
  const finish=()=>clearInterval(pulse);
  const timer=setTimeout(()=>{finish();_targetCompletions.delete(task.id);reject(new Error('当前总结等待超时，已保留目标页面；请检查处理状态，已发送的总结不要重复提交'));},30*60*1000);
  _targetCompletions.set(task.id,{tabId,resolve:payload=>{finish();clearTimeout(timer);_targetCompletions.delete(task.id);resolve(payload);},reject:e=>{finish();clearTimeout(timer);_targetCompletions.delete(task.id);reject(e);}});
 });
}
async function sendVideoChatGPT(data){
 const {task}=data;const target=await _openChatGPTAndSend({...data,attachments:data.attachments,taskId:task.id,beforePrepare:()=>_videoWorkflow.assertLive(task),beforeDispatch:tabId=>waitForTarget(task,tabId)});
 if(!target.ok){_targetCompletions.get(task.id)?.reject(new Error(target.error));throw new Error(target.error);}await target.completion;
}
async function sendVideoAIStudio(data){
 const tab=await createTaskTarget('https://aistudio.google.com/prompts/new_chat',false,data.openerTabId);
 recordTargetPhase(data.task,tab,'created-background');
 const completed=waitForTarget(data.task,tab.id);completed.catch(()=>{});
 _updateActiveTranscribeTask(data.task.tabId,'AI Studio 已在后台创建，正在连接页面上传脚本...');
 try{
  await _pageBridge.waitFor(tab.id,'aistudio',{assertLive:()=>_videoWorkflow.assertLive(data.task)});
  recordTargetPhase(data.task,await chrome.tabs.get(tab.id),'script-connected');
  _updateActiveTranscribeTask(data.task.tabId,'AI Studio 上传脚本已连接，正在移交音频和提示词...');
  const accepted=await VidSiftAttachmentTransfer.send(chrome,tab.id,{type:'VIDSIFT_AISTUDIO_UPLOAD_AND_RUN',taskId:data.task.id,attachments:data.attachments,biliTabId:data.openerTabId,tempChat:data.tempChat,bgOpen:data.bgOpen,videoTitle:data.videoTitle,bvid:data.bvid,source:data.source,relayToChatGPT:true,duration:data.duration},{assertLive:()=>_videoWorkflow.assertLive(data.task)});
  if(!accepted?.ok)throw new Error(accepted?.error||'AI Studio 未确认接收音频任务，页面材料未重复上传');
  recordTargetPhase(data.task,await chrome.tabs.get(tab.id),'task-accepted');
  return await completed;
 }catch(e){_targetCompletions.get(data.task.id)?.reject(e);await completed.catch(()=>{});throw e;}
}
let _localTranscription;
let _localMediaCache;
let _groqCredentialPrompt;
function groqCredentialPrompt(){return _groqCredentialPrompt??=new GroqCredentialPrompt(chrome);}
async function transcribeVideo(audio,data,notify,signal){
 if(data.transcribeService==='groq'){
  if(!data.localAudio||typeof data.task.client.transcribeGroq!=='function')throw new Error('本机程序不支持Groq转写，请更新本包本机程序');
  if(signal.aborted)throw new Error('视频处理已取消');
  await groqCredentialPrompt().ensure({client:data.task.client,task:data.task,signal,assertLive:()=>_videoWorkflow.assertLive(data.task),onWait:()=>{
   diagnoseTask(data.task,'groq.key_required');notify('STATUS','请在新窗口填写 Groq API Key，保存后继续当前音频转写...');
  }});
  await _videoWorkflow.assertLive(data.task);
  diagnoseTask(data.task,'groq.start');notify('STATUS','正在上传完整音轨到Groq并转写...');
  const result=await data.task.client.transcribeGroq(data.localAudio,data.groqSettings,text=>notify('STATUS',text));
  if(signal.aborted||data.task.cancelled)throw new Error('视频处理已取消');
  if(!result.srt?.trim())throw new Error('Groq没有返回有效逐字稿，未发送到ChatGPT');
  diagnoseTask(data.task,'groq.completed',{duration:result.duration,elapsedMs:result.elapsedMs,originalBytes:result.inputBytes,outputBytes:result.uploadedBytes,subtitleCount:result.segmentCount});return result.srt;
 }
 if(data.localAudio){
  _localTranscription||=new LocalTranscription({runtime:chrome.runtime,storage:chrome.storage.local,ensureOffscreen:ensureOffscreenDocument});
  return _localTranscription.start({taskId:data.task.id,descriptor:data.localAudio,client:data.task.client,model:data.model,device:data.device,settings:data.localSettings,signal,onProgress:text=>{diagnoseTask(data.task,'local.progress',{phase:'transcription'});notify('STATUS',text);}});
 }
 if(data.transcribeService==='local'){
  if(!data.model||!data.device)throw new Error('本地转写模型或设备未设置，请在设置页完成配置');
  await ensureOffscreenDocument();const requestId=data.task.id;_localProgressMap.set(requestId,notify);
  try{
   const result=await _runWithConcurrencyLimit(async()=>{
    if(signal.aborted)throw new Error('视频处理已取消');
    return chrome.runtime.sendMessage({target:'offscreen',action:'transcribe',model:data.model,device:data.device,audioBase64:audio.base64,requestId});
   },notify);
   if(signal.aborted)throw new Error('视频处理已取消');
   if(!result?.ok)throw new Error(result?.error||'本地转写失败');return chunksToSrt(result.chunks);
  }finally{_localProgressMap.delete(requestId);}
 }
 const api=(data.selfHostedUrl||'').replace(/\/$/,'');
 if(!api)throw new Error('自建转写服务地址未配置');
 const u=new URL(api);if(!['http:','https:'].includes(u.protocol))throw new Error('自建转写服务地址必须使用 HTTP 或 HTTPS');
 const bytes=Uint8Array.from(atob(audio.base64),c=>c.charCodeAt(0));const form=new FormData();
 form.append('audio',new Blob([bytes],{type:audio.mime}),audio.name);
 notify('STATUS','正在提交音频到自建转写服务...');
 const response=await fetch(api+'/transcribe',{method:'POST',headers:{Authorization:'Bearer '+data.selfHostedToken},body:form,signal});
 return VidSiftPlatforms.readTranscription(response,notify);
}
const _videoWorkflow=new VideoWorkflow({
 loadLocalMedia:(task,pageSource)=>(_localMediaCache??=new LocalMediaCache(chrome.storage.local)).load(task,pageSource),
 saveLocalMedia:(task,result,settings)=>(_localMediaCache??=new LocalMediaCache(chrome.storage.local)).save(task,result,settings),
 finishLocalMedia:(task,status)=>(_localMediaCache??=new LocalMediaCache(chrome.storage.local)).finish(task,status),
 diagnostic:diagnoseTask,
 identify:VidSiftPlatforms.identify,toSrt:VidSiftPlatforms.toSrt,normalize:ScreenshotSettings.normalize,normalizeAudio:AudioSettings.normalize,
 getTab:id=>chrome.tabs.get(id),client:()=>new NativeMediaClient(),existing:_getActiveTranscribeTask,
 snapshot:async task=>{
  if(task.source.platform!=='douyin')return null;
  const results=await chrome.scripting.executeScript({target:{tabId:task.tabId,frameIds:[0]},world:'MAIN',func:DouyinPageSource,args:[task.source.videoId]});
  return results[0]?.result||null;
 },
 lock:_setActiveTranscribeTask,unlock:_clearActiveTranscribeTask,
 sendChatGPT:sendVideoChatGPT,sendAIStudio:sendVideoAIStudio,transcribe:transcribeVideo,
 cancelTarget:task=>{
  recordTargetCancellation(task);
  if(task.targetTabId)chrome.tabs.sendMessage(task.targetTabId,{type:'VIDSIFT_CANCEL_UPLOAD',taskId:task.id,reason:task.cancelReason}).catch(()=>{});
  _targetCompletions.get(task.id)?.reject(new Error(task.cancelReason+'，未自动发送'));
 }
});
async function captureTaskSource(task){
 let source={...task.source},pageSource;
 try{
  const result=await chrome.scripting.executeScript({target:{tabId:task.tabId,frameIds:[0]},func:()=>({url:location.href,title:document.querySelector('h1')?.textContent||document.title,coverUrl:document.querySelector('meta[property="og:image"]')?.content||document.querySelector('video[poster]')?.poster||'',duration:document.querySelector('video')?.duration})});
  const value=result[0]?.result;
  if(VidSiftPlatforms.identify(value?.url)?.key===task.source.key)source={...source,title:String(value.title||'').trim(),coverUrl:VidSiftVideoLibrary.normalizeCover(value.coverUrl),...(Number.isFinite(value.duration)&&value.duration>0?{duration:value.duration}:{})};
 }catch{}
 if(task.source.platform==='douyin'){
  try{const result=await chrome.scripting.executeScript({target:{tabId:task.tabId,frameIds:[0]},world:'MAIN',func:DouyinPageSource,args:[task.source.videoId]});const value=result[0]?.result;if(String(value?.videoId)===task.source.videoId)pageSource=value;}catch{}
 }
 return {source,pageSource};
}
async function prepareBilibiliSource(task,msg,captured){
 const source=task.source;
 const view=await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(source.videoId),{credentials:'include',signal:AbortSignal.timeout(20000)})).json();
 if(view.code!==0||!view.data?.aid||view.data.bvid!==source.videoId)throw new Error('B站视频信息读取失败：'+(view.message||view.code));
 if(source.part>1&&!view.data.pages?.[source.part-1]?.cid)throw new Error('未找到所选 B站分P，未发送其他分P的内容');
 const page=view.data.pages?.[source.part-1],cid=page?.cid||view.data.cid;
 const result={...captured.source,...source,title:view.data.title||captured.source.title||source.videoId,duration:page?.duration||view.data.duration,coverUrl:VidSiftVideoLibrary.normalizeCover(view.data.pic)||captured.source.coverUrl||'',subtitle:null,bili:{aid:view.data.aid,cid,pageUrl:source.url}};
 if(!msg.forceAudio){
  const player=await (await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${view.data.aid}&cid=${cid}`,{credentials:'include',signal:AbortSignal.timeout(20000)})).json();
  const tracks=player.data?.subtitle?.subtitles||[],track=tracks.find(t=>/zh/.test(t.lan))||tracks[0];
  if(track){const url=track.subtitle_url.startsWith('//')?'https:'+track.subtitle_url:track.subtitle_url;const data=await (await fetch(url,{credentials:'include',signal:AbortSignal.timeout(20000)})).json();if(data.body?.length)result.subtitle={body:data.body,lan:track.lan};}
 }
 return result;
}
async function startVideoSummary(msg,notify){
 const source=VidSiftPlatforms.identify(msg.sourceUrl);
 if(!source)throw new Error('视频来源无效');
 const tabId=msg.openerTabId;
 if(_videoWorkflow.tasks.has(tabId)||_legacyGuard.get(tabId)||_getActiveTranscribeTask(tabId))throw new Error('当前视频已有总结任务，请等待或取消');
 // Metadata acquisition belongs to the worker, never to the popup or source page.
 const task=_legacyGuard.begin(tabId,msg.sourceUrl);task.diagnosticId=msg.diagnosticId;
 diagnoseTask(task,'task.started');
 _setActiveTranscribeTask(tabId,'video','已接收视频，正在后台取得字幕...');
 const configuration=(async()=>{await DouyinLocalSettings.migrate(chrome.storage.local);return chrome.storage.local.get(['selfHostedApiUrl','selfHostedApiToken','transcribeService','localModel','localDevice','douyinLocalSettings','groqSettings']);})();
 configuration.catch(()=>{});
 // Capture only metadata in parallel. Provider work and GPT generation stay FIFO.
 const preparation=(async()=>{const captured=await captureTaskSource(task);const source=task.source.platform==='bilibili'?await prepareBilibiliSource(task,msg,captured):captured.source;task.source=source;diagnoseTask(task,'source.prepared',{hasImage:!!source.coverUrl});return {source,pageSource:captured.pageSource};})();
 preparation.catch(()=>{});
 task.summaryQueued=true;msg.summaryQueued=true;
 try{const running=runSummaryJob({legacyTask:task,biliTabId:tabId},async()=>{
  await _legacyGuard.check(task);
  const stored=await configuration,selected=DouyinLocalSettings.resolve(source.platform,stored);
  Object.assign(msg,{transcribeService:selected.service,model:selected.model,device:selected.device,localSettings:selected.settings,groqSettings:selected.groq,selfHostedUrl:stored.selfHostedApiUrl,selfHostedToken:stored.selfHostedApiToken});
  const prepared=await preparation;await _legacyGuard.check(task);
  msg.source=prepared.source;msg.pageSource=prepared.pageSource;
  if(source.platform!=='bilibili'){
   await _legacyGuard.check(task);msg.sourceClosed=task.sourceClosed===true;
   finishLegacyTask(task);return await _videoWorkflow.start(msg,notify);
  }
  const {title,subtitle}=prepared.source;
  if(subtitle&&!ScreenshotSettings.normalize(msg.screenshotSettings).enabled){
   await handleTask({...msg,taskType:'chatgpt',biliTabId:tabId,videoTitle:title,bvid:source.videoId,file:{name:source.videoId+'.srt',content:VidSiftPlatforms.toSrt(subtitle.body)}},notify,task);
  }else{
   msg.sourceClosed=task.sourceClosed===true;
   finishLegacyTask(task);
   return await _videoWorkflow.start(msg,notify);
  }
 });notify('ACCEPTED','后台已接收并加入队列，可关闭源视频页');return await running;
 }catch(error){diagnoseTask(task,'task.failed',{category:VidSiftDiagnostics.category(error),errorName:error.name});throw error;}finally{finishLegacyTask(task);}
}
chrome.runtime.onConnect.addListener(port=>{
 if(port.name!=='vidsift-video')return;
 let connected=true;port.onDisconnect.addListener(()=>{connected=false;});
 port.onMessage.addListener(msg=>{
  if(msg.type!=='START_VIDEO_TASK')return;
  const notify=(type,text)=>{overlayMsg(msg.openerTabId,{type:type==='ERROR'?'EXT_ERROR':'EXT_STATUS',text});if(connected)try{port.postMessage({type,text});}catch{}};
  startVideoSummary(msg,notify).catch(e=>notify('ERROR',e.message));
 });
});
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
 if(['VIDSIFT_GROQ_KEY_READY','VIDSIFT_GROQ_KEY_SAVE'].includes(msg.type)){
  groqCredentialPrompt().handle(msg,sender).then(sendResponse,()=>sendResponse({ok:false,error:'密钥配置未完成，请重新打开配置窗口'}));return true;
 }
 if(msg.type==='VIDSIFT_GROQ_CONFIGURE'){
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('options.html')){sendResponse({ok:false});return false;}
  (async()=>{let client;try{client=new NativeMediaClient();await groqCredentialPrompt().ensure({client});sendResponse({ok:true,configured:true});}catch(e){sendResponse({ok:false,error:e.message});}finally{client?.close();}})();return true;
 }
 if(msg.type==='VIDSIFT_GROQ_STATUS'){
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('options.html')){sendResponse({ok:false});return false;}
  (async()=>{let client;try{client=new NativeMediaClient();sendResponse({ok:true,...await client.groqStatus()});}catch(e){sendResponse({ok:false,error:e.message});}finally{client?.close();}})();return true;
 }
 if(msg.type==='VIDSIFT_DIAGNOSTIC_START'){
  if(sender.tab||!sender.url?.endsWith('/popup.html')){sendResponse({ok:false});return false;}
  _diagnostics.begin(msg.taskId,{sourceTabId:msg.sourceTabId,...(VidSiftPlatforms.identify(msg.sourceUrl)||{})}).then(()=>_diagnostics.record(msg.taskId,msg.stage||'popup.clicked',msg.details)).then(ok=>sendResponse({ok}));return true;
 }
 if(msg.type==='VIDSIFT_DIAGNOSTIC'){
  const fromPopup=!sender.tab&&sender.url?.endsWith('/popup.html');
  if(!fromPopup&&!/^(?:aistudio|library)\./.test(msg.stage||'')){sendResponse({ok:false});return false;}
  if(!fromPopup&&!sender.tab){sendResponse({ok:false});return false;}
  _diagnostics.record(msg.taskId,msg.stage,msg.details,fromPopup?undefined:sender.tab.id).then(ok=>sendResponse({ok}));return true;
 }
 if(msg.type==='VIDSIFT_TARGET_DONE'){
  const target=_targetCompletions.get(msg.taskId);
  if(target&&target.tabId===sender.tab?.id){_diagnostics.record(msg.taskId,msg.ok?'target.completed':'target.failed',{accepted:!!msg.ok,category:msg.ok?'success':VidSiftDiagnostics.category(msg.error)},sender.tab.id);if(msg.ok)target.resolve({transcript:msg.transcript});else target.reject(new Error(msg.error||'目标页面上传失败'));}
  sendResponse({ok:!!target});return false;
 }
 if(msg.type==='VIDSIFT_TARGET_SENT'){
  const target=_targetCompletions.get(msg.taskId);
  const ok=target?.tabId===sender.tab?.id&&!!target;
  if(ok){_diagnostics.record(msg.taskId,'target.submitted',{accepted:true},sender.tab.id);const tabId=_targetSourceTabs.get(sender.tab.id);_updateActiveTranscribeTask(tabId,'总结已发送，正在等待本次 ChatGPT 生成完成；后续视频仍在排队');}
  sendResponse({ok});return false;
 }
 if(msg.type==='CANCEL_VIDEO_TASK'){
  const requestedId=sender.tab?.id??msg.tabId;
  const tabId=_targetSourceTabs.get(requestedId)??requestedId;
  const cancelled=_videoWorkflow.cancel(tabId);const legacy=_legacyGuard.cancel(tabId);
  if(legacy){if(legacy.targetTabId)chrome.tabs.sendMessage(legacy.targetTabId,{type:'VIDSIFT_CANCEL_UPLOAD',taskId:legacy.id}).catch(()=>{});_targetCompletions.get(legacy.id)?.reject(new Error('视频任务已取消'));_clearActiveTranscribeTask(tabId);}
  sendResponse({ok:cancelled||!!legacy});return false;
 }
 if(msg.type==='VIDSIFT_SOURCE_CHANGED'){
  const task=_videoWorkflow.tasks.get(sender.tab?.id),source=VidSiftPlatforms.identify(msg.url);
  if(task&&source?.key!==task.source.key){verifySourceChange(task).then(()=>sendResponse({ok:true}),()=>sendResponse({ok:false}));return true;}
  sendResponse({ok:true});return false;
 }
 if(msg.type==='VIDSIFT_NATIVE_STATUS'){
  (async()=>{let client;try{client=new NativeMediaClient();const {result}=await client.request('diagnostics');sendResponse({ok:true,...result});}catch(e){sendResponse({ok:false,error:e.message});}finally{client?.close();}})();return true;
 }
});
chrome.tabs.onUpdated.addListener((id,change)=>{
 const legacy=_legacyGuard.get(id);
 if(legacy&&!legacy.sourceClosed&&change.url&&VidSiftPlatforms.identify(change.url)?.key!==legacy.source.key){
  _legacyGuard.cancel(id);if(legacy.targetTabId)chrome.tabs.sendMessage(legacy.targetTabId,{type:'VIDSIFT_CANCEL_UPLOAD',taskId:legacy.id}).catch(()=>{});
  _targetCompletions.get(legacy.id)?.reject(new Error('源视频已切换，未发送旧视频内容'));
 }
 const task=_videoWorkflow.tasks.get(id);if(!task||!change.url)return;
 if(VidSiftPlatforms.identify(change.url)?.key!==task.source.key)verifySourceChange(task).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(id=>{
 _targetSourceTabs.delete(id);
 const task=_videoWorkflow.tasks.get(id),legacy=_legacyGuard.get(id);
 for(const pending of [task,legacy])if(pending){pending.sourceClosed=true;diagnoseTask(pending,'source.closed');}
 for(const target of _targetCompletions.values())if(target.tabId===id)target.reject(new Error('目标页面已关闭，未完成发送'));
});
