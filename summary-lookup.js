(function(root){
 'use strict';
 async function completedPage({source,config,external,verify,cursor=null}){
  if(!config.enabled||config.reminderEnabled===false)return {ok:true,disabled:true,records:[],nextCursor:null};
  const lib=root.VidSiftVideoLibrary||(typeof require==='function'?require('./video-library.js'):null),video=lib.normalizeSource(source);
  const hello=await external(config.extensionId,{type:'ZHIXING_VIDSIFT_HELLO'});
  if(!hello?.ok||!hello.capabilities?.includes('list-video-v1'))throw Error('请更新知行批注书库后查询已有总结');
  const result=await external(config.extensionId,{type:'ZHIXING_VIDSIFT_LIST_VIDEO',version:1,videoUrl:video.url,limit:10,...(cursor?{cursor}:{})});
  if(!result?.ok)throw Object.assign(Error(result?.error||'书库读取失败，结果尚未确认'),{code:result?.code});
  if(!Array.isArray(result.records)||result.records.length>10||!Number.isSafeInteger(result.total)||result.total<result.records.length||(result.nextCursor!==null&&typeof result.nextCursor!=='string'))throw Error('书库查询结果格式无效');
  const seen=new Set(),records=result.records.map(record=>{
   if(!record||typeof record.id!=='string'||seen.has(record.id)||lib.conversationUrl(record.chatgptUrl)!==record.chatgptUrl||record.chatgptUrl.split('/').at(-1)!==record.id||lib.normalizeSource({url:record.videoUrl}).url!==video.url)throw Error('书库视频或对话身份不匹配');
   seen.add(record.id);return {id:record.id,title:String(record.title||video.title).slice(0,500),videoUrl:video.url,chatgptUrl:record.chatgptUrl,createdAt:record.createdAt,updatedAt:record.updatedAt};
  });
  const proofs=records.length?await verify(records.map(r=>r.id)):[],byId=new Map(proofs.map(p=>[p.conversationId,p]));
  const fresh=await external(config.extensionId,{type:'ZHIXING_VIDSIFT_LIST_VIDEO',version:1,videoUrl:video.url,limit:10,...(cursor?{cursor}:{})});
  if(!fresh?.ok||JSON.stringify(fresh.records)!==JSON.stringify(result.records)||fresh.total!==result.total)throw Object.assign(Error('视频总结记录已变化，请重新核验'),{code:'LIST_CHANGED'});
  let pending=0,unknown=0,verificationMessage='';const completed=[];
  for(const record of records){const proof=byId.get(record.id);if(proof?.status==='completed')completed.push(record);else if(proof?.status==='pending')pending++;else {unknown++;verificationMessage||=proof?.reason||'部分总结暂时无法核实，请确认ChatGPT已登录后刷新核验';}}
  return {ok:true,records:completed,checked:records.length,pending,unknown,verificationMessage,totalCandidates:result.total,nextCursor:result.nextCursor,basis:'local-projection'};
 }
 const api={completedPage};root.VidSiftSummaryLookup=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
