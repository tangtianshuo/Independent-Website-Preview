import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink,access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
let installBundle,extractBundleArchive;
try { ({installBundle,extractBundleArchive}=await import('../ops/install-bundle.mjs')); } catch {}
const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'install-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const stagingDir=join(root,'staging');const bundlesRoot=join(root,'bundles'); await mkdir(stagingDir);
 const files=[{path:'index.html',size:5,checksum:hash('hello')}];
 const record={id:'aeroframe',version:'1.0.4',manifestChecksum:`sha256:${'1'.repeat(64)}`,sourceCommit:'a'.repeat(40),bundleDigest:`sha256:${hash(JSON.stringify(files))}`,artifactDigest:`sha256:${'2'.repeat(64)}`,bundlePath:'templates/aeroframe/1.0.4',adapterVersion:'1',protocolVersion:1,status:'available'};
 await writeFile(join(stagingDir,'index.html'),'hello');
 await writeFile(join(stagingDir,'preview-bundle.json'),JSON.stringify({schemaVersion:1,templateId:record.id,templateVersion:record.version,protocolVersion:1,manifestChecksum:record.manifestChecksum,sourceCommit:record.sourceCommit,bundleDigest:record.bundleDigest,files}));
 return {root,stagingDir,bundlesRoot,record,registryPath:join(root,'registry/preview/index.json')};
}
test('installs verified bundle before registry visibility and is idempotent',async t=>{
 assert.equal(typeof installBundle,'function'); const f=await fixture(t);
 assert.equal(await installBundle(f),'installed');assert.equal(await installBundle(f),'unchanged');
 assert.equal(JSON.parse(await readFile(f.registryPath,'utf8')).records[0].bundleDigest,f.record.bundleDigest);
 assert.equal(await readFile(join(f.bundlesRoot,'aeroframe/1.0.4/index.html'),'utf8'),'hello');
});
for(const mutation of ['missing','checksum','traversal','symlink','extra','digest','identity']) test(`rejects ${mutation} without replacing installed bytes or registry`,async t=>{
 assert.equal(typeof installBundle,'function'); const f=await fixture(t); await installBundle(f);const before=await readFile(f.registryPath,'utf8');
 const p=join(f.stagingDir,'index.html');const mp=join(f.stagingDir,'preview-bundle.json');const m=JSON.parse(await readFile(mp,'utf8'));
 if(mutation==='missing')await rm(p);if(mutation==='checksum')await writeFile(p,'wrong');if(mutation==='symlink'){await rm(p);await symlink('/etc/hosts',p);}if(mutation==='extra')await writeFile(join(f.stagingDir,'extra'),'x');if(mutation==='traversal')m.files[0].path='../escape';if(mutation==='digest')m.bundleDigest=`sha256:${'f'.repeat(64)}`;if(mutation==='identity')m.sourceCommit='f'.repeat(40);
 await writeFile(mp,JSON.stringify(m)); await assert.rejects(installBundle(f));
 assert.equal(await readFile(join(f.bundlesRoot,'aeroframe/1.0.4/index.html'),'utf8'),'hello'); assert.equal(await readFile(f.registryPath,'utf8'),before);
});
test('different valid content for an installed identity conflicts',async t=>{assert.equal(typeof installBundle,'function');const f=await fixture(t);await installBundle(f);const p=join(f.stagingDir,'preview-bundle.json');const m=JSON.parse(await readFile(p,'utf8'));m.files[0].checksum=hash('other');m.bundleDigest=`sha256:${hash(JSON.stringify(m.files))}`;await writeFile(join(f.stagingDir,'index.html'),'other');await writeFile(p,JSON.stringify(m));await assert.rejects(installBundle({...f,record:{...f.record,bundleDigest:m.bundleDigest}}),/conflict/i);});
test('registry failure leaves no published target',async t=>{assert.equal(typeof installBundle,'function');const f=await fixture(t);await writeFile(join(f.root,'blocked'),'x');await assert.rejects(installBundle({...f,registryPath:join(f.root,'blocked/index.json')}));await assert.rejects(access(join(f.bundlesRoot,'aeroframe/1.0.4')));});

import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
function archive(entries) {
 const chunks=[];
 for(const {path,type='0',body=''} of entries){const h=Buffer.alloc(512);h.write(path,0,100);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(Buffer.byteLength(body).toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write('00',263);h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,Buffer.from(body),Buffer.alloc((512-Buffer.byteLength(body)%512)%512));}
 chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks));
}
for(const [name,entries] of Object.entries({traversal:[{path:'../escape'}],absolute:[{path:'/escape'}],symlink:[{path:'link',type:'2'}],hardlink:[{path:'link',type:'1'}],device:[{path:'device',type:'3'}],duplicate:[{path:'index.html'},{path:'index.html'}],collision:[{path:'dir'},{path:'dir/file'}]}))test(`rejects ${name} archive before extraction`,async t=>{
 const f=await fixture(t);const stagingDir=join(f.root,'extract');await mkdir(stagingDir);const archivePath=join(f.root,'bad.tar.gz');await writeFile(archivePath,archive(entries));await assert.rejects(extractBundleArchive({archivePath,stagingDir}));assert.deepEqual(await (await import('node:fs/promises')).readdir(stagingDir),[]);
});
test('extracts only checked regular ustar files',async t=>{const f=await fixture(t);const stagingDir=join(f.root,'extract');await mkdir(stagingDir);const archivePath=join(f.root,'bundle.tar.gz');await writeFile(archivePath,archive([{path:'./',type:'5'},{path:'./index.html',body:'hello'}]));await extractBundleArchive({archivePath,stagingDir});assert.equal(await readFile(join(stagingDir,'index.html'),'utf8'),'hello');});
test('concurrent configured installs retain registry entries',async t=>{const f=await fixture(t);const second={...f.record,id:'fireguard',bundlePath:'templates/fireguard/1.0.4'};const other=join(f.root,'other');await (await import('node:fs/promises')).cp(f.stagingDir,other,{recursive:true});const p=join(other,'preview-bundle.json');const m=JSON.parse(await readFile(p,'utf8'));m.templateId=second.id;await writeFile(p,JSON.stringify(m));await Promise.all([installBundle(f),installBundle({...f,stagingDir:other,record:second})]);assert.equal(JSON.parse(await readFile(f.registryPath,'utf8')).records.length,2);});
test('base interface installs; retry registers verified orphan after killed lock owner',async t=>{
 const f=await fixture(t);assert.equal(await installBundle({stagingDir:f.stagingDir,bundlesRoot:f.bundlesRoot,record:f.record}),'installed');
 const child=spawn(process.execPath,['--input-type=module','-e',`import {mkdir,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; const lock=join(process.argv[1],'.install.lock'); await mkdir(lock);await writeFile(join(lock,process.pid+'-terminated-test'),'');process.send('locked');setInterval(()=>{},1000);`,f.bundlesRoot],{stdio:['ignore','ignore','inherit','ipc']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});await once(child,'message');child.kill('SIGKILL');await once(child,'exit');
 assert.equal(await installBundle(f),'installed');assert.equal(await installBundle(f),'unchanged');assert.equal(JSON.parse(await readFile(f.registryPath,'utf8')).records.length,1);
});
