import{json}from'../_lib/core.js';
export async function onRequestGet(){return json({ok:true,service:'northlight',environment:'cloudflare-pages',time:new Date().toISOString()})}
