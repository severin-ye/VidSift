(function(root){
 'use strict';
 class VideoWorkflow{
  constructor(deps){this.deps=deps;this.tasks=new Map();}
  async assertLive(task){
   const check=()=>{if(task.cancelled||this.tasks.get(task.tabId)!==task)throw new Error('视频处理已取消或被替代');};
   check();
   if(task.sourceClosed)return;
   let tab;
   try{tab=await this.deps.getTab(task.tabId);}catch(e){
    if(!/No tab with id\b|标签页不存在|不存在的标签页/i.test(String(e?.message||e)))throw e;
    task.sourceClosed=true;
   }
   check();
   if(task.sourceClosed)return;
   const now=this.deps.identify(tab.url||'');
   if(!now||now.key!==task.source.key)throw new Error('源视频已切换，已停止发送旧视频内容');
  }
  async start(msg,notify=()=>{}){
   const d=this.deps,tabId=msg.openerTabId,source=d.identify(msg.sourceUrl);
   if(!source)throw new Error('当前页面不是支持的视频页面');
   if(this.tasks.has(tabId)||d.existing(tabId))throw new Error('当前视频已有任务进行中，请等待或取消');
   const task={tabId,source,id:'video_'+Date.now()+'_'+Math.random().toString(36).slice(2),diagnosticId:msg.diagnosticId,summaryQueued:msg.summaryQueued===true,sourceClosed:msg.sourceClosed===true,cancelled:false,controller:new AbortController()};
   this.tasks.set(tabId,task);d.lock(tabId,'video','正在提取视频内容...');
   const log=(stage,value)=>{try{d.diagnostic?.(task,stage,value);}catch{}};log('task.started');
   const status=(type,text)=>{if(this.tasks.get(tabId)===task)d.lock(tabId,'video',text);notify(type,text);};let assets=[],localAudio,localOutcome='failed';
   try{
    await this.assertLive(task);log('source.checked');task.client=d.client();log('native.connected');
    if(typeof task.client.request==='function'){try{const reply=await task.client.request('diagnostics');log('native.version',{nativeVersion:reply.result?.version||'unknown'});}catch{log('native.diagnostics_failed');}}
    let pageSource=msg.pageSource;
    if(pageSource&&String(pageSource.videoId)!==source.videoId)throw new Error('已采集作品与点击的视频不一致，未发送内容');
    if(source.platform==='douyin'&&!pageSource&&d.snapshot&&!task.sourceClosed){
     status('STATUS','正在读取当前抖音作品的原视频信息...');
     try{pageSource=await d.snapshot(task);}catch{pageSource=null;}
     await this.assertLive(task);
     if(!pageSource)status('STATUS','当前页面未提供完整原视频地址，改用限时解析...');
    }
    const local=msg.transcribeService==='groq'||source.platform==='douyin'&&msg.transcribeService==='local';
    let result;
    if(local&&!d.normalize(msg.screenshotSettings).enabled&&d.loadLocalMedia){result=await d.loadLocalMedia(task,pageSource);await this.assertLive(task);if(result){log('local.media_reused');status('STATUS','已核验并复用本作品的完整音频，不重新下载');}}
    if(!result){
     log('native.resolve');
     result=await task.client.resolve({url:msg.sourceUrl,source:{...msg.source,...pageSource},forceAudio:!!msg.forceAudio,needAudio:true,localTranscription:local,localSettings:msg.localSettings,audioSettings:d.normalizeAudio?d.normalizeAudio(msg.audioSettings):msg.audioSettings,screenshots:d.normalize(msg.screenshotSettings)},text=>{log('native.progress',{phase:/YouTube 字幕/.test(text)?'youtube_subtitle':/元数据/.test(text)?'metadata':/字幕轨道/.test(text)?'subtitle_tracks':/下载/.test(text)?'download':/压缩|编码/.test(text)?'encode':'processing'});status('STATUS',text);});
     if(local&&result.localAudio)await d.saveLocalMedia?.(task,result,msg.localSettings);
    }
    localAudio=result.localAudio;
    log('native.completed',{hasSubtitle:!!result.subtitle?.body?.length,subtitleCount:result.subtitle?.body?.length||0,hasAudio:!!result.audio,duration:result.duration,imageCount:result.images?.length||0,
     subtitleStatus:result.subtitleStatus,originalBytes:result.audioInfo?.originalBytes,outputBytes:result.audioInfo?.outputBytes,
     audioCandidateCount:result.audioInfo?.candidateCount,selectedSourceBytes:result.audioInfo?.selectedSourceBytes,
     selectedSourceBitrate:result.audioInfo?.selectedSourceBitrate,audioSourceKind:result.audioInfo?.sourceKind});
    assets=[result.audio,...(result.images||[])].filter(Boolean).map(a=>a.assetId);
    if(result.audio&&d.normalizeAudio&&!result.audioInfo)throw new Error('本机媒体程序尚未支持音频设置，请更新到本包5.1.0本机程序后重试');
    await this.assertLive(task);
    if(d.normalize(msg.screenshotSettings).enabled && !(result.images||[]).length) throw new Error('图片提取未得到可用画面，已停止自动发送；可关闭图片提取后重试');
    if(result.frameInfo?.mode==='interval' && result.frameInfo.interval>d.normalize(msg.screenshotSettings).interval)status('STATUS','为覆盖全程并满足拼图上限，实际截图间隔已调整为 '+result.frameInfo.interval+' 秒');
    const context={platform:result.platform||source.platform,videoId:result.videoId,title:result.title||msg.source?.title||source.videoId,url:msg.sourceUrl,duration:result.duration,coverUrl:result.coverUrl||pageSource?.coverUrl||msg.source?.coverUrl||''};
    const attachments=[];
    for(const image of result.images||[]){await this.assertLive(task);attachments.push(await task.client.readAsset(image.assetId));}
    let srt=msg.forceAudio?'':result.subtitle?.body?.length?d.toSrt(result.subtitle.body):'';
    const common={...msg,taskId:task.id,biliTabId:tabId,videoTitle:context.title,bvid:context.videoId,source:context,localAudio,task};
    if(!srt){
     if(!result.audio&&!localAudio)throw new Error('未取得可用字幕或完整音频，请检查视频访问权限');
     if(msg.transcribeService==='groq'||source.platform==='douyin'&&msg.transcribeService==='local'){
      if(!localAudio)throw new Error('本机媒体程序不支持当前音轨转写，请更新本包本机程序');
      if(msg.transcribeService==='local'&&typeof task.client.readPcmWindow!=='function')throw new Error('本机媒体程序不支持分段本地转写，请更新本包本机程序');
      log(msg.transcribeService==='groq'?'groq.prepare':'local.start',{duration:result.duration});
      srt=await d.transcribe(null,common,status,task.controller.signal);
      if(!srt?.trim())throw new Error('音轨转写没有取得有效口播文字，未发送到 ChatGPT');
     }else{
      status('STATUS','正在读取视频音频...');const audio=await task.client.readAsset(result.audio.assetId);await this.assertLive(task);
      if((msg.transcribeService||'aistudio')==='aistudio'){
      log('aistudio.start');
      status('STATUS','正在后台转写音频，完成后自动交给 ChatGPT...');
      const transcription=await d.sendAIStudio({...common,audio,duration:result.duration,attachments:[audio,...attachments]});
      srt=transcription?.transcript;
      if(!srt?.trim())throw new Error('AI Studio 未返回完整逐字稿，未发送到 ChatGPT');
      }else{
       srt=await d.transcribe(audio,common,status,task.controller.signal);
       if(!srt?.trim())throw new Error('音频转写结果为空，未发送到 ChatGPT');
      }
     }
    }
    if(srt){
     log('chatgpt.start');
     await this.assertLive(task);
     const name=(context.videoId+'_'+context.title).replace(/[\\/:*?"<>|]/g,'_').slice(0,160)+'.srt';
     const file={name,content:srt};
     await d.sendChatGPT({...common,file,attachments:[{name,mime:'text/plain',content:srt},...attachments]});
    }
    if(task.cancelled||this.tasks.get(tabId)!==task)throw new Error('视频处理已取消或被替代');
    localOutcome='success';log('task.completed');status('DONE','总结请求已发送给 ChatGPT。');return {ok:true,source:context,frameInfo:result.frameInfo};
   }catch(e){log('task.failed',{category:root.VidSiftDiagnostics?.category(e)||'operation_failed',errorName:e.name});status('ERROR',e.message);throw e;}
   finally{
    if(localAudio)try{await task.client?.finishLocalAudio?.(localAudio,task.cancelled?'cancelled':localOutcome);}catch{}
    if(localAudio)try{await d.finishLocalMedia?.(task,task.cancelled?'cancelled':localOutcome);}catch{}
    try{await task.client?.release(assets);}catch{}task.client?.close();
    if(this.tasks.get(tabId)===task){this.tasks.delete(tabId);d.unlock(tabId);}
   }
  }
  cancel(tabId,reason='已在扩展中取消当前视频任务'){
   const task=this.tasks.get(tabId);if(!task||task.cancelled)return false;task.cancelled=true;task.cancelReason=reason;task.controller.abort();task.client?.cancel();this.deps.cancelTarget(task);return true;
  }
 }
 root.VideoWorkflow=VideoWorkflow;if(typeof module!=='undefined')module.exports={VideoWorkflow};
})(globalThis);
