'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const hash=data=>createHash('sha256').update(data).digest('hex');
function versionParts(tag){
 const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
 return match?match.slice(1).map(BigInt):null;
}
function compare(a,b){
 const x=versionParts(a),y=versionParts(b);
 for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;
 return 0;
}
async function publish({version,tag,zip,repository,api}){
 if(!versionParts(version)||tag!==`v${version}`)throw Error('标签必须与 package.json 版本一致');
 if(!Buffer.isBuffer(zip)||!zip.length)throw Error('ZIP 文件为空');
 const published=await api.listReleases();
 if(published.some(r=>!r.draft&&versionParts(r.tag_name)&&compare(r.tag_name,tag)>0))return {status:'superseded',tag};
 let release=published.find(r=>r.tag_name===tag);
 const name=`VidSift-${version}-standalone.zip`;
 const checksum=Buffer.from(`${hash(zip)}  ${name}\n`);
 const body=`<!-- vidsift-auto-release -->\n## 下载与安装\n\n在下方 Assets 下载 **${name}**，全部解压后，在 Chrome / Edge 扩展管理页开启开发者模式，选择“加载已解压的扩展程序”。无需克隆代码或运行 npm，请不要选择 Source code。\n\nYouTube、抖音和图片提取还需要 Windows 本机程序，详见包内 INSTALL.md。\n\n本版本仍为测试版；完整真实登录态视频处理流程的验证边界见 README。\n\nSHA256SUMS.txt 用于校验 ZIP；新版本通过上传校验后，脚本会删除旧版扩展 ZIP，保留版本标签及发布说明。`;
 if(!release)release=await api.createRelease({tag_name:tag,name:`知行视频总结 ${tag}（测试版）`,body,draft:true,prerelease:true,make_latest:'false'});
 async function ensureAsset(assetName,data,type){
  let asset=(await api.listAssets(release)).find(a=>a.name===assetName);
  const digest='sha256:'+hash(data);
  if(asset&&(asset.state!=='uploaded'||asset.size!==data.length||asset.digest!==digest))throw Error(`${assetName} 已存在但内容不同；不覆盖已发布资产`);
  if(!asset)asset=await api.uploadAsset(release,assetName,data,type);
  const downloaded=await api.downloadAsset(asset);
  if(asset.state!=='uploaded'||downloaded.length!==data.length||hash(downloaded)!==hash(data))throw Error(`${assetName} 下载校验失败，保留旧 ZIP`);
  return asset;
 }
 await ensureAsset(name,zip,'application/zip');
 await ensureAsset('SHA256SUMS.txt',checksum,'text/plain');
 if(release.draft)release=await api.publishRelease(release);
 if(release.draft)throw Error('新版发布未确认，保留旧 ZIP');
 const releases=await api.listReleases();
 // A newer release created outside this workflow also prevents stale cleanup.
 if(releases.some(r=>!r.draft&&versionParts(r.tag_name)&&compare(r.tag_name,tag)>0))return {status:'superseded',tag};
 const deleted=[];
 for(const older of releases){
  if(older.draft||!versionParts(older.tag_name)||compare(older.tag_name,tag)>=0)continue;
  const assets=await api.listAssets(older);
  const oldZip=assets.find(a=>a.name===`VidSift-${older.tag_name.replace(/^v/,'')}-standalone.zip`);
  if(!oldZip)continue;
  await api.deleteAsset(oldZip);deleted.push(`${older.tag_name}/${oldZip.name}`);
  const oldSum=assets.find(a=>a.name==='SHA256SUMS.txt');
  if(oldSum)await api.deleteAsset(oldSum);
  const notice=`> 扩展 ZIP 已移至[最新版下载页](https://github.com/${repository}/releases)，本页保留历史发布说明。`;
  if(!(older.body||'').includes(notice))await api.updateBody(older,`${notice}\n\n${older.body||''}`);
 }
 return {status:'published',tag,sha256:hash(zip),deleted,url:`https://github.com/${repository}/releases/tag/${tag}`};
}
function githubApi(repository,token){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Invalid repository');
 if(!token)throw Error('GITHUB_TOKEN is required');
 const root=`https://api.github.com/repos/${repository}`;
 async function request(url,{method='GET',data,type,bytes=false}={}){
  const target=new URL(url);
  if(target.protocol!=='https:'||!['api.github.com','uploads.github.com'].includes(target.hostname))throw Error('Unexpected GitHub API host');
  const headers={Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28',Accept:bytes?'application/octet-stream':'application/vnd.github+json'};
  let body;
  if(data!==undefined){headers['Content-Type']=type||'application/json';body=Buffer.isBuffer(data)?data:JSON.stringify(data);}
  const response=await fetch(url,{method,headers,body,signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(`GitHub ${method} ${target.pathname}: HTTP ${response.status}`);
  if(response.status===204)return;
  return bytes?Buffer.from(await response.arrayBuffer()):response.json();
 }
 async function paginate(endpoint){
  const all=[];
  for(let page=1;;page++){
   const rows=await request(`${root}${endpoint}?per_page=100&page=${page}`);all.push(...rows);
   if(rows.length<100)return all;
  }
 }
 return {
  listReleases:()=>paginate('/releases'),
  listAssets:r=>paginate(`/releases/${r.id}/assets`),
  createRelease:data=>request(`${root}/releases`,{method:'POST',data}),
  uploadAsset:(r,name,data,type)=>request(`${r.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`,{method:'POST',data,type}),
  downloadAsset:a=>request(`${root}/releases/assets/${a.id}`,{bytes:true}),
  publishRelease:r=>request(`${root}/releases/${r.id}`,{method:'PATCH',data:{draft:false}}),
  deleteAsset:a=>request(`${root}/releases/assets/${a.id}`,{method:'DELETE'}),
  updateBody:(r,body)=>request(`${root}/releases/${r.id}`,{method:'PATCH',data:{body}})
 };
}
async function main(){
 const project=path.resolve(__dirname,'..');
 const {version}=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8'));
 const tag=process.env.RELEASE_TAG;
 if(tag!==`v${version}`)throw Error('版本标签与 package.json 不一致');
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'}).trim();
 const tagged=execFileSync('git',['rev-parse',`refs/tags/${tag}^{commit}`],{cwd:project,encoding:'utf8'}).trim();
 if(head!==tagged)throw Error('工作目录并非该版本标签的提交');
 const repository=process.env.GITHUB_REPOSITORY;
 const result=await publish({version,tag,repository,zip:fs.readFileSync(path.join(project,'dist',`VidSift-${version}-standalone.zip`)),api:githubApi(repository,process.env.GITHUB_TOKEN)});
 console.log(JSON.stringify(result,null,2));
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## 自动发布\n\n状态：${result.status}\n\n版本：${tag}\n\n${result.url||''}\n\n旧 ZIP 清理：${(result.deleted||[]).length} 份\n`);
}
module.exports={publish};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
