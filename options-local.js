'use strict';
(function(){
 const $=id=>document.getElementById(id),status=$('douyinLocalStatus');
 const fields={model:['douyinModel',1],device:['douyinDevice',1],threads:['douyinThreads',1],maxDuration:['douyinMaxMinutes',60],maxSourceBytes:['douyinMaxBytes',1048576],cacheBytes:['douyinCacheBytes',1048576],memoryBudgetMiB:['douyinMemory',1],failureTtlHours:['douyinFailureHours',1],successTtlHours:['douyinSuccessHours',1]};
 function show(service,settings){$('douyinService').value=service;for(const[key,[id,unit]]of Object.entries(fields))$(id).value=['model','device'].includes(key)?settings[key]:settings[key]/unit;}
 function read(){return Object.fromEntries(Object.entries(fields).map(([key,[id,unit]])=>[key,['model','device'].includes(key)?$(id).value:Number($(id).value)*unit]));}
 $('douyinLocalSave').addEventListener('click',async()=>{try{await DouyinLocalSettings.save(chrome.storage.local,$('douyinService').value,read());status.textContent='已保存，下次新任务生效';}catch(e){status.textContent='抖音设置未保存：'+e.message;}});
 $('douyinLocalReset').addEventListener('click',async()=>{try{const defaults=await DouyinLocalSettings.restore(chrome.storage.local);show('local',defaults);status.textContent='本块已恢复默认，其他设置和草稿保留';}catch(e){status.textContent='抖音设置恢复失败：'+e.message;}});
 chrome.storage.local.get(['douyinTranscribeService','douyinLocalSettings']).then(value=>show(value.douyinTranscribeService||'local',DouyinLocalSettings.normalize(value.douyinLocalSettings))).catch(e=>{status.textContent='抖音设置读取失败：'+e.message;});
})();
