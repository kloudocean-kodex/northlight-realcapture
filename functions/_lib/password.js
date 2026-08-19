const enc=new TextEncoder();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export async function hashPBKDF2(password,iterations=210000){const salt=crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',enc.encode(String(password)),'PBKDF2',false,['deriveBits']),bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},key,256);return`pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`}
