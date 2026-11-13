(function(root){
 'use strict';
 const SESSION='biliCompanionSession', ALARM='vidsift-bili-companion';
 function sourceOf(value){
  if(!value||value.platform!=='bilibili'||!/^BV\w+$/.test(value.videoId||''))return null;
  const part=Math.max(1,Number.parseInt(value.part,10)||1);
  return {platform:'bilibili',videoId:value.videoId,part,key:`bilibili:${value.videoId}:${part}`,url:`https://www.bilibili.com/video/${value.videoId}?p=${part}`,title:String(value.title||'').slice(0,300)};
 }
 function matches(url,source){
  try{const u=new URL(url);return u.protocol==='https:'&&['www.bilibili.com','bilibili.com'].includes(u.hostname)&&u.pathname.match(/^\/(?:zh-Han[st]\/)?video\/(BV\w+)\/?$/)?.[1]===source.videoId&&Math.max(1,parseInt(u.searchParams.get('p'),10)||1)===source.part;}catch{return false;}
 }
 class BiliCompanion {
  constructor(chrome){
   this.chrome=chrome;this.enabled=true;this.queue=[];this.current=null;this.last=null;this.pendingStops=0;this.tail=Promise.resolve();
   this.ready=this._hydrate();
  }
  _serial(fn){const next=this.tail.then(()=>this.ready).then(fn);this.tail=next.catch(()=>{});return next;}
  async _hydrate(){
   const local=await this.chrome.storage.local.get(['biliCompanionEnabled','biliCompanionLast']);
   this.enabled=local.biliCompanionEnabled!==false;this.last=local.biliCompanionLast||null;
   const saved=(await this.chrome.storage.session.get(SESSION))[SESSION];
   if(saved){this.queue=(saved.queue||[]).filter(x=>sourceOf(x.source)).slice(0,50);this.current=saved.current||null;}
   if(this.current){
    let tab;try{tab=await this.chrome.tabs.get(this.current.tabId);}catch{}
    if(!this.enabled||!tab||tab.active||!matches(tab.url,this.current.source)){
     this.last={state:'stopped',reason:'恢复时伴播页已关闭、离开视频或由用户接管',historyConfirmed:false};this.current=null;
    }
   }
   if(!this.enabled)this.queue=[];
   await this._persist();await this._start();
  }
  async _persist(){
   await this.chrome.storage.session.set({[SESSION]:{queue:this.queue,current:this.current}});
   await this.chrome.storage.local.set({biliCompanionLast:this.last});
   if(this.current&&this.chrome.alarms)await this.chrome.alarms.create(ALARM,{when:Math.max(Date.now()+1000,this.current.deadline)});
   else if(this.chrome.alarms)await this.chrome.alarms.clear(ALARM);
  }
  _status(){return {enabled:this.enabled,current:this.current?{...this.current,source:{...this.current.source}}:null,queued:this.queue.length,last:this.last?{...this.last}:null,historyConfirmed:false};}
  status(){return this._serial(()=>this._status());}
  enqueue(source,options={}){return this._serial(async()=>{
   const normalized=sourceOf(source);
   if(!normalized)return {ok:false,reason:'仅支持有效的B站视频'};
   if(!this.enabled)return {ok:false,reason:'总结伴播已关闭'};
   if(this.current?.source.key===normalized.key||this.queue.some(x=>x.source.key===normalized.key))return {ok:true,duplicate:true,...this._status()};
   if(this.queue.length+(this.current?1:0)>=50)return {ok:false,reason:'总结伴播队列已满（50项）'};
   this.queue.push({source:normalized,taskId:String(options.taskId||'').slice(0,150)});
   await this._persist();await this._start();return {ok:true,...this._status()};
  });}
  async _start(){
   while(this.enabled&&!this.pendingStops&&!this.current&&this.queue.length){
    const item=this.queue.shift();let tab;
    try{
     tab=await this.chrome.tabs.create({url:'about:blank',active:false});
     this.current={...item,tabId:tab.id,state:'loading',deadline:Date.now()+120000,position:0,historyConfirmed:false};
     // Persist ownership before navigation: only this tab may claim playback.
     await this._persist();
     await this.chrome.tabs.update(tab.id,{muted:true,autoDiscardable:false});
     await this.chrome.tabs.update(tab.id,{url:item.source.url});
     await this._persist();return;
    }catch(error){
     this.current=null;this.last={state:'failed',reason:`伴播页创建失败：${error.message||error}`,historyConfirmed:false};
     if(tab)try{await this.chrome.tabs.remove(tab.id);}catch{}
     await this._persist();
    }
   }
  }
  async _finish(state,reason,close=true){
   const old=this.current;if(!old)return;
   this.current=null;this.last={state,reason,historyConfirmed:false};
   await this._persist();
   if(close)try{await this.chrome.tabs.remove(old.tabId);}catch{}
   else if(this.chrome.tabs.sendMessage)try{await this.chrome.tabs.sendMessage(old.tabId,{type:'VIDSIFT_COMPANION_RELEASE'});}catch{}
   await this._start();
  }
  stopAll(){this.pendingStops++;return this._serial(async()=>{try{this.queue=[];await this._finish('stopped','已停止全部总结伴播');await this._persist();return {ok:true,...this._status()};}finally{this.pendingStops--;}});}
  setEnabled(enabled){if(!enabled)this.pendingStops++;return this._serial(async()=>{try{
   this.enabled=!!enabled;await this.chrome.storage.local.set({biliCompanionEnabled:this.enabled});
   if(!this.enabled){this.queue=[];await this._finish('stopped','总结伴播已关闭');}
   await this._persist();return {ok:true,...this._status()};
   }finally{if(!enabled)this.pendingStops--;}
  });}
  handleMessage(message,sender){return this._serial(async()=>{
   const current=this.current;
   if(!current||sender?.id!==this.chrome.runtime.id||sender.frameId!==0||sender.tab?.id!==current.tabId||!matches(sender.url,current.source)||!matches(sender.tab.url,current.source))return {ok:false,reason:'非当前总结伴播页'};
   let tab;try{tab=await this.chrome.tabs.get(current.tabId);}catch{}
   if(!tab||tab.active||!matches(tab.url,current.source)){
    await this._finish('stopped','伴播页已由用户接管或离开视频',false);return {ok:false};
   }
   if(message.type==='VIDSIFT_COMPANION_CLAIM')return {ok:true,source:current.source};
   if(message.type!=='VIDSIFT_COMPANION_EVENT'||!matches(message.url,current.source))return {ok:false};
   const event=message.event;
   if(event==='ended'){
    const duration=Number(message.duration),position=Number(message.position);
    if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(position)||position<duration-1)return {ok:false,reason:'播放器结束证据无效'};
    // Content has already paused and blocked subsequent play events. Leave the
    // official page alive briefly for its own ended reporting before closing.
    current.state='ending';await this._persist();
    await new Promise(resolve=>setTimeout(resolve,1500));
    await this._finish('player-ended','播放器已结束；B站历史记录未核验');
   }else if(['failed','paused','left'].includes(event))await this._finish(event==='failed'?'failed':'stopped',String(message.reason||event).slice(0,300),event==='failed');
   else if(event==='progress'){
    const position=Number(message.position);
    if(Number.isFinite(position)&&position>current.position+0.2){current.position=position;current.deadline=Date.now()+120000;current.state='playing';}
    await this._persist();
   }else return {ok:false};
   return {ok:true};
  });}
  onRemoved(tabId){return this._serial(async()=>{if(this.current?.tabId===tabId)await this._finish('stopped','伴播页已关闭',false);});}
  onActivated(info){return this._serial(async()=>{if(this.current?.tabId===info.tabId){let tab;try{tab=await this.chrome.tabs.get(info.tabId);}catch{}if(tab?.active)await this._finish('stopped','伴播页已由用户接管',false);}});}
  onUpdated(tabId,change,tab){return this._serial(async()=>{
   if(this.current?.tabId!==tabId)return;
   // Navigation events can be queued while create/mute/navigate runs. Re-read
   // the live tab so an old about:blank notification cannot cancel playback.
   let live;try{live=await this.chrome.tabs.get(tabId);}catch{return;}
   if(change.mutedInfo?.muted===false||live.mutedInfo?.muted===false){
    // Restore tab silence before handing the page back to the user.
    try{await this.chrome.tabs.update(tabId,{muted:true});}catch{}
    await this._finish('stopped','伴播页标签静音被解除，已恢复静音并停止自动控制',false);return;
   }
   // tabs.update resolves before the navigation commits: get() may still show
   // about:blank, with the intended URL only in pendingUrl (or not yet exposed).
   // Do not interpret that initial blank document as the user leaving the video.
   if(!live.active&&live.url==='about:blank'&&this.current.state==='loading'&&!this.current.reachedSource)return;
   if(matches(live.url,this.current.source))this.current.reachedSource=true;
   if(!matches(live.url,this.current.source)||live.active)await this._finish('stopped','伴播页已离开视频或由用户接管',false);
  });}
  onAlarm(alarm){return this._serial(async()=>{if(alarm.name===ALARM&&this.current){if(Date.now()>=this.current.deadline)await this._finish('failed','伴播页加载或播放停滞超时');else await this._persist();}});}
 }
 root.BiliCompanion=BiliCompanion;if(typeof module!=='undefined')module.exports=BiliCompanion;
})(globalThis);
