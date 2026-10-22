import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(process.env.SKETCH_TEST_DEPENDENCIES || import.meta.url);
const {Miniflare}=require('miniflare');
const mf=new Miniflare({modules:true,scriptPath:new URL('../collaboration/worker.mjs',import.meta.url).pathname,// The installed local runtime supports this date; production uses 2026-10-22.
compatibilityDate:'2026-08-06',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOMS:{className:'SketchRoom',useSQLite:true}}});
const origin='https://googlesketch.com';
const messages=new WeakMap();
function wait(ws,type){return new Promise((resolve,reject)=>{const q=messages.get(ws);const old=q.findIndex(m=>m.type===type);if(old>=0)return resolve(q.splice(old,1)[0]);const timer=setTimeout(()=>{ws.removeEventListener('message',handler);reject(Error('Timed out: '+type));},4000);function handler(e){const m=JSON.parse(e.data);if(m.type===type){const idx=q.findIndex(item=>item.type===type);if(idx>=0)q.splice(idx,1);clearTimeout(timer);ws.removeEventListener('message',handler);resolve(m);}}ws.addEventListener('message',handler);});}
async function connect(id,token,client){const r=await mf.dispatchFetch(`https://test/rooms/${id}/connect`,{headers:{Origin:origin,Upgrade:'websocket'}});assert.equal(r.status,101);const ws=r.webSocket;ws.accept();messages.set(ws,[]);ws.addEventListener('message',e=>messages.get(ws).push(JSON.parse(e.data)));ws.send(JSON.stringify({type:'auth',token,client}));return ws;}
const send=(ws,m)=>ws.send(JSON.stringify(m));
try{
  const bad=await mf.dispatchFetch('https://test/rooms',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'});assert.equal(bad.status,403);
  const created=await mf.dispatchFetch('https://test/rooms',{method:'POST',headers:{Origin:origin},body:JSON.stringify({ops:[{type:'page',page:'p1'}]})});assert.equal(created.status,201);const room=await created.json();
  const host=await connect(room.id,room.hostToken,'host-client');assert.equal((await wait(host,'ready')).role,'host');
  const guest=await connect(room.id,room.guestToken,'guest-client');assert.equal((await wait(guest,'ready')).role,'guest');
  send(host,{type:'ops',batch:'a',ops:[{type:'put',page:'p1',id:'host-shape',svg:'<rect x="10" y="10" width="30" height="30"/>'}]});assert.equal((await wait(guest,'ops')).ops[0].id,'host-shape');await wait(host,'ops');
  send(guest,{type:'ops',batch:'b',ops:[{type:'put',page:'p1',id:'guest-shape',svg:'<circle cx="10" cy="10" r="5"/>'}]});assert.equal((await wait(host,'ops')).ops[0].id,'guest-shape');await wait(guest,'ops');
  send(host,{type:'editing',value:false});assert.equal((await wait(guest,'editing')).value,false);await wait(host,'editing');
  send(guest,{type:'ops',batch:'blocked',ops:[{type:'delete',page:'p1',id:'host-shape'}]});assert.equal((await wait(guest,'rejected')).batch,'blocked');
  send(guest,{type:'editing',value:true});send(guest,{type:'sync'});const snapshot=await wait(guest,'snapshot');assert.equal(snapshot.editing,false);assert.equal(snapshot.state.pages[0].objects.length,2);
  send(host,{type:'editing',value:true});await wait(guest,'editing');await wait(host,'editing');
  // Interleaved changes must retain both independent objects.
  send(host,{type:'ops',batch:'c',ops:[{type:'put',page:'p1',id:'third',svg:'<path d="M1 1L2 2"/>'}]});send(guest,{type:'ops',batch:'d',ops:[{type:'put',page:'p1',id:'fourth',svg:'<path d="M3 3L4 4"/>'}]});await wait(host,'ops');await wait(host,'ops');
  const resumed=await connect(room.id,room.guestToken,'resumed');assert.equal((await wait(resumed,'ready')).state.pages[0].objects.length,4);
  send(guest,{type:'ops',batch:'forbidden-page',ops:[{type:'page',page:'student-page'}]});assert.match((await wait(guest,'rejected')).message,/teacher/);
  send(host,{type:'end'});assert.equal((await wait(guest,'ended')).type,'ended');const ended=await mf.dispatchFetch(`https://test/rooms/${room.id}/connect`,{headers:{Origin:origin,Upgrade:'websocket'}});assert.equal(ended.status,410);
  console.log('PASS: origin restriction, role authentication, bidirectional updates, simultaneous objects, server-enforced editing permission, reconnect snapshot, teacher-only pages, session end.');
}finally{await mf.dispose();}
