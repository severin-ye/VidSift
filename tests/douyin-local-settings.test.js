const test=require('node:test'),assert=require('node:assert/strict');
const settings=require('../douyin-local-settings.js');
test('Douyin defaults to Groq without changing other platform choices',()=>{
 const old={transcribeService:'selfhosted',localModel:'custom/model',customPrompt:'keep'};
 const resolved=settings.resolve('douyin',old);
 assert.equal(resolved.service,'groq');assert.equal(resolved.groq.model,'whisper-large-v3-turbo');assert.equal(resolved.device,'wasm');
 assert.equal(settings.resolve('youtube',old).service,'selfhosted');assert.equal(settings.resolve('youtube',old).model,'custom/model');
 assert.deepEqual(old,{transcribeService:'selfhosted',localModel:'custom/model',customPrompt:'keep'});
});
test('Groq settings accept only tested models and bounded request timeouts',()=>{
 assert.throws(()=>settings.validateGroq({model:'unknown'}),/模型/);
 assert.throws(()=>settings.validateGroq({timeoutSeconds:0}),/超时/);
 assert.equal(settings.validateGroq({model:'whisper-large-v3'}).timeoutSeconds,180);
});
test('explicit Douyin service and settings survive subsequent upgrades',()=>{
 assert.equal(settings.resolve('douyin',{douyinTranscribeService:'global',transcribeService:'aistudio'}).service,'aistudio');
 const saved={douyinTranscribeService:'local',douyinLocalSettings:{model:'Xenova/whisper-small',threads:2}};
 assert.equal(settings.resolve('douyin',saved).model,'Xenova/whisper-small');assert.equal(settings.resolve('douyin',saved).settings.threads,2);
});
test('settings validation rejects invalid resource values instead of silently enabling unlimited work',()=>{
 assert.throws(()=>settings.validate({maxDuration:0}),/时长/);
 assert.throws(()=>settings.validate({threads:12}),/线程/);
 assert.throws(()=>settings.validate({model:'untrusted/model'}),/模型/);
 assert.throws(()=>settings.validate({cacheBytes:NaN}),/缓存/);
 assert.equal(settings.validate({}).maxSourceBytes,536870912);
});
test('saving and restoring only touches the Douyin settings block',async()=>{
 const data={customPrompt:'private draft',transcribeService:'selfhosted',audioSettings:{bitrate:'128k'},douyinLocalSettings:{threads:2}};
 const store={get:async()=>({...data}),set:async patch=>Object.assign(data,patch)};
 await settings.save(store,'local',{threads:3});assert.equal(data.douyinLocalSettings.threads,3);
 await settings.restore(store);assert.equal(data.douyinLocalSettings.threads,4);assert.equal(data.customPrompt,'private draft');
 assert.equal(data.transcribeService,'selfhosted');assert.deepEqual(data.audioSettings,{bitrate:'128k'});
});
