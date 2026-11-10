(function(root){
 'use strict';
 class VideoWorkflow{
  constructor(deps){this.deps=deps;this.tasks=new Map();}
  async assertLive(task){
   if(task.cancelled)throw new Error('视频处理已取消');
   const tab=await this.deps.getTab(task.tabId),now=this.deps.identify(tab.url||'');
   if(!now||now.key!==task.source.key)throw new Error('源视频已切换，已停止发送旧视频内容');
  }
  async start(msg,notify=()=>{}){
   const d=this.deps,tabId=msg.openerTabId,source=d.identify(msg.sourceUrl);
   if(!source)throw new Error('当前页面不是支持的视频页面');
   if(this.tasks.has(tabId)||d.existing(tabId))throw new Error('当前视频已有任务进行中，请等待或取消');
   const task={tabId,source,id:'video_'+Date.now()+'_'+Math.random().toString(36).slice(2),cancelled:false,controller:new AbortController()};
   this.tasks.set(tabId,task);d.lock(tabId,'video','正在提取视频内容...');
   const status=(type,text)=>{d.lock(tabId,'video',text);notify(type,text);};let assets=[];
   try{
    await this.assertLive(task);task.client=d.client();
    let pageSource;
    if(source.platform==='douyin'&&d.snapshot){
     status('STATUS','正在读取当前抖音作品的原视频信息...');
     try{pageSource=await d.snapshot(task);}catch{pageSource=null;}
     await this.assertLive(task);
     if(!pageSource)status('STATUS','当前页面未提供完整原视频地址，改用限时解析...');
    }
    const result=await task.client.resolve({url:msg.sourceUrl,source:{...msg.source,...pageSource},forceAudio:!!msg.forceAudio,needAudio:true,audioSettings:d.normalizeAudio?d.normalizeAudio(msg.audioSettings):msg.audioSettings,screenshots:d.normalize(msg.screenshotSettings)},text=>status('STATUS',text));
    assets=[result.audio,...(result.images||[])].filter(Boolean).map(a=>a.assetId);
    if(result.audio&&d.normalizeAudio&&!result.audioInfo)throw new Error('本机媒体程序尚未支持音频设置，请更新到本包5.1.0本机程序后重试');
    await this.assertLive(task);
    if(d.normalize(msg.screenshotSettings).enabled && !(result.images||[]).length) throw new Error('图片提取未得到可用画面，已停止自动发送；可关闭图片提取后重试');
    if(result.frameInfo?.mode==='interval' && result.frameInfo.interval>d.normalize(msg.screenshotSettings).interval)status('STATUS','为覆盖全程并满足拼图上限，实际截图间隔已调整为 '+result.frameInfo.interval+' 秒');
    const context={platform:result.platform,videoId:result.videoId,title:result.title||msg.source?.title||source.videoId,url:msg.sourceUrl,duration:result.duration};
    const attachments=[];
    for(const image of result.images||[]){await this.assertLive(task);attachments.push(await task.client.readAsset(image.assetId));}
    let srt=msg.forceAudio?'':result.subtitle?.body?.length?d.toSrt(result.subtitle.body):'';
    const common={...msg,taskId:task.id,biliTabId:tabId,videoTitle:context.title,bvid:context.videoId,source:context,task};
    if(!srt){
     if(!result.audio)throw new Error('未取得可用字幕或完整音频，请检查视频访问权限');
     status('STATUS','正在读取视频音频...');const audio=await task.client.readAsset(result.audio.assetId);await this.assertLive(task);
     if((msg.transcribeService||'aistudio')==='aistudio'){
      status('STATUS','正在后台转写音频，完成后自动交给 ChatGPT...');
      const transcription=await d.sendAIStudio({...common,audio,duration:result.duration,attachments:[audio,...attachments]});
      srt=transcription?.transcript;
      if(!srt?.trim())throw new Error('AI Studio 未返回完整逐字稿，未发送到 ChatGPT');
     }else{
      srt=await d.transcribe(audio,common,status,task.controller.signal);
      if(!srt?.trim())throw new Error('音频转写结果为空，未发送到 ChatGPT');
     }
    }
    if(srt){
     await this.assertLive(task);
     const name=(context.videoId+'_'+context.title).replace(/[\\/:*?"<>|]/g,'_').slice(0,160)+'.srt';
     const file={name,content:srt};
     await d.sendChatGPT({...common,file,attachments:[{name,mime:'text/plain',content:srt},...attachments]});
    }
    if(task.cancelled)throw new Error('视频处理已取消');
    status('DONE','字幕/音频与所选图片已上传并发送。');return {ok:true,source:context,frameInfo:result.frameInfo};
   }catch(e){status('ERROR',e.message);throw e;}
   finally{
    try{await task.client?.release(assets);}catch{}task.client?.close();
    this.tasks.delete(tabId);d.unlock(tabId);
   }
  }
  cancel(tabId,reason='已在扩展中取消当前视频任务'){
   const task=this.tasks.get(tabId);if(!task||task.cancelled)return false;task.cancelled=true;task.cancelReason=reason;task.controller.abort();task.client?.cancel();this.deps.cancelTarget(task);return true;
  }
 }
 root.VideoWorkflow=VideoWorkflow;if(typeof module!=='undefined')module.exports={VideoWorkflow};
})(globalThis);
