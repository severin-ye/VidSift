(function(root){
 'use strict';
 const SETTINGS_KEY='videoLibrarySettings',STATE_KEY='videoLibraryState';
 const DEFAULTS={enabled:true,reminderEnabled:true,extensionId:'ajjcbhalcgpmelnmlnheefbfikdgmjdp'};
 const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
 function settings(value={}){return {enabled:value?.enabled!==false,reminderEnabled:value?.reminderEnabled!==false,extensionId:/^[a-p]{32}$/.test(value?.extensionId||'')?value.extensionId:DEFAULTS.extensionId};}
 function conversationUrl(value){
  try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.username||u.password||u.port||u.searchParams.get('temporary-chat')==='true')return null;
   if(!new RegExp('^/(?:g/[^/]+/)?c/'+UUID+'/?$','i').test(u.pathname))return null;return u.origin+u.pathname.replace(/\/$/,'');
  }catch{return null;}
 }
 function normalizeSource(source){
  const u=new URL(source.url||source.videoUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)throw Error('视频来源链接无效');
  let platform,videoId,url;
  if(['bilibili.com','www.bilibili.com'].includes(u.hostname)){
   videoId=u.pathname.match(/^\/video\/(BV\w+)/)?.[1]||u.searchParams.get('bvid');if(!/^BV\w+$/.test(videoId||''))throw Error('B站视频身份无效');
   platform='bilibili';const part=Math.max(1,parseInt(u.searchParams.get('p'),10)||1);url='https://www.bilibili.com/video/'+videoId+(part>1?'?p='+part:'');
  }else if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(u.hostname)){
   videoId=u.hostname==='youtu.be'?u.pathname.split('/')[1]:u.searchParams.get('v')||u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
   if(!/^[\w-]{11}$/.test(videoId||''))throw Error('YouTube视频身份无效');platform='youtube';url='https://www.youtube.com/watch?v='+videoId;
  }else if(['www.douyin.com','douyin.com'].includes(u.hostname)){
   videoId=u.pathname.match(/\/video\/(\d+)/)?.[1]||u.searchParams.get('modal_id')||u.searchParams.get('aweme_id');
   if(!/^\d+$/.test(videoId||''))throw Error('抖音视频身份无效');platform='douyin';url='https://www.douyin.com/video/'+videoId;
  }else throw Error('视频来源不是支持的平台');
  return {platform,videoId,url,title:String(source.title||videoId).slice(0,500),coverUrl:String(source.coverUrl||'')};
 }
 function makeRecord(source,chatgptUrl,{now=Date.now}={}){
  const chat=conversationUrl(chatgptUrl);if(!chat)throw Error('没有可回访的ChatGPT对话链接');const video=normalizeSource(source),at=new Date(now()).toISOString();
  return {id:chat.split('/').at(-1).toLowerCase(),title:video.title,videoUrl:video.url,chatgptUrl:chat,platform:video.platform,videoId:video.videoId,coverDataUrl:'',coverUrl:video.coverUrl,createdAt:at,updatedAt:at};
 }
 function allowedCover(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['hdslb.com','ytimg.com','ggpht.com','douyinpic.com','douyincdn.com','byteimg.com','ibytedtos.com','pstatp.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d));}catch{return false;}
 }
 function normalizeCover(value){
  try{const u=new URL(value);if(u.protocol==='http:')u.protocol='https:';return allowedCover(u.href)?u.href:'';}catch{return '';}
 }
 async function downloadCover(url,fetcher=root.fetch){
  if(!allowedCover(url))throw Error('封面来源不在视频平台图片范围内');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);let reader;
  try{
   const response=await fetcher(url,{credentials:'omit',redirect:'error',signal:controller.signal});
   if(!response.ok||response.url&&!allowedCover(response.url))throw Error('视频封面下载失败');
   const mime=(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
   if(!['image/jpeg','image/png','image/webp'].includes(mime))throw Error('封面不是支持的图片类型');
   if(Number(response.headers.get('content-length'))>192*1024)throw Error('视频封面超过192KiB');
   let data;
   if(response.body?.getReader){reader=response.body.getReader();const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>192*1024)throw Error('视频封面超过192KiB');chunks.push(value);}data=new Uint8Array(size);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}}
   else data=new Uint8Array(await response.arrayBuffer());
   if(!data.length||data.length>192*1024)throw Error('视频封面为空或超过192KiB');
   const signature=mime==='image/png'?data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71:mime==='image/jpeg'?data[0]===255&&data[1]===216&&data[2]===255:data.length>12&&String.fromCharCode(...data.slice(0,4))==='RIFF'&&String.fromCharCode(...data.slice(8,12))==='WEBP';
   if(!signature)throw Error('视频封面内容与图片类型不符');
   let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
   return 'data:'+mime+';base64,'+btoa(binary);
  }finally{clearTimeout(timer);if(reader)try{await reader.cancel();}catch{}}
 }
 function deadline(promise,ms=6000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('书库接收等待超时，已保留待保存记录')),ms);})]).finally(()=>clearTimeout(timer));}
 class VideoLibraryBridge{
  constructor(api,{cover=downloadCover,now=Date.now,onError=()=>{}}={}){this.api=api;this.cover=cover;this.now=now;this.onError=onError;this.serial=Promise.resolve();this.draining=null;}
  async read(){const state=(await this.api.storage.local.get(STATE_KEY))[STATE_KEY]||{version:1,tasks:[],pending:[],message:'尚无视频总结保存记录'};if(!state.covers)state.covers=[];return state;}
  mutate(fn){const run=this.serial.then(async()=>{const state=await this.read();const result=await fn(state);await this.api.storage.local.set({[STATE_KEY]:state});return result;});this.serial=run.catch(()=>{});return run;}
  async status(){const state=await this.read();return {pending:state.pending.length+state.covers.length,unsaved:state.pending.length,coverPending:state.covers.length,waiting:state.tasks.filter(t=>t.sent).length,message:state.message,lastSavedAt:state.lastSavedAt||null};}
  async register({taskId,tabId,source,tempChat}){
   if(tempChat||!(await this.getSettings()).enabled)return;
   const checked=normalizeSource(source);
   await this.mutate(s=>{if(s.tasks.some(t=>t.taskId===taskId))return;if(s.tasks.length>=50)throw Error('视频书库待处理记录已达上限，请先在设置中重试保存');s.tasks.push({taskId,tabId,source:checked,createdAt:new Date(this.now()).toISOString(),sent:false});});
  }
  async getSettings(){return settings((await this.api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);}
  async abandon(taskId){return this.mutate(s=>{s.tasks=s.tasks.filter(t=>t.taskId!==taskId||t.sent);});}
  async submitted(taskId,sender){
   let task=await this.mutate(s=>{const t=s.tasks.find(t=>t.taskId===taskId&&t.tabId===sender.tab?.id);if(t){t.sent=true;t.sentAt=t.sentAt||this.now();s.message='已发送总结请求，正在等待可回访的ChatGPT链接';return structuredClone(t);}});
   if(task?.chatgptUrl)await this.queue(task,task.chatgptUrl);
  }
  async confirmed(taskId,sender,url){
   const canonical=conversationUrl(url);if(!canonical)return;
   const task=await this.mutate(s=>{const t=s.tasks.find(t=>t.taskId===taskId&&t.tabId===sender.tab?.id);if(t){t.chatgptUrl=canonical;return structuredClone(t);}});
   if(task?.sent)await this.queue(task,canonical);
  }
  async queue(task,url){
   const record=makeRecord(task.source,url,{now:this.now});record.createdAt=task.createdAt;
   await this.mutate(s=>{const current=s.tasks.find(t=>t.taskId===task.taskId&&t.sent);if(!current)return;current.chatgptUrl=record.chatgptUrl;const existing=s.pending.find(p=>p.id===record.id);if(!existing&&s.pending.length>=20){s.message='视频书库待保存记录已满，请在设置中重试；当前链接仍已保留';return;}if(!existing)s.pending.push(record);s.tasks=s.tasks.filter(t=>t.taskId!==task.taskId);s.message='视频总结信息已在本地排队，等待知行批注书库接收';});
  }
  drain(){if(this.draining)return this.draining;this.draining=this.deliver().finally(()=>{this.draining=null;});return this.draining;}
  async deliver(){
   const config=await this.getSettings();if(!config.enabled)return this.status();
   for(const task of (await this.read()).tasks.filter(t=>t.sent&&t.chatgptUrl))await this.queue(task,task.chatgptUrl);
   const state=await this.read();if(!state.pending.length&&!state.covers.length)return this.status();
   try{
    const hello=await deadline(this.api.runtime.sendMessage(config.extensionId,{type:'ZHIXING_VIDSIFT_HELLO'}));
    if(!hello?.ok||hello.protocol!=='zhixing-video-library'||hello.version!==1)throw Error('知行批注书库尚未支持视频入库，请更新后重试');
    const unsaved=state.pending.slice(0,state.covers.length?4:5),supplements=state.covers.slice(0,5-unsaved.length);
    for(const original of [...unsaved,...supplements]){
     const record={...original};if(record.coverUrl&&!record.coverDataUrl)try{record.coverDataUrl=await this.cover(record.coverUrl);}catch{}
     const alreadySaved=supplements.some(p=>p.id===record.id);
     if(alreadySaved&&!record.coverDataUrl){await this.mutate(s=>{s.covers=s.covers.filter(p=>p.id!==record.id);s.covers.push(record);s.message='视频链接已保存，部分封面仍未取得；补图不会阻断新卡片保存';});continue;}
     const result=await deadline(this.api.runtime.sendMessage(config.extensionId,{type:'ZHIXING_VIDSIFT_SAVE_VIDEO',version:1,record}));
     if(!result?.ok||result.id!==record.id)throw Error(result?.error||'知行批注书库未确认保存，记录仍保留待重试');
     await this.mutate(s=>{s.pending=s.pending.filter(p=>p.id!==record.id);s.covers=s.covers.filter(p=>p.id!==record.id);let detail='';if(!record.coverDataUrl&&record.coverUrl){if(s.covers.length<20){s.covers.push(record);detail='；封面待补齐，不影响其他卡片保存';}else detail='；封面暂缺，补图待办已达20条，本条未排入补图';}else if(!record.coverDataUrl)detail='；页面未提供可用封面地址，本条显示封面暂缺';s.lastSavedAt=new Date(this.now()).toISOString();s.message='视频和ChatGPT链接已在知行批注书库本地保存'+(record.coverDataUrl?'，封面已保存':detail);});
    }
   }catch(e){await this.mutate(s=>{s.message='视频总结尚未保存到知行批注书库：'+String(e.message).slice(0,300)+'；已保留待办，可在设置中重试';});try{await this.onError(e);}catch{}}
   return this.status();
  }
 }
 const api={DEFAULTS,SETTINGS_KEY,STATE_KEY,settings,conversationUrl,normalizeSource,makeRecord,allowedCover,normalizeCover,downloadCover,VideoLibraryBridge};root.VidSiftVideoLibrary=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
