import{verifyXeroSignature,syncXeroInvoice}from'../_lib/xero.js';
import{integration,logSync}from'../_lib/core.js';
import{readBoundedText,RequestBodyTooLargeError}from'../_lib/http-body.js';

const MAX_XERO_WEBHOOK_BYTES=1024*1024;

export async function onRequestPost(context){const{request,env}=context;let raw;try{raw=await readBoundedText(request,MAX_XERO_WEBHOOK_BYTES)}catch(error){if(error instanceof RequestBodyTooLargeError)return new Response('payload too large',{status:413});throw error}const signature=request.headers.get('x-xero-signature');if(!await verifyXeroSignature(raw,signature,env.XERO_WEBHOOK_KEY))return new Response('invalid signature',{status:401});let payload={};try{payload=JSON.parse(raw)}catch{return new Response('invalid json',{status:400})}const ix=await integration(env,'xero'),tenantId=ix?.metadata?.xero_tenant_id,events=Array.isArray(payload.events)?payload.events:[];const job=(async()=>{for(const ev of events){try{if(String(ev.eventCategory||'').toUpperCase()!=='INVOICE')continue;if(tenantId&&ev.tenantId&&tenantId!==ev.tenantId)continue;await syncXeroInvoice(env,ev.resourceId)}catch(e){await logSync(env,'xero','inbound','invoice','webhook_invoice_failed',{entity_id:ev.resourceId||null,status:'failed',error:e.message,payload:ev})}}})();if(context.waitUntil)context.waitUntil(job);else await job;return new Response(null,{status:200})}
