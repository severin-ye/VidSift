const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {publish}=require('../scripts/publish-release.cjs');
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 let id=1;const events=[];const releases=[];const contents=new Map();
 const asset=(name,data)=>{const a={id:id++,name,size:data.length,state:'uploaded',digest:'sha256:'+hash(data)};contents.set(a.id,data);return a;};
 const add=(tag,files,draft=false)=>{const r={id:id++,tag_name:tag,draft,body:'历史说明',assets:files.map(([n,d])=>asset(n,Buffer.from(d)))};releases.push(r);return r;};
 const api={
  listReleases:async()=>releases,
  listAssets:async r=>r.assets,
  createRelease:async data=>{events.push('create');return add(data.tag_name,[],true);},
  uploadAsset:async(r,name,data)=>{events.push('upload:'+name);const a=asset(name,data);r.assets.push(a);return a;},
  downloadAsset:async a=>{events.push('verify:'+a.name);return contents.get(a.id);},
  publishRelease:async r=>{events.push('publish');r.draft=false;return r;},
  deleteAsset:async a=>{events.push('delete:'+a.name);for(const r of releases)r.assets=r.assets.filter(x=>x.id!==a.id);},
  updateBody:async(r,body)=>{r.body=body;}
 };
 const input={version:'5.2.4',tag:'v5.2.4',zip:Buffer.from('verified ZIP bytes'),repository:'severin-ye/VidSift',api};
 return {api,add,events,releases,input,contents};
}
test('verified new ZIP is published before deleting only managed older assets',async()=>{
 const f=fixture();const old=f.add('v5.2.3',[['VidSift-5.2.3-standalone.zip','old'],['SHA256SUMS.txt','old hash'],['other.zip','keep']]);
 const result=await publish(f.input);assert.equal(result?.status,'published');
 assert.ok(f.events.indexOf('delete:VidSift-5.2.3-standalone.zip')>f.events.indexOf('publish'));
 assert.ok(f.events.indexOf('publish')>f.events.indexOf('verify:SHA256SUMS.txt'));
 assert.deepEqual(old.assets.map(x=>x.name),['other.zip']);assert.ok(old.body.includes('历史说明'));
});
test('failed ZIP upload preserves every old asset',async()=>{
 const f=fixture();const old=f.add('v5.2.3',[['VidSift-5.2.3-standalone.zip','old']]);f.api.uploadAsset=async()=>{throw Error('upload failed');};
 await assert.rejects(()=>publish(f.input),/upload failed/);assert.equal(old.assets.length,1);assert.ok(!f.events.some(x=>x.startsWith('delete:')));
});
test('corrupt downloaded asset blocks publication and old ZIP cleanup',async()=>{
 const f=fixture();f.add('v5.2.3',[['VidSift-5.2.3-standalone.zip','old']]);f.api.downloadAsset=async()=>Buffer.from('corrupt');
 await assert.rejects(()=>publish(f.input),/校验/);assert.ok(!f.events.includes('publish'));assert.ok(!f.events.some(x=>x.startsWith('delete:')));
});
test('rerunning identical release reuses verified assets',async()=>{
 const f=fixture();await publish(f.input);await publish(f.input);
 assert.equal(f.events.filter(x=>x==='upload:VidSift-5.2.4-standalone.zip').length,1);assert.equal(f.releases.length,1);
});
test('old tag replay performs no mutations when a newer version is published',async()=>{
 const f=fixture();f.add('v5.3.0',[['VidSift-5.3.0-standalone.zip','newer']]);
 const r=await publish(f.input);assert.equal(r?.status,'superseded');assert.deepEqual(f.events,[]);
});
test('same version with different bytes is refused without removing assets',async()=>{
 const f=fixture();const r=f.add('v5.2.4',[['VidSift-5.2.4-standalone.zip','different']]);
 await assert.rejects(()=>publish(f.input),/已存在|不同/);assert.equal(r.assets.length,1);assert.ok(!f.events.some(x=>x.startsWith('delete:')));
});
test('drafts and unversioned releases are not cleanup targets',async()=>{
 const f=fixture();const draft=f.add('v5.2.2',[['VidSift-5.2.2-standalone.zip','draft']],true);const custom=f.add('backup',[['VidSift-5.2.1-standalone.zip','custom']]);
 await publish(f.input);assert.equal(draft.assets.length,1);assert.equal(custom.assets.length,1);
});
test('cleanup failure keeps the new published ZIP and resumes on retry',async()=>{
 const f=fixture();f.add('v5.2.3',[['VidSift-5.2.3-standalone.zip','old']]);const remove=f.api.deleteAsset;f.api.deleteAsset=async()=>{throw Error('delete denied');};
 await assert.rejects(()=>publish(f.input),/delete denied/);assert.equal(f.releases.find(x=>x.tag_name==='v5.2.4').draft,false);
 f.api.deleteAsset=remove;assert.equal((await publish(f.input)).status,'published');assert.equal(f.events.filter(x=>x==='upload:VidSift-5.2.4-standalone.zip').length,1);
});
test('tag mismatch fails before remote writes',async()=>{
 const f=fixture();f.input.tag='v5.2.3';await assert.rejects(()=>publish(f.input),/版本/);assert.deepEqual(f.events,[]);
});

test('checksum upload failure leaves a resumable draft and preserves old ZIP',async()=>{
 const f=fixture();const old=f.add('v5.2.3',[['VidSift-5.2.3-standalone.zip','old']]);const upload=f.api.uploadAsset;
 f.api.uploadAsset=async(r,name,data,type)=>{if(name==='SHA256SUMS.txt')throw Error('checksum upload failed');return upload(r,name,data,type);};
 await assert.rejects(()=>publish(f.input),/checksum upload failed/);assert.equal(old.assets.length,1);assert.ok(!f.events.includes('publish'));
 f.api.uploadAsset=upload;assert.equal((await publish(f.input)).status,'published');assert.equal(f.events.filter(x=>x==='upload:VidSift-5.2.4-standalone.zip').length,1);
});
