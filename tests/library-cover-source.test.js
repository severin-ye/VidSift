const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const lib=require('../video-library.js');
async function prepared(pic,sourceCover,apiOK=true){
 let saved;
 const chrome={runtime:{onMessage:{addListener(){}},onStartup:{addListener(){}}},tabs:{onRemoved:{addListener(){}}}};
 class Bridge{async getSettings(){return {enabled:true};}async register(task){saved=task;} }
 const ctx=vm.createContext({chrome,VidSiftVideoLibrary:{...lib,VideoLibraryBridge:Bridge},VidSiftPlatforms:require('../platforms.js'),AbortSignal,console,
  fetch:async()=>{if(!apiOK)throw Error('network');return {ok:true,json:async()=>({code:0,data:{bvid:'BV1ECWH6dEkR',pic}})};}});
 vm.runInContext(fs.readFileSync('background-library.js','utf8'),ctx);
 await ctx.prepareVideoLibraryTask({taskId:'t',targetTabId:7,source:{url:'https://www.bilibili.com/video/BV1ECWH6dEkR',coverUrl:sourceCover}});
 return saved.source;
}
test('Bilibili HTTP metadata cover survives after the source page closes',async()=>{
 const source=await prepared('http://i1.hdslb.com/bfs/archive/real.jpg','');
 assert.equal(source.coverUrl,'https://i1.hdslb.com/bfs/archive/real.jpg@640w_360h_1c.jpg');
});
test('missing or untrusted API cover never clears an already captured cover',async()=>{
 const valid='https://i1.hdslb.com/existing.jpg@1200w_630h';
 for(const pic of ['',undefined,'https://evil.test/x.jpg'])assert.equal((await prepared(pic,valid)).coverUrl,valid);
});
test('captured HTTP cover remains usable when the redundant metadata request fails',async()=>{
 assert.equal((await prepared('', 'http://i1.hdslb.com/real.jpg',false)).coverUrl,'https://i1.hdslb.com/real.jpg@640w_360h_1c.jpg');
});
