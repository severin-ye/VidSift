const {test}=require('node:test');
const assert=require('node:assert/strict');
const P=require('../platforms.js');
test('identifies current part and supported SPA video forms',()=>{
 assert.equal(P.identify('https://www.bilibili.com/video/BV123abc?p=2').key,'bilibili:BV123abc:2');
 assert.equal(P.identify('https://www.youtube.com/watch?v=abc123XYZ_0&list=foo').key,'youtube:abc123XYZ_0');
 assert.equal(P.identify('https://www.youtube.com/shorts/abc123XYZ_0').key,'youtube:abc123XYZ_0');
 assert.equal(P.identify('https://www.douyin.com/?modal_id=123456789').key,'douyin:123456789');
 assert.equal(P.identify('https://www.bilibili.com/list/watchlater?bvid=BV123abc&p=3').key,'bilibili:BV123abc:3');
});
test('rejects spoofed hosts and arbitrary URLs',()=>{
 for(const u of ['https://youtube.com.evil.test/watch?v=abc123XYZ_0','file:///a.mp4','https://example.com/video/123']) assert.equal(P.identify(u),null);
});
test('SRT preserves timestamps with safe millisecond carry',()=>{
 assert.equal(P.srtTime(59.9999),'00:01:00,000');
 assert.match(P.toSrt([{from:1.25,to:2.5,content:'hello'}]),/00:00:01,250 --> 00:00:02,500\nhello/);
 assert.throws(()=>P.toSrt([{from:NaN,to:2,content:'bad'}]));
});
test('SSE result handles CRLF and multiline events and rejects missing results',async()=>{
 const response=new Response('event: status\r\ndata: {"text":"working"}\r\n\r\nevent: result\r\ndata: {"srt":"valid"}\r\n\r\n');
 assert.equal(await P.readTranscription(response,()=>{}),'valid');
 await assert.rejects(()=>P.readTranscription(new Response('event: status\ndata: {}\n\n'),()=>{}),/未返回/);
});
