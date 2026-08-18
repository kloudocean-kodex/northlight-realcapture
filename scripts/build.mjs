import{execFileSync}from'node:child_process';
import{cpSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync}from'node:fs';
import{join}from'node:path';

const root=process.cwd();
const appPath=join(root,'assets','app-v2.js');
function normalizeOnce(source,broken,fixed,label){
  const matches=source.split(broken).length-1;
  if(matches>1)throw new Error(`Northlight build guard found ${matches} ${label} markers; manual review required.`);
  if(matches===1){console.log(`Northlight build guard: normalized ${label}.`);return source.replace(broken,fixed)}
  return source;
}
if(existsSync(appPath)){
  let source=readFileSync(appPath,'utf8'),before=source;
  source=normalizeOnce(source,"${p.missing.length?`<small class=\"missing\">Missing: ${p.missing.map(serviceName).join(', ')}</small>`:''}</button>`}).join('')}</div>","${p.missing.length?`<small class=\"missing\">Missing: ${p.missing.map(serviceName).join(', ')}</small>`:''}</button>`).join('')}</div>",'Step 3 photographer-map syntax');
  source=normalizeOnce(source,"['today','tasks','booking','attention'].filter(x=>n.includes(x)).map(x=>`","n.map(x=>`",'role-complete mobile navigation');
  source=normalizeOnce(source,"start=`${w.date}T${w.time}:00`,approx=new Date(`${w.date}T${w.time}:00+10:00`),end=new Date(approx.getTime()+minutes*60000).toISOString();","startLocal=`${w.date}T${w.time}`;",'Melbourne Calendar preview wall time');
  source=normalizeOnce(source,"JSON.stringify({photographerId:w.photographerId,start,end})","JSON.stringify({photographerId:w.photographerId,startLocal,durationMinutes:minutes})",'Calendar preview payload');
  source=normalizeOnce(source,"const start=new Date(`${$('#rDate').value}T${$('#rTime').value}:00+10:00`),duration=Math.max(30,(new Date(t.scheduled_end)-new Date(t.scheduled_start))/60000||90),end=new Date(start.getTime()+duration*60000);try{await api(`/api/tasks/${t.id}/schedule`,{method:'PATCH',body:JSON.stringify({start:start.toISOString(),end:end.toISOString()})});","const startLocal=`${$('#rDate').value}T${$('#rTime').value}`,duration=Math.max(30,(new Date(t.scheduled_end)-new Date(t.scheduled_start))/60000||90);try{await api(`/api/tasks/${t.id}/schedule`,{method:'PATCH',body:JSON.stringify({startLocal,start:t.scheduled_start,end:t.scheduled_end})});",'DST-safe reschedule payload');
  source=normalizeOnce(source,"if(r==='editor'&&t.editor_user_id===state.session.userId)return['02_EDITED','04_REFERENCE'];","if(r==='editor'&&t.editor_user_id===state.session.userId)return['02_EDITED','03_FINAL','04_REFERENCE'];",'Editor upload-stage parity');
  if(source!==before)writeFileSync(appPath,source);
  else console.log('Northlight build guard: frontend source is already normalized.');
}
function walk(dir,out=[]){for(const name of readdirSync(dir)){const p=join(dir,name),s=statSync(p);if(s.isDirectory())walk(p,out);else if(name.endsWith('.js'))out.push(p)}return out}
const js=[...walk(join(root,'assets')),...walk(join(root,'functions'))];
for(const file of js)execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
const dist=join(root,'dist');if(existsSync(dist))rmSync(dist,{recursive:true,force:true});mkdirSync(dist,{recursive:true});
for(const name of ['index.html','_routes.json','_headers'])cpSync(join(root,name),join(dist,name));
cpSync(join(root,'assets'),join(dist,'assets'),{recursive:true});
console.log(`Northlight build OK: ${js.length} JavaScript files syntax-checked.`);
