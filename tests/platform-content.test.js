const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('source-page status never creates an overlay and SPA source tracking remains active',()=>{
 let receive,poll;const sent=[],location={href:'https://www.douyin.com/video/111'};
 const identify=url=>({key:url});
 vm.runInNewContext(fs.readFileSync('platform-content.js','utf8'),{location,VidSiftPlatforms:{identify},setInterval:fn=>{poll=fn;},chrome:{runtime:{onMessage:{addListener(fn){receive=fn;}},sendMessage:async msg=>sent.push(msg)}}});
 for(const type of ['EXT_STATUS','EXT_ERROR','EXT_HIDE_STATUS']){
  let ack=false;receive({type,text:'fixture'},null,r=>ack=r.ok);assert.equal(ack,true);
 }
 location.href='https://www.douyin.com/video/222';poll();assert.equal(sent.length,1);assert.equal(sent[0].type,'VIDSIFT_SOURCE_CHANGED');
});
