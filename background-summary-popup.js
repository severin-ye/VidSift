'use strict';

async function summaryPopupTab(message) {
 const tab=await chrome.tabs.get(message.tabId);
 const [active]=await chrome.tabs.query({active:true,currentWindow:true});
 if(!tab?.url||active?.id!==tab.id||message.expectedUrl!==tab.url)throw Object.assign(Error('页面已切换，请重新打开视频总结扩展'),{code:'STALE_TAB'});
 return tab;
}
async function summaryPopupRequest(message) {
 const tab=await summaryPopupTab(message);
 const chat=VidSiftVideoLibrary.conversationUrl(tab.url);
 const videoMode=!chat&&typeof message.expectedVideoUrl==='string';
 const canonical=url=>VidSiftVideoLibrary.normalizeSource({url}).url;
 let video=videoMode?canonical(message.expectedVideoUrl):null;
 if(!chat&&!videoMode)throw Error('当前页面没有可管理的视频总结');
 async function assertVideo(){
  const current=await summaryPopupTab(message);
  if(videoMode){
   const {source}=await VidSiftCurrentVideo.discover(chrome,current,{capture:false});
   if(canonical(source.url)!==video)throw Object.assign(Error('当前视频已切换，请重新打开视频总结扩展'),{code:'STALE_TAB'});
   await summaryPopupTab(message);
  }
 }
 await assertVideo();
 const config=await _videoLibrary.getSettings();
 if(config.enabled===false)throw Object.assign(Error('书库联动·关，请在设置中开启后读取视频总结'),{code:'LIBRARY_DISABLED'});
 const external=async payload=>{
  await summaryPopupTab(message);
  return summaryDeadline(chrome.runtime.sendMessage(config.extensionId,payload),6000);
 };
 const hello=await external({type:'ZHIXING_VIDSIFT_HELLO'});
 const capabilities=hello?.ok&&hello.capabilities||[];
 const required=videoMode?['list-video-v1']:['summary-context-v1','rate-video-v1'];
 if(!required.every(capability=>capabilities.includes(capability)))throw Object.assign(Error('知行批注书库版本暂不支持此面板，请更新书库后重试'),{code:'OLD_LIBRARY'});
 const remove=message.type==='VIDSIFT_POPUP_SUMMARY_REMOVE';
 const currentId=chat?.split('/').at(-1);
 const cursor=remove&&message.recordId===currentId?null:message.cursor;
 const context=await external({
  type:videoMode?'ZHIXING_VIDSIFT_LIST_VIDEO':'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',
  version:1,limit:10,...(videoMode?{videoUrl:video}:{chatgptUrl:chat}),...(cursor?{cursor}:{})
 });
 await assertVideo();
 if(!context?.ok)throw Object.assign(Error(context?.code==='NOT_FOUND'?'当前对话尚未收录到知行批注书库':context?.error||'书库未确认总结列表，请重试'),{code:context?.code});
 const validScore=score=>score===null||(Number.isInteger(score)&&score>=1&&score<=10);
 if(!videoMode)video=canonical(context.current?.videoUrl);
 const validRecord=record=>record&&VidSiftVideoLibrary.conversationUrl(record.chatgptUrl)===record.chatgptUrl&&record.chatgptUrl.split('/').at(-1)===record.id&&canonical(record.videoUrl)===video;
 const validPage=page=>Array.isArray(page.records)&&page.records.length<=10&&page.records.every(validRecord)&&Number.isSafeInteger(page.total)&&page.total>=page.records.length&&(page.nextCursor===null||typeof page.nextCursor==='string');
 if(!validPage(context)||!videoMode&&(!validRecord(context.current)||context.current.id!==currentId||!validScore(context.rating)))throw Error('书库返回的对话或评分格式无效，请更新书库后重试');
 if(message.type==='VIDSIFT_POPUP_SUMMARY_RATE'){
  if(videoMode||!validScore(message.score))throw Error('请在已收录的 GPT 对话页选择有效评分');
  const result=await external({type:'ZHIXING_VIDSIFT_SET_VIDEO_RATING',version:1,chatgptUrl:chat,videoUrl:video,score:message.score});
  await summaryPopupTab(message);
  if(!result?.ok||result.id!==currentId||result.score!==message.score)throw Error(result?.error||'书库未确认评分保存，请重试');
  return {ok:true,score:result.score};
 }
 if(remove||message.type==='VIDSIFT_POPUP_SUMMARY_OPEN'){
  const member=remove&&message.recordId===currentId?context.current:context.records.find(record=>record.id===message.recordId);
  if(!member)throw Error('这条总结不在当前视频列表中，请重新读取');
  if(remove){
   if(!capabilities.includes('remove-video-v1'))throw Error('请更新知行批注书库后移除总结');
   const result=await external({type:'ZHIXING_VIDSIFT_REMOVE_VIDEO',version:1,chatgptUrl:member.chatgptUrl,videoUrl:video});
   if(!result?.ok||result.id!==member.id)throw Error(result?.error||'书库未确认移除总结，请重新读取');
   if(videoMode)void chrome.tabs.sendMessage?.(tab.id,{type:'VIDSIFT_SUMMARIES_REFRESH'}).catch(()=>{});
   const currentRemoved=member.id===currentId;
   let switched=false;
   if(currentRemoved){
    const next=context.records.find(record=>record.id!==currentId);
    if(next)try{
     await summaryPopupTab(message);
     await chrome.tabs.update(tab.id,{url:next.chatgptUrl});
     switched=true;
    }catch{}
   }
   return {ok:true,currentRemoved,switched};
  }
  if(videoMode)await chrome.tabs.create({url:member.chatgptUrl,active:true,openerTabId:tab.id,windowId:tab.windowId});
  else {
   await chrome.tabs.update(tab.id,{url:member.chatgptUrl});
   const after=await chrome.tabs.get(tab.id),[active]=await chrome.tabs.query({active:true,currentWindow:true});
   if(active?.id!==tab.id||VidSiftVideoLibrary.conversationUrl(after?.pendingUrl||after?.url)!==member.chatgptUrl)throw Error('总结切换期间页面已变化，请重新打开扩展');
  }
  return {ok:true};
 }
 return {...context,ok:true,canRemove:capabilities.includes('remove-video-v1')};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(!['VIDSIFT_POPUP_SUMMARY_CONTEXT','VIDSIFT_POPUP_SUMMARY_RATE','VIDSIFT_POPUP_SUMMARY_OPEN','VIDSIFT_POPUP_SUMMARY_REMOVE'].includes(message?.type))return false;
 if(sender.tab||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html')){reply({ok:false,error:'此操作只允许扩展弹窗发起',code:'FORBIDDEN'});return false;}
 void summaryPopupRequest(message).then(reply,error=>reply({ok:false,error:error.message,code:error.code||'LIBRARY_FAILED'}));return true;
});
