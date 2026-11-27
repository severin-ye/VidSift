'use strict';
const _videoLibrary=new VidSiftVideoLibrary.VideoLibraryBridge(chrome,{onError:error=>_diagnostics.visibleError({component:'library',category:'library',message:'视频总结尚未保存到知行批注书库：'+error.message})});
async function confirmVideoCollection(link){
 const chatgptUrl=VidSiftVideoLibrary.conversationUrl(link);
 if(!chatgptUrl)throw Error('收藏未确认本次 ChatGPT 对话，已保留页面，请勿重复发送');
 const id=chatgptUrl.split('/').at(-1);
 try{
  await _videoLibrary.drain(id);
  const {enabled,extensionId}=await _videoLibrary.getSettings();
  if(enabled){
   const result=await summaryDeadline(chrome.runtime.sendMessage(extensionId,{type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl,limit:10}),6000);
   if(result?.ok&&result.current?.id===id)return;
  }
 }catch{}
 throw Error('总结已生成，书库尚未确认收藏；已保留 ChatGPT 页面，可在扩展设置重试入库');
}
async function prepareVideoLibraryTask({taskId,targetTabId,source,legacyTask,openerTabId,videoTitle,tempChat}){
 if(tempChat||!taskId)return false;
 try{
  if(!(await _videoLibrary.getSettings()).enabled)return false;
  let info=source||legacyTask?.source;
  const tabId=legacyTask?.tabId??openerTabId;
  if(!info?.url&&Number.isInteger(tabId))info={...info,url:(await chrome.tabs.get(tabId)).url};
  info=VidSiftVideoLibrary.normalizeSource({...info,title:videoTitle||info?.title});
  info.coverUrl=VidSiftVideoLibrary.normalizeCover(info.coverUrl);
  if(info.platform==='youtube')info.coverUrl='https://i.ytimg.com/vi/'+info.videoId+'/hqdefault.jpg';
  if(info.platform==='bilibili'&&!info.coverUrl){
   try{const response=await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(info.videoId),{credentials:'omit',signal:AbortSignal.timeout(5000)});const result=await response.json();if(response.ok&&result.code===0&&result.data?.bvid===info.videoId){info.coverUrl=VidSiftVideoLibrary.normalizeCover(result.data.pic)||info.coverUrl;if(!videoTitle)info.title=result.data.title||info.title;}}catch{}
  }
  if(!info.coverUrl&&Number.isInteger(tabId)){
   try{
    const result=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:()=>({url:location.href,coverUrl:document.querySelector('video[poster]')?.poster||document.querySelector('meta[property="og:image"]')?.content||''})});
    const snapshot=result[0]?.result;
    if(snapshot&&VidSiftPlatforms.identify(snapshot.url)?.key===VidSiftPlatforms.identify(info.url)?.key)info.coverUrl=VidSiftVideoLibrary.normalizeCover(snapshot.coverUrl);
   }catch{}
  }
  if(info.platform==='bilibili'&&VidSiftVideoLibrary.allowedCover(info.coverUrl)&&!info.coverUrl.includes('@'))info.coverUrl+='@640w_360h_1c.jpg';
  if(!VidSiftVideoLibrary.allowedCover(info.coverUrl))info.coverUrl='';
  await _videoLibrary.register({taskId,tabId:targetTabId,source:info,tempChat:false});return true;
 }catch(e){await _diagnostics.visibleError({component:'library',category:'library',taskId,message:'视频总结书库记录尚未登记：'+e.message});console.warn('视频总结书库记录尚未登记：',e.message);return false;}
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(msg.type==='VIDSIFT_TARGET_DONE'&&msg.ok===false){_videoLibrary.abandon(msg.taskId).catch(()=>{});return false;}
 if(['VIDSIFT_LIBRARY_SUBMITTED','VIDSIFT_LIBRARY_CONFIRMED','VIDSIFT_LIBRARY_UNCONFIRMED'].includes(msg.type)){
  if(!sender.tab||!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url||sender.tab.url||'')){reply({ok:false});return false;}
  if(msg.type==='VIDSIFT_LIBRARY_UNCONFIRMED'){
   _videoLibrary.mutate(s=>{const task=s.tasks.find(t=>t.taskId===msg.taskId&&t.tabId===sender.tab.id&&t.sent);if(task){task.captureStatus='unconfirmed';s.message='总结请求已发送，但本次ChatGPT链接未确认，尚未入书库；已保留视频待办，不会重发总结';}}).then(()=>reply({ok:true})).catch(e=>reply({ok:false,error:e.message}));return true;
  }
  (msg.type==='VIDSIFT_LIBRARY_SUBMITTED'?_videoLibrary.submitted(msg.taskId,sender):_videoLibrary.confirmed(msg.taskId,sender,msg.chatgptUrl)).then(()=>{reply({ok:true});return _videoLibrary.drain();}).catch(e=>reply({ok:false,error:e.message}));return true;
 }
 if(['VIDSIFT_LIBRARY_STATUS','VIDSIFT_LIBRARY_RETRY'].includes(msg.type)){
  if(sender.tab){reply({ok:false});return false;}
  (msg.type==='VIDSIFT_LIBRARY_RETRY'?_videoLibrary.drain():_videoLibrary.status()).then(status=>reply({ok:true,...status})).catch(e=>reply({ok:false,error:e.message}));return true;
 }
});
chrome.tabs.onRemoved.addListener(tabId=>{_videoLibrary.mutate(s=>{for(const task of s.tasks.filter(t=>t.tabId===tabId&&t.sent&&!t.chatgptUrl)){task.captureStatus='unconfirmed';s.message='总结请求已发送，但页面已关闭且本次ChatGPT链接未确认，尚未入书库；已保留视频待办，不会重发总结';}s.tasks=s.tasks.filter(t=>t.tabId!==tabId||t.chatgptUrl||t.sent);}).catch(()=>{});});
chrome.runtime.onStartup?.addListener(()=>{_videoLibrary.drain().catch(()=>{});});
