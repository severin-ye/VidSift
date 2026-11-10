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
    if(p.maxBytes!==undefined){
     if(typeof msg.data!=='string'||msg.data.length>349528){this.pending.delete(msg.id);p.reject(new Error('PCM 分块超过上限'));return;}
     let size;try{size=atob(msg.data).length;}catch{this.pending.delete(msg.id);p.reject(new Error('PCM 分块编码无效'));return;}
     p.receivedBytes+=size;if(p.receivedBytes>p.maxBytes){this.pending.delete(msg.id);p.reject(new Error('PCM 分块超过上限'));return;}
    }
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
  async groqStatus(){const {result}=await this.request('groq_status');return result;}
  async storeGroqKey(apiKey){const {result}=await this.request('groq_store_key',{apiKey});return result;}
  async transcribeGroq(descriptor,settings={},onProgress){
   const {result}=await this.request('transcribe_groq',{fingerprint:descriptor?.fingerprint,videoId:descriptor?.videoId,model:settings.model||'whisper-large-v3-turbo',timeoutSeconds:settings.timeoutSeconds??180},onProgress);return result;
  }
  readAsset(assetId){
   return this.request('read_asset',{assetId}).then(({result,chunks})=>{
    const bytes=chunks.map(s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0))),size=bytes.reduce((n,a)=>n+a.length,0);
    if(result.size!==size)throw new Error('媒体分块长度不完整');
    const joined=new Uint8Array(size);let offset=0;for(const a of bytes){joined.set(a,offset);offset+=a.length;}
    let binary='';for(let i=0;i<joined.length;i+=32768)binary+=String.fromCharCode(...joined.subarray(i,i+32768));
    return {name:result.name,mime:result.mime,base64:btoa(binary)};
   });
  }
  async prepareLocalAudio(descriptor,videoId){
   const data=typeof descriptor==='string'?{fingerprint:descriptor,videoId}:{fingerprint:descriptor?.fingerprint,videoId:descriptor?.videoId};
   const {result}=await this.request('prepare_local_audio',data);return result;
  }
  async finishLocalAudio(descriptor,status){const {result}=await this.request('local_audio_finish',{fingerprint:typeof descriptor==='string'?descriptor:descriptor?.fingerprint,status});return result;}
  async modelFileInfo(model,revision,file,progress){const {result}=await this.request('model_file_info',{model,revision,file},progress);return result;}
  async modelFileChunk(model,revision,file,offset,length){
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>262144)throw new Error('模型文件读取范围无效');
   const {result}=await this.request('model_file_chunk',{model,revision,file,offset,length});return result;
  }
  readPcmWindow(fingerprint,start,duration){
   if(!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0||duration>30)return Promise.reject(new Error('PCM 窗口须在音频内且不超过 30 秒'));
   const request=this.request('read_pcm_window',{fingerprint,start,duration});
   const pending=this.pending.get(request.requestId);pending.maxBytes=30*16000*4;pending.receivedBytes=0;
   return request.then(({result,chunks})=>{
    if(result?.encoding!=='f32le'||result.sampleRate!==16000||!Number.isInteger(result.size)||result.size<=0||result.size>30*16000*4||result.samples*4!==result.size||result.fingerprint!==fingerprint||result.start!==start)throw new Error('PCM 窗口元数据无效');
    const joined=new Uint8Array(result.size);let offset=0;
    for(const chunk of chunks){const raw=atob(chunk);if(offset+raw.length>joined.length)throw new Error('PCM 分块长度超过上限');for(let i=0;i<raw.length;i++)joined[offset++]=raw.charCodeAt(i);}
    if(offset!==result.size)throw new Error('PCM 分块长度不完整');
    let binary='';for(let i=0;i<joined.length;i+=32768)binary+=String.fromCharCode(...joined.subarray(i,i+32768));
    return {...result,base64:btoa(binary)};
   });
  }
  async release(assetIds){if(!this.closed&&assetIds.length)await this.request('release',{assetIds});}
  cancel(){for(const [targetId,p]of this.pending){try{this.port.postMessage({id:`cancel_${++this.counter}`,action:'cancel',targetId});}catch{}p.reject(new Error('已取消视频处理'));}this.pending.clear();}
  close(){if(!this.closed){this.closed=true;this.port.disconnect();}}
 }
 root.NativeMediaClient=NativeMediaClient;if(typeof module!=='undefined')module.exports={NativeMediaClient};
})(globalThis);
