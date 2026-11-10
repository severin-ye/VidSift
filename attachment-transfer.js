(function(root){
  'use strict';
  const PREFIX='VIDSIFT_ATTACHMENT_', CHUNK_SIZE=256*1024, THRESHOLD=1024*1024, MAX_SIZE=256*1024*1024, TIMEOUT=120000;
  function describe(message){
    const metadata={...message};delete metadata.audioData;
    const attachments=message.attachments || (message.audioData ? [{name:message.fileName||'audio.m4a',mime:'audio/mp4',base64:message.audioData}] : []);
    const fields=[];let size=0;
    metadata.attachments=attachments.map((attachment,index)=>{
      const clean={...attachment};
      for(const field of ['base64','content'])if(typeof clean[field]==='string'){
        const value=clean[field];delete clean[field];size+=value.length;
        const chunkSize=field==='content'?CHUNK_SIZE/2:CHUNK_SIZE;
        fields.push({index,field,value,length:value.length,chunkSize,chunks:Math.ceil(value.length/chunkSize)});
      }
      return clean;
    });
    if(size>MAX_SIZE)throw new Error('附件传输超过 256 MiB 数据上限，请缩短音频或减少附件');
    if(JSON.stringify(metadata).length>CHUNK_SIZE)throw new Error('附件任务说明过长，无法安全传输');
    return {metadata,fields,size};
  }
  async function send(api,tabId,message,{assertLive=()=>{},onProgress=()=>{},forceChunk=true}={}){
    const {metadata,fields,size}=describe(message);
    // Remove the legacy duplicate even for the direct path.
    const direct={...message};if(message.attachments)delete direct.audioData;
    async function transmit(payload){
      await assertLive();
      let reply;
      try{reply=await api.tabs.sendMessage(tabId,payload,{frameId:0});}catch(error){throw new Error(`附件传输中断（页面可能已导航或组件已重载）：${error.message}`);}
      if(!reply?.ok)throw new Error(reply?.error||'附件传输未获页面确认，已停止且不会重复提交');
      return reply;
    }
    if(size<THRESHOLD&&!forceChunk)return transmit(direct);
    const transferId=globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const taskId=message.taskId || transferId;
    const common={transferId,taskId};let begun=false;
    try{
      const begin=await transmit({type:PREFIX+'BEGIN',...common,metadata:{...metadata,taskId},fields:fields.map(({value,...field})=>field)});
      begun=true;const receiverId=begin.receiverId;
      if(!receiverId)throw new Error('附件接收组件版本不兼容');
      let transferred=0;
      for(let fieldIndex=0;fieldIndex<fields.length;fieldIndex++){
        const field=fields[fieldIndex];
        for(let sequence=0;sequence<field.chunks;sequence++){
          const data=field.value.slice(sequence*field.chunkSize,(sequence+1)*field.chunkSize);
          const reply=await transmit({type:PREFIX+'CHUNK',...common,receiverId,fieldIndex,sequence,data});
          if(reply.receiverId!==receiverId)throw new Error('附件接收组件已重载，已停止传输');
          transferred+=data.length;onProgress({transferred,total:size});
        }
      }
      // A failed acknowledgement is ambiguous. Never retry this commit.
      return await transmit({type:PREFIX+'COMMIT',...common,receiverId});
    }catch(error){
      if(begun){
        try{await api.tabs.sendMessage(tabId,{type:PREFIX+'ABORT',...common},{frameId:0});}catch(_){}
        try{await api.tabs.sendMessage(tabId,{type:'VIDSIFT_CANCEL_UPLOAD',taskId,reason:'附件传输应答异常，已停止本次自动发送'},{frameId:0});}catch(_){}
      }
      throw error;
    }
  }
  function createReceiver({reserve,release,accept,isCancelled=()=>false,timeout=TIMEOUT}){
    let active=null;
    const receiverId=globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    function clear(){if(!active)return;const taskId=active.taskId;clearTimeout(active.timer);active.parts=[];active=null;release(taskId);}
    function touch(){clearTimeout(active.timer);active.timer=setTimeout(clear,timeout);active.timer?.unref?.();}
    function handle(msg){
      if(!msg?.type?.startsWith(PREFIX))return null;
      try{
        if(msg.type===PREFIX+'BEGIN'){
          if(active)return {ok:false,error:'已有附件传输正在处理',receiverId};
          if(!msg.transferId||!msg.taskId||msg.metadata?.taskId!==msg.taskId||msg.metadata?.type!=='VIDSIFT_AISTUDIO_UPLOAD_AND_RUN')throw new Error('附件传输任务标识无效');
          if(!Array.isArray(msg.fields)||!Array.isArray(msg.metadata.attachments)||msg.fields.length>64)throw new Error('附件传输清单无效');
          let size=0;const keys=new Set();
          for(const field of msg.fields){
            const key=`${field.index}:${field.field}`;
            if(!Number.isInteger(field.index)||!msg.metadata.attachments[field.index]||!['base64','content'].includes(field.field)||keys.has(key)||!Number.isSafeInteger(field.length)||field.length<0||field.chunkSize!==(field.field==='content'?CHUNK_SIZE/2:CHUNK_SIZE)||field.chunks!==Math.ceil(field.length/field.chunkSize))throw new Error('附件分块清单无效');
            keys.add(key);size+=field.length;
          }
          if(size>MAX_SIZE||JSON.stringify(msg.metadata).length>CHUNK_SIZE)throw new Error('附件传输超过大小上限');
          if(isCancelled(msg.taskId)||!reserve(msg.taskId))throw new Error('任务已取消或已有附件任务正在处理');
          active={taskId:msg.taskId,transferId:msg.transferId,metadata:msg.metadata,fields:msg.fields,parts:msg.fields.map(()=>[]),fieldIndex:0,sequence:0};
          while(active.fieldIndex<active.fields.length&&!active.fields[active.fieldIndex].chunks)active.fieldIndex++;
          touch();return {ok:true,receiverId};
        }
        if(!active||active.transferId!==msg.transferId||active.taskId!==msg.taskId)throw new Error('附件传输不存在或任务标识不符');
        if(msg.type===PREFIX+'ABORT'){clear();return {ok:true,receiverId};}
        if(msg.receiverId!==receiverId||isCancelled(msg.taskId))throw new Error('附件接收组件已变化或任务已取消');
        if(msg.type===PREFIX+'CHUNK'){
          const field=active.fields[active.fieldIndex];
          if(!field||msg.fieldIndex!==active.fieldIndex||msg.sequence!==active.sequence||typeof msg.data!=='string'||msg.data.length!==Math.min(field.chunkSize,field.length-active.sequence*field.chunkSize))throw new Error('附件分块缺失、重复或顺序不符');
          active.parts[active.fieldIndex].push(msg.data);
          if(++active.sequence===field.chunks){active.fieldIndex++;active.sequence=0;while(active.fieldIndex<active.fields.length&&!active.fields[active.fieldIndex].chunks)active.fieldIndex++;}
          touch();return {ok:true,receiverId};
        }
        if(msg.type===PREFIX+'COMMIT'){
          if(active.fieldIndex!==active.fields.length)throw new Error('附件分块不完整，未上传');
          const completed=active;
          for(let i=0;i<completed.fields.length;i++){const field=completed.fields[i];completed.metadata.attachments[field.index][field.field]=completed.parts[i].join('');}
          clearTimeout(active.timer);active=null;completed.parts=[];
          try{accept(completed.metadata);}catch(error){release(completed.taskId);throw error;}
          return {ok:true,receiverId};
        }
        throw new Error('未知附件传输消息');
      }catch(error){if(active?.taskId===msg.taskId&&active?.transferId===msg.transferId)clear();return {ok:false,error:error.message,receiverId};}
    }
    return {handle,cancel(taskId){if(active?.taskId===taskId)clear();},dispose:clear};
  }
  const api={send,createReceiver,CHUNK_SIZE,THRESHOLD,MAX_SIZE};root.VidSiftAttachmentTransfer=api;root.AttachmentTransfer=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
