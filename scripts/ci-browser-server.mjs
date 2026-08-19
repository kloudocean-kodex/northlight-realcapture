import{createServer}from'node:http';
import{readFile,stat}from'node:fs/promises';
import{extname,join,normalize,resolve}from'node:path';

const root=resolve(process.cwd());
const port=Number(process.env.PORT||4173);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};

function safePath(urlPath){
  const decoded=decodeURIComponent(String(urlPath||'/').split('?')[0]);
  const rel=normalize(decoded==='/'?'index.html':decoded.replace(/^\/+/,''));
  const full=resolve(join(root,rel));
  return full===root||full.startsWith(root+'/')?full:null;
}

const server=createServer(async(req,res)=>{
  try{
    if(String(req.url||'').startsWith('/api/')){
      res.writeHead(401,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify({error:'Authentication required.'}));
      return;
    }
    const file=safePath(req.url);
    if(!file){res.writeHead(400);res.end('Bad request');return}
    const info=await stat(file);
    if(!info.isFile())throw new Error('not_file');
    const body=await readFile(file);
    res.writeHead(200,{'content-type':types[extname(file).toLowerCase()]||'application/octet-stream','cache-control':'no-store'});
    res.end(body);
  }catch{
    res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});
    res.end('Not found');
  }
});

server.listen(port,'127.0.0.1',()=>console.log(`Northlight CI browser server listening on http://127.0.0.1:${port}`));

for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
