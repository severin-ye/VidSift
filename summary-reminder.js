(function(root){
 'use strict';
 function viewingMode(doc,win){
  if(doc.fullscreenElement||doc.webkitFullscreenElement)return true;
  if(doc.querySelector('ytd-watch-flexy[theater], ytd-watch-flexy[fullscreen]'))return true;
  if(doc.querySelector('.bpx-state-web, .bpx-state-fullscreen, .bilibili-player-mode-webfullscreen, .bilibili-player-mode-fullscreen'))return true;
  const videos=doc.querySelectorAll?[...doc.querySelectorAll('video')]:[doc.querySelector('video')];
  return videos.some(video=>{const r=video?.getBoundingClientRect();return !!r&&r.width>=win.innerWidth*.94&&r.height>=win.innerHeight*.75&&(r.top??0)<=win.innerHeight*.25&&(r.bottom??win.innerHeight)>=win.innerHeight*.75;});
 }
 if(typeof module!=='undefined')module.exports={viewingMode};
 if(typeof document==='undefined'||root.__vidsiftSummaryReminder)return;
 root.__vidsiftSummaryReminder=true;
 let host,shadow,button,panel,list,note,more,source,key='',epoch=0,loading=false,expanded=false,immersive=false,frame=0;
 let records=[],cursor=null,unknown=0,pending=0,error='',disabled=false,checked=0,total=0,lastRenderDiagnostic='';
 const modeObserver=new MutationObserver(()=>scheduleMode());
 const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-3-2H4zM13 7a3 3 0 0 1 3-3h5v15h-5a4 4 0 0 0-3 2"/></svg>';
 function mount(){
  if(host?.isConnected)return;
  host=document.createElement('div');host.id='vidsift-summary-reminder';host.style.cssText='position:fixed;right:24px;top:88px;z-index:2147483000;display:none';
  shadow=host.attachShadow({mode:'open'});shadow.innerHTML=`<style>
   :host{all:initial;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#24383f;font-size:13px;line-height:1.45;color-scheme:light}
   *{box-sizing:border-box}button{font:inherit;cursor:pointer;color:inherit}button:focus-visible{outline:3px solid #348273;outline-offset:3px}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
   .capsule{display:flex;align-items:center;gap:9px;padding:11px 15px;background:#fff;border:1px solid #d7e3df;border-radius:28px;box-shadow:0 5px 20px #1a3e4a20;color:#294f4b;white-space:nowrap}.capsule svg:first-child{color:#3b8074}.capsule:hover{background:#f4faf7}.chevron{width:13px;height:13px;margin-left:3px}
   [hidden]{display:none!important}.panel{width:330px;max-width:calc(100vw - 28px);padding:17px;background:#fff;border:1px solid #dde4e5;border-radius:13px;box-shadow:0 10px 35px #182e3c25}.head{display:flex;gap:9px;align-items:center}.symbol{width:29px;height:29px;background:#edf5f3;color:#317469;border-radius:8px;display:grid;place-items:center}.head strong{font-size:15px;flex:1;line-height:1.4}.close{border:0;background:transparent;font-size:21px;color:#687d7d;padding:0 4px;line-height:1.2}.sub{margin:6px 0 12px;color:#6a7b7c;font-size:11px}.records{max-height:min(300px,calc(100vh - 290px));overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.record{display:flex;gap:10px;align-items:center;width:100%;text-align:left;padding:12px 0;border:0;border-bottom:1px solid #edf0f1;background:#fff}.record:hover{background:#f4f8f6}.file{width:27px;height:32px;background:#f1f5f5;border-radius:5px;display:grid;place-items:center;color:#6a8588}.file svg{width:15px;height:15px}.info{flex:1;min-width:0}.title{font-size:12px;font-weight:650;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.time{display:block;font-size:10px;color:#71817f;margin-top:4px}.open{font-size:10px;color:#34786f;white-space:nowrap}.note{color:#756232;font-size:11px;margin:10px 0;line-height:1.6}.foot{display:flex;align-items:center;justify-content:space-between;margin-top:12px;gap:8px;color:#758784;font-size:9px}.refresh,.more{border:0;background:none;color:#34786f;padding:3px 0;font-size:11px;text-decoration:underline;text-underline-offset:3px}.more{display:block;margin:10px auto 0}.refresh:disabled,.more:disabled{opacity:.5;cursor:wait}.loading{opacity:.75}@media(max-width:600px){.panel{width:310px}.capsule{padding:10px 12px;font-size:12px}}
  </style><button class="capsule" aria-expanded="false" title="点击查看已核实完成的总结">${icon}<span class="count"></span><svg class="chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button><section class="panel" aria-label="已有视频总结" hidden><div class="head"><span class="symbol">${icon}</span><strong></strong><button class="close" aria-label="收起总结列表" title="收起">×</button></div><p class="sub">仅列出已核实生成完成的总结</p><div class="records"></div><p class="note" role="status"></p><button class="more" hidden>继续核验其余记录</button><div class="foot"><span>来自知行批注书库</span><button class="refresh">刷新核验</button></div></section>`;
  document.documentElement.append(host);button=shadow.querySelector('.capsule');panel=shadow.querySelector('.panel');list=shadow.querySelector('.records');note=shadow.querySelector('.note');more=shadow.querySelector('.more');
  button.addEventListener('click',()=>{expanded=true;render();shadow.querySelector('.close').focus();});shadow.querySelector('.close').addEventListener('click',()=>{expanded=false;render();button.focus();});
  shadow.querySelector('.refresh').addEventListener('click',()=>refresh(true,true));more.addEventListener('click',()=>load(cursor));
  shadow.addEventListener('keydown',e=>{if(e.key==='Escape'){expanded=false;render();button.focus();}});
 }
 function render(){
  mount();const visible=!disabled&&!!source&&!immersive&&(records.length>0||unknown>0||!!cursor||!!error||loading);
  host.style.display=visible?'block':'none';host.dataset.viewing=String(immersive);host.dataset.state=error?'error':unknown?'partial':loading?'loading':'ready';
  button.hidden=expanded;panel.hidden=!expanded;button.setAttribute('aria-expanded',String(expanded));
  const label=records.length?'已有 '+records.length+' 份总结':error||unknown?'总结尚未核实':loading?'正在核验已有总结':'还有记录待核验';
  shadow.querySelector('.count').textContent=label;shadow.querySelector('.head strong').textContent=label;
  list.replaceChildren();records.forEach((record,i)=>{const row=document.createElement('button');row.className='record';row.title=record.title;row.innerHTML='<span class="file">'+icon+'</span><span class="info"><span class="title"></span><span class="time"></span></span><span class="open">打开 ↗</span>';row.querySelector('.title').textContent='总结 '+(i+1)+(i===0?' · 最近保存':'');const date=new Date(record.createdAt);row.querySelector('.time').textContent=Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'保存时间未知';row.addEventListener('click',async()=>{try{const result=await chrome.runtime.sendMessage({type:'VIDSIFT_SUMMARY_OPEN',videoUrl:source.url,url:record.chatgptUrl});if(!result?.ok)throw Error(result?.error||'打开总结失败');}catch(e){error=e.message;render();}});list.append(row);});
  const messages=[];if(error)messages.push(error);if(unknown)messages.push('有 '+unknown+' 条记录暂时无法核实，未计入总结数量。');if(cursor)messages.push('已核验 '+checked+'/'+total+' 条保存记录；可继续核验其余记录。');if(loading)messages.push('正在核验对应对话，请稍候。');
  note.textContent=messages.join(' ');note.hidden=!messages.length;more.hidden=!cursor;more.disabled=loading;shadow.querySelector('.refresh').disabled=loading;
  const signature=[key,visible,immersive,expanded,records.length,!!error].join('|');
  if(signature!==lastRenderDiagnostic){lastRenderDiagnostic=signature;const rect=host.getBoundingClientRect(),shown=visible&&rect.width>0&&rect.height>0&&getComputedStyle(host).visibility!=='hidden';chrome.runtime.sendMessage({type:'VIDSIFT_SUMMARIES_VIEW_STATE',ready:shown,active:!immersive,state:visible&&!shown?'blocked':immersive?'watching':expanded?'expanded':'folded',count:records.length}).catch(()=>{});}
 }
 function observeMode(){
  modeObserver.disconnect();const watched=new Set([document.documentElement,document.body,document.querySelector('ytd-watch-flexy')]);for(const video of document.querySelectorAll('video')){const rect=video.getBoundingClientRect();if(rect.bottom<0||rect.top>window.innerHeight)continue;let node=video;for(let i=0;node&&i<14;i++,node=node.parentElement)watched.add(node);}
  for(const node of watched)if(node)modeObserver.observe(node,{attributes:true,attributeFilter:['class','style','theater','fullscreen','full-bleed-player']});scheduleMode();
 }
 function scheduleMode(){if(frame)return;frame=requestAnimationFrame(()=>{frame=0;const next=viewingMode(document,window);if(next)expanded=false;immersive=next;if(host)render();});}
 async function load(nextCursor=null,restarted=false){
  if(loading||!source)return;loading=true;const ticket=epoch,video=source.url;render();
  try{
   const result=await chrome.runtime.sendMessage({type:'VIDSIFT_SUMMARIES_QUERY',videoUrl:video,cursor:nextCursor});
   if(ticket!==epoch||VidSiftPlatforms.identify(location.href)?.key!==key)return;
   if(!result?.ok){if(result?.code==='LIST_CHANGED'&&!restarted){records=[];checked=0;unknown=0;pending=0;cursor=null;loading=false;await load(null,true);return;}throw Error(result?.error||'已有总结暂时无法核验');}
   disabled=!!result.disabled;const ids=new Set(records.map(r=>r.id));for(const record of result.records||[])if(!ids.has(record.id)){records.push(record);ids.add(record.id);}
   cursor=result.nextCursor;unknown+=result.unknown||0;pending+=result.pending||0;checked+=result.checked||0;total=result.totalCandidates||0;error=result.verificationMessage||'';
  }catch(e){if(ticket===epoch)error=e.message;}
  finally{if(ticket===epoch){loading=false;render();}}
 }
 function refresh(force=false,keepOpen=false){
  const next=VidSiftPlatforms.identify(location.href),nextKey=next?.key||'';
  if(nextKey===key&&(!force||loading))return;
  const retainedOpen=keepOpen&&expanded;epoch++;key=nextKey;source=next;records=[];cursor=null;checked=0;total=0;unknown=0;pending=0;error='';disabled=false;expanded=retainedOpen;loading=false;observeMode();
  immersive=viewingMode(document,window);if(!source){if(host)host.style.display='none';return;}if(document.visibilityState==='hidden')return;void load();
 }
 chrome.runtime.onMessage.addListener(message=>{if(message.type==='VIDSIFT_SUMMARIES_REFRESH')refresh(true);});
 chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.videoLibrarySettings)refresh(true);});
 document.addEventListener('fullscreenchange',scheduleMode);document.addEventListener('webkitfullscreenchange',scheduleMode);window.addEventListener('resize',scheduleMode,{passive:true});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh(true);});window.addEventListener('popstate',()=>refresh());window.addEventListener('hashchange',()=>refresh());window.addEventListener('yt-navigate-finish',()=>refresh());
 const discovery=new MutationObserver(changes=>{if(changes.some(change=>[...change.addedNodes,...change.removedNodes].some(node=>node.nodeType===1&&(node.matches?.('video,ytd-watch-flexy')||node.querySelector?.('video')))))observeMode();});
 if(document.body)discovery.observe(document.body,{childList:true,subtree:true});
 window.addEventListener('pagehide',()=>{epoch++;modeObserver.disconnect();discovery.disconnect();if(frame)cancelAnimationFrame(frame);},{once:true});
 refresh(true);
})(globalThis);
