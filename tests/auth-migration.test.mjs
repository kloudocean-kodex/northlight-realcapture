import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{hashPBKDF2}from'../functions/_lib/password.js';
import{verifyPBKDF2}from'../functions/_lib/core.js';

test('per-user PBKDF2 passwords verify correctly and reject another password',async()=>{const hash=await hashPBKDF2('Northlight personal password 2026');assert.match(hash,/^pbkdf2\$210000\$/);assert.equal(await verifyPBKDF2('Northlight personal password 2026',hash),true);assert.equal(await verifyPBKDF2('different password',hash),false)});

test('login and session validation bind sessions to the account auth version',async()=>{const login=await readFile(new URL('../functions/api/auth/login.js',import.meta.url),'utf8'),core=await readFile(new URL('../functions/_lib/core.js',import.meta.url),'utf8');assert.match(login,/password_hash,active,metadata/);assert.match(login,/authVersion:Number\(u\.metadata\?\.auth_version\|\|0\)/);assert.match(core,/select=id,role_code,name,email,active,metadata/);assert.match(core,/Number\(s\.authVersion\|\|0\)!==authVersion/);assert.match(core,/authentication_required/)});

test('change-password migrates legacy accounts without exposing or reusing the pilot credential',async()=>{const endpoint=await readFile(new URL('../functions/api/auth/change-password.js',import.meta.url),'utf8');assert.match(endpoint,/verifyPBKDF2/);assert.match(endpoint,/stored\.startsWith\('scrypt\$'\)/);assert.match(endpoint,/PILOT_LOGIN_PASSWORD/);assert.match(endpoint,/personal password different from the pilot password/);assert.match(endpoint,/hashPBKDF2\(newPassword\)/);assert.match(endpoint,/auth_version:nextVersion/);assert.match(endpoint,/password_scheme:'pbkdf2'/);assert.match(endpoint,/password_hash=eq\.\$\{encodeURIComponent\(stored\)\}/);assert.match(endpoint,/if\(!rows\?\.\[0\]\)return error\(409/);assert.match(endpoint,/return json\(\{ok:true,message:'Password updated\. Sign in again with your new password\.'\}/);assert.match(endpoint,/clearSessionCookie\(\)/);assert.doesNotMatch(endpoint,/console\./)});

test('every signed-in role receives the same quiet password-change UI',async()=>{const ux=await readFile(new URL('../assets/ux-runtime.js',import.meta.url),'utf8');assert.match(ux,/id='changePasswordBtn'|btn\.id='changePasswordBtn'/);assert.match(ux,/aria-label','Change password'/);assert.match(ux,/\/api\/auth\/change-password/);assert.match(ux,/New password · 12\+ characters/);assert.match(ux,/Passwords do not match/);assert.match(ux,/location\.reload\(\)/)});
