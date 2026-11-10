(function(root){
 'use strict';
 class GroqCredentialPrompt{
  constructor(api){
   this.api=api;this.entries=new Map();this.tasks=new Map();
   api.windows.onRemoved.addListener(id=>{for(const entry of this.entries.values())if(entry.windowId===id)this.finish(entry,new Error('已取消Groq密钥配置，未继续转写或发送'));});
  }
  finish(entry,error){
   if(this.entries.get(entry.token)!==entry)return;
   this.entries.delete(entry.token);this.tasks.delete(entry.key);clearTimeout(entry.timer);clearInterval(entry.pulse);
   entry.signal?.removeEventListener('abort',entry.abort);
   if(error)entry.reject(error);else entry.resolve(true);
   if(entry.windowId!==undefined)this.api.windows.remove(entry.windowId).catch(()=>{});
  }
  async ensure({client,task,signal=task?.controller?.signal,assertLive,onWait}){
   if(signal?.aborted)throw new Error('视频处理已取消');
   if((await client.groqStatus()).configured)return true;
   if(signal?.aborted)throw new Error('视频处理已取消');
   await assertLive?.();
   if(signal?.aborted)throw new Error('视频处理已取消');
   const key=task?.id||'settings';if(this.tasks.has(key))return this.tasks.get(key).promise;
   const entry={key,token:crypto.randomUUID(),client,signal,assertLive,forTask:!!task,saving:false};
   entry.promise=new Promise((resolve,reject)=>{entry.resolve=resolve;entry.reject=reject;});entry.promise.catch(()=>{});
   entry.abort=()=>this.finish(entry,new Error('视频处理已取消'));
   this.entries.set(entry.token,entry);this.tasks.set(key,entry);signal?.addEventListener('abort',entry.abort,{once:true});
   entry.timer=setTimeout(()=>this.finish(entry,new Error('Groq密钥填写等待已结束，未继续转写或发送；可重新运行任务')),15*60*1000);
   entry.pulse=setInterval(()=>{this.api.runtime.getPlatformInfo?.().catch(()=>{});},20000);
   onWait?.();
   try{
    entry.created=this.api.windows.create({url:this.api.runtime.getURL('groq-key.html')+'#'+entry.token,type:'popup',width:480,height:560});
    const window=await entry.created;entry.windowId=window.id;entry.tabId=window.tabs?.[0]?.id;
    if(!this.entries.has(entry.token))this.api.windows.remove(window.id).catch(()=>{});
   }catch{this.finish(entry,new Error('无法打开Groq密钥输入窗口，请从设置页配置后重试'));}
   return entry.promise;
  }
  async handle(message,sender){
   if(sender.id!==this.api.runtime.id||typeof sender.url!=='string')return{ok:false,error:'密钥配置请求来源无效'};
   const [url,token]=sender.url.split('#');
   if(url!==this.api.runtime.getURL('groq-key.html')||!token)return{ok:false,error:'密钥配置请求来源无效'};
   const entry=this.entries.get(token);if(!entry)return{ok:false,error:'当前配置窗口已失效，请从视频任务或设置页重新打开'};
   try{await entry.created;}catch{return{ok:false,error:'配置窗口未就绪'};}
   if(sender.tab?.id!==entry.tabId||this.entries.get(token)!==entry)return{ok:false,error:'密钥配置请求来源无效'};
   if(message.type==='VIDSIFT_GROQ_KEY_READY')return{ok:true,forTask:entry.forTask};
   if(message.type!=='VIDSIFT_GROQ_KEY_SAVE')return{ok:false,error:'未知密钥配置操作'};
   if(entry.saving)return{ok:false,error:'正在验证并保存，请稍候'};
   entry.saving=true;
   const checkLive=async()=>{try{if(entry.signal?.aborted)throw new Error('视频处理已取消');await entry.assertLive?.();if(entry.signal?.aborted||this.entries.get(token)!==entry)throw new Error('密钥配置已取消');}catch(error){this.finish(entry,error);throw error;}};
   try{
    await checkLive();
    const saved=await entry.client.storeGroqKey(message.apiKey);
    message.apiKey='';
    if(!saved?.configured)throw new Error('Groq密钥未保存，请重试');
    await checkLive();this.finish(entry);return{ok:true};
   }catch(error){return{ok:false,error:error.message||'Groq密钥未保存，请重试'};}
   finally{message.apiKey='';entry.saving=false;}
  }
 }
 root.GroqCredentialPrompt=GroqCredentialPrompt;if(typeof module!=='undefined')module.exports={GroqCredentialPrompt};
})(globalThis);
