import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import vm from'node:vm';

const source=await readFile(new URL('../assets/runtime-guard.js',import.meta.url),'utf8');

function runGuard(initialText){
  let text=initialText,writes=0,mutationCallback=null;
  const strong={get textContent(){return text},set textContent(value){writes++;text=value}};
  const document={
    documentElement:{},
    querySelectorAll(selector){return selector==='.crafted strong'?[strong]:[]},
    querySelector(){return null},
    addEventListener(){},
    createElement(){return{appendChild(){},classList:{add(){},remove(){}},set textContent(value){},get textContent(){return''}}}
  };
  class MutationObserver{constructor(callback){mutationCallback=callback}observe(){}}
  const window={fetch:async()=>({ok:true,clone(){return this},async json(){return{}}})};
  vm.runInNewContext(source,{window,document,MutationObserver,setTimeout,clearTimeout,queueMicrotask,Promise,Map,JSON,encodeURIComponent,console});
  return{get text(){return text},get writes(){return writes},mutate(){mutationCallback?.([])}};
}

test('login branding polish is idempotent and cannot feed its MutationObserver forever',()=>{
  const alreadyCorrect=runGuard('ProddyG');
  assert.equal(alreadyCorrect.writes,0);
  alreadyCorrect.mutate();alreadyCorrect.mutate();
  assert.equal(alreadyCorrect.writes,0);

  const needsCorrection=runGuard('PRODDYG');
  assert.equal(needsCorrection.text,'ProddyG');
  assert.equal(needsCorrection.writes,1);
  needsCorrection.mutate();needsCorrection.mutate();
  assert.equal(needsCorrection.writes,1);
});
