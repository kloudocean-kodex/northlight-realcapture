import{verifyDropboxSignature,connectedDropboxAccount,enqueueDropboxSync}from'../_lib/dropbox-sync.js';
import{logSync}from'../_lib/core.js';
import{readBoundedText,RequestBodyTooLargeError}from'../_lib/http-body.js';

const MAX_DROPBOX_WEBHOOK_BYTES=256*1024;

export async function onRequestGet({request}){const u=new URL(request.url),challenge=u.searchParams.get('challenge');if(!challenge)return new Response('missing challenge',{status:400});return new Response(challenge,{status:200,headers:{'content-type':'text/plain','x-content-type-options':'nosniff'}})}

export async function onRequestPost(context){const{request,env}=context;let raw;try{raw=await readBoundedText(request,MAX_DROPBOX_WEBHOOK_BYTES)}catch(error){if(error instanceof RequestBodyTooLargeError)return new Response('payload too large',{status:413});throw error}const signature=request.headers.get('x-dropbox-signature');if(!await verifyDropboxSignature(raw,signature,env.DROPBOX_APP_SECRET))return new Response('invalid signature',{status:401});let payload={};try{payload=JSON.parse(raw)}catch{return new Response('invalid json',{status:400})}const{accountId}=await connectedDropboxAccount(env),accounts=payload?.list_folder?.accounts||[];if(accountId&&accounts.length&&!accounts.includes(accountId))return new Response(null,{status:200});try{await enqueueDropboxSync(env,{webhookAt:new Date().toISOString()})}catch{const logJob=logSync(env,'dropbox','inbound','files','webhook_queue_failed',{status:'failed',error:'dropbox_sync_queue_unavailable',payload:{accountCount:accounts.length}}).catch(()=>{});if(context.waitUntil)context.waitUntil(logJob);else await logJob;return new Response('sync queue unavailable',{status:503,headers:{'retry-after':'60'}})}return new Response(null,{status:200})}
