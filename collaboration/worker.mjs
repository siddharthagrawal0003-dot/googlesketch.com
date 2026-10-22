import { DurableObject } from 'cloudflare:workers';

const ORIGINS = new Set(['https://googlesketch.com','https://www.googlesketch.com','https://googlesketch.pages.dev','https://googlesketch.gardenmesa512.chatgpt.site']);
const MAX_MESSAGE = 256 * 1024;
const MAX_ASSET = 4 * 1024 * 1024;
const MAX_ASSETS = 40 * 1024 * 1024;
const DAY = 86400000;
const token = () => crypto.randomUUID().replaceAll('-','') + crypto.randomUUID().replaceAll('-','');
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(n=>n.toString(16).padStart(2,'0')).join('');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
function applyOps(state, ops, host) {
  if (!Array.isArray(ops) || ops.length > 1500) throw Error('Too many changes.');
  for (const op of ops) {
    if (!op || !validId(op.page || 'title')) throw Error('Invalid change.');
    if(op.type==='focus'){if(!host)throw Error('Only the teacher can change the shared page.');if(!state.pages.some(p=>p.id===op.page))throw Error('Page no longer exists.');state.activePage=op.page;}
    else if (op.type === 'title') { if (!host) throw Error('Only the teacher can rename the session.'); state.title=String(op.value).slice(0,120); }
    else if (op.type === 'page') {
      if (!host) throw Error('Only the teacher can add pages.');
      if (!state.pages.some(p=>p.id===op.page)) { if(state.pages.length>=100)throw Error('Page limit reached.');state.pages.push({id:op.page,objects:[]}); }
    } else {
      const p=state.pages.find(p=>p.id===op.page);if(!p)throw Error('Page no longer exists.');
      if(!validId(op.id))throw Error('Invalid object.');
      const i=p.objects.findIndex(o=>o.id===op.id);
      if(!host && ((i>=0 && /data-background=["']true["']/.test(p.objects[i].svg)) || (op.type==='put' && /data-background=["']true["']/.test(op.svg||''))))throw Error('Only the teacher can change PDF backgrounds.');
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
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, size INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS asset_chunks (id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, part))');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }
  read(){const rows=this.ctx.storage.sql.exec('SELECT data FROM room WHERE id=1').toArray();return rows.length?JSON.parse(rows[0].data):null;}
  write(data){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO room (id,data) VALUES (1,?)',JSON.stringify(data));}
  async initialize(state,hostHash,guestHash) {
    if(this.read())return false;
    this.write({state,hostHash,guestHash,editing:true,ended:false,revision:0,expires:Date.now()+DAY});
    await this.ctx.storage.setAlarm(Date.now()+DAY);return true;
  }
  async authorize(value, write=false) {
    if(typeof value!=='string'||value.length!==64)throw Error('Invalid session credential.');
    const digest=await hash(value),room=this.read();
    if(!room||room.ended||Date.now()>room.expires)throw Error('Session has ended.');
    const host=digest===room.hostHash;
    if(!host && digest!==room.guestHash)throw Error('Invalid session credential.');
    if(write&&!host&&!room.editing)throw Error('Student editing is off.');
    return {room,host};
  }
  async storeAsset(value,data) {
    await this.authorize(value,true);
    if(typeof data!=='string'||data.length>MAX_ASSET||!/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(data))throw Error('PDF page or image is too large to share.');
    const id=await hash(data);
    // Authorization is checked again after hashing, before the atomic storage writes.
    await this.authorize(value,true);
    if(this.ctx.storage.sql.exec('SELECT id FROM assets WHERE id=?',id).toArray().length)return {id};
    const used=this.ctx.storage.sql.exec('SELECT COALESCE(SUM(size),0) AS total FROM assets').one().total;
    if(used+data.length>MAX_ASSETS)throw Error('This session has reached its 40 MB document limit. Split the PDF into a smaller session.');
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec('INSERT INTO assets (id,size) VALUES (?,?)',id,data.length);
      for(let offset=0,part=0;offset<data.length;offset+=64000,part++)this.ctx.storage.sql.exec('INSERT INTO asset_chunks (id,part,data) VALUES (?,?,?)',id,part,data.slice(offset,offset+64000));
    });
    return {id};
  }
  async readAsset(value,id) {
    await this.authorize(value);
    if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid PDF page.');
    const rows=this.ctx.storage.sql.exec('SELECT data FROM asset_chunks WHERE id=? ORDER BY part',id).toArray();
    if(!rows.length)throw Error('Shared PDF page is unavailable.');
    return {data:rows.map(row=>row.data).join('')};
  }
  changeState(room,ops,host){
    const state=applyOps(room.state,ops,host);
    for(const op of ops)if(op.type==='put')for(const match of op.svg.matchAll(/sketch-asset:([a-f0-9]{64})/g))if(!this.ctx.storage.sql.exec('SELECT id FROM assets WHERE id=?',match[1]).toArray().length)throw Error('Upload the PDF page before sharing it.');
    room.state=state;room.revision++;this.write(room);return room;
  }
  async commit(value,ops) {
    const {room,host}=await this.authorize(value,true);
    if(!host)throw Error('Only the teacher can import PDF pages.');
    this.changeState(room,ops,host);this.broadcast({type:'ops',ops,revision:room.revision,client:'document-import'});return {revision:room.revision};
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
      try{this.changeState(room,message.ops,attachment.role==='host');}catch(error){this.send(ws,{type:'rejected',batch:message.batch,message:error.message});return;}
      this.broadcast({type:'ops',ops:message.ops,revision:room.revision,client:attachment.client,batch:message.batch});
    } catch {this.send(ws,{type:'error',message:'Could not process this change.'});}
  }
  webSocketClose(ws,code,reason){ws.close(code,reason);this.presence();}
  webSocketError(ws){ws.close(1011,'Connection lost');this.presence();}
  async alarm(){this.broadcast({type:'ended'});for(const ws of this.ctx.getWebSockets())ws.close(1000,'Session expired');this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec('DELETE FROM asset_chunks');this.ctx.storage.sql.exec('DELETE FROM assets');this.ctx.storage.sql.exec('DELETE FROM room');});}
}
async function boundedJson(request,limit=MAX_MESSAGE) {
  const reader=request.body?.getReader();if(!reader)throw Error('Missing data');let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Initial board is too large. Start with a smaller whiteboard.');chunks.push(value);}}catch(e){await reader.cancel();throw e;}
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
      const assetRoute=url.pathname.match(/^\/rooms\/([a-f0-9-]{36})\/(assets|asset|ops)$/);
      if(assetRoute&&request.method==='POST'){
        const data=await boundedJson(request,assetRoute[2]==='assets'?MAX_ASSET+1024:MAX_MESSAGE);
        const room=env.ROOMS.getByName(assetRoute[1]);
        if(assetRoute[2]==='assets')return reply(await room.storeAsset(data.token,data.data));
        if(assetRoute[2]==='asset')return reply(await room.readAsset(data.token,data.id));
        return reply(await room.commit(data.token,data.ops));
      }
      const match=url.pathname.match(/^\/rooms\/([a-f0-9-]{36})\/connect$/);
      if(match&&request.method==='GET')return env.ROOMS.getByName(match[1]).fetch(request);
      return reply({error:'Not found'},404);
    }catch(error){return reply({error:error.message||'Could not start session.'},400);}
  }
};
