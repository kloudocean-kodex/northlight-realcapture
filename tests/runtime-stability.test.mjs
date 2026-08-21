import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import vm from'node:vm';

const source=await readFile(new URL('../assets/runtime-guard.js',import.meta.url),'utf8');

function runGuard(initialText){
  let text=initialText,writes=0;const listeners=new Map();
  const strong={get textContent(){return text},set textContent(value){writes++;text=value}};
  const document={
    documentElement:{},
    querySelectorAll(selector){return selector==='.crafted strong'?[strong]:[]},
    querySelector(){return null},
    addEventListener(type,fn){const rows=listeners.get(type)||[];rows.push(fn);listeners.set(type,rows)},
    createElement(){return{appendChild(){},classList:{add(){},remove(){}},set textContent(value){},get textContent(){return''}}}
  };
  const window={fetch:async()=>({ok:true,clone(){return this},async json(){return{}}})};
  vm.runInNewContext(source,{window,document,setTimeout,clearTimeout,queueMicrotask,Promise,Map,JSON,encodeURIComponent,console});
  return{get text(){return text},get writes(){return writes},render(){for(const fn of listeners.get('northlight:rendered')||[])fn()}};
}

test('login branding polish is idempotent across explicit render events',()=>{
  const alreadyCorrect=runGuard('ProddyG');
  assert.equal(alreadyCorrect.writes,0);
  alreadyCorrect.render();alreadyCorrect.render();
  assert.equal(alreadyCorrect.writes,0);

  const needsCorrection=runGuard('PRODDYG');
  assert.equal(needsCorrection.text,'ProddyG');
  assert.equal(needsCorrection.writes,1);
  needsCorrection.render();needsCorrection.render();
  assert.equal(needsCorrection.writes,1);
});
