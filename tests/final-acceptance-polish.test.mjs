import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const guard=await readFile(new URL('../assets/runtime-guard.js',import.meta.url),'utf8');
const contract=await readFile(new URL('../assets/contract-runtime.js',import.meta.url),'utf8');
const css=await readFile(new URL('../assets/runtime.css',import.meta.url),'utf8');
const icons=await readFile(new URL('../assets/icons.js',import.meta.url),'utf8');
const admin=await readFile(new URL('../functions/api/admin/users.js',import.meta.url),'utf8');
const adminUser=await readFile(new URL('../functions/api/admin/users/[id].js',import.meta.url),'utf8');
const freebusy=await readFile(new URL('../functions/api/calendar/freebusy.js',import.meta.url),'utf8');
const rules=await readFile(new URL('../PRODUCT_RULES.md',import.meta.url),'utf8');

test('booking preview sends the same area and selected services required by server scheduling truth',()=>{
  assert.match(freebusy,/area=String\(b\.area\|\|''\)/);
  assert.match(freebusy,/Array\.isArray\(b\.services\)/);
  assert.match(freebusy,/evaluateBooking\(env,\{photographerId,area,serviceCodes:services/);
  assert.match(guard,/captureBookingContext\(\)/);
  assert.match(guard,/if\(!payload\.area&&bookingArea\)payload\.area=bookingArea/);
  assert.match(guard,/payload\.services=\[\.\.\.bookingServices\]/);
  assert.match(guard,/requestInit=enrichFreebusy\(init\)/);
});

test('photographer choice stays honest until date-time availability is actually verified',()=>{
  assert.match(rules,/If availability cannot be verified, do not show a misleading green `Available` state\./);
  assert.match(contract,/honestPhotographerChoice/);
  assert.match(contract,/label==='Recommended'\|\|label==='Available'/);
  assert.match(contract,/badge\.remove\(\)/);
  assert.doesNotMatch(contract,/Eligible|Perfect match|match score/i);
});

test('stale profile load cannot silently influence booking order or editor workload copy',()=>{
  assert.match(contract,/Number\(a\.disabled\)-Number\(b\.disabled\)/);
  assert.match(contract,/localeCompare\(bn,'en',\{sensitivity:'base'\}\)/);
  assert.match(contract,/removeStaleEditorLoad/);
  assert.match(contract,/\^Current load\\b/i);
  assert.doesNotMatch(adminUser,/patch\.current_load|current_load\s*=/i);
});

test('mobile navigation exposes a quiet current-page state and respects phone safe areas',()=>{
  assert.match(contract,/aria-current'\)!=='page'/);
  assert.match(contract,/btn\.classList\.toggle\('active',active\)/);
  assert.match(css,/\.mobile-nav button\.active\{color:var\(--forest\)\}/);
  assert.match(css,/env\(safe-area-inset-bottom\)/);
});

test('integration actions use clear provider-level connect and reconnect wording',()=>{
  assert.match(contract,/Reconnect Google Workspace/);
  assert.match(contract,/Connect Google Workspace/);
  assert.match(contract,/Reconnect Xero/);
  assert.match(contract,/Connect Xero/);
});

test('new team credentials use the same 12-character minimum as personal passwords',()=>{
  assert.match(admin,/password\.length<12/);
  assert.match(admin,/Temporary password must be at least 12 characters/);
  assert.match(contract,/input\.minLength!==12/);
  assert.match(contract,/autocomplete='new-password'/);
  assert.match(contract,/12 or more characters/);
});

test('small controls and media folders stay inside the Northlight SVG icon system',()=>{
  assert.match(icons,/folder:'<path/);
  assert.match(icons,/close:'<path/);
  assert.match(contract,/window\.NLIcon\('close'\)/);
  assert.match(guard,/window\.NLIcon\(d\?\.available\?'check':'alert'\)/);
});

test('final polish preserves pilot scope and Photographer-only personal Calendar',()=>{
  assert.match(contract,/role==='photographer'/);
  assert.match(contract,/Google Calendar/);
  for(const source of[guard,contract,admin])assert.doesNotMatch(source,/priority\s*[:=]\s*['"](?:rush|urgent|priority)/i);
});
