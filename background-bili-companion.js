'use strict';
// This playback queue is independent of provider work, GPT generation and library saving.
globalThis.VidSiftCompanion=new BiliCompanion(chrome);
(() => {
 const companion=globalThis.VidSiftCompanion;
 const report=error=>globalThis.VidSiftErrors?.report('总结伴播未完成：'+String(error?.message||error),{component:'companion'});
 const run=promise=>Promise.resolve(promise).catch(report);
 companion.ready.catch(report);
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(!/^VIDSIFT_COMPANION_/.test(message?.type||''))return false;
  const content=['VIDSIFT_COMPANION_CLAIM','VIDSIFT_COMPANION_EVENT'].includes(message.type);
  if(content){
   run(companion.handleMessage(message,sender).then(respond,error=>respond({ok:false,error:String(error.message)})));
   return true;
  }
  if(!['VIDSIFT_COMPANION_STATUS','VIDSIFT_COMPANION_STOP','VIDSIFT_COMPANION_SET_ENABLED'].includes(message.type))return false;
  if(sender.id!==chrome.runtime.id||![chrome.runtime.getURL('options.html'),chrome.runtime.getURL('popup.html')].includes(sender.url)){
   respond({ok:false,error:'总结伴播控制只接受扩展设置页或弹窗'});return false;
  }
  if(message.type==='VIDSIFT_COMPANION_SET_ENABLED'&&typeof message.enabled!=='boolean'){
   respond({ok:false,error:'总结伴播开关值无效'});return false;
  }
  const result=message.type==='VIDSIFT_COMPANION_SET_ENABLED'?companion.setEnabled(message.enabled):message.type==='VIDSIFT_COMPANION_STOP'?companion.stopAll():companion.status();
  run(result.then(status=>respond({ok:true,...status}),error=>respond({ok:false,error:String(error.message)})));
  return true;
 });
 chrome.tabs.onRemoved.addListener(id=>run(companion.onRemoved(id)));
 chrome.tabs.onUpdated.addListener((id,change,tab)=>run(companion.onUpdated(id,change,tab)));
 chrome.tabs.onActivated.addListener(info=>run(companion.onActivated(info)));
 chrome.alarms.onAlarm.addListener(alarm=>run(companion.onAlarm(alarm)));
 chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.biliCompanionEnabled)run(companion.setEnabled(changes.biliCompanionEnabled.newValue!==false));
 });
})();
