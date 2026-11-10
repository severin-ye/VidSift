'use strict';
const _videoLibrary=new VidSiftVideoLibrary.VideoLibraryBridge(chrome);
async function prepareVideoLibraryTask({taskId,targetTabId,source,legacyTask,openerTabId,videoTitle,tempChat}){
 if(tempChat||!taskId)return false;
 try{
  if(!(await _videoLibrary.getSettings()).enabled)return false;
  let info=source||legacyTask?.source;
  const tabId=legacyTask?.tabId??openerTabId;
  if(!info?.url&&Number.isInteger(tabId))info={...info,url:(await chrome.tabs.get(tabId)).url};
  info=VidSiftVideoLibrary.normalizeSource({...info,title:videoTitle||info?.title});
  if(info.platform==='youtube')info.coverUrl='https://i.ytimg.com/vi/'+info.videoId+'/hqdefault.jpg';
  if(info.platform==='bilibili'){
   try{const response=await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(info.videoId),{credentials:'omit',signal:AbortSignal.timeout(5000)});const result=await response.json();if(response.ok&&result.code===0&&result.data?.bvid===info.videoId){info.coverUrl=result.data.pic||'';if(!videoTitle)info.title=result.data.title||info.title;}}catch{}
  }
  if(!info.coverUrl&&Number.isInteger(tabId)){
   try{
    const result=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:()=>({url:location.href,coverUrl:document.querySelector('video[poster]')?.poster||document.querySelector('meta[property="og:image"]')?.content||''})});
    const snapshot=result[0]?.result;
    if(snapshot&&VidSiftPlatforms.identify(snapshot.url)?.key===VidSiftPlatforms.identify(info.url)?.key)info.coverUrl=snapshot.coverUrl;
   }catch{}
  }
  if(info.platform==='bilibili'&&VidSiftVideoLibrary.allowedCover(info.coverUrl)&&!info.coverUrl.includes('@'))info.coverUrl+='@640w_360h_1c.jpg';
  if(!VidSiftVideoLibrary.allowedCover(info.coverUrl))info.coverUrl='';
  await _videoLibrary.register({taskId,tabId:targetTabId,source:info,tempChat:false});return true;
 }catch(e){console.warn('视频总结书库记录尚未登记：',e.message);return false;}
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(msg.type==='VIDSIFT_TARGET_DONE'&&msg.ok===false){_videoLibrary.abandon(msg.taskId).catch(()=>{});return false;}
 if(['VIDSIFT_LIBRARY_SUBMITTED','VIDSIFT_LIBRARY_CONFIRMED'].includes(msg.type)){
  if(!sender.tab||!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url||sender.tab.url||'')){reply({ok:false});return false;}
  (msg.type==='VIDSIFT_LIBRARY_SUBMITTED'?_videoLibrary.submitted(msg.taskId,sender):_videoLibrary.confirmed(msg.taskId,sender,msg.chatgptUrl)).then(()=>{reply({ok:true});return _videoLibrary.drain();}).catch(e=>reply({ok:false,error:e.message}));return true;
 }
 if(['VIDSIFT_LIBRARY_STATUS','VIDSIFT_LIBRARY_RETRY'].includes(msg.type)){
  if(sender.tab){reply({ok:false});return false;}
  (msg.type==='VIDSIFT_LIBRARY_RETRY'?_videoLibrary.drain():_videoLibrary.status()).then(status=>reply({ok:true,...status})).catch(e=>reply({ok:false,error:e.message}));return true;
 }
});
chrome.tabs.onRemoved.addListener(tabId=>{_videoLibrary.mutate(s=>{s.tasks=s.tasks.filter(t=>t.tabId!==tabId||t.chatgptUrl);}).catch(()=>{});});
chrome.runtime.onStartup?.addListener(()=>{_videoLibrary.drain().catch(()=>{});});
