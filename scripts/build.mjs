import{execFileSync}from'node:child_process';
import{cpSync,existsSync,mkdirSync,readdirSync,rmSync,statSync}from'node:fs';
import{join}from'node:path';

const root=process.cwd();
function walk(dir,out=[]){for(const name of readdirSync(dir)){const p=join(dir,name),s=statSync(p);if(s.isDirectory())walk(p,out);else if(name.endsWith('.js'))out.push(p)}return out}
const js=[...walk(join(root,'assets')),...walk(join(root,'functions'))];
for(const file of js)execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
const dist=join(root,'dist');if(existsSync(dist))rmSync(dist,{recursive:true,force:true});mkdirSync(dist,{recursive:true});
for(const name of ['index.html','_routes.json','_headers'])cpSync(join(root,name),join(dist,name));
cpSync(join(root,'assets'),join(dist,'assets'),{recursive:true});
console.log(`Northlight build OK: ${js.length} JavaScript files syntax-checked.`);
