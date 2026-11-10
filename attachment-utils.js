(function(root){
  'use strict';
  const allowed=new Set(['text/plain','application/x-subrip','image/jpeg','audio/mp4','audio/mpeg','audio/wav','audio/webm','audio/ogg']);
  function normalizeMessage(msg,target='chatgpt'){
    let list=msg.attachments;
    if(list===undefined){if(target==='aistudio')list=[{name:msg.fileName||`bili_audio_${crypto.randomUUID().slice(0,8)}.m4s`,mime:'audio/mp4',base64:msg.audioData}];else list=[{...msg.file,mime:msg.file?.mime||'text/plain'}];}
    if(!Array.isArray(list)||!list.length)throw new Error('没有可上传的附件');
    const names=new Set();let images=0;
    return list.map(a=>{if(!a||typeof a.name!=='string')throw new Error('附件缺少文件名');let name=a.name.replace(/[\\/\x00-\x1f]/g,'_').trim();if(!name||name.length>240)throw new Error('附件文件名无效');const mime=String(a.mime||'').toLowerCase();if(!allowed.has(mime))throw new Error(`不支持附件类型：${mime}`);if(mime==='image/jpeg'&&++images>15)throw new Error('图片拼图附件最多 15 张');const dot=name.lastIndexOf('.'),base=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';let n=1;while(names.has(name))name=`${base}(${n++})${ext}`;names.add(name);
      const text=mime==='text/plain'||mime==='application/x-subrip';if(text&&typeof a.content!=='string')throw new Error(`字幕内容无效：${name}`);if(!text&&(typeof a.base64!=='string'||!a.base64.length||a.base64.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)))throw new Error(`附件二进制数据无效：${name}`);
      return text?{name,mime,content:a.content}:{name,mime,base64:a.base64};});
  }
  function toFile(a){if(a.content!==undefined)return new File([a.content],a.name,{type:a.mime});const binary=atob(a.base64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return new File([bytes],a.name,{type:a.mime});}
  async function uploadAll(attachments,upload){for(const a of attachments){try{await upload(a);}catch(e){if(e.retryable!==true)throw e;await upload(a);}}}
  function contextualPrompt(prompt,attachments,source=''){if(!attachments.some(a=>a.mime==='image/jpeg'))return prompt;return `${prompt}\n\n视频画面补充说明：来源 ${source||'当前视频'}。拼图中的时间标记对应原视频时间，请结合字幕或音频理解画面；不要将不同时间的画面视为同时发生。`;}
  const api={normalizeMessage,toFile,uploadAll,contextualPrompt};root.VidSiftAttachments=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
