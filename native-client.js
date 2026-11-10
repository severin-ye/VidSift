(function(root){
 'use strict';
 class NativeMediaClient{
  constructor(runtime=chrome.runtime){
   this.runtime=runtime;this.pending=new Map();this.counter=0;this.closed=false;
   try{this.port=runtime.connectNative('com.vidsift.media');}catch(e){throw new Error('本机媒体提取程序未就绪，请在设置页检查安装：'+e.message);}
   this.port.onMessage.addListener(msg=>this.receive(msg));
   this.port.onDisconnect.addListener(()=>{
    this.closed=true;const detail=runtime.lastError?.message;
    for(const p of this.pending.values())p.reject(new Error('本机媒体提取程序连接已断开'+(detail?'：'+detail:'，请检查设置页的安装状态')));
    this.pending.clear();
   });
  }
  receive(msg){
   const p=this.pending.get(msg?.id);if(!p)return;
   if(msg.type==='progress'){p.progress?.(msg.text);return;}
   if(msg.type==='chunk'){
    if(msg.sequence!==p.chunks.length){this.pending.delete(msg.id);p.reject(new Error('媒体分块顺序不正确'));return;}
    p.chunks.push(msg.data);return;
   }
   if(msg.type==='result'||msg.type==='error'){
    this.pending.delete(msg.id);
    if(msg.type==='error')p.reject(new Error(msg.error||'本机提取失败'));
    else p.resolve({result:msg.result,chunks:p.chunks});
   }
  }
  request(action,data={},progress){
   if(this.closed)return Promise.reject(new Error('本机媒体提取连接已关闭'));
   const id=`vs_${Date.now()}_${++this.counter}`;
   const promise=new Promise((resolve,reject)=>{
    this.pending.set(id,{resolve,reject,progress,chunks:[]});
    try{this.port.postMessage({...data,id,action});}catch(e){this.pending.delete(id);reject(e);}
   });promise.requestId=id;return promise;
  }
  async resolve(data,progress){const {result}=await this.request('resolve',data,progress);return result;}
  readAsset(assetId){
   return this.request('read_asset',{assetId}).then(({result,chunks})=>{
    const bytes=chunks.map(s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0))),size=bytes.reduce((n,a)=>n+a.length,0);
    if(result.size!==size)throw new Error('媒体分块长度不完整');
    const joined=new Uint8Array(size);let offset=0;for(const a of bytes){joined.set(a,offset);offset+=a.length;}
    let binary='';for(let i=0;i<joined.length;i+=32768)binary+=String.fromCharCode(...joined.subarray(i,i+32768));
    return {name:result.name,mime:result.mime,base64:btoa(binary)};
   });
  }
  async release(assetIds){if(!this.closed&&assetIds.length)await this.request('release',{assetIds});}
  cancel(){for(const [targetId,p]of this.pending){try{this.port.postMessage({id:`cancel_${++this.counter}`,action:'cancel',targetId});}catch{}p.reject(new Error('已取消视频处理'));}this.pending.clear();}
  close(){if(!this.closed){this.closed=true;this.port.disconnect();}}
 }
 root.NativeMediaClient=NativeMediaClient;if(typeof module!=='undefined')module.exports={NativeMediaClient};
})(globalThis);
