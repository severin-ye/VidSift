(function(root){
 'use strict';
 const KEY='vidsiftLocalMedia';
 class LocalMediaCache{
  constructor(storage){this.storage=storage;this.queue=Promise.resolve();}
  _update(fn){const work=this.queue.catch(()=>{}).then(async()=>{const raw=(await this.storage.get(KEY))[KEY]||{};const state={...raw};const result=await fn(state);await this.storage.set({[KEY]:state});return result;});this.queue=work.catch(()=>{});return work;}
  async load(task,pageSource){
   const saved=(await this.storage.get(KEY))[KEY]?.[task.source.key];
   if(!saved||saved.expiresAt<=Date.now()||saved.result?.videoId!==task.source.videoId||!saved.result.localAudio||typeof task.client.prepareLocalAudio!=='function')return null;
   if(Number.isFinite(pageSource?.duration)&&Math.abs(pageSource.duration-saved.result.duration)>2)return null;
   try{
    const localAudio=await task.client.prepareLocalAudio(saved.result.localAudio,task.source.videoId);
    if(localAudio.videoId!==task.source.videoId||localAudio.fingerprint!==saved.result.localAudio.fingerprint||Math.abs(localAudio.duration-saved.result.duration)>2)return null;
    task.localMediaSettings=saved.settings;return {...saved.result,localAudio,audio:null,subtitle:null,images:[],frameInfo:{mode:'disabled',frameCount:0,collageCount:0}};
   }catch(error){if(task.cancelled||task.controller?.signal.aborted)throw error;return null;}
  }
  save(task,result,settings={}){
   if(!result.localAudio)return Promise.resolve();task.localMediaSettings=settings;
   const value={platform:result.platform,videoId:result.videoId,title:result.title||result.videoId,duration:result.duration,coverUrl:result.coverUrl||'',localAudio:result.localAudio,audioInfo:result.audioInfo,subtitleStatus:result.subtitleStatus};
   return this._update(state=>{state[task.source.key]={result:value,settings:{failureTtlHours:settings.failureTtlHours??24,successTtlHours:settings.successTtlHours??1},expiresAt:Date.now()+(settings.failureTtlHours??24)*3600000,updatedAt:Date.now()};const keys=Object.keys(state).sort((a,b)=>state[b].updatedAt-state[a].updatedAt);for(const key of keys.slice(20))delete state[key];});
  }
  finish(task,status){return this._update(state=>{const entry=state[task.source.key];if(!entry)return;const hours=status==='success'?entry.settings.successTtlHours:entry.settings.failureTtlHours;entry.expiresAt=Date.now()+hours*3600000;entry.updatedAt=Date.now();entry.status=status;});}
 }
 root.LocalMediaCache=LocalMediaCache;if(typeof module!=='undefined')module.exports={LocalMediaCache};
})(globalThis);
