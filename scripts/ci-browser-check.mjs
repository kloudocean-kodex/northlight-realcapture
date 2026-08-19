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
let browser=null,ws=null,stderr='';

function appendStderr(chunk){stderr=(stderr+String(chunk)).slice(-12000)}
async function cleanup(){
  try{ws?.close()}catch{}
  if(browser&&!browser.killed){try{browser.kill('SIGTERM')}catch{};await sleep(150);if(browser.exitCode===null)try{browser.kill('SIGKILL')}catch{}}
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
process.once('SIGTERM',()=>cleanup().finally(()=>process.exit(143)));
process.once('SIGINT',()=>cleanup().finally(()=>process.exit(130)));

function withTimeout(promise,ms,label){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${ms}ms`)),ms)})]).finally(()=>clearTimeout(timer));
}
async function waitForPageTarget(){
  const deadline=Date.now()+8000;
  let last='';
  while(Date.now()<deadline){
    try{
      const r=await fetch('http://127.0.0.1:9222/json/list');
      if(r.ok){const list=await r.json(),page=list.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);if(page)return page;last=`targets=${list.length}`}
      else last=`HTTP ${r.status}`;
    }catch(e){last=e.message}
    if(browser?.exitCode!==null)throw new Error(`Chrome exited before DevTools became ready (${browser.exitCode}). ${stderr}`);
    await sleep(100);
  }
  throw new Error(`Chrome DevTools did not become ready: ${last}. ${stderr}`);
}
function openSocket(url){
  return withTimeout(new Promise((resolve,reject)=>{
    const socket=new WebSocket(url);
    socket.addEventListener('open',()=>resolve(socket),{once:true});
    socket.addEventListener('error',()=>reject(new Error('Could not connect to Chrome DevTools WebSocket.')),{once:true});
  }),5000,'DevTools WebSocket connection');
}
function client(socket){
  let id=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    let msg;try{msg=JSON.parse(String(event.data))}catch{return}
    if(!msg.id||!pending.has(msg.id))return;
    const p=pending.get(msg.id);pending.delete(msg.id);clearTimeout(p.timer);
    if(msg.error)p.reject(new Error(`${p.method}: ${msg.error.message||'protocol error'}`));else p.resolve(msg.result);
  });
  return(method,params={},timeoutMs=4000)=>new Promise((resolve,reject)=>{
    const commandId=++id;
    const timer=setTimeout(()=>{pending.delete(commandId);reject(new Error(`${method} timed out after ${timeoutMs}ms`))},timeoutMs);
    pending.set(commandId,{resolve,reject,timer,method});
    socket.send(JSON.stringify({id:commandId,method,params}));
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
    '--remote-debugging-port=9222',`--user-data-dir=${profile}`,'about:blank'
  ],{stdio:['ignore','ignore','pipe']});
  browser.stderr.on('data',appendStderr);
  const page=await waitForPageTarget();
  ws=await openSocket(page.webSocketDebuggerUrl);
  const command=client(ws);
  await command('Page.enable');
  await command('Runtime.enable');
  const nav=await command('Page.navigate',{url:target},5000);
  if(nav?.errorText)throw new Error(`Navigation failed: ${nav.errorText}`);

  const deadline=Date.now()+20000;
  let state=null,lastError=null;
  while(Date.now()<deadline){
    try{
      const result=await command('Runtime.evaluate',{expression,returnByValue:true},Math.min(3000,Math.max(500,deadline-Date.now())));
      state=result?.result?.value||null;
      if(valid(state))break;
      lastError=null;
    }catch(e){lastError=e}
    await sleep(250);
  }
  if(!valid(state))throw new Error(`Login did not become responsive. Last state=${JSON.stringify(state)}${lastError?` · ${lastError.message}`:''}`);

  await sleep(1000);
  const second=await command('Runtime.evaluate',{expression,returnByValue:true},3000);
  const sustained=second?.result?.value||null;
  if(!valid(sustained))throw new Error(`Login stopped responding after initial render. State=${JSON.stringify(sustained)}`);
  console.log(`Real-browser main thread responsive twice at ${target} · ${sustained.ready} · ${sustained.title}`);
}finally{
  await cleanup();
}
