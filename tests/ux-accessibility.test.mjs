import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {MiniDocument,MiniNode,createAppHarness,parseHTML} from './ui-dom-harness.mjs';

const uxSource=await readFile(new URL('../assets/ux-runtime.js',import.meta.url),'utf8');
const iconSource=await readFile(new URL('../assets/icons.js',import.meta.url),'utf8');
const designCss=await readFile(new URL('../assets/design-system.css',import.meta.url),'utf8');
const indexSource=await readFile(new URL('../index.html',import.meta.url),'utf8');

function loadUx(){
  const document=new MiniDocument(),listeners=new Map(),window={fetch:async()=>({ok:true,async json(){return{}},clone(){return this}}),NLIcon:name=>`<svg data-icon="${name}" aria-hidden="true"></svg>`,addEventListener(type,fn){listeners.set(type,fn)}};
  class MutationObserver{constructor(fn){this.fn=fn}observe(){}}
  vm.runInNewContext(uxSource,{window,document,MutationObserver,queueMicrotask,setTimeout,clearTimeout,location:{reload(){}},JSON,String,Promise,Map,Set,encodeURIComponent,console});
  return{document,window,listeners,api:window.NorthlightA11y};
}

test('task search executes against rendered task-row selectors and announces exact result counts',()=>{
  const h=loadUx(),page=new MiniNode('section',{id:'page'},h.document);page.innerHTML='<button class="task-row">RC-1001 · 24 Albany Road · Toorak · Alex Able</button><button class="task-row">RC-1002 · 7 Bay Street · Brighton · Blair Busy</button><button class="task-row">RC-1003 · 10 Queen Street · Melbourne · Alex Able</button>';h.document.body.appendChild(page);
  const input=new MiniNode('input',{},h.document),count=new MiniNode('span',{},h.document),empty=new MiniNode('div',{},h.document);
  input.value='Alex';h.api.applyTaskSearch(input,count,empty);
  assert.deepEqual(page.querySelectorAll('.task-row').map(x=>x.hidden),[false,true,false]);
  assert.equal(count.textContent,'2 of 3 tasks');assert.equal(count.getAttribute('aria-label'),'2 of 3 tasks match your search');assert.equal(empty.hidden,true);
  input.value='nonexistent';h.api.applyTaskSearch(input,count,empty);
  assert.deepEqual(page.querySelectorAll('.task-row').map(x=>x.hidden),[true,true,true]);assert.equal(count.textContent,'0 of 3 tasks');assert.equal(empty.hidden,false);
  input.value='';h.api.applyTaskSearch(input,count,empty);
  assert.deepEqual(page.querySelectorAll('.task-row').map(x=>x.hidden),[false,false,false]);assert.equal(count.textContent,'3 tasks');assert.equal(empty.hidden,true);
});

test('focus trap cycles forward, backward and safely handles an empty dialog',()=>{
  const h=loadUx(),root=new MiniNode('div',{},h.document),first=new MiniNode('button',{},h.document),last=new MiniNode('button',{},h.document);root.append(first,last);root.querySelectorAll=()=>[first,last];
  let prevented=0;h.document.activeElement=last;h.api.trapFocus({key:'Tab',shiftKey:false,preventDefault(){prevented++}},root);assert.equal(h.document.activeElement,first);assert.equal(prevented,1);
  h.document.activeElement=first;h.api.trapFocus({key:'Tab',shiftKey:true,preventDefault(){prevented++}},root);assert.equal(h.document.activeElement,last);assert.equal(prevented,2);
  root.querySelectorAll=()=>[];h.api.trapFocus({key:'Tab',shiftKey:false,preventDefault(){prevented++}},root);assert.equal(h.document.activeElement,root);assert.equal(prevented,3);
});

test('login and booking dialogs render native labels, live errors, labelled modal semantics and SVG close controls',()=>{
  const h=createAppHarness(),login=parseHTML(h.run('loginView()'));
  assert.equal(login.querySelector('label[for="email"]').textContent,'Email');assert.ok(login.querySelector('#email'));
  assert.equal(login.querySelector('label[for="password"]').textContent,'Password');assert.equal(login.querySelector('#password').getAttribute('autocomplete'),'current-password');
  const error=login.querySelector('#loginError');assert.equal(error.getAttribute('role'),'alert');assert.equal(error.getAttribute('aria-live'),'assertive');assert.equal(login.querySelector('#loginForm button').getAttribute('type'),'submit');
  h.run(`state.session=${JSON.stringify({role:'agent',userId:'agent-1',name:'Agent A'})};state.bootstrap={users:[],services:[],providers:[]};state.wizard={step:1,services:[],agentId:'agent-1',suburb:'',area:'Inner East',slotAvailable:false,notes:''};drawWizard()`);
  const modal=h.document.querySelector('#overlay .modal');assert.equal(modal.getAttribute('role'),'dialog');assert.equal(modal.getAttribute('aria-modal'),'true');assert.equal(modal.getAttribute('aria-labelledby'),'bookingWizardTitle');
  const close=h.document.querySelector('#closeModal');assert.equal(close.getAttribute('type'),'button');assert.equal(close.getAttribute('aria-label'),'Close booking');assert.ok(close.querySelector('svg'));
});

test('SVG icon system produces hidden decorative vectors for every compact navigation control',()=>{
  const window={};vm.runInNewContext(iconSource,{window,String,Object});
  for(const name of['close','more','chevron']){const dom=parseHTML(window.NLIcon(name));const svg=dom.querySelector('svg');assert.ok(svg,`${name} SVG`);assert.equal(svg.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');assert.ok(svg.querySelectorAll('path,circle,line,polyline,rect').length>0,`${name} geometry`)}
  assert.doesNotMatch(window.NLIcon('close'),/×/);
});

function rgb(hex){const n=Number.parseInt(hex.slice(1),16);return[(n>>16)&255,(n>>8)&255,n&255]}
function lum(hex){return rgb(hex).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0)}
function ratio(a,b){const[x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return(x+.05)/(y+.05)}
function cssVar(name){return designCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`,'i'))?.[1]}

test('design tokens meet WCAG AA contrast and the static shell exposes live status before JavaScript runs',()=>{
  for(const name of['muted','eyebrow','amber'])assert.ok(ratio(cssVar(name),'#fffdf9')>=4.5,`${name} contrast is ${ratio(cssVar(name),'#fffdf9').toFixed(2)}:1`);
  assert.ok(ratio('#173e30','#ffffff')>=4.5);
  const page=parseHTML(indexSource),toast=page.querySelector('#toast');assert.equal(toast.getAttribute('role'),'status');assert.equal(toast.getAttribute('aria-live'),'polite');assert.equal(toast.getAttribute('aria-atomic'),'true');
  assert.ok(page.querySelector('link[href*="display=swap"]'));assert.equal(page.querySelectorAll('link[rel="stylesheet"]').at(-1).getAttribute('href'),'/assets/design-system.css');
});
