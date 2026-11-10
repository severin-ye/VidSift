const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');process.chdir(path.resolve(__dirname,'..'));
for(const file of fs.readdirSync('.').filter(x=>x.endsWith('.js'))){const r=cp.spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status)throw Error(file+': '+r.stderr);}
const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
const files=[manifest.background.service_worker,manifest.action.default_popup,manifest.options_ui.page,...manifest.content_scripts.flatMap(x=>x.js),...Object.values(manifest.icons)];
for(const file of files)if(!fs.existsSync(file))throw Error('Manifest resource missing: '+file);
for(const html of ['popup.html','options.html','offscreen.html'])for(const m of fs.readFileSync(html,'utf8').matchAll(/(?:src|href)="([^"#]+)"/g))if(!/^(https?:|data:)/.test(m[1])&&!fs.existsSync(m[1]))throw Error(html+' missing '+m[1]);
const crypto=require('node:crypto');const id=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
if(id!=='kggdkncbamdlhhihfkeldbbkppkgihad')throw Error('独立扩展身份发生变化');
console.log('Syntax, manifest assets and standalone extension ID verified: '+id);
