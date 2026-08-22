const enc=new TextEncoder();
export const PASSWORD_KDF_SCHEME='pbkdf2cf';
export const PASSWORD_KDF_ITERATIONS=100000;
export const PASSWORD_KDF_SEGMENTS=3;
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function derive(material,salt,iterations){const key=await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},key,256))}
export async function hashPBKDF2(password,iterations=PASSWORD_KDF_ITERATIONS,segments=PASSWORD_KDF_SEGMENTS){
  if(!Number.isInteger(iterations)||iterations<60000||iterations>PASSWORD_KDF_ITERATIONS)throw new Error('password_kdf_iterations_not_supported');
  if(!Number.isInteger(segments)||segments<2||segments>10)throw new Error('password_kdf_segments_not_supported');
  const salts=[];let material=enc.encode(String(password));
  for(let i=0;i<segments;i++){const salt=crypto.getRandomValues(new Uint8Array(16));salts.push(salt);material=await derive(material,salt,iterations)}
  return`${PASSWORD_KDF_SCHEME}$${iterations}$${segments}$${salts.map(b64).join('.')}$${b64(material)}`
}
