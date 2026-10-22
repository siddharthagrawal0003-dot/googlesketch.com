/* Shared whiteboard sessions. Standalone work keeps its existing local save path. */
(() => {
  'use strict';
  const uuid=()=>crypto.randomUUID?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const API='https://googlesketch-collab.siddharth-agrawal0003.workers.dev';
  const originalSave=save, originalAdd=addPage;
  const c={room:null,role:null,token:null,guestToken:null,socket:null,ready:false,editing:true,base:null,ids:[],pending:new Map(),client:uuid(),retry:0,stopped:false,applying:false,incoming:[]};
  const share=[...document.querySelectorAll('header button')].find(b=>b.textContent.includes('Share workspace'));
  share.removeAttribute('onclick');share.id='shareWorkspace';share.onclick=openSession;
  const dialog=document.createElement('dialog');dialog.id='sessionDialog';dialog.setAttribute('aria-labelledby','sessionHeading');
  dialog.innerHTML=`<div class="session-head"><h2 id="sessionHeading">Share whiteboard</h2><button id="closeSessionDialog" aria-label="Close sharing">✕</button></div><p id="sessionDescription">Start a live session and invite your student. No account needed.</p><div id="sessionStart"><p class="session-note">Your current whiteboard will be shared with anyone who has the student link. Sessions last up to 24 hours. PDF, image and video imports stay available in your personal workspace.</p><button class="primary" id="startSession">Start session</button></div><div id="sessionActive" hidden><p id="sessionConnection" role="status"></p><div id="teacherSharing"><label for="studentLink">Student invitation link</label><div class="session-link"><input id="studentLink" readonly><button id="copyStudentLink">Copy link</button></div><label class="session-edit"><input id="studentEditing" type="checkbox" checked> Allow student to edit</label><p class="session-note">Keep this teacher tab open. Share only the student link above.</p><button id="endSession">End session for everyone</button></div><div id="studentSharing" hidden><p id="studentPermission"></p><button id="leaveSession">Leave session</button></div></div><p id="sessionError" role="alert"></p>`;
  document.body.append(dialog);
  const css=document.createElement('style');css.textContent=`#sessionDialog{width:min(520px,calc(100vw - 24px));max-height:90dvh;overflow:auto;border:1px solid var(--surface-high);border-radius:24px;padding:24px;background:var(--surface-low);color:var(--text)}.session-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.session-head h2{margin:0;font-size:23px}.session-head button{padding:6px 10px}.session-note{font-size:12px;color:var(--muted);line-height:1.6}.session-link{display:flex;gap:8px;margin:8px 0 18px}.session-link input{min-width:0;flex:1;padding:10px;border:1px solid #c4c7c5;border-radius:10px;background:var(--surface);color:var(--text)}.session-edit{display:flex;align-items:center;gap:9px;margin:12px 0}.session-edit input{width:18px;height:18px}#sessionError{color:#b3261e;line-height:1.5}#sessionConnection{color:var(--primary)}#endSession{color:#b3261e}body.session-viewer #selectionBox{display:none!important}body.session-viewer #paper{cursor:default}#sessionBanner{font-size:12px;color:var(--primary);padding:5px 10px;border-radius:12px;background:var(--primary-container)}[hidden]{display:none!important}`;document.head.append(css);
  const banner=document.createElement('span');banner.id='sessionBanner';banner.hidden=true;banner.setAttribute('role','status');document.querySelector('.documentbar').append(banner);
  const $s=id=>document.getElementById(id);
  $s('closeSessionDialog').onclick=()=>dialog.close();$s('startSession').onclick=startSession;
  $s('copyStudentLink').onclick=async()=>{try{await navigator.clipboard.writeText($s('studentLink').value);toast('Student link copied.');}catch{$s('studentLink').select();toast('Select and copy the student link.');}};
  $s('studentEditing').onchange=()=>{if(c.ready)c.socket.send(JSON.stringify({type:'editing',value:$s('studentEditing').checked}));else $s('studentEditing').checked=c.editing;};
  $s('endSession').onclick=()=>{if(c.ready&&confirm('End this session for everyone? Each person keeps their own copy.'))c.socket.send(JSON.stringify({type:'end'}));};
  $s('leaveSession').onclick=()=>stop('You left the session. Your copy is saved on this device.');
  function status(text){banner.textContent=text;banner.hidden=!c.room;$s('sessionConnection').textContent=text;if(c.room)$('#saveState').textContent=c.ready?'● Live session':'● Connecting…';}
  function openSession(){updateDialog();dialog.showModal();}
  function updateDialog(){
    $s('sessionStart').hidden=!!c.room;$s('sessionActive').hidden=!c.room;
    $s('teacherSharing').hidden=c.role!=='host';$s('studentSharing').hidden=c.role!=='guest';
    $s('sessionDescription').textContent=c.room?'Changes appear on both whiteboards as each action is completed.':'Start a live session and invite your student. No account needed.';
    $s('studentEditing').checked=c.editing;$s('studentEditing').disabled=!c.ready;
    $s('studentPermission').textContent=c.editing?'You can write on this shared whiteboard.':'Your teacher has switched student editing off. You can still follow along.';
    if(c.guestToken)$s('studentLink').value=location.origin+location.pathname+'#room='+c.room+'&key='+c.guestToken;
    share.textContent=c.room?'♧ Session':'♧ Share workspace';
    const blocked=!!c.room&&(!c.ready||(c.role==='guest'&&!c.editing));document.body.classList.toggle('session-viewer',blocked);
    $('#title').contentEditable=String(!c.room||c.role==='host');
  }
  // Remote SVG is reconstructed from an allowlist before it can enter the board.
  const tags=new Set(['g','path','line','polyline','polygon','rect','ellipse','circle','text','tspan','defs','marker','clipPath','mask','metadata','title','desc','image']);
  const attributes=new Set(['id','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','width','height','d','points','transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','opacity','fill-opacity','stroke-opacity','font-size','font-family','font-style','font-weight','text-anchor','dominant-baseline','dx','dy','rotate','marker-end','marker-start','marker-mid','markerWidth','markerHeight','refX','refY','orient','markerUnits','viewBox','preserveAspectRatio','clip-path','clipPathUnits','mask','maskUnits','data-points','data-old','data-collab-id','data-board-width','data-board-height','data-background','data-whiteout','data-graph']);
  function safeNode(markup,id){
    const doc=new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">'+markup+'</svg>','image/svg+xml');if(doc.querySelector('parsererror'))return null;
    function copy(source){if(source.nodeType===3)return document.createTextNode(source.textContent);if(source.nodeType!==1||source.namespaceURI!==NS||!tags.has(source.localName))return null;
      const target=document.createElementNS(NS,source.localName);for(const a of source.attributes){if(attributes.has(a.name)&&!/[<>]/.test(a.value)&&(!/url\s*\(/i.test(a.value)||/^url\(#[\w-]+\)$/.test(a.value)))target.setAttribute(a.name,a.value);
      // Embedded SVG graph images are rendered in an isolated image context, never injected as markup.
      if(a.name==='href'&&source.localName==='image'&&/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(a.value))target.setAttribute('href',a.value);}
      for(const child of source.childNodes){const n=copy(child);if(n)target.append(n);}return target;}
    const n=copy(doc.documentElement.firstElementChild);if(n)n.dataset.collabId=id;return n;
  }
  function objects(root){const seen=new Set();return [...root.children].map(n=>{let id=n.dataset.collabId;if(!id||seen.has(id))id=uuid();n.dataset.collabId=id;seen.add(id);return {id,svg:n.outerHTML};});}
  function capture(){
    pages[page]=svg.innerHTML;
    while(c.ids.length<pages.length)c.ids.push(uuid());c.ids.length=pages.length;
    const state={title:$('#title').textContent.slice(0,120),pages:pages.map((markup,i)=>{let root;if(i===page)root=svg;else root=new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">'+markup+'</svg>','image/svg+xml').documentElement;const list=objects(root);pages[i]=root.innerHTML;return {id:c.ids[i],objects:list};})};
    return state;
  }
  function diff(before,after){const ops=[];if(before.title!==after.title)ops.push({type:'title',value:after.title});for(const p of after.pages){const old=before.pages.find(x=>x.id===p.id);if(!old)ops.push({type:'page',page:p.id});const map=new Map((old?.objects||[]).map(o=>[o.id,o.svg]));for(const o of p.objects){if(map.get(o.id)!==o.svg)ops.push({type:'put',page:p.id,...o});map.delete(o.id);}for(const id of map.keys())ops.push({type:'delete',page:p.id,id});}return ops;}
  function apply(state,ops){for(const op of ops){if(op.type==='title'){state.title=op.value;continue;}let p=state.pages.find(x=>x.id===op.page);if(op.type==='page'){if(!p)state.pages.push({id:op.page,objects:[]});continue;}if(!p)continue;const i=p.objects.findIndex(x=>x.id===op.id);if(op.type==='delete'){if(i>=0)p.objects.splice(i,1);}else if(op.type==='put'){const object={id:op.id,svg:op.svg};if(i>=0)p.objects[i]=object;else p.objects.push(object);}}return state;}
  function display(state){
    const currentId=c.ids[page];c.ids=state.pages.map(p=>p.id);page=Math.max(0,c.ids.indexOf(currentId));
    const cleaned=state.pages.map(p=>p.objects.map(o=>safeNode(o.svg,o.id)).filter(Boolean));pages=cleaned.map(nodes=>nodes.map(n=>n.outerHTML).join(''));
    const wanted=new Map(cleaned[page].map(n=>[n.dataset.collabId,n]));for(const child of [...svg.children])if(!wanted.has(child.dataset.collabId))child.remove();
    for(const [id,n] of wanted){const old=[...svg.children].find(x=>x.dataset.collabId===id);if(!old)svg.append(n);else if(old.outerHTML!==n.outerHTML)old.replaceWith(n);}
    $('#title').textContent=state.title;selectObject(null);hist=[];future=[];fitBoard();renderPages();
    c.applying=true;originalSave();c.applying=false;status(c.ready?'Live · '+(c.role==='host'?'Teacher':'Student'):'Connecting…');
  }
  function canEdit(){return !c.room||(c.ready&&(c.role==='host'||c.editing));}
  save=function(){
    if(!c.room||c.applying){originalSave();return;}
    if(!canEdit()){if(c.base)display(c.base);return;}
    const now=capture(),ops=diff(c.base,now);if(!ops.length){originalSave();status('Live · '+(c.role==='host'?'Teacher':'Student'));return;}
    if(c.role==='guest'&&ops.some(o=>o.type==='page'||o.type==='title')){display(c.base);toast('Your teacher manages pages and the session name.');return;}
    const batch=uuid(),message=JSON.stringify({type:'ops',ops,batch});
    if(new TextEncoder().encode(message).length>250000){display(c.base);toast('This change is too large to share. Try a smaller object.');return;}
    c.pending.set(batch,ops);c.base=now;c.socket.send(message);originalSave();status('Syncing…');
  };
  addPage=function(){if(c.room&&c.role!=='host'){toast('Your teacher manages shared pages.');return;}if(!canEdit())return;originalAdd();};
  function guard(event){if(!c.room)return;const t=event.target;if(!canEdit()&&(t.closest('#paper,#selectionBox')||event.type==='keydown'&&!editingField(event)||event.type==='paste'&&!editingField(event))){event.preventDefault();event.stopImmediatePropagation();return;}
    if(event.type==='click'&&t.closest('[onclick]')&&/import|#file|#project/.test(t.closest('[onclick]').getAttribute('onclick'))){event.preventDefault();event.stopImmediatePropagation();toast('Use imports in your personal workspace. Shared sessions currently support whiteboard objects and graphs.');}}
  for(const name of ['pointerdown','pointermove','pointerup','dblclick','keydown','paste','click'])document.addEventListener(name,guard,true);
  for(const id of ['file','project'])$s(id).addEventListener('change',e=>{if(c.room){e.stopImmediatePropagation();e.target.value='';toast('Imports are available outside shared sessions.');}},true);
  $('#title').addEventListener('blur',()=>{if(c.room)save();});
  async function startSession(){
    $s('sessionError').textContent='';$s('startSession').disabled=true;
    try{
      originalSave();c.ids=[];const state=capture();if(state.pages.some(p=>p.objects.some(o=>/data-background=|foreignObject|<image(?![^>]*data-graph=)/.test(o.svg))))throw Error('Start with a whiteboard without imported PDFs, images or video. Graphs are supported.');
      const ops=diff({title:'',pages:[]},state);const response=await fetch(API+'/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ops})});const data=await response.json();if(!response.ok)throw Error(data.error||'Could not start session.');
      Object.assign(c,{room:data.id,token:data.hostToken,guestToken:data.guestToken,role:'host',stopped:false,base:state});
      try{localStorage.setItem('sketch-host-'+c.room,JSON.stringify({token:c.token,guestToken:c.guestToken}));}catch{toast('Keep this tab open: this device cannot save your teacher session.');}history.replaceState(null,'',location.pathname+'#room='+c.room);connect();updateDialog();
    }catch(error){$s('sessionError').textContent=error.message;}finally{$s('startSession').disabled=false;}
  }
  function connect(){
    c.ready=false;status(c.retry?'Connection lost · reconnecting…':'Connecting…');updateDialog();
    const ws=new WebSocket(API.replace('https:','wss:')+'/rooms/'+c.room+'/connect');c.socket=ws;
    ws.onopen=()=>ws.send(JSON.stringify({type:'auth',token:c.token,client:c.client}));
    function receive(m){
      if(m.type==='ready'||m.type==='snapshot'){
        c.ready=true;c.retry=0;c.role=m.role||c.role;c.editing=m.editing;
        let state=m.state;const resend=[...c.pending];for(const [,ops]of resend)apply(state,ops);c.base=state;display(state);updateDialog();
        for(const [batch,ops]of resend)ws.send(JSON.stringify({type:'ops',batch,ops}));return;
      }
      if(m.type==='ops'){
        const self=m.client===c.client;if(!self&&(drawing||moving||erasing||resizeGesture)){c.incoming.push(m);return;}if(self)c.pending.delete(m.batch);
        // Preserve local work that has not yet been saved while merging another user's objects.
        const local=capture(),unsaved=diff(c.base,local);let state=apply(structuredClone(c.base),m.ops);
        for(const [,ops]of c.pending)apply(state,ops);c.base=structuredClone(state);apply(state,unsaved);
        if(!self)display(state);status(c.pending.size?'Syncing…':'Live · '+(c.role==='host'?'Teacher':'Student'));return;
      }
      if(m.type==='editing'){c.editing=m.value;if(!c.editing&&c.role==='guest'){drawing=null;moving=null;erasing=false;resizeGesture=null;if(c.base)display(c.base);}updateDialog();status(c.editing?'Live · student editing on':'Live · student editing off');return;}
      if(m.type==='presence'){status('Live · '+m.count+' connected');return;}
      if(m.type==='rejected'){c.pending.delete(m.batch);$s('sessionError').textContent=m.message;toast(m.message);ws.send(JSON.stringify({type:'sync'}));return;}
      if(m.type==='error'){toast(m.message);return;}
      if(m.type==='ended')stop('Session ended. Your copy is saved on this device.');
    };
    ws.onmessage=event=>{if(c.socket!==ws)return;try{receive(JSON.parse(event.data));}catch{toast('Could not read a shared change. Reconnecting…');ws.close();}};
    c.receive=receive;
    ws.onclose=event=>{if(c.socket!==ws||c.stopped)return;c.ready=false;updateDialog();if(event.code===1008){stop('This invitation is invalid. Ask your teacher for a new link.');return;}if(c.retry>=6){stop('Could not reconnect. Your copy is saved. Reopen the session link to try again.',true);return;}status('Connection lost · reconnecting…');setTimeout(()=>{if(!c.stopped)connect();},Math.min(15000,1000*2**c.retry++));};
    ws.onerror=()=>status('Connection interrupted · reconnecting…');
  }
  function stop(message,keepHost=false){c.stopped=true;c.socket?.close();const wasRoom=c.room;c.room=null;c.ready=false;c.pending.clear();c.incoming=[];banner.hidden=true;document.body.classList.remove('session-viewer');history.replaceState(null,'',location.pathname);updateDialog();originalSave();toast(message);$s('sessionError').textContent=message;if(!keepHost&&c.role==='host'&&wasRoom)localStorage.removeItem('sketch-host-'+wasRoom);}
  // Finish the local gesture before merging queued remote changes.
  document.addEventListener('pointerup',()=>{setTimeout(()=>{if(c.room&&c.incoming.length&&!drawing&&!moving&&!erasing&&!resizeGesture){const incoming=c.incoming.splice(0);for(const m of incoming)c.receive(m);}},0);});
  window.addEventListener('online',()=>{if(c.room&&!c.ready&&!c.stopped){c.retry=0;connect();}});
  window.addEventListener('beforeunload',event=>{if(c.pending.size){event.preventDefault();event.returnValue='';}});
  const invitation=new URLSearchParams(location.hash.slice(1)),room=invitation.get('room'),key=invitation.get('key');
  if(room&&/^[a-f0-9-]{36}$/.test(room)){
    let host;try{host=JSON.parse(localStorage.getItem('sketch-host-'+room));}catch{}
    if(key&&/^[a-f0-9]{64}$/.test(key)){Object.assign(c,{room,token:key,role:'guest',stopped:false});connect();}
    else if(host?.token){Object.assign(c,{room,token:host.token,guestToken:host.guestToken,role:'host',stopped:false});connect();}
    else{toast('Ask your teacher for the complete student invitation link.');}
  }
})();
