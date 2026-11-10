(function(root){
 'use strict';
 const configurations={
  bilibili:{name:'B站音频下载脚本',ping:'VIDSIFT_BILI_PING',files:['task-diagnostics.js','error-reporter.js','bilibili-content.js'],main:['bilibili-content-main.js'],accept:u=>u.protocol==='https:'&&u.hostname==='www.bilibili.com'&&(/^\/video\/BV\w+/.test(u.pathname)||u.pathname.startsWith('/list/'))},
  chatgpt:{name:'ChatGPT上传脚本',ping:'VIDSIFT_CHATGPT_PING',main:['chatgpt-library-main.js'],files:['task-diagnostics.js','error-reporter.js','conversation-binding.js','attachment-utils.js','conversation-title.js','chatgpt-content.js'],accept:u=>u.protocol==='https:'&&['chatgpt.com','chat.openai.com'].includes(u.hostname)},
  aistudio:{name:'AI Studio上传脚本',ping:'VIDSIFT_AISTUDIO_PING',files:['task-diagnostics.js','error-reporter.js','attachment-utils.js','aistudio-transcript.js','attachment-transfer.js','aistudio-content.js'],accept:u=>u.protocol==='https:'&&u.hostname==='aistudio.google.com'}
 };
 class PageBridge{
  constructor(api){this.api=api;this.pending=new Map();}
  async ensure(tabId,kind){
   if(!Number.isInteger(tabId)||tabId<0)throw new Error('页面连接缺少有效标签页，请重新打开源视频页面');
   const key=tabId+':'+kind;if(this.pending.has(key))return this.pending.get(key);
   const attempt=this.repair(tabId,kind);this.pending.set(key,attempt);
   try{return await attempt;}finally{if(this.pending.get(key)===attempt)this.pending.delete(key);}
  }
  async waitFor(tabId,kind,{timeout=45000,assertLive=async()=>{},onStatus=()=>{}}={}){
   const config=configurations[kind];if(!config)throw new Error('不支持的页面连接类型');
   const deadline=Date.now()+timeout;let lastError;
   while(Date.now()<deadline){
    await assertLive();const tab=await this.api.tabs.get(tabId);let url;try{url=new URL(tab.url||'');}catch{}
    if(url&&config.accept(url)){
     let timer;try{await Promise.race([this.ensure(tabId,kind),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('页面脚本未连接，仍在等待响应')),2000);})]);await assertLive();return;}catch(e){lastError=e;if(!/未连接|仍未连接/.test(e.message))throw e;}finally{clearTimeout(timer);}
    }else if(url&&url.protocol!=='about:')throw new Error(config.name+'对应页面已切换或转到登录页，请在正确页面完成登录后重试');
    onStatus('正在连接 '+config.name+'，等待页面脚本响应...');
    await new Promise(resolve=>setTimeout(resolve,250));
   }
   throw new Error(config.name+'连接超时；页面尚未收到附件，请检查登录或站点权限'+(lastError?'：'+lastError.message:''));
  }
  async repair(tabId,kind){
   const config=configurations[kind];if(!config)throw new Error('不支持的页面连接类型');
   const valid=async()=>{const tab=await this.api.tabs.get(tabId);let u;try{u=new URL(tab.url);}catch{}if(!u||!config.accept(u))throw new Error(config.name+'对应页面已切换或转到登录页，请在正确页面完成登录后重试');};
   const ping=async()=>{try{const r=await this.api.tabs.sendMessage(tabId,{type:config.ping},{frameId:0});if(kind==='aistudio'&&r?.ok&&r.component===kind&&!r.attachmentTransfer)throw new Error('AI Studio 页面仍是旧版上传脚本，请关闭旧页面并从视频页重新发起任务');if(kind==='chatgpt'&&r?.ok&&r.component===kind&&r.captureProtocol!==2)throw new Error('ChatGPT 页面仍是旧版对话脚本，请刷新该页后重试');return r?.ok&&r.component===kind&&(kind!=='bilibili'||r.mainReady);}catch(e){if(e.message?.includes('旧版上传脚本')||e.message?.includes('旧版对话脚本'))throw e;return false;}};
   await valid();if(await ping())return;
   if(!this.api.scripting?.executeScript)throw new Error(config.name+'未连接，当前扩展未取得脚本补载权限；请在扩展管理页重新加载并确认权限');
   try{
    await valid();
    if(config.main)await this.api.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',files:config.main,injectImmediately:true});
    await this.api.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',files:config.files,injectImmediately:true});
   }catch(e){throw new Error(config.name+'补载失败，请检查该站点的扩展权限：'+e.message);}
   await valid();if(!await ping())throw new Error(config.name+'仍未连接，已停止本次任务；请刷新该页面后重试');
  }
 }
 root.PageBridge=PageBridge;if(typeof module!=='undefined')module.exports={PageBridge};
})(globalThis);
