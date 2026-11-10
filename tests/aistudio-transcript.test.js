const test=require('node:test'),assert=require('node:assert/strict'),{parse}=require('../aistudio-transcript.js');
const full='1\n00:00:00,000 --> 00:00:05,000\n第一句。\n\n2\n00:00:05,000 --> 00:00:10,000\n第二句。';
const mark='[转写完成 00:00:10]';
test('complete SRT validates from plain text or a fenced response and strips marker',()=>{
 assert.equal(parse(full+'\n'+mark,10),full);
 assert.equal(parse('完整字幕如下：\n```srt\n'+full+'\n```\n'+mark,10),full);
 assert.equal(parse('```srt\n'+full+'\n'+mark+'\n```',10),full);
});
for(const [label,text,duration] of [
 ['missing completion marker',full,10],
 ['duplicate marker',full+'\n'+mark+'\n'+mark,10],
 ['wrong duration',full+'\n'+mark,100],
 ['missing duration',full+'\n'+mark,undefined],
 ['bad timestamp',full.replace('00:00:05,000','00:61:05,000')+'\n'+mark,10],
 ['missing sequence',full.replace('\n\n2\n','\n\n3\n')+'\n'+mark,10],
 ['empty caption',full.replace('第二句。','')+'\n'+mark,10],
 ['reverse timestamp',full.replace('00:00:10,000','00:00:04,000')+'\n'+mark,10],
 ['over duration',full.replace('00:00:10,000','00:00:15,000')+'\n'+mark,10],
 ['partial tail with a completion marker','1\n00:00:00,000 --> 00:00:03,000\n残稿\n'+mark,10],
 ['partial beginning','1\n00:00:05,000 --> 00:00:10,000\n残稿\n'+mark,10],
 ['multiple code blocks','```srt\n'+full+'\n```\n```srt\n'+full+'\n```\n'+mark,10],
])test(label+' is rejected instead of relayed',()=>assert.throws(()=>parse(text,duration),/未转交 GPT/));
test('short trailing silence is accepted within the explicit coverage tolerance',()=>{
 assert.equal(parse(full.replace('00:00:10,000','00:00:09,000')+'\n'+mark,10).includes('00:00:09,000'),true);
});
