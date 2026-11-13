'use strict';
// Query only the current video's metadata, then verify its saved conversations.
const _summaryQueries=new Map(),_summaryTabJobs=new Map();let _summaryReader=null,_summarySlots=0;const _summaryWaiters=[];
function takeSummarySlot(valid){if(!valid())return Promise.resolve(false);if(_summarySlots<2){_summarySlots++;return Promise.resolve(true);}return new Promise(resolve=>_summaryWaiters.push({valid,resolve}));}
function releaseSummarySlot(){while(_summaryWaiters.length){const next=_summaryWaiters.shift();if(next.valid()){next.resolve(true);return;}next.resolve(false);}_summarySlots--;}
function cancelSummaryJob(tabId){const job=_summaryTabJobs.get(tabId);if(job)job.valid=false;_summaryTabJobs.delete(tabId);for(let i=_summaryWaiters.length-1;i>=0;i--)if(!_summaryWaiters[i].valid()){_summaryWaiters[i].resolve(false);_summaryWaiters.splice(i,1);}}
function summaryDeadline(promise,ms=12000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('已有总结核验超时，请稍后重试')),ms);})]).finally(()=>clearTimeout(timer));}
function connectSummaryReader(tab){
 return new Promise((resolve,reject)=>{
  let settled=false,busy=false,again=false;
  const timer=setTimeout(()=>finish(Object.assign(Error('ChatGPT核验入口尚未就绪，请确认页面可访问后刷新核验'),{code:'READER_NOT_READY'})),18000);
  function finish(error){if(settled)return;settled=true;clearTimeout(timer);chrome.tabs.onUpdated.removeListener(updated);error?reject(error):resolve();}
  async function attempt(){
   if(settled)return;if(busy){again=true;return;}busy=true;let current;
   try{
    current=await chrome.tabs.get(tab.id);if(!/^https:\/\/chatgpt\.com\//.test(current?.url||''))return;
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['summary-verification.js','summary-verifier-content.js'],injectImmediately:true});
    if(settled)return;
    const ping=await summaryDeadline(chrome.tabs.sendMessage(tab.id,{type:'VIDSIFT_SUMMARY_READER_PING'}));
    if(!ping?.ok)throw Error('ChatGPT只读核验入口未就绪');finish();
   }catch(error){if(current?.status==='complete')finish(Object.assign(error,{code:error.code||'READER_CONNECT_FAILED'}));}
   finally{busy=false;if(again){again=false;void attempt();}}
  }
  function updated(id,change){if(id===tab.id&&(change.url||change.status))void attempt();}
  chrome.tabs.onUpdated.addListener(updated);void attempt();
 });
}
async function closeOwnedSummaryReader(reader){
 try{if(reader.owned&&reader.tabId!=null){const current=await chrome.tabs.get(reader.tabId).catch(()=>null);if(current?.active||current&&!/^https:\/\/chatgpt\.com\/?$/.test(current.url||''))reader.everUsed=true;if(current&&!reader.everUsed)await chrome.tabs.remove(reader.tabId).catch(()=>{});}}
 finally{reader.dispose?.();}
}
async function createSummaryReader(){
  const tabs=await chrome.tabs.query({url:['https://chatgpt.com/*']});
  let tab=tabs.find(t=>!new URL(t.url).searchParams.has('temporary-chat'));
  const reader={tabId:tab?.id,owned:!tab,everUsed:false,users:0,closing:false},activatedBeforeCreate=new Set();
  const activated=info=>{if(reader.tabId==null)activatedBeforeCreate.add(info.tabId);else if(info.tabId===reader.tabId)reader.everUsed=true;};
  const navigated=(id,change)=>{if(id===reader.tabId&&change.url&&!/^https:\/\/chatgpt\.com\/?$/.test(change.url))reader.everUsed=true;};
  if(reader.owned){chrome.tabs.onActivated.addListener(activated);chrome.tabs.onUpdated.addListener(navigated);reader.dispose=()=>{chrome.tabs.onActivated.removeListener(activated);chrome.tabs.onUpdated.removeListener(navigated);};}
  try{
   if(!tab){tab=await chrome.tabs.create({url:'https://chatgpt.com/',active:false});reader.tabId=tab.id;reader.everUsed=tab.active||activatedBeforeCreate.has(tab.id);}
   await connectSummaryReader(tab);
   return reader;
  }catch(error){await closeOwnedSummaryReader(reader);throw error;}
}
async function acquireSummaryReader(){
 if(!_summaryReader){const entry={promise:null};_summaryReader=entry;entry.promise=createSummaryReader().catch(error=>{if(_summaryReader===entry)_summaryReader=null;throw error;});}
 const entry=_summaryReader,reader=await entry.promise;
 if(reader.closing){await reader.closed;return acquireSummaryReader();}
 reader.entry=entry;reader.users++;return reader;
}
async function releaseSummaryReader(reader){
 reader.users--;if(reader.users)return;
 reader.closing=true;reader.closed=closeOwnedSummaryReader(reader).finally(()=>{if(_summaryReader===reader.entry)_summaryReader=null;});await reader.closed;
}
async function verifySummaryIds(ids,valid=()=>true){
 if(!valid())throw Error('视频已切换，已取消旧总结核验');
 const reader=await acquireSummaryReader();const results=new Array(ids.length);let index=0;
 try{await Promise.all(Array.from({length:Math.min(2,ids.length)},async()=>{while(index<ids.length&&valid()){const i=index++,id=ids[i];if(!await takeSummarySlot(valid))return;try{if(!valid())return;const proof=await summaryDeadline(chrome.tabs.sendMessage(reader.tabId,{type:'VIDSIFT_VERIFY_SAVED_SUMMARY',id}),18000);results[i]=proof?.ok?proof:{status:'unknown',conversationId:id,reason:proof?.error||'ChatGPT核验入口未响应'};}catch{results[i]={status:'unknown',conversationId:id,reason:'对应总结对话核验超时，请稍后刷新'};}finally{releaseSummarySlot();}}}));if(!valid())throw Error('视频已切换，已取消旧总结核验');return results.filter(Boolean);}
 finally{await releaseSummaryReader(reader);}
}
function summarySenderSource(sender){
 if(sender.id!==chrome.runtime.id||!sender.tab||!sender.url)throw Error('已有总结查询仅允许当前视频页面');
 return VidSiftVideoLibrary.normalizeSource({url:sender.url});
}
function summaryDiagnosticId(tabId,video){const part=video.platform==='bilibili'?new URL(video.url).searchParams.get('p')||1:1;return 'reminder_'+tabId+'_'+video.videoId+'_'+part;}
async function summaryPage(message,sender){
 const source=summarySenderSource(sender),actual=VidSiftVideoLibrary.normalizeSource({url:(await chrome.tabs.get(sender.tab.id)).url});
 if(source.url!==actual.url||VidSiftVideoLibrary.normalizeSource({url:message.videoUrl}).url!==actual.url)throw Error('视频已切换，已丢弃旧总结查询');
 const config=await _videoLibrary.getSettings(),key=sender.tab.id+'|'+source.url+'|'+(message.cursor||'');
 if(_summaryQueries.has(key))return _summaryQueries.get(key);
 const diagnosticId=summaryDiagnosticId(sender.tab.id,source);await _diagnostics.begin(diagnosticId,{sourceTabId:sender.tab.id,platform:source.platform,videoId:source.videoId});await _diagnostics.record(diagnosticId,'library.reminder_queried',{state:'querying'});
 if(VidSiftVideoLibrary.normalizeSource({url:(await chrome.tabs.get(sender.tab.id)).url}).url!==source.url)throw Error('视频已切换，已取消旧总结查询');
 cancelSummaryJob(sender.tab.id);const job={valid:true,source:source.url};_summaryTabJobs.set(sender.tab.id,job);
 const run=VidSiftSummaryLookup.completedPage({source,config,cursor:message.cursor,external:(id,msg)=>{if(!job.valid)throw Error('视频已切换，已取消旧总结查询');return summaryDeadline(chrome.runtime.sendMessage(id,msg),6000);},verify:ids=>verifySummaryIds(ids,()=>job.valid)});
 _summaryQueries.set(key,run);try{const result=await run;if(!job.valid)throw Error('视频已切换，已丢弃旧总结结果');await _diagnostics.record(diagnosticId,'library.reminder_result',{state:result.disabled?'disabled':result.records.length?'completed':result.unknown?'unknown':result.pending?'pending':'no_candidates',count:result.records.length,checkedCount:result.checked||0,pendingCount:result.pending||0,unknownCount:result.unknown||0,candidateCount:result.totalCandidates||0});return result;}catch(error){await _diagnostics.record(diagnosticId,'library.reminder_failed',{state:'failed',reason:error.code||'lookup_failed'});throw error;}finally{if(_summaryQueries.get(key)===run)_summaryQueries.delete(key);if(_summaryTabJobs.get(sender.tab.id)===job)_summaryTabJobs.delete(sender.tab.id);}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.type==='VIDSIFT_SUMMARIES_VIEW_STATE'){
  (async()=>{const source=summarySenderSource(sender),id=summaryDiagnosticId(sender.tab.id,source);await _diagnostics.begin(id,{sourceTabId:sender.tab.id,platform:source.platform,videoId:source.videoId});await _diagnostics.record(id,'library.reminder_view',{ready:message.ready===true,active:message.active===true,state:['watching','expanded','folded','blocked'].includes(message.state)?message.state:'unknown',count:Number.isSafeInteger(message.count)&&message.count>=0?message.count:0});})().catch(()=>{});reply({ok:true});return false;
 }
 if(message.type==='VIDSIFT_SUMMARIES_QUERY'){
  if(message.cursor!=null&&(typeof message.cursor!=='string'||message.cursor.length>2048)){reply({ok:false,error:'总结分页身份无效'});return false;}
  summaryPage(message,sender).then(reply,error=>reply({ok:false,error:error.message,code:error.code}));return true;
 }
 if(message.type==='VIDSIFT_SUMMARY_OPEN'){
  (async()=>{summarySenderSource(sender);const source=VidSiftVideoLibrary.normalizeSource({url:message.videoUrl}),current=VidSiftVideoLibrary.normalizeSource({url:(await chrome.tabs.get(sender.tab.id)).url});if(source.url!==current.url)throw Error('视频已切换');const url=VidSiftVideoLibrary.conversationUrl(message.url);if(!url)throw Error('总结链接无效');await chrome.tabs.create({url,active:true});return {ok:true};})().then(reply,error=>reply({ok:false,error:error.message}));return true;
 }
 if(message.type==='VIDSIFT_TARGET_DONE'&&message.ok===true&&sender.tab&&/^https:\/\/chatgpt\.com\//.test(sender.url||'')){
  chrome.tabs.query({}).then(tabs=>Promise.all(tabs.filter(t=>VidSiftPlatforms.identify(t.url)).map(t=>chrome.tabs.sendMessage(t.id,{type:'VIDSIFT_SUMMARIES_REFRESH'}).catch(()=>{})))).catch(()=>{});
 }
});
chrome.tabs.onUpdated.addListener((id,change,tab)=>{if(change.url){const job=_summaryTabJobs.get(id);try{if(job&&VidSiftVideoLibrary.normalizeSource({url:change.url}).url!==job.source)cancelSummaryJob(id);}catch{cancelSummaryJob(id);}}if(change.url||change.status==='complete'){const video=VidSiftPlatforms.identify(change.url||tab?.url);if(!video)return;const diagnosticId=summaryDiagnosticId(id,video);_diagnostics.begin(diagnosticId,{sourceTabId:id,platform:video.platform,videoId:video.videoId}).then(()=>_diagnostics.record(diagnosticId,'library.reminder_source',{state:'observed'})).catch(()=>{});chrome.tabs.sendMessage(id,{type:'VIDSIFT_SUMMARIES_REFRESH'}).catch(()=>{});}});
chrome.tabs.onRemoved.addListener(cancelSummaryJob);
