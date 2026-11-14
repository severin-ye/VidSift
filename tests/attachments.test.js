const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../attachment-utils.js');
test('legacy SRT and audio payloads remain valid',()=>{assert.equal(A.normalizeMessage({file:{name:'a.srt',content:'字幕'}})[0].mime,'text/plain');assert.equal(A.normalizeMessage({audioData:'AAEC'},'aistudio')[0].mime,'audio/mp4');});
test('long Chinese subtitle names fit the UTF-8 upload limit without changing subtitles',()=>{
 const original='7698527283597905202_'+ '荣格《红书》精读与内心探索'.repeat(12)+'.srt',content='1\n00:00:01,000 --> 00:44:57,000\n完整字幕';
 const [attachment]=A.normalizeMessage({file:{name:original,content}});
 assert.ok(Buffer.byteLength(attachment.name,'utf8')<=120);
 assert.ok(attachment.name.startsWith('7698527283597905202_'));
 assert.ok(attachment.name.endsWith('.srt'));
 assert.equal(attachment.content,content);
});
test('truncated Unicode names remain valid and unique within the byte budget',()=>{
 const name='e\u0301😀中文'.repeat(50)+'.jpg';
 const list=A.normalizeMessage({attachments:Array.from({length:12},()=>({name,mime:'image/jpeg',base64:'/9j/AA=='}))});
 assert.equal(new Set(list.map(a=>a.name)).size,12);
 for(const a of list){assert.ok(Buffer.byteLength(a.name,'utf8')<=120);assert.equal(a.name,a.name.normalize('NFC'));assert.ok(a.name.endsWith('.jpg'));assert.ok(!a.name.includes('\ufffd'));}
});
test('short attachment names retain their existing spelling',()=>{
 const [a]=A.normalizeMessage({file:{name:'视频_abc123.srt',content:'x'}});
 assert.equal(a.name,'视频_abc123.srt');
});
test('JPEG stays binary and duplicate attachment names are disambiguated',async()=>{const list=A.normalizeMessage({attachments:[{name:'frame.jpg',mime:'image/jpeg',base64:'/9j/AA=='},{name:'frame.jpg',mime:'image/jpeg',base64:'/9j/AA=='}]});assert.notEqual(list[0].name,list[1].name);const f=A.toFile(list[0]);assert.equal(f.type,'image/jpeg');assert.deepEqual([...new Uint8Array(await f.arrayBuffer())],[255,216,255,0]);});
test('15 collage cap excludes subtitles and audio',()=>{const image={name:'x.jpg',mime:'image/jpeg',base64:'/9j/AA=='};assert.equal(A.normalizeMessage({attachments:[...Array(15).fill(image),{name:'a.srt',mime:'text/plain',content:'x'}]}).length,16);assert.throws(()=>A.normalizeMessage({attachments:Array(16).fill(image)}),/15/);});
test('uncertain upload is never retried and prevents the send continuation',async()=>{let calls=0,sends=0;await assert.rejects(async()=>{await A.uploadAll([{name:'a'},{name:'b'}],async()=>{calls++;throw new Error('processing timeout');});sends++;});assert.equal(calls,1);assert.equal(sends,0);});
test('partial/slow uploads finish before one send and only positively failed upload retries',async()=>{const calls=[];let release;const wait=new Promise(r=>release=r);let failed=false;let sends=0;const p=A.uploadAll([{name:'srt'},{name:'image'}],async a=>{calls.push(a.name);if(a.name==='image'&&!failed){failed=true;throw Object.assign(new Error('rejected'),{retryable:true});}if(a.name==='image')await wait;}).then(()=>sends++);await new Promise(setImmediate);assert.equal(sends,0);assert.deepEqual(calls,['srt','image','image']);release();await p;assert.equal(sends,1);});
test('screenshot context preserves prompt and is absent for legacy SRT',()=>{assert.equal(A.contextualPrompt('mine',[{mime:'text/plain'}],'src'),'mine');assert.match(A.contextualPrompt('mine',[{mime:'image/jpeg'}],'src'),/^mine[\s\S]*src[\s\S]*时间/);});
