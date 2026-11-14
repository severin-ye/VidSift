(function(root){
  'use strict';
  const allowed=new Set(['text/plain','application/x-subrip','image/jpeg','audio/mp4','audio/mpeg','audio/wav','audio/webm','audio/ogg']);
  // Upload services validate UTF-8 bytes, rather than JavaScript string length.
  // Reserve space for the extension and duplicate suffix before clipping at a
  // Unicode code point boundary; subtitle/image content is never shortened.
  function clipFilename(value,budget){let result='',bytes=0;for(const char of value){const cp=char.codePointAt(0),size=cp<=0x7f?1:cp<=0x7ff?2:cp<=0xffff?3:4;if(bytes+size>budget)break;result+=char;bytes+=size;}return result;}
  function safeFilename(value,suffix=''){
    const name=value.replace(/[\\/\x00-\x1f]/g,'_').trim().normalize('NFC');
    if(!name)throw new Error('附件文件名无效');
    const dot=name.lastIndexOf('.'),hasExtension=dot>0&&name.length-dot<=12;
    const base=hasExtension?name.slice(0,dot):name,ext=hasExtension?name.slice(dot):'';
    const reserved=Array.from(suffix+ext).reduce((n,char)=>{const cp=char.codePointAt(0);return n+(cp<=0x7f?1:cp<=0x7ff?2:cp<=0xffff?3:4);},0);
    return clipFilename(base,120-reserved)+suffix+ext;
  }
  function normalizeMessage(msg,target='chatgpt'){
    let list=msg.attachments;
    if(list===undefined){if(target==='aistudio')list=[{name:msg.fileName||`bili_audio_${crypto.randomUUID().slice(0,8)}.m4s`,mime:'audio/mp4',base64:msg.audioData}];else list=[{...msg.file,mime:msg.file?.mime||'text/plain'}];}
    if(!Array.isArray(list)||!list.length)throw new Error('没有可上传的附件');
    const names=new Set();let images=0;
    return list.map(a=>{if(!a||typeof a.name!=='string')throw new Error('附件缺少文件名');let name=safeFilename(a.name);const mime=String(a.mime||'').toLowerCase();if(!allowed.has(mime))throw new Error(`不支持附件类型：${mime}`);if(mime==='image/jpeg'&&++images>15)throw new Error('图片拼图附件最多 15 张');let n=1;while(names.has(name))name=safeFilename(a.name,`(${n++})`);names.add(name);
      const text=mime==='text/plain'||mime==='application/x-subrip';if(text&&typeof a.content!=='string')throw new Error(`字幕内容无效：${name}`);if(!text&&(typeof a.base64!=='string'||!a.base64.length||a.base64.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)))throw new Error(`附件二进制数据无效：${name}`);
      return text?{name,mime,content:a.content}:{name,mime,base64:a.base64};});
  }
  function toFile(a){if(a.content!==undefined)return new File([a.content],a.name,{type:a.mime});const binary=atob(a.base64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return new File([bytes],a.name,{type:a.mime});}
  async function uploadAll(attachments,upload){for(const a of attachments){try{await upload(a);}catch(e){if(e.retryable!==true)throw e;await upload(a);}}}
  function contextualPrompt(prompt,attachments,source=''){if(!attachments.some(a=>a.mime==='image/jpeg'))return prompt;return `${prompt}\n\n视频画面补充说明：来源 ${source||'当前视频'}。拼图中的时间标记对应原视频时间，请结合字幕或音频理解画面；不要将不同时间的画面视为同时发生。`;}
  const api={normalizeMessage,toFile,uploadAll,contextualPrompt};root.VidSiftAttachments=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
