import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('tasks get one minimal client-side search without adding backend or CRM scope',async()=>{const ux=await read('assets/ux-runtime.js');assert.match(ux,/id='nlTaskSearch'|wrap\.id='nlTaskSearch'/);assert.match(ux,/input\.type='search'/);assert.match(ux,/Property, address, suburb, task no or Photographer/);assert.match(ux,/document\.querySelectorAll\('#page \.task-row'\)/);assert.match(ux,/textContent\|\|''\)\.toLowerCase\(\)\.includes\(q\)/);assert.match(ux,/row\.hidden=!match/);assert.doesNotMatch(ux,/lead|pipeline|campaign|priority|rush/i)});

test('signed-in workspace has skip navigation and polite route/toast announcements',async()=>{const ux=await read('assets/ux-runtime.js'),css=await read('assets/runtime.css');assert.match(ux,/Skip to main content/);assert.match(ux,/skip\.href='#page'/);assert.match(ux,/page\.tabIndex=-1/);assert.match(ux,/nlRouteAnnouncer/);assert.match(ux,/aria-live','polite'/);assert.match(ux,/toastNode\.setAttribute\('role','status'\)/);assert.match(ux,/aria-atomic','true'/);assert.match(css,/\.sr-only\{/);assert.match(css,/\.skip-link:focus\{transform:translateY\(0\)\}/)});

test('runtime modals and task drawer trap keyboard focus, support Escape and restore focus',async()=>{const ux=await read('assets/ux-runtime.js');assert.match(ux,/function trapFocus\(e,root\)/);assert.match(ux,/e\.key!=='Tab'/);assert.match(ux,/runtimeReturnFocus=document\.activeElement/);assert.match(ux,/target\?\.isConnected/);assert.match(ux,/drawerReturnFocus=document\.activeElement/);assert.match(ux,/drawer\.setAttribute\('role','dialog'\)/);assert.match(ux,/drawer\.setAttribute\('aria-modal','true'\)/);assert.match(ux,/aria-labelledby/);assert.match(ux,/if\(e\.key==='Escape'\)/);assert.match(ux,/closeRuntimeModal\(\)/);assert.match(ux,/drawer\.querySelector\('#closeDrawer,\.icon-btn'\)\?\.click\(\)/)});

test('search and accessibility polish stay responsive and preserve reduced-motion behavior',async()=>{const css=await read('assets/runtime.css');assert.match(css,/\.task-search\{/);assert.match(css,/@media\(max-width:980px\).*\.task-search\{grid-template-columns:1fr\}/s);assert.match(css,/@media\(max-width:560px\).*\.task-search\{/s);assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/focus-visible/)});
