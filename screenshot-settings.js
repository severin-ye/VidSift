(function(root){
  'use strict';
  const DEFAULTS=Object.freeze({enabled:false,mode:'auto',interval:5,maxCollages:15,rows:3,columns:3,width:960,height:540,quality:90,sceneThreshold:0.3});
  const ranges={interval:[0.1,3600,false],maxCollages:[1,15,true],rows:[1,3,true],columns:[1,3,true],width:[160,3840,true],height:[90,2160,true],quality:[1,100,true],sceneThreshold:[0,1,false]};
  const modes=['auto','interval','scene'];
  function normalize(value={}){value=value&&typeof value==='object'?value:{};const out={...DEFAULTS,enabled:value.enabled===true,mode:modes.includes(value.mode)?value.mode:'auto'};for(const [key,[min,max,integer]]of Object.entries(ranges)){const n=value[key]==null||value[key]===''?NaN:Number(value[key]);out[key]=Number.isFinite(n)?Math.min(max,Math.max(min,integer?Math.round(n):n)):DEFAULTS[key];}return out;}
  function validate(value){if(!value||!modes.includes(value.mode))throw new Error('mode：请选择有效提取模式');for(const [key,[min,max,integer]]of Object.entries(ranges)){const n=value[key]===''?NaN:Number(value[key]);if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw new Error(`${key}：请输入 ${min}–${max} 范围内${integer?'的整数':'的数值'}`);}return normalize(value);}
  const api={DEFAULTS,STORAGE_KEY:'screenshotSettings',normalize,validate};root.ScreenshotSettings=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
