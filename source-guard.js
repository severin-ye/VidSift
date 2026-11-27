(function(root){
 'use strict';
 class SourceGuard{
  constructor(getTab,identify,resolveSource){this.getTab=getTab;this.identify=identify;this.resolveSource=resolveSource;this.tasks=new Map();this.counter=0;}
  begin(tabId,url,admission){
   if(!Number.isInteger(tabId)||tabId<0)throw new Error('视频来源标签页缺失或无效，请重新打开源视频页面后重试');
   const source=this.identify(url);if(!source)throw new Error('视频来源无效，请刷新源视频页面');
   const taskKey=admission?.taskKey??tabId;
   const previous=this.tasks.get(taskKey);if(previous)previous.cancelled=true;
   const task={id:'legacy_'+Date.now()+'_'+(++this.counter),tabId,taskKey,source,cancelled:false,sourceLocked:admission?.sourceLocked===true};this.tasks.set(taskKey,task);return task;
  }
  get(tabId,taskId){const task=this.tasks.get(tabId);if(taskId&&task?.id!==taskId)throw new Error('原视频任务已被替代，未发送旧转写结果');return task;}
  async check(task){
   if(!task||task.cancelled||this.tasks.get(task.taskKey)!==task)throw new Error('视频任务已取消或被替代，未发送内容');
   if(!task.sourceClosed&&!task.sourceLocked){
    let tab;
    try{tab=await this.getTab(task.tabId);}catch(e){
     if(!/No tab with id\b|标签页不存在|不存在的标签页/i.test(String(e?.message||e)))throw e;
     task.sourceClosed=true;
    }
    if(task.cancelled||this.tasks.get(task.taskKey)!==task)throw new Error('视频任务已取消或被替代，未发送内容');
    if(!task.sourceClosed){const now=task.source.frameUrl&&this.resolveSource?await this.resolveSource(tab):this.identify(tab.url||'');if(now?.key!==task.source.key||task.source.frameUrl&&now?.frameId!==task.source.frameId)throw new Error('源视频已切换，未发送旧视频内容');}
   }
   if(task.cancelled||this.tasks.get(task.taskKey)!==task)throw new Error('视频任务已取消或被替代，未发送内容');
  }
  cancel(tabId){const task=this.tasks.get(tabId);if(task){task.cancelled=true;task.abort?.();}return task;}
   finish(task){if(this.tasks.get(task.taskKey)===task)this.tasks.delete(task.taskKey);}
 }
 root.SourceGuard=SourceGuard;if(typeof module!=='undefined')module.exports={SourceGuard};
})(globalThis);
