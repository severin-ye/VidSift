// Serialized into the current page's MAIN world. Return only the selected
// public video's metadata/resource; never return general page/account state.
function DouyinPageSource(expectedId){
 'use strict';
 const url=new URL(location.href),routeId=url.searchParams.get('modal_id')||url.searchParams.get('aweme_id')||url.pathname.match(/\/video\/(\d+)/)?.[1];
 if(routeId!==expectedId)return null;
 const domains=['douyinvod.com','douyin.com','zjcdn.com','bytecdn.cn','ibytedtos.com','byteimg.com','pstatp.com'];
 function allowed(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}}
 function candidate(item){
  if(String(item.aweme_id??item.awemeId??item.id)!==expectedId)return null;
  const video=item.video||item.videoModel||item.videoInfo;if(!video||typeof video!=='object')return null;
  const addresses=[video.play_addr,video.playAddr,video.download_addr,video.downloadAddr,...(Array.isArray(video.bit_rate)?video.bit_rate.map(b=>b.play_addr):[]),...(Array.isArray(video.bitRateList)?video.bitRateList.map(b=>b.playAddr):[])];
  const media=addresses.flatMap(a=>Array.isArray(a)?a.flatMap(v=>typeof v==='string'?[v]:[v?.src,v?.url]):a?.url_list||a?.urlList||[]).filter(u=>typeof u==='string'&&u.length<8192).map(u=>u.startsWith('//')?'https:'+u:u).find(allowed);
  const duration=Number(video.duration??item.duration)/1000;
  if(!media||!Number.isFinite(duration)||duration<=0)return null;
  // This list belongs to the selected video's playback data; music.play_url
  // is a different object and must never be used as the narration source.
  const audio=(Array.isArray(video.bitRateAudioList)?video.bitRateAudioList:[]).slice().sort((a,b)=>(Number(a.bitrate)||Infinity)-(Number(b.bitrate)||Infinity)).flatMap(a=>Array.isArray(a.urlList)?a.urlList.map(u=>typeof u==='string'?u:u?.src||u?.url):[]).filter(u=>typeof u==='string'&&u.length<8192).map(u=>u.startsWith('//')?'https:'+u:u).find(allowed);
  return {platform:'douyin',videoId:expectedId,title:String(item.desc||item.item_title||item.title||('抖音视频 '+expectedId)).slice(0,512),duration,douyin:{videoId:expectedId,videoUrl:media,...(audio?{audioUrl:audio}:{})}};
 }
 const roots=[];let videoOnly=null;
 for(const key of ['_ROUTER_DATA','__INITIAL_STATE__','_SSR_DATA','RENDER_DATA']){try{if(window[key]&&typeof window[key]==='object')roots.push(window[key]);}catch{}}
 let chars=0;
 for(const script of Array.from(document.querySelectorAll('script')).slice(0,40)){
  const raw=(script.textContent||'').trim();chars+=raw.length;if(chars>8*1024*1024)break;if(!raw)continue;
  for(const encoded of [false,true]){
   try{const text=(encoded?decodeURIComponent(raw):raw).replace(/^window\._ROUTER_DATA\s*=\s*/,'').replace(/;\s*$/,'');roots.push(JSON.parse(text));break;}catch{}
  }
 }
 for(const video of Array.from(document.querySelectorAll('video')).slice(0,12)){
  // The player creates its video element imperatively; React owns its wrapper.
  try{let element=video;for(let level=0;element&&level<12;level++,element=element.parentElement){const key=Object.keys(element).find(k=>k.startsWith('__reactFiber$'));if(!key)continue;let fiber=element[key];for(let n=0;fiber&&n<20;n++,fiber=fiber.return){if(fiber.memoizedProps)roots.push(fiber.memoizedProps);}break;}}catch{}
 }
 // Inspect the player's own DTO before walking unrelated React children.
 for(const props of roots){try{for(const item of [props,props.item,props.awemeInfo,props.originAwemeInfo,props.xgplayerConfig?.awemeInfo,props.baseConfig?.awemeInfo]){if(item&&typeof item==='object'){const result=candidate(item);if(result?.douyin.audioUrl)return result;if(result&&!videoOnly)videoOnly=result;}}}catch{}}
 const seen=new WeakSet(),stack=roots.reverse().map(value=>({value,depth:0})),deadline=Date.now()+150;let count=0;
 while(stack.length&&count++<20000&&Date.now()<deadline){
  const {value,depth}=stack.pop();if(!value||typeof value!=='object'||seen.has(value)||depth>12)continue;seen.add(value);
  try{const result=candidate(value);if(result?.douyin.audioUrl)return result;if(result&&!videoOnly)videoOnly=result;for(const key of Object.keys(value).slice(0,160)){if(['stateNode','alternate','dependencies'].includes(key))continue;const child=value[key];if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});}}catch{}
 }
 return videoOnly;
}
globalThis.DouyinPageSource=DouyinPageSource;
if(typeof module!=='undefined')module.exports={DouyinPageSource};
