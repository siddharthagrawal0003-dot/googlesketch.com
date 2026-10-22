import { DurableObject } from 'cloudflare:workers';

const ORIGINS = new Set(['https://googlesketch.com','https://www.googlesketch.com','https://googlesketch.pages.dev','https://googlesketch.gardenmesa512.chatgpt.site']);
const MAX_MESSAGE = 256 * 1024;
const DAY = 86400000;
const token = () => crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,'0')).join('');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
function applyOps(state, ops, host) {
  if (!Array.isArray(ops) || ops.length > 1500) throw Error('Too many changes.');
  for (const op of ops) {
    if (!op || !validId(op.page || 'title')) throw Error('Invalid change.');
    if (op.type === 'title') { if (!host) throw Error('Only the teacher can rename the session.'); state.title=String(op.value).slice(0,120); }
    else if (op.type === 'page') {
      if (!host) throw Error('Only the teacher can add pages.');
      if (!state.pages.some(p=>p.id===op.page)) { if(state.pages.length>=100)throw Error('Page limit reached.');state.pages.push({id:op.page,objects:[]}); }
    } else {
      const p=state.pages.find(p=>p.id===op.page);if(!p)throw Error('Page no longer exists.');
      if(!validId(op.id))throw Error('Invalid object.');
      const i=p.objects.findIndex(o=>o.id===op.id);
      if(op.type==='put') {
        if(typeof op.svg!=='string'||op.svg.length>200000)throw Error('This object is too large to share.');
        const object={id:op.id,svg:op.svg}; if(i<0)p.objects.push(object);else p.objects[i]=object;
      } else if(op.type==='delete') {if(i>=0)p.objects.splice(i,1);}
      else throw Error('Invalid change.');
    }
  }
  if (new TextEncoder().encode(JSON.stringify(state)).length>1800000 || state.pages.reduce((n,p)=>n+p.objects.length,0)>10000)throw Error('Session is full. Export your work and start a new session.');
  return state;
}
export class SketchRoom extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }
  read(){const rows=this.ctx.storage.sql.exec('SELECT data FROM room WHERE id=1').toArray();return rows.length?JSON.parse(rows[0].data):null;}
  write(data){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO room (id,data) VALUES (1,?)',JSON.stringify(data));}
  async initialize(state,hostHash,guestHash) {
    if(this.read())return false;
    this.write({state,hostHash,guestHash,editing:true,ended:false,revision:0,expires:Date.now()+DAY});
    await this.ctx.storage.setAlarm(Date.now()+DAY);return true;
  }
  async fetch(request) {
    const room=this.read();if(!room||room.ended||Date.now()>room.expires)return new Response('Session has ended.',{status:410});
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
    if(this.ctx.getWebSockets().length>=8)return new Response('Session is full',{status:429});
    const [client,server]=Object.values(new WebSocketPair());this.ctx.acceptWebSocket(server);server.serializeAttachment({role:null,opened:Date.now()});
    return new Response(null,{status:101,webSocket:client});
  }
  send(ws,message){try{ws.send(JSON.stringify(message));}catch{ws.close(1011,'Connection error');}}
  broadcast(message){for(const ws of this.ctx.getWebSockets())if(ws.deserializeAttachment()?.role)this.send(ws,message);}
  presence(){this.broadcast({type:'presence',count:this.ctx.getWebSockets().filter(ws=>ws.deserializeAttachment()?.role&&ws.readyState===1).length});}
  async webSocketMessage(ws,raw) {
    try {
      if(typeof raw!=='string'||new TextEncoder().encode(raw).length>MAX_MESSAGE){ws.close(1009,'Change too large');return;}
      const message=JSON.parse(raw);let room=this.read();const attachment=ws.deserializeAttachment();
      if(!room||room.ended||Date.now()>room.expires){this.send(ws,{type:'ended'});ws.close(1000,'Session ended');return;}
      if(!attachment?.role) {
        if(message.type!=='auth'||typeof message.token!=='string'||message.token.length!==64){ws.close(1008,'Invalid invitation');return;}
        const digest=await hash(message.token);room=this.read();
        const role=digest===room.hostHash?'host':digest===room.guestHash?'guest':null;
        if(!role||room.ended){ws.close(1008,'Invalid invitation');return;}
        ws.serializeAttachment({role,client:validId(message.client)?message.client:crypto.randomUUID(),last:0,count:0});
        this.send(ws,{type:'ready',state:room.state,revision:room.revision,role,editing:room.editing,expires:room.expires});this.presence();return;
      }
      const now=Date.now();if(now-attachment.last>1000){attachment.last=now;attachment.count=0;}
      attachment.count++;ws.serializeAttachment(attachment);if(attachment.count>25){this.send(ws,{type:'error',message:'Please slow down.'});return;}
      if(message.type==='ping'){this.send(ws,{type:'pong'});return;}
      if(message.type==='sync'){this.send(ws,{type:'snapshot',state:room.state,revision:room.revision,editing:room.editing});return;}
      if(message.type==='editing'&&attachment.role==='host') {room.editing=message.value===true;this.write(room);this.broadcast({type:'editing',value:room.editing});return;}
      if(message.type==='end'&&attachment.role==='host') {room.ended=true;this.write(room);this.broadcast({type:'ended'});for(const peer of this.ctx.getWebSockets())peer.close(1000,'Session ended');return;}
      if(message.type!=='ops')return;
      if(attachment.role!=='host'&&!room.editing){this.send(ws,{type:'rejected',batch:message.batch,message:'Student editing is off.'});return;}
      try{room.state=applyOps(room.state,message.ops,attachment.role==='host');}catch(error){this.send(ws,{type:'rejected',batch:message.batch,message:error.message});return;}
      room.revision++;this.write(room);
      this.broadcast({type:'ops',ops:message.ops,revision:room.revision,client:attachment.client,batch:message.batch});
    } catch {this.send(ws,{type:'error',message:'Could not process this change.'});}
  }
  webSocketClose(ws,code,reason){ws.close(code,reason);this.presence();}
  webSocketError(ws){ws.close(1011,'Connection lost');this.presence();}
  async alarm(){this.broadcast({type:'ended'});for(const ws of this.ctx.getWebSockets())ws.close(1000,'Session expired');await this.ctx.storage.deleteAll();}
}
async function boundedJson(request) {
  const reader=request.body?.getReader();if(!reader)throw Error('Missing data');let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_MESSAGE)throw Error('Initial board is too large. Start with a smaller whiteboard.');chunks.push(value);}}catch(e){await reader.cancel();throw e;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get('Origin');
    const headers={'Access-Control-Allow-Origin':ORIGINS.has(origin)?origin:'https://googlesketch.com','Vary':'Origin','Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
    const reply=(body,status=200)=>Response.json(body,{status,headers});
    if(!ORIGINS.has(origin))return reply({error:'Open this session from GoogleSketch.'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'POST,GET,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}});
    try {
      if(url.pathname==='/rooms'&&request.method==='POST') {
        const input=await boundedJson(request);const state=applyOps({title:'Sketch',pages:[]},input.ops,true);
        if(!state.pages.length)return reply({error:'A session needs a page.'},400);
        const id=crypto.randomUUID(),hostToken=token(),guestToken=token();
        await env.ROOMS.getByName(id).initialize(state,await hash(hostToken),await hash(guestToken));
        return reply({id,hostToken,guestToken,expires:Date.now()+DAY},201);
      }
      const match=url.pathname.match(/^\/rooms\/([a-f0-9-]{36})\/connect$/);
      if(match&&request.method==='GET')return env.ROOMS.getByName(match[1]).fetch(request);
      return reply({error:'Not found'},404);
    }catch(error){return reply({error:error.message||'Could not start session.'},400);}
  }
};
