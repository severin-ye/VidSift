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
  const timer=setTimeout(()=>{finish();_targetCompletions.delete(task.id);reject(new Error('附件上传等待超时，已保留页面材料，请检查后重试'));},30*60*1000);
  _targetCompletions.set(task.id,{tabId,resolve:payload=>{finish();clearTimeout(timer);_targetCompletions.delete(task.id);resolve(payload);},reject:e=>{finish();clearTimeout(timer);_targetCompletions.delete(task.id);reject(e);}});
 });
}
async function sendVideoChatGPT(data){
 const {task}=data;const target=await _openChatGPTAndSend({...data,attachments:data.attachments,taskId:task.id,beforePrepare:()=>_videoWorkflow.assertLive(task),beforeDispatch:tabId=>waitForTarget(task,tabId)});
 if(!target.ok){_targetCompletions.get(task.id)?.reject(new Error(target.error));throw new Error(target.error);}await target.completion;
}
async function sendVideoAIStudio(data){
 const {index,windowId}=await getTabInfo(data.openerTabId);
 const tab=await chrome.tabs.create({url:'https://aistudio.google.com/prompts/new_chat',active:false,index:index+1,openerTabId:data.openerTabId,windowId});
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
async function transcribeVideo(audio,data,notify,signal){
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
chrome.runtime.onConnect.addListener(port=>{
 if(port.name!=='vidsift-video')return;
 let connected=true;port.onDisconnect.addListener(()=>{connected=false;});
 port.onMessage.addListener(msg=>{
  if(msg.type!=='START_VIDEO_TASK')return;
  const notify=(type,text)=>{overlayMsg(msg.openerTabId,{type:type==='ERROR'?'EXT_ERROR':'EXT_STATUS',text});if(connected)try{port.postMessage({type,text});}catch{}};
  _videoWorkflow.start(msg,notify).catch(()=>{});
 });
});
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
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
 if(legacy&&change.url&&VidSiftPlatforms.identify(change.url)?.key!==legacy.source.key){
  _legacyGuard.cancel(id);if(legacy.targetTabId)chrome.tabs.sendMessage(legacy.targetTabId,{type:'VIDSIFT_CANCEL_UPLOAD',taskId:legacy.id}).catch(()=>{});
  _targetCompletions.get(legacy.id)?.reject(new Error('源视频已切换，未发送旧视频内容'));
 }
 const task=_videoWorkflow.tasks.get(id);if(!task||!change.url)return;
 if(VidSiftPlatforms.identify(change.url)?.key!==task.source.key)verifySourceChange(task).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(id=>{
 _targetSourceTabs.delete(id);
 _videoWorkflow.cancel(id,'原视频标签页已关闭，任务已停止');const legacy=_legacyGuard.cancel(id);
 if(legacy){if(legacy.targetTabId)chrome.tabs.sendMessage(legacy.targetTabId,{type:'VIDSIFT_CANCEL_UPLOAD',taskId:legacy.id}).catch(()=>{});_targetCompletions.get(legacy.id)?.reject(new Error('源视频页面已关闭，任务已取消'));_updateActiveTranscribeTask(id,'源视频页面已关闭，任务已取消');finishLegacyTask(legacy);}
 for(const target of _targetCompletions.values())if(target.tabId===id)target.reject(new Error('目标页面已关闭，未完成发送'));
});
