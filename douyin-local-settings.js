(function(root){
 'use strict';
 const MiB=1048576;
 const defaults=Object.freeze({model:'Xenova/whisper-small',device:'wasm',threads:4,maxDuration:3600,maxSourceBytes:512*MiB,cacheBytes:1024*MiB,failureTtlHours:24,successTtlHours:1,memoryBudgetMiB:6144});
 const models=Object.freeze({'Xenova/whisper-base':'64da57285918e20ea79ea5c88eed7197933abaa8','Xenova/whisper-small':'2d67713f236afa48a18992566e7647f6ca848e13'});
 const services=new Set(['global','local','aistudio','selfhosted']);
 function validate(value={}){
  const out={...defaults,...value};
  if(!Object.hasOwn(models,out.model))throw Error('抖音本地模型只能选择已验证的量化 base 或 small');
  if(!['wasm','webgpu'].includes(out.device))throw Error('抖音转写设备无效');
  for(const [key,min,max,label]of [['threads',1,8,'推理线程'],['maxDuration',60,21600,'视频时长'],['maxSourceBytes',MiB,4*1024*MiB,'来源文件大小'],['cacheBytes',64*MiB,20*1024*MiB,'任务缓存'],['failureTtlHours',1,168,'失败缓存保留时间'],['successTtlHours',0,48,'成功缓存保留时间'],['memoryBudgetMiB',512,8192,'启动内存预估上限']]){
   if(!Number.isSafeInteger(out[key])||out[key]<min||out[key]>max)throw Error(label+'超出允许范围');
  }
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,out[key]]));
 }
 function normalize(value){try{return validate(value||{});}catch{return {...defaults};}}
 function resolve(platform,stored={}){
  const globalService=stored.transcribeService||'aistudio';
  if(platform!=='douyin')return {service:globalService,model:stored.localModel||null,device:stored.localDevice||null};
  const choice=services.has(stored.douyinTranscribeService)?stored.douyinTranscribeService:'local';
  const settings=normalize(stored.douyinLocalSettings),service=choice==='global'?globalService:choice;
  return {service,model:choice==='global'?stored.localModel||settings.model:settings.model,device:choice==='global'?stored.localDevice||settings.device:settings.device,settings};
 }
 async function save(storage,service,value){
  if(!services.has(service))throw Error('抖音转写方式无效');const settings=validate(value);
  await storage.set({douyinTranscribeService:service,douyinLocalSettings:settings});return settings;
 }
 async function restore(storage){return save(storage,'local',defaults);}
 const api={defaults,models,validate,normalize,resolve,save,restore};root.DouyinLocalSettings=api;
 if(typeof module!=='undefined')module.exports=api;
})(globalThis);
