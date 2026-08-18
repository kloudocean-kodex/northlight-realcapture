import{execFileSync}from'node:child_process';
import{cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync}from'node:fs';
import{join}from'node:path';

const root=process.cwd();
const appPath=join(root,'assets','app-v2.js');
if(existsSync(appPath)){
  const broken="</button>`}).join('')";
  const fixed="</button>`).join('')";
  const source=readFileSync(appPath,'utf8');
  const matches=source.split(broken).length-1;
  if(matches>1)throw new Error(`Northlight build guard found ${matches} Step 3 photographer-map syntax markers; manual review required.`);
  if(matches===1){
    writeFileSync(appPath,source.replace(broken,fixed));
    console.log('Northlight build guard: repaired Step 3 photographer-map syntax before validation.');
  }else{
    console.log('Northlight build guard: Step 3 photographer-map source is already normalized.');
  }
}
function walk(dir,out=[]){for(const name of readdirSync(dir)){const p=join(dir,name),s=statSync(p);if(s.isDirectory())walk(p,out);else if(name.endsWith('.js'))out.push(p)}return out}
const js=[...walk(join(root,'assets')),...walk(join(root,'functions'))];
for(const file of js)execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
const dist=join(root,'dist');if(existsSync(dist))rmSync(dist,{recursive:true,force:true});mkdirSync(dist,{recursive:true});
for(const name of ['index.html','_routes.json','_headers'])cpSync(join(root,name),join(dist,name));
cpSync(join(root,'assets'),join(dist,'assets'),{recursive:true});
console.log(`Northlight build OK: ${js.length} JavaScript files syntax-checked.`);
