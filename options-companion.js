'use strict';
(() => {
 const enabled=document.getElementById('companion-enabled'),label=document.getElementById('companion-label'),status=document.getElementById('companion-status');
 const save=document.getElementById('companion-save'),reset=document.getElementById('companion-reset'),stop=document.getElementById('companion-stop'),refresh=document.getElementById('companion-refresh');
 const buttons=[enabled,save,reset,stop,refresh];
 const show=(text,error=false)=>{status.textContent=text;status.classList.toggle('error',error);};
 const updateLabel=()=>{label.textContent=enabled.checked?'总结伴播·开':'总结伴播·关';};
 const states={opening:'正在打开官方视频页',loading:'等待官方播放器',playing:'正在静音播放',ending:'已播完，等待官方页面上报','player-ended':'播放器已播完',ended:'播放器已播完',completed:'播放器已播完',stopped:'已停止',closed:'伴播页已关闭',failed:'播放未完成',taken_over:'已交给你控制',navigated:'伴播页已离开当前视频',timeout:'播放等待超时'};
 function render(value){
  enabled.checked=value.enabled===true;updateLabel();
  const current=value.current;
  const queued=Array.isArray(value.queued)?value.queued.length:Number(value.queued)||0;
  let text=current?'正在伴播'+(current.source?.title?'「'+current.source.title+'」':'当前视频'):'当前没有正在伴播的视频';
  if(current?.state||current?.phase)text+='；'+(states[current.state||current.phase]||'正在处理');
  if(Number.isFinite(current?.position))text+='，已播放 '+Math.floor(current.position)+' 秒';
  text+='；等待 '+queued+' 条';
  if(value.last&&!current)text+='；上次：'+(value.last.reason||value.last.message||value.last.text||states[value.last.state||value.last.phase]||'已结束');
  show(text+'。播放器播完不代表推荐效果已验证；B站历史由官方页面记录。');
 }
 async function request(type,extra={}){
  const result=await chrome.runtime.sendMessage({type,...extra});
  if(!result?.ok)throw Error(result?.error||'扩展后台没有返回伴播状态');
  render(result);return result;
 }
 async function act(type,extra){
  buttons.forEach(button=>{button.disabled=true;});
  try{await request(type,extra);}catch(error){show('无法确认总结伴播状态：'+error.message,true);}
  finally{buttons.forEach(button=>{button.disabled=false;});}
 }
 enabled.addEventListener('change',updateLabel);
 save.addEventListener('click',()=>act('VIDSIFT_COMPANION_SET_ENABLED',{enabled:enabled.checked}));
 reset.addEventListener('click',()=>act('VIDSIFT_COMPANION_SET_ENABLED',{enabled:true}));
 stop.addEventListener('click',()=>act('VIDSIFT_COMPANION_STOP'));
 refresh.addEventListener('click',()=>act('VIDSIFT_COMPANION_STATUS'));
 act('VIDSIFT_COMPANION_STATUS');
})();
