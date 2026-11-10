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


test('mixed omitted hours remain absolute across ten minutes and one hour',()=>{
 const input='1\n00:00:00,000 --> 10:00,000\n第一句 10:00,000 保持原文。\n\n2\n10:00,000 --> 01:00:00,000\n第二句。\n\n3\n60:00,000 --> 72:03,123\n第三句。';
 const expected=input.replace(' --> 10:00,000',' --> 00:10:00,000').replace('\n10:00,000 -->','\n00:10:00,000 -->').replace('\n60:00,000 --> 72:03,123','\n01:00:00,000 --> 01:12:03,123');
 assert.equal(parse(input+'\n[转写完成 01:12:03]',4323.123),expected);
});
test('omitted-hour normalization preserves caption text and original cue separators',()=>{
 const input='1\n00:00,000\t--> 00:05,000 \n口播中的 32:54,500、00:00:05,000 和编号 2 不变。\n \n\n2\n00:05,000 --> 00:10,000\n结尾。';
 const expected=input.replace('00:00,000\t--> 00:05,000','00:00:00,000\t--> 00:00:05,000').replace('\n00:05,000 --> 00:10,000','\n00:00:05,000 --> 00:00:10,000');
 assert.equal(parse(input+'\n'+mark,10),expected);
});
for(const [label,timing] of [
 ['single-digit minutes','0:00,000 --> 00:10,000'],
 ['invalid seconds','00:00,000 --> 00:60,000'],
 ['two-digit milliseconds','00:00,00 --> 00:10,000'],
 ['four-digit milliseconds','00:00,0000 --> 00:10,000'],
 ['period milliseconds','00:00.000 --> 00:10,000'],
 ['incomplete clock','00:00,000 --> 00:10'],
 ['timing with extra text','00:00,000 --> 00:10,000 extra'],
 ['negative clock','-00:00,000 --> 00:10,000'],
 ['invalid explicit hour clock','00:60:00,000 --> 01:00:10,000'],
])test(label+' is not guessed by clock normalization',()=>{
 assert.throws(()=>parse('1\n'+timing+'\n字幕。\n'+mark,10),/未转交 GPT/);
});
test('omitted-hour clocks cannot reset after an earlier absolute cue',()=>{
 const input='1\n00:00:00,000 --> 00:05:00,000\n第一句。\n\n2\n00:00,000 --> 10:00,000\n重置。\n[转写完成 00:10:00]';
 assert.throws(()=>parse(input,600),/时间范围不连续/);
});
test('normalized clocks retain duration, marker, numbering and boundary checks',()=>{
 const input=full.replaceAll('00:00:','00:');
 assert.throws(()=>parse(input+'\n[转写完成 00:00:20]',10),/标记与音频时长不符/);
 assert.throws(()=>parse(input.replace('00:10,000','00:15,000')+'\n'+mark,10),/超出音频/);
 assert.throws(()=>parse(input.replace('\n\n2\n','\n\n3\n')+'\n'+mark,10),/编号/);
 assert.throws(()=>parse('1\n00:05,000 --> 00:10,000\n遗漏开头。\n'+mark,10),/首尾/);
 assert.throws(()=>parse('1\n00:00,000 --> 00:03,000\n遗漏结尾。\n'+mark,10),/首尾/);
 assert.throws(()=>parse('1\n00:05,000 --> 00:04,000\n倒序。\n'+mark,10),/时间范围/);
});

test('overlapping normalized cues and abbreviated completion markers remain rejected',()=>{
 const overlap='1\n00:00,000 --> 00:05,000\n第一句。\n\n2\n00:04,000 --> 00:10,000\n重叠。';
 assert.throws(()=>parse(overlap+'\n'+mark,10),/时间范围不连续/);
 assert.throws(()=>parse(full+'\n[转写完成 00:10]',10),/完成标记/);
});
