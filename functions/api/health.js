import{json}from'../_lib/core.js';
import{BUILD_INFO}from'../_lib/build-info.js';
export async function onRequestGet({env}){return json({ok:true,service:'northlight',environment:'cloudflare-pages',time:new Date().toISOString(),deployment:{commitSha:env.CF_PAGES_COMMIT_SHA||BUILD_INFO.commitSha||null,branch:env.CF_PAGES_BRANCH||BUILD_INFO.branch||null,buildTime:BUILD_INFO.buildTime||null}})}
