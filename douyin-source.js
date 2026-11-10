// Serialized into the current page's MAIN world. Return only the selected
// public video's metadata/resource; never return general page/account state.
function DouyinPageSource(expectedId){
 'use strict';
 const url=new URL(location.href),routeId=url.searchParams.get('modal_id')||url.searchParams.get('aweme_id')||url.pathname.match(/\/video\/(\d+)/)?.[1];
 if(routeId!==expectedId)return null;
 const domains=['douyinvod.com','douyin.com','zjcdn.com','bytecdn.cn','ibytedtos.com','byteimg.com','pstatp.com'];
 function allowed(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}}
 const audioCandidates=[],subtitleTracks=[],audioKeys=new Map();let inlineSubtitle=null;
 const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0?v:null;
 function collect(item,video,duration){
  for(const a of (Array.isArray(video.bitRateAudioList)?video.bitRateAudioList:[]).slice(0,12)){
   const urls=(Array.isArray(a.urlList)?a.urlList:[]).map(v=>typeof v==='string'?v:v?.src||v?.url).filter(v=>typeof v==='string'&&v.length<8192).map(v=>v.startsWith('//')?'https:'+v:v).filter(allowed).slice(0,3);
   if(!urls.length)continue;const size=positive(a.size),bitrate=positive(a.bitrate),key=String(a.fileHash||a.fileId||urls[0]);
   if(audioKeys.has(key)){const previous=audioKeys.get(key);previous.urls=[...new Set([...previous.urls,...urls])].slice(0,3);continue;}
   if(audioCandidates.length>=12)continue;
   const entry={urls,...(size?{size}:{}),...(bitrate?{bitrate}:{}),expectedBytes:size||(bitrate?bitrate*duration/8:null),sizeBasis:size?'metadata':bitrate?'estimate':'unknown'};audioCandidates.push(entry);audioKeys.set(key,entry);
  }
  const add=(value,ext,language)=>{if(subtitleTracks.length>=12||typeof value!=='string'||value.length>=8192)return;const u=value.startsWith('//')?'https:'+value:value;if(!allowed(u)||!['srt','vtt','json'].includes(ext))return;if(!subtitleTracks.some(t=>t.url===u))subtitleTracks.push({url:u,ext,language:String(language||'und').slice(0,32)});};
  const format=v=>({webvtt:'vtt',creator_caption:'json',srt:'srt',vtt:'vtt',json:'json'})[String(v||'').toLowerCase()];
  for(const t of (Array.isArray(video.subtitleInfos)?video.subtitleInfos:[]).slice(0,12))add(t.Url,format(t.Format),t.LanguageCodeName);
  for(const t of (Array.isArray(video.cla_info?.caption_infos)?video.cla_info.caption_infos:[]).slice(0,12))add(t.url,format(t.Format),t.lang);
  for(const sticker of (Array.isArray(item.interaction_stickers)?item.interaction_stickers:[]).slice(0,12))for(const t of (Array.isArray(sticker.auto_video_caption_info?.auto_captions)?sticker.auto_video_caption_info.auto_captions:[]).slice(0,12))for(const u of (t.url?.url_list||[]).slice(0,3))add(u,'json',t.language);
  const utterances=Array.isArray(video.utterances)?video.utterances:Array.isArray(item.utterances)?item.utterances:null;
  if(!inlineSubtitle&&utterances){const body=utterances.slice(0,10000).filter(t=>Number.isFinite(t.start_time)&&Number.isFinite(t.end_time)&&t.start_time>=0&&t.end_time>t.start_time&&typeof t.text==='string'&&t.text.trim()).map(t=>({from:t.start_time/1000,to:t.end_time/1000,content:t.text.slice(0,8192)}));if(body.length&&JSON.stringify(body).length<500000)inlineSubtitle={body,lan:'und'};}
 }
 function candidate(item){
  if(String(item.aweme_id??item.awemeId??item.id)!==expectedId)return null;
  const video=item.video||item.videoModel||item.videoInfo;if(!video||typeof video!=='object')return null;
  const addresses=[video.play_addr,video.playAddr,video.download_addr,video.downloadAddr,...(Array.isArray(video.bit_rate)?video.bit_rate.map(b=>b.play_addr):[]),...(Array.isArray(video.bitRateList)?video.bitRateList.map(b=>b.playAddr):[])];
  const media=addresses.flatMap(a=>Array.isArray(a)?a.flatMap(v=>typeof v==='string'?[v]:[v?.src,v?.url]):a?.url_list||a?.urlList||[]).filter(u=>typeof u==='string'&&u.length<8192).map(u=>u.startsWith('//')?'https:'+u:u).find(allowed);
  const duration=Number(video.duration??item.duration)/1000;
  if(!media||!Number.isFinite(duration)||duration<=0)return null;
  collect(item,video,duration);
  // This list belongs to the selected video's playback data; music.play_url
  // is a different object and must never be used as the narration source.
  const audio=(Array.isArray(video.bitRateAudioList)?video.bitRateAudioList:[]).slice().sort((a,b)=>(Number(a.bitrate)||Infinity)-(Number(b.bitrate)||Infinity)).flatMap(a=>Array.isArray(a.urlList)?a.urlList.map(u=>typeof u==='string'?u:u?.src||u?.url):[]).filter(u=>typeof u==='string'&&u.length<8192).map(u=>u.startsWith('//')?'https:'+u:u).find(allowed);
  const cover=[video.cover,video.origin_cover,video.originCover,video.coverUrl].flatMap(v=>typeof v==='string'?[v]:v?.url_list||v?.urlList||[]).find(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['douyinpic.com','douyincdn.com','byteimg.com','ibytedtos.com','pstatp.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}});
  return {platform:'douyin',videoId:expectedId,title:String(item.desc||item.item_title||item.title||('抖音视频 '+expectedId)).slice(0,512),duration,...(cover?{coverUrl:cover}:{}),douyin:{videoId:expectedId,videoUrl:media,...(audio?{audioUrl:audio}:{})}};
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
 for(const props of roots){try{for(const item of [props,props.item,props.awemeInfo,props.originAwemeInfo,props.xgplayerConfig?.awemeInfo,props.baseConfig?.awemeInfo]){if(item&&typeof item==='object'){const result=candidate(item);if(result&&!videoOnly)videoOnly=result;}}}catch{}}
 const seen=new WeakSet(),stack=roots.reverse().map(value=>({value,depth:0})),deadline=Date.now()+150;let count=0;
 while(stack.length&&count++<20000&&Date.now()<deadline){
  const {value,depth}=stack.pop();if(!value||typeof value!=='object'||seen.has(value)||depth>12)continue;seen.add(value);
  try{const result=candidate(value);if(result&&!videoOnly)videoOnly=result;for(const key of Object.keys(value).slice(0,160)){if(['stateNode','alternate','dependencies'].includes(key))continue;const child=value[key];if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});}}catch{}
 }
 if(videoOnly){audioCandidates.sort((a,b)=>(a.expectedBytes??Infinity)-(b.expectedBytes??Infinity));if(audioCandidates.length){videoOnly.douyin.audioCandidates=audioCandidates;videoOnly.douyin.audioUrl=audioCandidates[0].urls[0];}if(subtitleTracks.length)videoOnly.douyin.subtitleTracks=subtitleTracks;if(inlineSubtitle)videoOnly.subtitle=inlineSubtitle;videoOnly.douyin.subtitleProbeStatus=inlineSubtitle?'available':'unknown';}
 return videoOnly;
}
globalThis.DouyinPageSource=DouyinPageSource;
if(typeof module!=='undefined')module.exports={DouyinPageSource};
