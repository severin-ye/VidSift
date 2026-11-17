const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('background-video.js','utf8');
function fixture({capable=true,noSpeech=false}={}){let finish,calls=0,live=true;const gate=new Promise(r=>{finish=r;});
 const context=vm.createContext({groqCredentialPrompt:()=>({ensure:()=>gate}),_videoWorkflow:{assertLive:async()=>{if(!live)throw Error('源视频已切换');}},diagnoseTask(){}});
 vm.runInContext(source.slice(source.indexOf('async function transcribeVideo('),source.indexOf('const _videoWorkflow=')),context);
 const task={nativeCapabilities:capable?['speech-vad-v1']:[],client:{detectSpeech:async()=>({speechStatus:noSpeech?'none':'present'}),transcribeGroq:async()=>{calls++;if(noSpeech)return {srt:'',speechStatus:'none'};if(calls===1)throw Error('未配置 GROQ_API_KEY');return{srt:'valid transcript',speechStatus:'present'};}}};
 return {run:()=>context.transcribeVideo(null,{transcribeService:'groq',localAudio:{},task},()=>{},new AbortController().signal),finish,calls:()=>calls,switchSource:()=>{live=false;}};
}
test('Groq speech check precedes key setup and missing key retries only after setup',async()=>{const f=fixture(),p=f.run();await new Promise(r=>setImmediate(r));assert.equal(f.calls(),1);f.finish();assert.equal(await p,'valid transcript');assert.equal(f.calls(),2);});
test('a source changed while key dialog is open never uploads old audio',async()=>{const f=fixture(),p=f.run();await new Promise(setImmediate);f.switchSource();f.finish();await assert.rejects(p,/源视频已切换/);assert.equal(f.calls(),1);});

test('old Native is rejected before upload and no-speech never asks for credentials',async()=>{
 const old=fixture({capable:false});await assert.rejects(old.run(),/5.14.0/);assert.equal(old.calls(),0);
 const music=fixture({noSpeech:true});const result=await music.run();assert.equal(result.speechStatus,'none');assert.equal(music.calls(),0);
});

test('local Whisper uses the same speech boundary and skips its engine for music',async()=>{
 const f=fixture({noSpeech:true});const data={transcribeService:'local',localAudio:{},task:{nativeCapabilities:['speech-vad-v1'],client:{detectSpeech:async()=>({speechStatus:'none'})}}};
 const c=vm.createContext({diagnoseTask(){},_videoWorkflow:{assertLive:async()=>{}}});vm.runInContext(source.slice(source.indexOf('async function transcribeVideo('),source.indexOf('const _videoWorkflow=')),c);
 assert.equal((await c.transcribeVideo(null,data,()=>{},new AbortController().signal)).speechStatus,'none');
});
