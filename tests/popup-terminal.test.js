const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

async function fixture(initial={active:false}){
 const elements=new Map(),intervals=[],listeners=[];
 const element=id=>{if(!elements.has(id)){const classes=new Set();elements.set(id,{textContent:'',checked:false,disabled:false,style:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},addEventListener(){}});}return elements.get(id);};
 let state=initial;
 const port={onMessage:{addListener:fn=>listeners.push(fn)},onDisconnect:{addListener(){}},postMessage(){}};
 const context=vm.createContext({console,document:{getElementById:element},localStorage:{getItem:()=>null,setItem(){}},setInterval:fn=>intervals.push(fn),
  ScreenshotSettings:{normalize:()=>({enabled:false})},AudioSettings:{normalize:()=>({})},
  VidSiftPlatforms:{identify:url=>url?.includes('douyin.com')?{platform:'douyin',videoId:'123'}:null},
  DouyinLocalSettings:{migrate:async()=>{},resolve:()=>({service:'groq'})},
  chrome:{storage:{local:{get:async()=>({}),set:async()=>{}}},tabs:{query:async()=>[{id:7,url:'https://www.douyin.com/video/123'}]},runtime:{connect:()=>port,sendMessage:async msg=>msg.type==='GET_TAB_TRANSCRIBE_STATUS'?state:{},openOptionsPage(){}}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8'),context,{filename:'popup.js'});
 await new Promise(setImmediate);
 return {element,context,emit:msg=>listeners.forEach(fn=>fn(msg)),poll:async next=>{state=next;await intervals[0]();}};
}

test('live transcription failure replaces stale compression progress and permits retry',async()=>{
 const f=await fixture();await vm.runInContext('run()',f.context);
 f.emit({type:'ACCEPTED',text:'后台已接收'});
 f.emit({type:'STATUS',text:'正在压缩完整音频供 Groq 上传（队列 1/1）'});
 f.emit({type:'ERROR',text:'Groq 压缩后仍超过24MB'});
 assert.match(f.element('statusText').textContent,/Groq 压缩后仍超过24MB/);
 assert.doesNotMatch(f.element('statusText').textContent,/正在压缩|队列/);
 assert.equal(f.element('errorBox').classList.contains('show'),true);
 assert.equal(f.element('runBtn').disabled,false);
 assert.equal(f.element('cancelBtn').style.display,'none');
});

test('reopened popup displays retained terminal failure instead of active processing',async()=>{
 const f=await fixture({active:false,statusText:'Groq 压缩后仍超过24MB'});
 assert.equal(f.element('statusText').textContent,'Groq 压缩后仍超过24MB');
 assert.equal(f.element('runBtn').disabled,false);
 assert.notEqual(f.element('runBtn').textContent,'视频处理进行中');
});

test('popup following an existing task replaces progress when the worker ends it',async()=>{
 const f=await fixture({active:true,statusText:'正在压缩完整音频供 Groq 上传（队列 1/1）'});
 assert.equal(f.element('runBtn').disabled,true);
 await f.poll({active:false,statusText:'Groq 压缩后仍超过24MB'});
 assert.equal(f.element('statusText').textContent,'Groq 压缩后仍超过24MB');
 assert.equal(f.element('runBtn').disabled,false);
 assert.equal(f.element('cancelBtn').style.display,'none');
});
