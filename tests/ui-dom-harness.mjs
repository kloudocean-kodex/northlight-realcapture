import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const decode=s=>String(s).replace(/&(?:amp|lt|gt|quot|#039);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#039;':"'"}[x]));
const camel=s=>s.replace(/-([a-z])/g,(_,x)=>x.toUpperCase());

function splitSelector(selector){return selector.split(',').map(x=>x.trim()).filter(Boolean)}
function simpleMatch(node,selector){
  if(node.tag==='#text')return false;
  let s=selector.trim();
  for(const part of s.match(/:not\(([^)]+)\)/g)||[]){if(simpleMatch(node,part.slice(5,-1)))return false;s=s.replace(part,'')}
  s=s.replace(/:(?:scope|first-child|last-child)/g,'');
  const tag=s.match(/^[a-z][\w-]*/i)?.[0];if(tag&&node.tag!==tag.toLowerCase())return false;
  for(const id of s.matchAll(/#([\w-]+)/g))if(node.getAttribute('id')!==id[1])return false;
  for(const c of s.matchAll(/\.([\w-]+)/g))if(!node.classList.contains(c[1]))return false;
  for(const a of s.matchAll(/\[([^\]=~^$*|\s]+)(?:\s*([~^$*|]?=)\s*["']?([^\]"']*)["']?)?\]/g)){
    const actual=node.getAttribute(a[1]);if(actual===null)return false;
    if(a[2]){const expected=a[3];if(a[2]==='='&&actual!==expected)return false;if(a[2]==='^='&&!actual.startsWith(expected))return false;if(a[2]==='$='&&!actual.endsWith(expected))return false;if(a[2]==='*='&&!actual.includes(expected))return false}
  }
  return true;
}
function selectorMatch(node,selector){
  const parts=selector.replace(/\s*>\s*/g,' > ').trim().split(/\s+/);let index=parts.length-1,current=node;
  if(!simpleMatch(current,parts[index]))return false;index--;
  while(index>=0){if(parts[index]==='>'){index--;current=current.parent;if(!current||!simpleMatch(current,parts[index]))return false;index--;continue}let parent=current.parent;while(parent&&!simpleMatch(parent,parts[index]))parent=parent.parent;if(!parent)return false;current=parent;index--}
  return true;
}

export class MiniNode{
  constructor(tag='div',attrs={},document=null,text=''){this.tag=tag.toLowerCase();this.attrs=new Map(Object.entries(attrs));this.ownerDocument=document;this.parent=null;this.childNodes=[];this._text=text;this.hidden=false;this.listeners=new Map();this.onclick=null;this.onchange=null;this.onsubmit=null;this.style={}}
  get id(){return this.getAttribute('id')||''}set id(v){this.setAttribute('id',v)}
  get className(){return this.getAttribute('class')||''}set className(v){this.setAttribute('class',v)}
  get classList(){const node=this,api={contains:c=>node.className.split(/\s+/).includes(c),add:(...cs)=>node.className=[...new Set([...node.className.split(/\s+/).filter(Boolean),...cs])].join(' '),remove:(...cs)=>node.className=node.className.split(/\s+/).filter(x=>!cs.includes(x)).join(' '),toggle:(c,on)=>{const yes=on??!api.contains(c);yes?api.add(c):api.remove(c);return yes}};return api}
  get dataset(){const node=this;return new Proxy({}, {get:(_,key)=>node.getAttribute(`data-${String(key).replace(/[A-Z]/g,x=>`-${x.toLowerCase()}`)}`)||undefined,set:(_,key,value)=>{node.setAttribute(`data-${String(key).replace(/[A-Z]/g,x=>`-${x.toLowerCase()}`)}`,String(value));return true}})}
  get children(){return this.childNodes.filter(x=>x.tag!=='#text')}
  get nextSibling(){if(!this.parent)return null;const i=this.parent.childNodes.indexOf(this);return this.parent.childNodes[i+1]||null}
  get isConnected(){let n=this;while(n){if(n===this.ownerDocument?.documentElement)return true;n=n.parent}return false}
  get disabled(){return this.attrs.has('disabled')}set disabled(v){v?this.attrs.set('disabled',''):this.attrs.delete('disabled')}
  get value(){if(this._value!==undefined)return this._value;const own=this.getAttribute('value');if(own!==null)return own;if(this.tag==='select'){const options=this.querySelectorAll('option'),selected=options.find(x=>x.attrs.has('selected'))||options[0];return selected?.getAttribute('value')??selected?.textContent??''}return''}set value(v){this._value=String(v)}
  get textContent(){return this.tag==='#text'?this._text:this.childNodes.map(x=>x.textContent).join('')}set textContent(v){this.childNodes=[];if(v!==''&&v!==null&&v!==undefined)this.appendChild(new MiniNode('#text',{},this.ownerDocument,String(v)))}
  get innerHTML(){return this.childNodes.map(x=>x.textContent).join('')}set innerHTML(v){this.childNodes=[];for(const child of parseFragment(v,this.ownerDocument))this.appendChild(child)}
  getAttribute(name){return this.attrs.has(name)?this.attrs.get(name):null}setAttribute(name,value){this.attrs.set(name,String(value))}removeAttribute(name){this.attrs.delete(name)}
  appendChild(node){node.parent=this;node.ownerDocument=this.ownerDocument;this.childNodes.push(node);return node}append(...nodes){for(const n of nodes)this.appendChild(typeof n==='string'?new MiniNode('#text',{},this.ownerDocument,n):n)}prepend(node){node.parent=this;node.ownerDocument=this.ownerDocument;this.childNodes.unshift(node)}
  before(node){if(!this.parent)return;const i=this.parent.childNodes.indexOf(this);node.parent=this.parent;node.ownerDocument=this.ownerDocument;this.parent.childNodes.splice(i,0,node)}
  insertBefore(node,before){if(!before)return this.appendChild(node);const i=this.childNodes.indexOf(before);node.parent=this;node.ownerDocument=this.ownerDocument;this.childNodes.splice(Math.max(0,i),0,node);return node}
  insertAdjacentHTML(position,html){if(position!=='beforeend')throw new Error(`Unsupported position ${position}`);for(const child of parseFragment(html,this.ownerDocument))this.appendChild(child)}
  remove(){if(!this.parent)return;this.parent.childNodes=this.parent.childNodes.filter(x=>x!==this);this.parent=null}
  contains(node){for(let n=node;n;n=n.parent)if(n===this)return true;return false}
  closest(selector){for(let n=this;n;n=n.parent)if(splitSelector(selector).some(s=>selectorMatch(n,s)))return n;return null}
  querySelectorAll(selector){const out=[];const selectors=splitSelector(selector);const visit=n=>{for(const child of n.children){if(selectors.some(s=>selectorMatch(child,s)))out.push(child);visit(child)}};visit(this);return out}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  addEventListener(type,fn){const rows=this.listeners.get(type)||[];rows.push(fn);this.listeners.set(type,rows)}
  dispatchEvent(event){event.target??=this;for(const fn of this.listeners.get(event.type)||[])fn.call(this,event);return true}
  click(){const e={type:'click',target:this,currentTarget:this,preventDefault(){this.defaultPrevented=true}};this.onclick?.(e);this.dispatchEvent(e)}
  focus(){if(this.ownerDocument)this.ownerDocument.activeElement=this}
  getClientRects(){return this.hidden?[]:[{}]}
  cloneNode(deep=false){const n=new MiniNode(this.tag,Object.fromEntries(this.attrs),this.ownerDocument,this._text);if(deep)for(const c of this.childNodes)n.appendChild(c.cloneNode(true));return n}
}

function parseFragment(html,document){
  const root=new MiniNode('fragment',{},document),stack=[root];
  for(const token of String(html).match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)||[]){
    if(token.startsWith('<!--'))continue;
    if(token.startsWith('</')){if(stack.length>1)stack.pop();continue}
    if(token.startsWith('<')){const m=token.match(/^<\s*([\w-]+)/);if(!m)continue;const tag=m[1].toLowerCase(),attrs={};const tail=token.slice(m[0].length,token.length-(token.endsWith('>')?1:0));for(const a of tail.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attrs[a[1]]=decode(a[2]??a[3]??a[4]??'');const node=new MiniNode(tag,attrs,document);stack.at(-1).appendChild(node);if(!VOID.has(tag)&&!token.endsWith('/>'))stack.push(node);continue}
    if(token)stack.at(-1).appendChild(new MiniNode('#text',{},document,decode(token)));
  }
  return root.childNodes;
}
export function parseHTML(html){const d=new MiniDocument(false);d.body.innerHTML=html;return d}

export class MiniDocument{
  constructor(shell=true){this.documentElement=new MiniNode('html',{},this);this.body=new MiniNode('body',{},this);this.documentElement.appendChild(this.body);this.activeElement=this.body;this.listeners=new Map();if(shell){for(const id of['root','overlay','toast']){const n=new MiniNode('div',{id},this);if(id==='toast')n.className='toast hidden';this.body.appendChild(n)}}}
  createElement(tag){return new MiniNode(tag,{},this)}
  querySelectorAll(selector){return this.documentElement.querySelectorAll(selector)}querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  addEventListener(type,fn){const rows=this.listeners.get(type)||[];rows.push(fn);this.listeners.set(type,rows)}
  dispatchEvent(event){for(const fn of this.listeners.get(event.type)||[])fn.call(this,event);return true}
}

const contractSource=await readFile(new URL('../assets/contract-runtime.js',import.meta.url),'utf8');
const appSource=await readFile(new URL('../assets/app-v2.js',import.meta.url),'utf8');

export function loadContracts(){const window={};vm.runInNewContext(contractSource,{window,Set,Object,Number,String,Boolean});return window.NorthlightContracts}

export function createAppHarness(){
  const document=new MiniDocument(),contracts=loadContracts(),requests=[],responses=[];
  const window={NorthlightContracts:contracts,NLIcon:name=>`<svg data-icon="${name}" aria-hidden="true"></svg>`,open(){},addEventListener(){}};
  window.window=window;
  const fetch=async(url,opt={})=>{if(String(url)==='/api/auth/session')return new Promise(()=>{});requests.push({url:String(url),method:String(opt.method||'GET'),body:opt.body?JSON.parse(opt.body):null});const next=responses.shift()||{ok:true,status:200,data:{available:true,connected:true}};return{ok:next.ok!==false,status:next.status||200,async json(){return next.data??{}},clone(){return this}}};
  const context=vm.createContext({window,document,fetch,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),CustomEvent:class{constructor(type,detail={}){this.type=type;Object.assign(this,detail)}},location:{href:'',reload(){}},confirm:()=>true,prompt:()=>'',console,Intl,Date,URLSearchParams,Map,Set,Promise,JSON,encodeURIComponent});
  vm.runInContext(appSource,context,{filename:'assets/app-v2.js'});
  return{context,document,window,contracts,requests,responses,run:code=>vm.runInContext(code,context)};
}

export const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
