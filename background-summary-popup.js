'use strict';
// Popup-only bridge. The library remains the sole persistent owner of ratings.
async function summaryPopupTab(message, snapshot) {
 const tab=await chrome.tabs.get(message.tabId);
 const [active]=await chrome.tabs.query({active:true,currentWindow:true});
 const url=VidSiftVideoLibrary.conversationUrl(tab?.url);
 if(!url||active?.id!==tab.id||message.expectedUrl!==tab.url||(snapshot&&snapshot.raw!==tab.url))throw Object.assign(Error('ChatGPT页面已切换，请重新打开扩展'),{code:'STALE_TAB'});
 return {id:tab.id,url,raw:tab.url};
}
async function summaryPopupRequest(message) {
 const tab=await summaryPopupTab(message);
 const config=await _videoLibrary.getSettings();
 await summaryPopupTab(message,tab);
 if(config.enabled===false)throw Object.assign(Error('书库联动·关，请在设置中开启后读取评分和总结列表'),{code:'LIBRARY_DISABLED'});
 const external=async payload=>{
  await summaryPopupTab(message,tab);
  const result=await summaryDeadline(chrome.runtime.sendMessage(config.extensionId,payload),6000);
  await summaryPopupTab(message,tab);
  return result;
 };
 const hello=await external({type:'ZHIXING_VIDSIFT_HELLO'});
 if(!hello?.ok||!hello.capabilities?.includes('summary-context-v1')||!hello.capabilities?.includes('rate-video-v1'))throw Object.assign(Error('知行批注书库版本暂不支持此面板，请更新书库后重试'),{code:'OLD_LIBRARY'});
 const context=await external({type:'ZHIXING_VIDSIFT_SUMMARY_CONTEXT',version:1,chatgptUrl:tab.url,limit:10,...(message.cursor?{cursor:message.cursor}:{})});
 if(!context?.ok)throw Object.assign(Error(context?.code==='NOT_FOUND'?'当前对话尚未收录到知行批注书库':context?.error||'书库未响应，评分与总结列表尚未确认'),{code:context?.code});
 const validScore=score=>score===null||(Number.isInteger(score)&&score>=1&&score<=10);
 const video=VidSiftVideoLibrary.normalizeSource({url:context.current?.videoUrl}).url;
 const validRecord=r=>r&&VidSiftVideoLibrary.conversationUrl(r.chatgptUrl)===r.chatgptUrl&&r.chatgptUrl.split('/').at(-1)===r.id&&VidSiftVideoLibrary.normalizeSource({url:r.videoUrl}).url===video;
 if(!validRecord(context.current)||context.current.id!==tab.url.split('/').at(-1)||!validScore(context.rating)||!Array.isArray(context.records)||context.records.length>10||!context.records.every(validRecord)||!Number.isSafeInteger(context.total)||context.total<context.records.length||(context.nextCursor!==null&&typeof context.nextCursor!=='string'))throw Error('书库返回的对话或评分格式无效，请更新书库后重试');
 if(message.type==='VIDSIFT_POPUP_SUMMARY_RATE'){
  if(!validScore(message.score))throw Error('评分必须为1至10或未评分');
  const result=await external({type:'ZHIXING_VIDSIFT_SET_VIDEO_RATING',version:1,chatgptUrl:tab.url,videoUrl:video,score:message.score});
  if(!result?.ok||result.id!==context.current.id||result.score!==message.score)throw Error(result?.error||'书库未确认评分保存，请重试');
  return {ok:true,score:result.score};
 }
 if(message.type==='VIDSIFT_POPUP_SUMMARY_OPEN'){
  const member=context.records.find(r=>r.id===message.recordId);
  if(!member)throw Error('这条总结不在当前视频列表中，请重新读取');
  await summaryPopupTab(message,tab);
  await chrome.tabs.update(tab.id,{url:member.chatgptUrl});
  const after=await chrome.tabs.get(tab.id),[active]=await chrome.tabs.query({active:true,currentWindow:true});
  if(active?.id!==tab.id||VidSiftVideoLibrary.conversationUrl(after?.url)!==member.chatgptUrl)throw Error('总结切换期间页面已变化，请重新打开扩展');
  return {ok:true};
 }
 return {...context,ok:true};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(!['VIDSIFT_POPUP_SUMMARY_CONTEXT','VIDSIFT_POPUP_SUMMARY_RATE','VIDSIFT_POPUP_SUMMARY_OPEN'].includes(message?.type))return false;
 if(sender.tab||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html')){reply({ok:false,error:'此操作只允许扩展弹窗发起',code:'FORBIDDEN'});return false;}
 summaryPopupRequest(message).then(reply).catch(error=>reply({ok:false,error:error.message,code:error.code||'LIBRARY_FAILED'}));return true;
});
