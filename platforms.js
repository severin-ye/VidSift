(function(root){
 'use strict';
 function identify(value){
  let u;try{u=new URL(value);}catch{return null;}
  if(!['https:','http:'].includes(u.protocol))return null;
  const host=u.hostname.toLowerCase();let platform,id,part=1;
  if(host==='www.bilibili.com'||host==='bilibili.com'){
   id=u.pathname.match(/^\/video\/(BV\w+)/)?.[1]||u.searchParams.get('bvid');
   if(!id||!/^BV\w+$/.test(id))return null;
   platform='bilibili';part=Math.max(1,parseInt(u.searchParams.get('p'),10)||1);
  }else if(['www.youtube.com','youtube.com','m.youtube.com','youtu.be'].includes(host)){
   id=host==='youtu.be'?u.pathname.split('/')[1]:u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
   if(!/^[\w-]{11}$/.test(id||''))return null;platform='youtube';
  }else if(['www.douyin.com','douyin.com','v.douyin.com'].includes(host)){
   id=u.pathname.match(/\/video\/(\d+)/)?.[1]||u.searchParams.get('modal_id')||u.searchParams.get('aweme_id');
   if(!id&&host==='v.douyin.com')id=u.pathname.replace(/\//g,'');
   if(!id)return null;platform='douyin';
  }else return null;
  return {platform,videoId:id,part,key:`${platform}:${id}${platform==='bilibili'?':'+part:''}`,url:u.href};
 }
 function srtTime(value){
  if(!Number.isFinite(value)||value<0)throw new Error('字幕时间无效');
  const ms=Math.round(value*1000),sec=Math.floor(ms/1000);
  return `${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor(sec/60)%60).padStart(2,'0')}:${String(sec%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;
 }
 function toSrt(body){
  if(!Array.isArray(body))throw new Error('字幕数据无效');
  return body.map((s,i)=>{if(!Number.isFinite(s.to)||s.to<s.from)throw new Error('字幕结束时间无效');return `${i+1}\n${srtTime(s.from)} --> ${srtTime(s.to)}\n${String(s.content||'')}`;}).join('\n\n');
 }
 async function readTranscription(response,notify=()=>{}){
  if(!response.ok)throw new Error(`转写服务请求失败：HTTP ${response.status}`);
  if(!response.body)throw new Error('转写服务未返回响应内容');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result='';
  function event(block){
   let type='',data=[];for(const line of block.split(/\r?\n/)){
    if(line.startsWith('event:'))type=line.slice(6).trim();
    if(line.startsWith('data:'))data.push(line.slice(5).replace(/^ /,''));
   }
   if(!data.length)return;let payload;try{payload=JSON.parse(data.join('\n'));}catch{payload={text:data.join('\n')};}
   if(type==='error')throw new Error(payload.error||payload.message||'转写服务返回错误');
   if(type==='result')result=payload.srt||payload.text||'';
   else if(payload.text||payload.message)notify('STATUS',payload.text||payload.message);
  }
  try{
   while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let match;
    while((match=/\r?\n\r?\n/.exec(buffer))){event(buffer.slice(0,match.index));buffer=buffer.slice(match.index+match[0].length);}
    if(done)break;
   }
   if(buffer.trim())event(buffer);
   if(!String(result).trim())throw new Error('转写服务未返回有效字幕结果');return result;
  }finally{reader.releaseLock();}
 }
 const api={identify,srtTime,toSrt,readTranscription};root.VidSiftPlatforms=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
