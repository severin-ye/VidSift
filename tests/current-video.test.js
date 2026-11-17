const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('current-video.js','utf8'),P=require('../platforms');
function video(props={},rect={left:0,top:0,right:800,bottom:450,width:800,height:450}){return {paused:false,ended:false,duration:40,poster:'',parentElement:null,getBoundingClientRect:()=>rect,closest:()=>null,...props};}
function context(url,videos=[],extra={}){const c={location:{href:url},URL,innerWidth:1200,innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),document:{title:'Fixture',querySelectorAll:s=>s==='video'?videos:[],querySelector:()=>null,getElementById:()=>null},window:{},...extra};vm.createContext(c);vm.runInContext(source,c);return c;}
const dto=id=>({awemeId:id,desc:'Selected',private:'must not leave page',video:{duration:40000,playAddr:[{src:'https://v.douyinvod.com/'+id+'.mp4'}]}});
function dy(id,rect){return video({'__reactFiber$test':{memoizedProps:{xgplayerConfig:{awemeInfo:dto(id)}},return:null}},rect);}
test('Douyin same URL resolves selected visible DTO, excluding hidden and offscreen retained items',()=>{
 const hidden=dy('111',{left:0,top:-790,right:800,bottom:10,width:800,height:800}),active=dy('222'),next=dy('333',{left:0,top:810,right:800,bottom:1260,width:800,height:450});
 const c=context('https://www.douyin.com/follow',[hidden,active,next]);let r=c.VidSiftCurrentVideo.probe();assert.equal(r.videoId,'222');assert.equal(r.videoIndex,1);assert.equal(JSON.stringify(r).includes('private'),false);
 active.__reactFiber$test.memoizedProps.xgplayerConfig.awemeInfo=dto('444');r=c.VidSiftCurrentVideo.probe();assert.equal(r.videoId,'444');assert.equal(r.url,'https://www.douyin.com/video/444');
});
test('multiple active visible videos are ambiguous; a hidden one is not an alternative',()=>{
 const a=dy('111'),b=dy('222'),c=context('https://www.douyin.com/follow',[a,b]);assert.match(c.VidSiftCurrentVideo.probe().error,/多个/);
 b.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0});assert.equal(c.VidSiftCurrentVideo.probe().videoId,'111');
});
test('YouTube player identity wins over stale route; embed and Bili player routes remain supported',()=>{
 const v=video(),player={contains:x=>x===v,getVideoData:()=>({video_id:'NEW123XYZ_0',title:'current'})};v.closest=()=>player;
 assert.equal(context('https://www.youtube.com/watch?v=abc123XYZ_0',[v]).VidSiftCurrentVideo.probe().videoId,'NEW123XYZ_0');
 assert.equal(P.identify('https://www.youtube-nocookie.com/embed/abc123XYZ_0').videoId,'abc123XYZ_0');
 assert.equal(P.identify('https://player.bilibili.com/player.html?bvid=BV123abc&p=2').part,2);
});
test('bangumi requires current episode DTO with BV and cid; an episode list is never selected',()=>{
 const url='https://www.bilibili.com/bangumi/play/ep123',v=video();
 const c=context(url,[v],{window:{__INITIAL_STATE__:{epInfo:{id:123,bvid:'BV123abc',cid:900,title:'episode'},epList:[{id:124,bvid:'BVother',cid:901}]}}});
 assert.equal(c.VidSiftCurrentVideo.probe().cid,900);c.window.__INITIAL_STATE__.epInfo.id=124;assert.equal(c.VidSiftCurrentVideo.probe().videoId,undefined);
});
test('feed resource capture only uses selected player, never matching global stale data',()=>{
 const a=dy('111'),b=dy('222'),c=context('https://www.douyin.com/follow',[a,b],{window:{_ROUTER_DATA:dto('111')}});vm.runInContext(fs.readFileSync('douyin-source.js','utf8'),c);
 assert.equal(c.DouyinPageSource('222',{playerIdentity:true,videoIndex:1}).videoId,'222');
 assert.equal(c.DouyinPageSource('111',{playerIdentity:true,videoIndex:1}),null);
 assert.equal(c.DouyinPageSource('111'),null);
});
test('discovery chooses only visible iframe and returns canonical URL with original frame identity',async()=>{
 const c=context('https://www.bilibili.com/');c.VidSiftPlatforms=P;
 const frameURL='https://www.youtube.com/embed/abc123XYZ_0';
 const records=[{frameId:0,result:{platform:'bilibili',url:'https://www.bilibili.com/',frames:[frameURL],visiblePlayers:0}},{frameId:7,result:{platform:'youtube',videoId:'abc123XYZ_0',key:'youtube:abc123XYZ_0',url:'https://www.youtube.com/watch?v=abc123XYZ_0',pageUrl:frameURL,visiblePlayers:1}},{frameId:8,result:{platform:'youtube',videoId:'NEW123XYZ_0',url:'https://www.youtube.com/watch?v=NEW123XYZ_0',pageUrl:'https://www.youtube.com/embed/NEW123XYZ_0',visiblePlayers:1}}];
 const chrome={scripting:{executeScript:async options=>options.target.frameIds?records.filter(r=>options.target.frameIds.includes(r.frameId)):records}};
 const {source}=await c.VidSiftCurrentVideo.discover(chrome,{id:1,url:'https://www.bilibili.com/'});assert.equal(source.frameId,7);assert.equal(source.frameUrl,frameURL);assert.equal(source.pageUrl,'https://www.bilibili.com/');assert.match(source.url,/watch\?v=/);
});
test('Bili cid is mapped to exact part before creating identity, never silently p1',async()=>{
 const c=context('https://space.bilibili.com/123');c.VidSiftPlatforms=P;c.AbortSignal=AbortSignal;
 c.fetch=async()=>({json:async()=>({code:0,data:{bvid:'BV123abc',pages:[{cid:1},{cid:900}]}})});
 const record={frameId:0,result:{platform:'bilibili',videoId:'BV123abc',cid:900,part:1,partKnown:false,key:'bilibili:BV123abc:1',url:'https://www.bilibili.com/video/BV123abc',pageUrl:'https://space.bilibili.com/123',visiblePlayers:1}};
 const chrome={scripting:{executeScript:async()=>[record]}},r=await c.VidSiftCurrentVideo.discover(chrome,{id:1,url:record.result.pageUrl});assert.equal(r.source.part,2);assert.equal(r.source.key,'bilibili:BV123abc:2');assert.match(r.source.url,/p=2/);
});
test('capture rechecks selected player and rejects switching between identity and resource reads',async()=>{
 const c=context('https://www.douyin.com/follow');c.VidSiftPlatforms=P;let probes=0;
 const initial={platform:'douyin',videoId:'111',key:'douyin:111',url:'https://www.douyin.com/video/111',pageUrl:'https://www.douyin.com/follow',visiblePlayers:1,videoIndex:0};
 const chrome={scripting:{executeScript:async options=>options.files?[]:options.args?[{frameId:0,result:{videoId:'111',douyin:{videoId:'111',videoUrl:'https://v.douyinvod.com/111.mp4'}}}]:[{frameId:0,result:++probes===1?initial:{...initial,videoId:'222'}}]}};
 await assert.rejects(c.VidSiftCurrentVideo.discover(chrome,{id:1,url:initial.pageUrl}),/切换/);
});
test('script permission failures cannot fall back to an unverified route identity',async()=>{
 const c=context('https://www.youtube.com/watch?v=abc123XYZ_0');c.VidSiftPlatforms=P;
 await assert.rejects(c.VidSiftCurrentVideo.discover({scripting:{executeScript:async()=>{throw Error('permission denied');}}},{id:1,url:c.location.href}),/权限/);
});

test('unrelated Douyin AI sidebar iframe does not hide the exact modal route when background video has no visible box',async()=>{
 const url='https://www.douyin.com/jingxuan/knowledge/search/test?modal_id=7690785624487590054',sidebar='https://so-landing.douyin.com/search_ai_mobile/pc';
 const c=context(url);c.VidSiftPlatforms=P;
 const top={...P.identify(url),pageUrl:url,frames:[sidebar],visiblePlayers:0,videoIndex:-1};
 const chrome={scripting:{executeScript:async()=>[{frameId:0,result:top},{frameId:8,result:{platform:null,url:sidebar}}]}};
 const result=await c.VidSiftCurrentVideo.discover(chrome,{id:1,url},{capture:false});assert.equal(result.source.videoId,'7690785624487590054');assert.equal(result.source.frameId,0);
 top.frames=['https://www.youtube.com/'];chrome.scripting.executeScript=async()=>[{frameId:0,result:top},{frameId:8,result:{platform:'youtube',url:top.frames[0],frames:[],visiblePlayers:0}}];
 await assert.rejects(c.VidSiftCurrentVideo.discover(chrome,{id:1,url},{capture:false}),/播放器/);
});
