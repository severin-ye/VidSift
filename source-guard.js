(function(root){
 'use strict';
 class SourceGuard{
  constructor(getTab,identify){this.getTab=getTab;this.identify=identify;this.tasks=new Map();this.counter=0;}
  begin(tabId,url){
   if(!Number.isInteger(tabId)||tabId<0)throw new Error('视频来源标签页缺失或无效，请重新打开源视频页面后重试');
   const source=this.identify(url);if(!source)throw new Error('视频来源无效，请刷新源视频页面');
   const previous=this.tasks.get(tabId);if(previous)previous.cancelled=true;
   const task={id:'legacy_'+Date.now()+'_'+(++this.counter),tabId,source,cancelled:false};this.tasks.set(tabId,task);return task;
  }
  get(tabId,taskId){const task=this.tasks.get(tabId);if(taskId&&task?.id!==taskId)throw new Error('原视频任务已被替代，未发送旧转写结果');return task;}
  async check(task){
   if(!task||task.cancelled||this.tasks.get(task.tabId)!==task)throw new Error('视频任务已取消或被替代，未发送内容');
   const tab=await this.getTab(task.tabId);if(this.identify(tab.url||'')?.key!==task.source.key)throw new Error('源视频已切换，未发送旧视频内容');
   if(task.cancelled||this.tasks.get(task.tabId)!==task)throw new Error('视频任务已取消或被替代，未发送内容');
  }
  cancel(tabId){const task=this.tasks.get(tabId);if(task){task.cancelled=true;task.abort?.();}return task;}
  finish(task){if(this.tasks.get(task.tabId)===task)this.tasks.delete(task.tabId);}
 }
 root.SourceGuard=SourceGuard;if(typeof module!=='undefined')module.exports={SourceGuard};
})(globalThis);
