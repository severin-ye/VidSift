(function(root){
 'use strict';
 // This function is serialized into a page's MAIN world. Return only bounded
 // public video metadata, never React trees or general application state.
 function probe(){
  const u=new URL(location.href),host=u.hostname;
  const platform=['www.douyin.com','douyin.com'].includes(host)?'douyin':/^(?:(?:www|m)\.)?youtube\.com$/.test(host)||['www.youtube-nocookie.com','youtube-nocookie.com','youtu.be'].includes(host)?'youtube':['www.bilibili.com','bilibili.com','player.bilibili.com','space.bilibili.com','t.bilibili.com','m.bilibili.com'].includes(host)?'bilibili':null;
  if(!platform)return {url:u.href,platform:null};
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el),w=Math.max(0,Math.min(r.right,innerWidth)-Math.max(0,r.left)),h=Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(0,r.top));return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0&&w*h>=Math.min(6000,r.width*r.height*.25)&&w*h/(r.width*r.height)>=.25;};
  const frames=Array.from(document.querySelectorAll('iframe')).filter(visible).map(f=>{try{return new URL(f.src,u.href).href;}catch{return '';}}).filter(Boolean).slice(0,32);
  const videos=Array.from(document.querySelectorAll('video')).slice(0,64),shown=videos.filter(visible),playing=shown.filter(v=>!v.paused&&!v.ended),choices=playing.length?playing:shown;
  if(choices.length>1)return {platform,url:u.href,frames,error:'页面有多个可见播放器，请只保留要总结的视频播放后重试'};
  const selected=choices[0],videoIndex=selected?videos.indexOf(selected):-1;
  let routeId=platform==='douyin'?(u.pathname.match(/\/video\/(\d+)/)?.[1]||u.searchParams.get('modal_id')||u.searchParams.get('aweme_id')):platform==='youtube'?(u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1]||(host==='youtu.be'?u.pathname.split('/')[1]:null)):(u.pathname.match(/\/video\/(BV\w+)/)?.[1]||u.searchParams.get('bvid'));
  let id,part=Math.max(1,parseInt(u.searchParams.get('p'),10)||1),cid,title='',isLive=false;
  const dto=value=>{
   if(!value||typeof value!=='object')return false;
   if(platform==='douyin'){const candidate=value.aweme_id??value.awemeId; if(/^\d+$/.test(String(candidate||''))&&(value.video||value.videoModel||value.videoInfo)){id=String(candidate);title=String(value.desc||value.title||'');isLive=value.isLive===true||value.aweme_type===101;return true;}}
   if(platform==='bilibili'&&/^BV\w+$/.test(value.bvid||'')&&Number(value.cid)>0){id=value.bvid;cid=Number(value.cid);title=String(value.title||value.long_title||'');return true;}
   return false;
  };
  // The nearest player wrapper owns the selected item's DTO. Never walk its
  // children/list arrays, where previous and next feed items are retained.
  if(selected){let element=selected;for(let n=0;element&&n<10&&!id;n++,element=element.parentElement){
   const key=Object.keys(element).find(k=>k.startsWith('__reactFiber$'));let fiber=key&&element[key];
   for(let level=0;fiber&&level<8&&!id;level++,fiber=fiber.return){const p=fiber.memoizedProps;if(p?.isActive===false)continue;for(const v of [p,p?.item,p?.awemeInfo,p?.originAwemeInfo,p?.xgplayerConfig?.awemeInfo,p?.baseConfig?.awemeInfo])if(dto(v))break;}
   const vue=element.__vue__||element.__vueParentComponent?.proxy;for(const v of [vue?.$props,vue?.$data,element.__vueParentComponent?.props])if(dto(v))break;
  }}
  if(platform==='youtube'&&selected){const player=selected.closest('.html5-video-player')||document.getElementById('movie_player');if(player?.contains(selected)){try{const data=player.getVideoData?.(),details=player.getPlayerResponse?.()?.videoDetails;const current=data?.video_id||details?.videoId;if(/^[\w-]{11}$/.test(current||'')){id=current;title=String(data?.title||details?.title||'');isLive=details?.isLive===true;}}catch{}}}
  if(platform==='bilibili'&&selected&&!id){try{const current=window.player?.getVideoMessage?.();dto(current);}catch{}if(!id&&u.pathname.startsWith('/bangumi/play/')){const ep=window.__INITIAL_STATE__?.epInfo,epId=u.pathname.match(/\/ep(\d+)/)?.[1];if(epId&&String(ep?.id)===epId)dto(ep);}}
  id=id||routeId;
  if(platform==='youtube'&&!/^[\w-]{11}$/.test(id||''))id=null;
  if(platform==='douyin'&&!/^\d+$/.test(id||''))id=null;
  if(platform==='bilibili'&&!/^BV\w+$/.test(id||''))id=null;
  if(!id)return {platform,url:u.href,frames,visiblePlayers:shown.length,error:selected?'无法确认当前播放器的作品编号，请打开该作品后重试':undefined};
  let partKnown=!cid;
  if(platform==='bilibili'&&cid){const pages=window.__INITIAL_STATE__?.videoData?.pages;if(Array.isArray(pages)){const index=pages.findIndex(p=>Number(p.cid)===cid);if(index>=0){part=index+1;partKnown=true;}}}
  const canonical=platform==='douyin'?'https://www.douyin.com/video/'+id:platform==='youtube'?'https://www.youtube.com/watch?v='+id:'https://www.bilibili.com/video/'+id+(part>1?'?p='+part:'');
  return {platform,videoId:id,part,partKnown,key:platform+':'+id+(platform==='bilibili'?':'+part:''),url:canonical,pageUrl:u.href,videoIndex,frames,visiblePlayers:shown.length,playing:!!selected&&!selected.paused,isLive,...(cid?{cid}:{}),title:String(title||document.querySelector('h1')?.textContent||document.title).slice(0,512),...(Number.isFinite(selected?.duration)&&selected.duration>0?{duration:selected.duration}:{}),coverUrl:String(selected?.poster||document.querySelector('meta[property="og:image"]')?.content||'').slice(0,8192)};
 }
 const parts=new Map();
 async function discover(chrome,tab,options={}){
  const route=root.VidSiftPlatforms.identify(tab.url||'');
  let results;
  try{results=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},world:'MAIN',func:probe});}
  catch(error){if(/No tab with id\b|标签页不存在|不存在的标签页/i.test(String(error?.message||error)))throw error;throw new Error('无法读取当前播放器，请刷新页面并确认扩展具有该站点权限');}
  const top=results.find(r=>r.frameId===0)?.result;
  const visibleFrames=new Set(top?.frames||[]);
  const reachable=results.filter(r=>r.frameId===0||visibleFrames.has(r.result?.pageUrl||r.result?.url));
  const ambiguous=reachable.find(r=>r.result?.error&&r.result?.visiblePlayers!==0);
  if(ambiguous)throw new Error(ambiguous.result.error);
  const candidates=reachable.filter(r=>r.result?.videoId&&(r.result.visiblePlayers>0||r.frameId===0&&!top?.frames?.length));
  if(candidates.length>1)throw new Error('页面有多个可见播放器，请只保留要总结的视频播放后重试');
  let selected=candidates[0];
  if(!selected&&route&&!top?.visiblePlayers&&!top?.frames?.length)selected={frameId:0,result:{...route,pageUrl:tab.url,videoIndex:-1}};
  if(!selected)throw new Error(top?.error||'当前页面没有可确认的 B站、YouTube 或抖音播放器');
  const {frames,visiblePlayers,playing,error,...metadata}=selected.result;
  if(metadata.isLive)throw new Error('暂不支持直播或尚未开始的视频，请使用已发布的完整视频');
  const source={...metadata,frameId:selected.frameId,pageUrl:tab.url,frameUrl:metadata.pageUrl};
  if(source.platform==='bilibili'&&source.cid&&!source.partKnown){
   const cacheKey=source.videoId+':'+source.cid;let part=parts.get(cacheKey);
   if(!part){const response=await fetch('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(source.videoId),{credentials:'include',signal:AbortSignal.timeout(20000)}),data=await response.json();const index=data.code===0&&data.data?.bvid===source.videoId?data.data.pages?.findIndex(p=>Number(p.cid)===source.cid):-1;if(!(index>=0))throw new Error('无法确认当前B站播放器的分P，未选择其他分P');part=index+1;parts.set(cacheKey,part);if(parts.size>32)parts.delete(parts.keys().next().value);}
   source.part=part;source.key='bilibili:'+source.videoId+':'+part;source.url='https://www.bilibili.com/video/'+source.videoId+(part>1?'?p='+part:'');
  }
  let pageSource=null;
  if(source.platform==='douyin'&&options.capture!==false){
   await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[source.frameId]},world:'MAIN',files:['douyin-source.js']});
   const captured=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[source.frameId]},world:'MAIN',func:(id,index)=>globalThis.DouyinPageSource(id,{videoIndex:index,playerIdentity:true}),args:[source.videoId,source.videoIndex]});
   pageSource=captured[0]?.result||null;
   if(!pageSource&&source.videoIndex>=0&&!root.VidSiftPlatforms.identify(source.frameUrl))throw new Error('当前抖音播放器的完整作品信息尚未就绪，请稍后重试');
  }
  if(options.capture!==false){const checked=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[source.frameId]},world:'MAIN',func:probe});const now=checked[0]?.result;if(now?.videoId!==source.videoId||now?.cid!==source.cid||now?.error)throw new Error('源视频已切换，请重新打开扩展后总结当前视频');}
  return {source,pageSource};
 }
 const api={probe,discover};root.VidSiftCurrentVideo=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
