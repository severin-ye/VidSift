const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const library=require('../video-library.js');
function fixture(){
 const event={addListener(){}};let current='https://www.bilibili.com/list/watchlater/?bvid=BV1new411c7mD&p=2';
 const chrome={runtime:{id:'extension',onMessage:event},tabs:{onUpdated:event,onRemoved:event,get:async()=>({url:current})}};
 const ctx=vm.createContext({chrome,URL,setTimeout,clearTimeout,VidSiftVideoLibrary:library,_videoLibrary:{getSettings:async()=>({enabled:true})},_diagnostics:{begin:async()=>{},record:async()=>{}},VidSiftSummaryLookup:{completedPage:async({source})=>({ok:true,records:[],source,totalCandidates:0})}});
 vm.runInContext(fs.readFileSync('background-summary-reminder.js','utf8'),ctx);
 const sender={id:'extension',frameId:0,url:'https://www.bilibili.com/list/watchlater/?bvid=BV1old411c7mD',tab:{id:4,url:current}};
 return {ctx,sender,setCurrent:url=>current=url};
}
test('SPA query uses browser tab snapshot while preserving current-video and part checks',async()=>{
 const f=fixture(),result=await f.ctx.summaryPage({videoUrl:f.sender.tab.url},f.sender);
 assert.equal(result.source.url,'https://www.bilibili.com/video/BV1new411c7mD?p=2');
 await assert.rejects(()=>f.ctx.summaryPage({videoUrl:f.sender.url},f.sender),/视频已切换/);
 await assert.rejects(()=>f.ctx.summaryPage({videoUrl:'https://www.bilibili.com/video/BV1new411c7mD'},f.sender),/视频已切换/);
 f.setCurrent('https://www.bilibili.com/video/BV1another411c7mD');
 await assert.rejects(()=>f.ctx.summaryPage({videoUrl:f.sender.tab.url},f.sender),/视频已切换/);
});
test('iframe, unrelated origin and non-extension senders cannot query current-video summaries',()=>{
 for(const extra of [{frameId:2},{id:'other'},{url:'https://example.test/video'},{tab:{id:4}}]){
  const f=fixture();assert.throws(()=>f.ctx.summarySenderSource({...f.sender,...extra}),/仅允许当前视频/);
 }
});
