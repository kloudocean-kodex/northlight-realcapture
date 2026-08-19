import{json,clearSessionCookie}from'../../_lib/core.js';
export async function onRequestPost(){return json({ok:true},200,{'set-cookie':clearSessionCookie()})}
