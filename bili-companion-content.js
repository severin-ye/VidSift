(async function(){
 'use strict';
 if(window.top!==window||globalThis.__vidsiftCompanionContent)return;
 globalThis.__vidsiftCompanionContent=true;
 const send=message=>chrome.runtime.sendMessage(message);
 let claim;try{claim=await send({type:'VIDSIFT_COMPANION_CLAIM'});}catch{return;}
 if(!claim?.ok)return;
 const source=claim.source;
 const matches=()=>{try{const u=new URL(location.href);return u.pathname.match(/^\/(?:zh-Han[st]\/)?video\/(BV\w+)\/?$/)?.[1]===source.videoId&&Math.max(1,parseInt(u.searchParams.get('p'),10)||1)===source.part;}catch{return false;}};
 let video=null,stopped=false,started=false,lastPosition=0,lastAdvance=Date.now(),lastReport=0,timer;
 const listeners=[];
 function listen(target,name,handler){target.addEventListener(name,handler,true);listeners.push(()=>target.removeEventListener(name,handler,true));}
 function detach(){clearInterval(timer);for(const remove of listeners)remove();}
 const release=message=>{if(message.type==='VIDSIFT_COMPANION_RELEASE'){stopped=true;detach();chrome.runtime.onMessage.removeListener(release);}};
 chrome.runtime.onMessage.addListener(release);
 async function report(){
  lastReport=Date.now();
  try{const response=await send({type:'VIDSIFT_COMPANION_EVENT',event:'progress',url:location.href,position:video.currentTime,duration:video.duration});if(!response?.ok&&!stopped){stopped=true;detach();video.pause();}}catch{if(!stopped){stopped=true;detach();video.pause();}}
 }
 async function finish(event,reason){
  if(stopped)return;stopped=true;detach();
  // Pause synchronously before official continuous-play handlers can advance.
  if(video&&event!=='left')video.pause();
  if(event==='ended')document.addEventListener('play',event=>event.target.pause(),true);
  try{await send({type:'VIDSIFT_COMPANION_EVENT',event,reason,url:location.href,position:video?.currentTime||0,duration:video?.duration||0});}catch{}
 }
 async function attach(found){
  video=found;video.muted=true;video.playbackRate=1;
  listen(video,'ended',()=>finish('ended','播放器已结束'));
  listen(video,'error',()=>finish('failed','官方播放器加载失败'));
  listen(video,'pause',()=>{if(started&&!video.ended)finish('paused','播放已暂停，不自动恢复');});
  listen(video,'volumechange',()=>{if(!stopped)video.muted=true;});
  listen(video,'ratechange',()=>{if(!stopped&&video.playbackRate!==1)video.playbackRate=1;});
  try{
   if(video.readyState===0)await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{clean();reject(new Error('metadata timeout'));},30000);
    const loaded=()=>{clean();resolve();};const clean=()=>{clearTimeout(timeout);video.removeEventListener('loadedmetadata',loaded);};
    video.addEventListener('loadedmetadata',loaded,{once:true});
   });
   if(stopped||!matches())return;
   video.currentTime=0;await video.play();
   if(stopped){video.pause();return;}started=true;lastAdvance=Date.now();await report();
  }catch{await finish('failed','官方播放器未能开始播放（可能需要登录或用户操作）');}
 }
 listen(window,'pagehide',()=>{stopped=true;detach();});
 timer=setInterval(async()=>{
  if(stopped)return;
  if(!matches()){await finish('left','伴播页已离开当前视频');return;}
  if(!video){
   const found=document.querySelector('video');
   if(found)attach(found);
   else if(Date.now()-lastAdvance>60000)await finish('failed','未找到官方视频播放器');
   return;
  }
  if(document.querySelector('video')!==video){await finish('failed','官方播放器已更换，停止当前伴播');return;}
  if(Date.now()-lastAdvance>90000){await finish('failed','官方播放器长时间没有播放进度');return;}
  if(!started)return;
  if(video.currentTime>lastPosition+0.2){lastPosition=video.currentTime;lastAdvance=Date.now();}
  if(lastReport&&Date.now()-lastReport<10000)return;
  await report();
 },1000);
})();
