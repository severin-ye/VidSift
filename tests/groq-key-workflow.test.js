const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('background-video.js','utf8');
function fixture(){let finish,calls=0,live=true;const gate=new Promise(r=>{finish=r;});
 const context=vm.createContext({groqCredentialPrompt:()=>({ensure:()=>gate}),_videoWorkflow:{assertLive:async()=>{if(!live)throw Error('源视频已切换');}},diagnoseTask(){}});
 vm.runInContext(source.slice(source.indexOf('async function transcribeVideo('),source.indexOf('const _videoWorkflow=')),context);
 const task={client:{transcribeGroq:async()=>{calls++;return{srt:'valid transcript'};}}};
 return {run:()=>context.transcribeVideo(null,{transcribeService:'groq',localAudio:{},task},()=>{},new AbortController().signal),finish,calls:()=>calls,switchSource:()=>{live=false;}};
}
test('Groq upload waits for key setup and then transcribes once',async()=>{const f=fixture(),p=f.run();await new Promise(r=>setImmediate(r));assert.equal(f.calls(),0);f.finish();assert.equal(await p,'valid transcript');assert.equal(f.calls(),1);});
test('a source changed while key dialog is open never uploads old audio',async()=>{const f=fixture(),p=f.run();f.switchSource();f.finish();await assert.rejects(p,/源视频已切换/);assert.equal(f.calls(),0);});
