'use strict';
(function(){
 const $=id=>document.getElementById(id),status=$('douyinLocalStatus');
 const fields={model:['douyinModel',1],device:['douyinDevice',1],threads:['douyinThreads',1],maxDuration:['douyinMaxMinutes',60],maxSourceBytes:['douyinMaxBytes',1048576],cacheBytes:['douyinCacheBytes',1048576],memoryBudgetMiB:['douyinMemory',1],failureTtlHours:['douyinFailureHours',1],successTtlHours:['douyinSuccessHours',1]};
 function visibility(){const service=$('douyinService').value;for(const e of document.querySelectorAll('[data-local-only]'))e.hidden=service!=='local';for(const e of document.querySelectorAll('[data-groq-only]'))e.hidden=service!=='groq';}
 function show(service,settings,groq=DouyinLocalSettings.groqDefaults){$('douyinService').value=service;for(const[key,[id,unit]]of Object.entries(fields))$(id).value=['model','device'].includes(key)?settings[key]:settings[key]/unit;$('groqModel').value=groq.model;$('groqTimeout').value=groq.timeoutSeconds;visibility();}
 function read(){return Object.fromEntries(Object.entries(fields).map(([key,[id,unit]])=>[key,['model','device'].includes(key)?$(id).value:Number($(id).value)*unit]));}
 $('douyinLocalSave').addEventListener('click',async()=>{try{await DouyinLocalSettings.save(chrome.storage.local,$('douyinService').value,read(),{model:$('groqModel').value,timeoutSeconds:Number($('groqTimeout').value)});status.textContent='已保存，下次新任务生效';}catch(e){status.textContent='抖音设置未保存：'+e.message;}});
 $('douyinLocalReset').addEventListener('click',async()=>{try{const defaults=await DouyinLocalSettings.restore(chrome.storage.local);show('groq',defaults);status.textContent='本块已恢复默认，其他设置和草稿保留';}catch(e){status.textContent='抖音设置恢复失败：'+e.message;}});
 $('douyinService').addEventListener('change',visibility);
 $('groqCheck').addEventListener('click',async()=>{try{const r=await chrome.runtime.sendMessage({type:'VIDSIFT_GROQ_STATUS'});$('groqStatus').textContent=r.ok?(r.configured?'已读取本机密钥，下次任务可用；此检测不会上传音频':'未找到 Groq API Key，请点击“填写 API Key”'):('检测失败：'+(r.error||'本机程序未响应'));}catch(e){$('groqStatus').textContent='检测失败：'+e.message;}});
 $('groqConfigure').addEventListener('click',async()=>{const button=$('groqConfigure');button.disabled=true;try{const r=await chrome.runtime.sendMessage({type:'VIDSIFT_GROQ_CONFIGURE'});$('groqStatus').textContent=r.ok?'本机已配置 Groq API Key，下次任务可用':('配置未完成：'+(r.error||'本机程序未响应'));}catch(e){$('groqStatus').textContent='配置未完成：'+e.message;}finally{button.disabled=false;}});
 chrome.storage.local.get(['douyinTranscribeService','douyinLocalSettings','groqSettings']).then(value=>show(value.douyinTranscribeService||'groq',DouyinLocalSettings.normalize(value.douyinLocalSettings),DouyinLocalSettings.normalizeGroq(value.groqSettings))).catch(e=>{status.textContent='抖音设置读取失败：'+e.message;});
})();
