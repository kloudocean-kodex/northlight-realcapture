import{spawn}from'node:child_process';
import{mkdtemp,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';

const target=process.argv[2];
const chrome=process.env.CHROME_BIN;
if(!target)throw new Error('Browser target URL is required.');
if(!chrome)throw new Error('CHROME_BIN is required.');

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profile=await mkdtemp(join(tmpdir(),'northlight-chrome-'));
let browser=null,chromeLog='';

function appendChromeLog(chunk){chromeLog=(chromeLog+String(chunk)).slice(-16000)}
async function cleanup(){
  if(browser&&!browser.killed){try{browser.kill('SIGTERM')}catch{};await sleep(150);if(browser.exitCode===null)try{browser.kill('SIGKILL')}catch{}}
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
process.once('SIGTERM',()=>cleanup().finally(()=>process.exit(143)));
process.once('SIGINT',()=>cleanup().finally(()=>process.exit(130)));

function pipeClient(input,output){
  let id=0,buffer=Buffer.alloc(0);
  const pending=new Map();
  output.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    for(;;){
      const nul=buffer.indexOf(0);if(nul<0)break;
      const raw=buffer.subarray(0,nul).toString('utf8');buffer=buffer.subarray(nul+1);
      if(!raw)continue;
      let msg;try{msg=JSON.parse(raw)}catch{continue}
      if(!msg.id||!pending.has(msg.id))continue;
      const p=pending.get(msg.id);pending.delete(msg.id);clearTimeout(p.timer);
      if(msg.error)p.reject(new Error(`${p.method}: ${msg.error.message||'protocol error'}`));else p.resolve(msg.result);
    }
  });
  output.on('error',e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e)}pending.clear()});
  return(method,params={},timeoutMs=4000,sessionId=null)=>new Promise((resolve,reject)=>{
    const commandId=++id;
    const timer=setTimeout(()=>{pending.delete(commandId);reject(new Error(`${method} timed out after ${timeoutMs}ms`))},timeoutMs);
    pending.set(commandId,{resolve,reject,timer,method});
    const message={id:commandId,method,params};if(sessionId)message.sessionId=sessionId;
    input.write(Buffer.concat([Buffer.from(JSON.stringify(message),'utf8'),Buffer.from([0])]),e=>{if(e){clearTimeout(timer);pending.delete(commandId);reject(e)}});
  });
}
const expression=`(()=>({
  ready:document.readyState,
  title:document.title,
  loginForm:!!document.getElementById('loginForm'),
  email:!!document.getElementById('email'),
  password:!!document.getElementById('password'),
  secure:document.body?.innerText.includes('Secure workspace')||false,
  crafted:document.body?.innerText.includes('Crafted by')||false,
  proddyg:document.body?.innerText.includes('ProddyG')||false
}))()`;
const valid=s=>s&&s.title==='Northlight · REALCAPTURE'&&s.loginForm&&s.email&&s.password&&s.secure&&s.crafted&&s.proddyg;

try{
  browser=spawn(chrome,[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking',
    '--remote-debugging-pipe',`--user-data-dir=${profile}`,'about:blank'
  ],{stdio:['ignore','ignore','pipe','pipe','pipe']});
  browser.stderr.on('data',appendChromeLog);
  const command=pipeClient(browser.stdio[3],browser.stdio[4]);

  let targets;
  try{targets=await command('Target.getTargets',{},8000)}catch(e){throw new Error(`Chrome DevTools pipe did not become responsive: ${e.message}. ${chromeLog}`)}
  let page=(targets?.targetInfos||[]).find(x=>x.type==='page');
  if(!page){
    const created=await command('Target.createTarget',{url:'about:blank'},5000);
    page={targetId:created?.targetId};
  }
  if(!page?.targetId)throw new Error(`Chrome DevTools pipe returned no page target. ${chromeLog}`);
  const attached=await command('Target.attachToTarget',{targetId:page.targetId,flatten:true},5000);
  const sessionId=attached?.sessionId;
  if(!sessionId)throw new Error(`Chrome DevTools pipe could not attach to page target. ${chromeLog}`);

  await command('Page.enable',{},4000,sessionId);
  await command('Runtime.enable',{},4000,sessionId);
  const nav=await command('Page.navigate',{url:target},5000,sessionId);
  if(nav?.errorText)throw new Error(`Navigation failed: ${nav.errorText}`);

  const deadline=Date.now()+20000;
  let state=null,lastError=null;
  while(Date.now()<deadline){
    try{
      const result=await command('Runtime.evaluate',{expression,returnByValue:true},Math.min(3000,Math.max(500,deadline-Date.now())),sessionId);
      state=result?.result?.value||null;
      if(valid(state))break;
      lastError=null;
    }catch(e){lastError=e}
    await sleep(250);
  }
  if(!valid(state))throw new Error(`Login did not become responsive. Last state=${JSON.stringify(state)}${lastError?` · ${lastError.message}`:''}. ${chromeLog}`);

  await sleep(1000);
  const second=await command('Runtime.evaluate',{expression,returnByValue:true},3000,sessionId);
  const sustained=second?.result?.value||null;
  if(!valid(sustained))throw new Error(`Login stopped responding after initial render. State=${JSON.stringify(sustained)}. ${chromeLog}`);
  console.log(`Real-browser main thread responsive twice at ${target} · ${sustained.ready} · ${sustained.title}`);
}finally{
  await cleanup();
}
