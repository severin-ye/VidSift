// Loaded by background.js after its single diagnostics journal is created.
(function(){
 'use strict';
 const hosts=new Set(['www.bilibili.com','www.youtube.com','m.youtube.com','youtu.be','www.douyin.com','v.douyin.com','chatgpt.com','chat.openai.com','aistudio.google.com']);
 function trusted(sender){
  if(sender?.id!==chrome.runtime.id)return false;
  try{
   const url=new URL(sender.url||sender.tab?.url||'');
   if(url.protocol==='chrome-extension:'&&url.hostname===chrome.runtime.id)return true;
   return url.protocol==='https:'&&hosts.has(url.hostname)&&sender.frameId===0&&Number.isInteger(sender.tab?.id);
  }catch{return false;}
 }
 chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=='VIDSIFT_VISIBLE_ERROR')return false;
  if(!trusted(sender)||!message.event||typeof message.event.message!=='string')return false;
  _diagnostics.visibleError(message.event,sender.tab?.id).then(ok=>reply({ok:ok===true}),()=>reply({ok:false}));
  return true;
 });
})();
