const test=require('node:test'),assert=require('node:assert/strict');
const settings=require('../douyin-local-settings.js');
test('all platforms share Groq default and respect subsequent explicit shared selections',()=>{
 for(const platform of ['bilibili','youtube','douyin']){
  const value=settings.resolve(platform,{});assert.equal(value.service,'groq');assert.equal(value.groq.model,'whisper-large-v3-turbo');
  assert.equal(settings.resolve(platform,{transcribeService:'selfhosted'}).service,'selfhosted');
 }
});

test('Groq settings accept only tested models and bounded request timeouts',()=>{
 assert.throws(()=>settings.validateGroq({model:'unknown'}),/模型/);
 assert.throws(()=>settings.validateGroq({timeoutSeconds:0}),/超时/);
 assert.equal(settings.validateGroq({model:'whisper-large-v3'}).timeoutSeconds,180);
});
test('shared service and existing audio parameters remain distinct',()=>{
 assert.equal(settings.resolve('douyin',{douyinTranscribeService:'global',transcribeService:'aistudio'}).service,'aistudio');
 const saved={douyinTranscribeService:'local',douyinLocalSettings:{model:'Xenova/whisper-small',threads:2}};
 assert.equal(settings.resolve('douyin',saved).service,'groq');assert.equal(settings.resolve('douyin',saved).model,'Xenova/whisper-small');assert.equal(settings.resolve('douyin',saved).settings.threads,2);
});
test('settings validation rejects invalid resource values instead of silently enabling unlimited work',()=>{
 assert.throws(()=>settings.validate({maxDuration:0}),/时长/);
 assert.throws(()=>settings.validate({threads:12}),/线程/);
 assert.throws(()=>settings.validate({model:'untrusted/model'}),/模型/);
 assert.throws(()=>settings.validate({cacheBytes:NaN}),/缓存/);
 assert.equal(settings.validate({}).maxSourceBytes,536870912);
});
test('saving and restoring the shared block preserves unrelated prompt and audio settings',async()=>{
 const data={customPrompt:'private draft',transcribeService:'selfhosted',audioSettings:{bitrate:'128k'},douyinLocalSettings:{threads:2}};
 const store={get:async()=>({...data}),set:async patch=>Object.assign(data,patch)};
 await settings.save(store,'local',{threads:3});assert.equal(data.douyinLocalSettings.threads,3);
 await settings.restore(store);assert.equal(data.douyinLocalSettings.threads,4);assert.equal(data.customPrompt,'private draft');
 assert.equal(data.transcribeService,'groq');assert.deepEqual(data.audioSettings,{bitrate:'128k'});
});

test('one-time unified default migration preserves all data and later explicit service choices',async()=>{
 const data={transcribeService:'aistudio',douyinTranscribeService:'groq',customPrompt:'keep',videoLibraryState:{pending:[1]},groqSettings:{model:'whisper-large-v3'},selfHostedApiToken:'retain'};
 const store={get:async()=>({...data}),set:async patch=>Object.assign(data,patch)};
 await settings.migrate(store);assert.equal(data.transcribeService,'groq');assert.equal(data.customPrompt,'keep');assert.deepEqual(data.videoLibraryState,{pending:[1]});assert.equal(data.groqSettings.model,'whisper-large-v3');assert.equal(data.selfHostedApiToken,'retain');
 data.transcribeService='local';await settings.migrate(store);assert.equal(data.transcribeService,'local');
});
