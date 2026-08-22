import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';

const root=resolve('dist'),port=Number(process.env.NORTHLIGHT_FIXTURE_PORT||4174);
const users=[
  {id:'admin-1',name:'Avery Admin',email:'avery@example.test',role_code:'admin',active:true},
  {id:'owner-1',name:'Olivia Owner',email:'olivia@example.test',role_code:'owner',active:true},
  {id:'agent-1',name:'Amelia Agent',email:'amelia@example.test',role_code:'agent',active:true},
  {id:'photo-1',name:'Priya Photographer',email:'priya@example.test',role_code:'photographer',active:true},
  {id:'editor-1',name:'Ethan Editor',email:'ethan@example.test',role_code:'editor',active:true}
];
const services=[{code:'photos',name:'Photography',duration_min:60,buffer_before_min:15,buffer_after_min:15,active:true,sort_order:1},{code:'floorplan',name:'Floor plan',duration_min:30,buffer_before_min:5,buffer_after_min:5,active:true,sort_order:2}];
const providers=[{user_id:'photo-1',areas:['Inner East','Bayside'],service_codes:['photos','floorplan'],working_hours:{mon:['08:00','18:00'],tue:['08:00','18:00'],wed:['08:00','18:00'],thu:['08:00','18:00'],fri:['08:00','17:00']},days_off:[],special_days:[],home_base:'Melbourne',service_radius_km:25,travel_buffer_min:15,timezone:'Australia/Melbourne',availability_version:1,availability_updated_at:new Date().toISOString()}];
const tomorrow=new Date(Date.now()+86400000);tomorrow.setUTCHours(0,30,0,0);
const tasks=[
  {id:'task-1',task_no:'RC-1042',property_name:'24 Albany Road',address:'24 Albany Road, Toorak VIC 3142',suburb:'Toorak',area:'Inner East',status:'assigned',scheduled_start:tomorrow.toISOString(),scheduled_end:new Date(tomorrow.getTime()+5400000).toISOString(),service_codes:['photos','floorplan'],agent_user_id:'agent-1',photographer_user_id:'photo-1',editor_user_id:'editor-1',notes:'Key safe beside the garage.',next_action:'Photographer needs to confirm the booking.',metadata:{}},
  {id:'task-2',task_no:'RC-1043',property_name:'7 Bay Street',address:'7 Bay Street, Brighton VIC 3186',suburb:'Brighton',area:'Bayside',status:'editing',scheduled_start:new Date(tomorrow.getTime()+86400000).toISOString(),scheduled_end:new Date(tomorrow.getTime()+91800000).toISOString(),service_codes:['photos'],agent_user_id:'agent-1',photographer_user_id:'photo-1',editor_user_id:'editor-1',next_action:'Editing is in progress.',metadata:{}},
  {id:'task-3',task_no:'RC-1038',property_name:'18 Queen Street',address:'18 Queen Street, Melbourne VIC 3000',suburb:'Melbourne',area:'CBD & Inner City',status:'delivered',scheduled_start:new Date(tomorrow.getTime()-86400000).toISOString(),scheduled_end:new Date(tomorrow.getTime()-81000000).toISOString(),service_codes:['photos'],agent_user_id:'agent-1',photographer_user_id:'photo-1',editor_user_id:'editor-1',next_action:'Final media is delivered.',metadata:{}}
];
const labels={admin:'Admin',owner:'Owner',agent:'Agent',photographer:'Photographer',editor:'Editor'};
const rolePermissions={admin:['all_tasks','create_task','assign','reassign','reschedule','cancel','archive','restore','manage_users','manage_roles','manage_integrations','manage_settings','review','upload','reports','view_raw','view_edited','view_final','view_finance','manage_finance'],owner:['all_tasks','create_task','assign','reassign','reschedule','cancel','archive','restore','comment','raise_issue','review','reports','view_raw','view_edited','view_final','view_finance'],agent:['own_tasks','create_task','assign','reassign_after_decline','reschedule','cancel','comment','raise_issue','review','upload_reference','view_final'],photographer:['assigned_tasks','confirm','decline','reschedule','comment','raise_issue','upload','upload_reference','view_raw'],editor:['editing_queue','comment','raise_issue','upload_edit','upload_final','upload_reference','revision','view_raw','view_edited','view_final']};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
const roleFor=req=>{try{return new URL(req.headers.referer||`http://127.0.0.1:${port}/?role=admin`).searchParams.get('role')||'admin'}catch{return'admin'}};
const forcedPasswordFor=req=>{try{return new URL(req.headers.referer||`http://127.0.0.1:${port}/`).searchParams.get('forcePassword')==='1'}catch{return false}};
const sessionFor=role=>{const user=users.find(x=>x.role_code===role)||users[0];return{userId:user.id,name:user.name,email:user.email,role,roleLabel:labels[role]||role}};
const visibleTasks=role=>{const s=sessionFor(role);if(['admin','owner'].includes(role))return tasks;if(role==='agent')return tasks.filter(x=>x.agent_user_id===s.userId);if(role==='photographer')return tasks.filter(x=>x.photographer_user_id===s.userId);if(role==='editor')return tasks.filter(x=>x.editor_user_id===s.userId);return[]};
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const readJson=req=>new Promise(resolve=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'))}catch{resolve({})}})});
const onboarding=()=>({bookable:true,credential_ready:true,must_change_password:false,profile_ready:true,calendar_connected:true,calendar_sync_healthy:true,calendar_watch_healthy:true,availability_version:providers[0].availability_version,last_calendar_sync_at:new Date().toISOString(),watch_expires_at:new Date(Date.now()+86400000).toISOString(),blockers:[]});

http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://127.0.0.1:${port}`),role=roleFor(req),session={...sessionFor(role),mustChangePassword:forcedPasswordFor(req)};
  if(url.pathname==='/api/auth/session')return send(res,200,{session});
  if(url.pathname==='/api/auth/change-password'&&req.method==='POST')return send(res,200,{ok:true,message:'Password updated. Sign in again with your new password.'});
  if(url.pathname==='/api/bootstrap')return send(res,200,{session,tenant:{id:'tenant-1',name:'REALCAPTURE',timezone:'Australia/Melbourne',settings:{}},users,services,packages:[{id:'package-1',name:'Standard listing',service_codes:['photos','floorplan']}],providers,editorProfiles:[{user_id:'editor-1',skills:['photos','floorplan']}],roles:['admin','owner'].includes(role)?Object.keys(labels).map(code=>({code,name:labels[code],permissions:rolePermissions[code]})):[],tasks:visibleTasks(role),integrations:['admin','owner'].includes(role)?[{provider:'dropbox',status:'connected',account_label:'REALCAPTURE Media'},{provider:'google',status:'connected',account_label:'Operations'},{provider:'xero',status:'connected',account_label:'REALCAPTURE AU'}]:[]});
  if(url.pathname==='/api/calendar/freebusy'&&req.method==='POST')return send(res,200,{available:true,connected:true,timeZone:'Australia/Melbourne'});
  if(url.pathname==='/api/calendar/status')return send(res,200,{connected:true,account:'priya@example.test',onboarding:onboarding(),sync:{last_error:null,last_incremental_sync_at:new Date().toISOString(),channel_expires_at:new Date(Date.now()+86400000).toISOString()}});
  if(url.pathname==='/api/operations/calendars')return send(res,200,{calendars:[{user:users.find(x=>x.id==='photo-1'),integration:{status:'connected',account_label:'Priya · Google'},profile:providers[0],onboarding:onboarding(),sync:{last_error:null,last_incremental_sync_at:new Date().toISOString()}}]});
  if(url.pathname==='/api/availability'&&req.method==='GET')return send(res,200,{profile:providers[0],onboarding:onboarding()});
  if(url.pathname==='/api/availability'&&req.method==='PATCH'){const body=await readJson(req);Object.assign(providers[0],{working_hours:body.workingHours||providers[0].working_hours,days_off:body.daysOff||[],special_days:body.specialDays||[],timezone:body.timeZone||providers[0].timezone,availability_version:providers[0].availability_version+1,availability_updated_at:new Date().toISOString()});return send(res,200,{profile:providers[0],onboarding:onboarding()})}
  if(url.pathname==='/api/calendar/disconnect'&&req.method==='POST')return send(res,200,{ok:true,message:'Fixture Calendar disconnected.'});
  if(url.pathname==='/api/operations/activity')return send(res,200,{issues:[],invoices:[],activity:[{source:'google',message:'Calendar protection checked',at:new Date().toISOString(),task:tasks[0]}]});
  if(url.pathname==='/api/finance/invoices')return send(res,200,{invoices:[]});
  if(url.pathname==='/api/preflight')return send(res,200,{ok:true,missing:[],configured:{XERO_CLIENT_ID:true,XERO_CLIENT_SECRET:true}});
  if(url.pathname==='/api/settings')return send(res,200,{operationsEmail:'pradeeppatilfg@gmail.com',source:'workspace'});
  if(url.pathname==='/api/comments')return send(res,200,{comments:[]});
  const taskMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)$/);if(taskMatch&&req.method==='GET'){const task=visibleTasks(role).find(x=>x.id===taskMatch[1]);return task?send(res,200,{task,events:[{type:'task_created',created_at:new Date().toISOString(),detail:{message:'Property task created.'}}]}):send(res,404,{error:'Task not found.'})}
  const filesMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)\/files$/);if(filesMatch)return send(res,200,{stages:['01_RAW','04_REFERENCE'],files:[]});
  if(url.pathname.startsWith('/api/'))return send(res,200,{ok:true});
  try{let rel=decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html';let file=resolve(join(root,rel));if(!file.startsWith(root))throw new Error('invalid path');if((await stat(file)).isDirectory())file=join(file,'index.html');const body=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(body)}catch{res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Not found')}
}).listen(port,'127.0.0.1',()=>console.log(`Northlight UI fixture server on http://127.0.0.1:${port}`));
