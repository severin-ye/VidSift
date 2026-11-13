'use strict';
// Query only the current video's metadata, then verify its saved conversations.
const _summaryQueries=new Map(),_summaryTabJobs=new Map();let _summaryReader=null,_summarySlots=0;const _summaryWaiters=[];
function takeSummarySlot(valid){if(!valid())return Promise.resolve(false);if(_summarySlots<2){_summarySlots++;return Promise.resolve(true);}return new Promise(resolve=>_summaryWaiters.push({valid,resolve}));}
function releaseSummarySlot(){while(_summaryWaiters.length){const next=_summaryWaiters.shift();if(next.valid()){next.resolve(true);return;}next.resolve(false);}_summarySlots--;}
function cancelSummaryJob(tabId){const job=_summaryTabJobs.get(tabId);if(job)job.valid=false;_summaryTabJobs.delete(tabId);for(let i=_summaryWaiters.length-1;i>=0;i--)if(!_summaryWaiters[i].valid()){_summaryWaiters[i].resolve(false);_summaryWaiters.splice(i,1);}}
function summaryDeadline(promise,ms=12000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('已有总结核验超时，请稍后重试')),ms);})]).finally(()=>clearTimeout(timer));}
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
   if(tab.status!=='complete')await new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(Error('ChatGPT核验页尚未就绪')),18000);const listener=(id,change)=>{if(id===tab.id&&change.status==='complete')finish();};function finish(error){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);error?reject(error):resolve();}chrome.tabs.onUpdated.addListener(listener);chrome.tabs.get(tab.id).then(t=>{if(t.status==='complete')finish();},finish);});
   await chrome.scripting.executeScript({target:{tabId:tab.id},files:['summary-verification.js','summary-verifier-content.js']});
   const ping=await summaryDeadline(chrome.tabs.sendMessage(tab.id,{type:'VIDSIFT_SUMMARY_READER_PING'}));if(!ping?.ok)throw Error('ChatGPT只读核验入口未就绪');
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
async function summaryPage(message,sender){
 const source=summarySenderSource(sender),actual=VidSiftVideoLibrary.normalizeSource({url:(await chrome.tabs.get(sender.tab.id)).url});
 if(source.url!==actual.url||VidSiftVideoLibrary.normalizeSource({url:message.videoUrl}).url!==actual.url)throw Error('视频已切换，已丢弃旧总结查询');
 const config=await _videoLibrary.getSettings(),key=sender.tab.id+'|'+source.url+'|'+(message.cursor||'');
 if(_summaryQueries.has(key))return _summaryQueries.get(key);
 cancelSummaryJob(sender.tab.id);const job={valid:true,source:source.url};_summaryTabJobs.set(sender.tab.id,job);
 const run=VidSiftSummaryLookup.completedPage({source,config,cursor:message.cursor,external:(id,msg)=>{if(!job.valid)throw Error('视频已切换，已取消旧总结查询');return summaryDeadline(chrome.runtime.sendMessage(id,msg),6000);},verify:ids=>verifySummaryIds(ids,()=>job.valid)});
 _summaryQueries.set(key,run);try{const result=await run;if(!job.valid)throw Error('视频已切换，已丢弃旧总结结果');return result;}finally{if(_summaryQueries.get(key)===run)_summaryQueries.delete(key);if(_summaryTabJobs.get(sender.tab.id)===job)_summaryTabJobs.delete(sender.tab.id);}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
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
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url){const job=_summaryTabJobs.get(id);try{if(job&&VidSiftVideoLibrary.normalizeSource({url:change.url}).url!==job.source)cancelSummaryJob(id);}catch{cancelSummaryJob(id);}}if(change.url||change.status==='complete')chrome.tabs.sendMessage(id,{type:'VIDSIFT_SUMMARIES_REFRESH'}).catch(()=>{});});
chrome.tabs.onRemoved.addListener(cancelSummaryJob);
