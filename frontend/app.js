const state={files:[],sending:false,newChatBusy:false,conversationId:null};
const $=s=>document.querySelector(s);
const messages=$("#messages"),input=$("#message"),toast=$("#toast");
const welcomeHTML=()=>`<div id="welcome" class="welcome"><svg class="welcome-logo" viewBox="0 0 64 64" aria-hidden="true"><use href="#i-logo"/></svg><h3>How can OMNIA IQ help?</h3><p>Ask anything. In Agent mode OMNIA researches the web, reads pages and files, creates documents and code, and works in your browser with your approval.</p></div>`;
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function renderMarkdown(raw){
 // Safety first: escape the ENTIRE input before any markdown processing, so no
 // markup we generate below can ever be reached by unescaped model/user text -
 // every tag in the final HTML is one this function added itself.
 let src=esc(raw==null?"":String(raw));
 const codeBlocks=[];
 // Fenced code blocks are pulled out and protected before any other processing
 // touches the text, so backticks/asterisks/underscores inside code are never
 // misread as inline formatting.
 src=src.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>{
  const idx=codeBlocks.length;
  codeBlocks.push({lang:(lang||"").trim(),code:code.replace(/\n$/,"")});
  return `\u0000CODEBLOCK${idx}\u0000`;
 });
 function inline(text){
  const spans=[];
  // Inline code is protected the same way as fenced blocks, for the same reason.
  text=text.replace(/`([^`\n]+)`/g,(_,code)=>{const idx=spans.length;spans.push(`<code>${code}</code>`);return `\u0001SPAN${idx}\u0001`});
  text=text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(_,label,url)=>{const idx=spans.length;spans.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);return `\u0001SPAN${idx}\u0001`});
  text=text.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g,(_,a,b)=>`<strong>${a||b}</strong>`);
  text=text.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)|(?<![_\w])_([^_\n]+)_(?!\w)/g,(_,a,b)=>`<em>${a||b}</em>`);
  text=text.replace(/\u0001SPAN(\d+)\u0001/g,(_,i)=>spans[Number(i)]);
  return text;
 }
 const lines=src.split("\n");
 const out=[];
 let list=null; // {type:"ul"|"ol", items:[]}
 let quote=null;
 function flushList(){if(list){out.push(`<${list.type}>${list.items.map(i=>`<li>${inline(i)}</li>`).join("")}</${list.type}>`);list=null}}
 function flushQuote(){if(quote){out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);quote=null}}
 for(const line of lines){
  const heading=line.match(/^(#{1,4})\s+(.*)$/);
  const ol=line.match(/^\s*\d+[.)]\s+(.*)$/);
  const ul=line.match(/^\s*[-*]\s+(.*)$/);
  const bq=line.match(/^\s*&gt;\s?(.*)$/);
  if(heading){flushList();flushQuote();const lvl=heading[1].length;out.push(`<h${lvl+2}>${inline(heading[2])}</h${lvl+2}>`);continue}
  if(/^\s*(-{3,}|\*{3,})\s*$/.test(line)){flushList();flushQuote();out.push("<hr>");continue}
  if(ol){flushQuote();if(!list||list.type!=="ol")flushList(),list={type:"ol",items:[]};list.items.push(ol[1]);continue}
  if(ul){flushQuote();if(!list||list.type!=="ul")flushList(),list={type:"ul",items:[]};list.items.push(ul[1]);continue}
  if(bq){flushList();if(!quote)quote=[];quote.push(bq[1]);continue}
  flushList();flushQuote();
  if(line.trim()===""){out.push("");continue}
  out.push(`<p>${inline(line)}</p>`);
 }
 flushList();flushQuote();
 let html=out.join("\n").replace(/(?:<p><\/p>\n?){1,}/g,"");
 html=html.replace(/\u0000CODEBLOCK(\d+)\u0000/g,(_,i)=>{
  const block=codeBlocks[Number(i)];
  const langLabel=block.lang?esc(block.lang):"text";
  return `<div class="code-block"><div class="code-block-head"><span>${langLabel}</span><button type="button" class="copy-code-btn">Copy</button></div><pre><code>${block.code}</code></pre></div>`;
 });
 return html;
}
function add(role,text,extra=""){
 const w=$("#welcome");if(w)w.remove();
 const n=document.createElement("div");n.className=`message ${role} ${extra}`;
 if(role==="assistant"&&extra!=="thinking"&&extra!=="error"){n.innerHTML=renderMarkdown(text)}else{n.textContent=text}
 messages.appendChild(n);messages.scrollTop=messages.scrollHeight;return n
}
function setMessageText(node,role,text,extra=""){
 node.className=`message ${role} ${extra}`.trim();
 if(role==="assistant"&&extra!=="thinking"&&extra!=="error"){node.innerHTML=renderMarkdown(text)}else{node.textContent=text}
}
messages.addEventListener("click",e=>{
 const btn=e.target.closest(".copy-code-btn");if(!btn)return;
 const code=btn.closest(".code-block")?.querySelector("code");if(!code)return;
 navigator.clipboard?.writeText(code.textContent).then(()=>{const original=btn.textContent;btn.textContent="Copied!";setTimeout(()=>btn.textContent=original,1500)}).catch(()=>notify("Could not copy to clipboard."));
});
function notify(t){toast.textContent=t;toast.classList.remove("hidden");clearTimeout(window.__toast);window.__toast=setTimeout(()=>toast.classList.add("hidden"),3500)}
window.omniaNotify=notify;

// A long video (10 minutes of footage) can legitimately render for well over 30 minutes on a modest laptop.
const LONG_RENDER_TIMEOUT_MS=6*60*60*1000;
const ACCESS_KEY_STORAGE = "omnia_access_key";
function getStoredAccessKey(){try{return localStorage.getItem(ACCESS_KEY_STORAGE)||""}catch{return""}}
function setStoredAccessKey(key){try{if(key)localStorage.setItem(ACCESS_KEY_STORAGE,key);else localStorage.removeItem(ACCESS_KEY_STORAGE)}catch{}}
let accessKeyOverlayShowing=false;
function showAccessKeyOverlay(message){
 if(accessKeyOverlayShowing)return;
 accessKeyOverlayShowing=true;
 const overlay=document.createElement("div");
 overlay.className="access-key-overlay";
 overlay.innerHTML=`<div class="access-key-box"><h3>OMNIA IQ is protected</h3><p>${esc(message||"Enter the access key configured for this OMNIA IQ instance.")}</p><input type="password" id="accessKeyInput" placeholder="Access key" autocomplete="off"><input type="text" id="accessOtpInput" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="Authenticator code (if enabled)"><button type="button" id="accessKeySubmit">Unlock</button><small id="accessKeyError" class="access-key-error"></small></div>`;
 document.body.appendChild(overlay);
 const input=overlay.querySelector("#accessKeyInput");
 const submit=async()=>{
  const key=input.value.trim();
  if(!key)return;
  try{
   const response=await fetch('/api/system/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,otp:overlay.querySelector("#accessOtpInput").value.trim()||null}),credentials:'same-origin'});
   if(!response.ok){const error=await response.json();overlay.querySelector('#accessKeyError').textContent=error.detail||'Sign-in failed';return}
  }catch{overlay.querySelector('#accessKeyError').textContent='Could not reach OMNIA';return}
  setStoredAccessKey('');
  overlay.remove();
  accessKeyOverlayShowing=false;
  location.reload();
 };
 overlay.querySelector("#accessKeySubmit").onclick=submit;
 input.addEventListener("keydown",e=>{if(e.key==="Enter")submit()});
 input.focus();
}
async function apiFetch(url,options={},timeoutMs=900000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 const key=getStoredAccessKey();
 const headers={...(options.headers||{})};
 if(key)headers["X-OMNIA-Access-Key"]=key;
 try{
  const response=await fetch(url,{...options,headers,signal:controller.signal});
  if(response.status===401&&!url.includes("auth-status")){
   let detail="";try{detail=(await response.clone().json()).detail||""}catch{}
   window.omniaSessionExpired?.();
  }
  return response;
 }
 catch(err){
  if(err.name==="AbortError")throw new Error("OMNIA IQ took too long to respond. The local model may be overloaded.");
  throw new Error("Connection to the OMNIA IQ backend was lost. Keep the OMNIA window open, check logs/runtime.log, and try Fast local mode for large files.");
 }finally{clearTimeout(timer)}
}
window.omniaApiFetch=apiFetch;
async function checkAccessKeyProtection(){
 try{
  const r=await fetch("/api/system/auth-status",{cache:"no-store"});
  const d=await r.json();
  if(d.launch_control_available===false){const nav=document.querySelector('nav [data-tab="launch"]');if(nav)nav.hidden=true;const panel=document.querySelector('#launch');if(panel)panel.hidden=true}
  if(d.protected){
   const sessionCheck=await fetch('/api/system/status',{credentials:'same-origin'});
   if(sessionCheck.ok)return;
   const key=getStoredAccessKey();
   if(!key){showAccessKeyOverlay();return}
   // Confirm the stored key is still valid before trusting it for the rest
   // of this session, rather than only discovering it's stale on first use.
   const test=await fetch("/api/system/status",{headers:{"X-OMNIA-Access-Key":key}});
   if(test.status===401){setStoredAccessKey("");showAccessKeyOverlay("That saved access key is no longer valid. Enter the current one.")}
  }
 }catch{/* connectivity issues are surfaced elsewhere; do not block on this check */}
}
function appendSources(node,sources){
 if(!sources||!sources.length)return;
 const box=document.createElement("div");box.className="message-sources";
 box.innerHTML=`<span class="message-sources-label">Sources</span>`+sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.snippet||"")}">${esc(s.title||s.url)}</a>`).join("");
 node.appendChild(box);messages.scrollTop=messages.scrollHeight;
}
async function history(){
 if(!state.conversationId){messages.innerHTML=welcomeHTML();return}
 const r=await apiFetch(`/api/chat/history?conversation_id=${state.conversationId}`,{},30000);const d=await r.json();messages.innerHTML="";if(!d.messages.length){messages.innerHTML=welcomeHTML();return}d.messages.forEach(m=>add(m.role,m.content))
}
async function loadConversations(){
 const q=$("#conversationSearch")?.value.trim()||"";const r=await apiFetch(q?`/api/chat/conversations/search?q=${encodeURIComponent(q)}`:"/api/chat/conversations",{cache:"no-store"},30000);const d=await r.json();
 const box=$("#conversationList");
 const items=d.conversations||[];
 if(!items.length){box.innerHTML='<div class="conversation-empty">No conversations yet</div>';return}
 box.innerHTML=items.map(c=>`<div class="conversation-item ${c.id===state.conversationId?"active":""}" data-conversation="${c.id}"><span class="conversation-title">${esc(c.title||"New conversation")}</span><button type="button" data-instructions-conversation="${c.id}" title="Chat instructions" aria-label="Chat instructions">⚙</button><button type="button" data-fork-conversation="${c.id}" title="Branch conversation" aria-label="Branch conversation">⑂</button><button type="button" data-rename-conversation="${c.id}" title="Rename" aria-label="Rename conversation">✎</button><button type="button" data-delete-conversation="${c.id}" title="Delete" aria-label="Delete conversation">×</button></div>`).join("");
 box.querySelectorAll("[data-conversation]").forEach(el=>el.onclick=e=>{if(e.target.closest("button"))return;selectConversation(Number(el.dataset.conversation))});
 box.querySelectorAll("[data-instructions-conversation]").forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=Number(btn.dataset.instructionsConversation);await editChatInstructions(id)});
 box.querySelectorAll("[data-fork-conversation]").forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=Number(btn.dataset.forkConversation);await forkChat(id)});
 box.querySelectorAll("[data-rename-conversation]").forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=Number(btn.dataset.renameConversation);const current=items.find(c=>c.id===id);const next=prompt("Rename conversation",current?.title||"");if(next===null)return;const trimmed=next.trim();if(!trimmed)return;await apiFetch(`/api/chat/conversations/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:trimmed})},15000);loadConversations()});
 box.querySelectorAll("[data-delete-conversation]").forEach(btn=>btn.onclick=async e=>{e.stopPropagation();const id=Number(btn.dataset.deleteConversation);if(!confirm("Delete this conversation? This cannot be undone."))return;await apiFetch(`/api/chat/conversations/${id}`,{method:"DELETE"},15000);if(state.conversationId===id){state.conversationId=null;messages.innerHTML=welcomeHTML()}loadConversations()});
}
async function editChatInstructions(id){
 try{const r=await apiFetch(`/api/chat/conversations/${id}`,{},15000);if(!r.ok)throw Error("Conversation not found");const data=await r.json();const result=prompt("Instructions for this conversation (leave blank to clear):",data.instructions||"");if(result===null)return;const saved=await apiFetch(`/api/chat/conversations/${id}/instructions`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({instructions:result})},15000);if(!saved.ok)throw Error("Failed to save instructions");notify("Conversation instructions saved");}catch(err){notify(err.message)}
}
async function forkChat(id){
 try{const r=await apiFetch(`/api/chat/conversations/${id}/fork`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})},30000);if(!r.ok)throw Error("Could not branch conversation");const d=await r.json();await selectConversation(d.id);notify("Conversation branched. Original preserved.");}catch(err){notify(err.message)}
}
async function selectConversation(id){
 if(state.sending)return;
 state.conversationId=id;showTab("chat");
 await history();
 await loadConversations();
 input.focus();
}
function attachments(){const box=$("#attachments");box.innerHTML=state.files.map((f,i)=>`<span class="chip">${esc(f.filename)} <button type="button" onclick="removeFile(${i})">×</button></span>`).join("")}
window.removeFile=i=>{state.files.splice(i,1);attachments()};
async function send(e){e.preventDefault();let text=input.value.trim();if(!text&&state.files.length)text="Inspect the attached file, determine the requested work from its contents and project context, then complete as much as possible and clearly report any blocker.";if(!text||state.sending)return;state.sending=true;$("#send").disabled=true;add("user",text);input.value="";const wait=add("assistant",state.files.length?"OMNIA IQ is reading the attached project and working on the request…":"OMNIA IQ is thinking…","thinking");
try{const r=await apiFetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:text,use_web:$("#webSearch").checked,harmony:$("#web").checked,file_ids:state.files.map(f=>f.file_id),conversation_id:state.conversationId})},900000);const d=await r.json();if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:JSON.stringify(d.detail));state.conversationId=d.conversation_id;setMessageText(wait,"assistant",d.reply);if(d.web_used)appendSources(wait,d.web_sources);if(d.providers_used?.length>1)notify(`OMNIA IQ harmonized ${d.providers_used.length} specialists`);else if($("#webSearch").checked&&!d.web_used)notify(d.web_error?`Web search unavailable: ${d.web_error}`:"Web search returned no results; answered from existing knowledge.");state.files=[];attachments();loadConversations()}catch(err){wait.textContent=err.message;wait.classList.remove("thinking");wait.classList.add("error")}finally{state.sending=false;$("#send").disabled=false;input.focus()}}
async function upload(file,attach=false){if(!file)return;const form=new FormData();form.append("document",file);notify(`Uploading ${file.name}…`);const r=await apiFetch("/api/files/upload",{method:"POST",body:form},600000),d=await r.json();if(!r.ok){notify(d.detail||"Upload failed");return}if(attach){state.files.push(d);attachments()}notify(`${file.name} attached and ready for processing`);loadFiles()}
const fileSize=n=>!n?"":n>=1073741824?`${(n/1073741824).toFixed(1)} GB`:n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.max(1,Math.ceil(n/1024))} KB`;
// Files library (v88.3): Trash hides a file from every picker; Delete forever (from Trash only) removes it from disk.
async function loadStorage(){
  const box=$("#fileStorage");if(!box)return;
  try{
    const r=await apiFetch("/api/files/storage",{},30000);if(!r.ok){box.textContent="";return}
    const s=await r.json(),lib=s.library,unlisted=s.orphans.uploads;
    const parts=[`${lib.files} file${lib.files===1?"":"s"} in the library`,`Trash: ${lib.trashed}${lib.trashed?` (${fileSize(lib.trashed_bytes)})`:""}`,
      `Uploads ${fileSize(s.areas.uploads.bytes)||"0 KB"}`,`Renders ${fileSize(s.areas.artifacts.bytes+s.areas.projects.bytes)||"0 KB"}`];
    let html=parts.map(p=>`<span>${esc(p)}</span>`).join("");
    if(lib.missing)html+=`<span class="warn" title="${esc(lib.missing_files.join(", "))}">${lib.missing} missing from disk</span>`;
    if(unlisted.count)html+=`<span class="warn" title="${esc(unlisted.names.join(", "))}">${unlisted.count} file${unlisted.count===1?"":"s"} in the uploads folder not in the library</span><button type="button" id="recoverFiles">Add to library</button>`;
    box.innerHTML=html;
    const recover=$("#recoverFiles");
    if(recover)recover.onclick=async()=>{const x=await apiFetch("/api/files/storage/recover",{method:"POST"},60000),d=await x.json();if(!x.ok){notify(d.detail||"Recovery failed");return}notify(`${d.recovered.length} file(s) added to the “${d.folder}” folder.`);loadFiles()};
  }catch(err){box.textContent=""}
}
async function downloadLibraryFile(f){
  const r=await apiFetch(`/api/files/library/${f.id}/download`,{},600000);
  if(!r.ok){const d=await r.json().catch(()=>({}));notify(d.detail||"Download failed");return}
  const url=URL.createObjectURL(await r.blob()),a=document.createElement("a");
  a.href=url;a.download=f.filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function deleteLibraryFile(f){
  if(!confirm(`Delete “${f.filename}” forever? This removes the file from disk and cannot be undone.`))return;
  const r=await apiFetch(`/api/files/library/${f.id}?confirm=true`,{method:"DELETE"},60000),d=await r.json();
  if(!r.ok){notify(d.detail||"Delete failed");return}
  notify(d.note||`${f.filename} was deleted forever.`);loadFiles();
}
async function emptyTrash(){
  if(!confirm("Delete every file in Trash forever? Files still used by a video project are kept. This cannot be undone."))return;
  const r=await apiFetch("/api/files/library/trash/empty",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirm:true})},120000),d=await r.json();
  if(!r.ok){notify(d.detail||"Could not empty the Trash");return}
  notify(`Deleted ${d.deleted.length} file(s) forever.`+(d.skipped.length?` Kept ${d.skipped.length} that video projects still use.`:""));loadFiles();
}
async function loadFiles(){
  const isTrash=!!$("#fileTrash")?.checked;
  const q=new URLSearchParams({q:$("#fileSearch")?.value||"",favorite:String(!!$("#fileFavorites")?.checked),trash:String(isTrash)});
  const folder=$("#fileFolder")?.value?.trim();if(folder)q.set("folder",folder);
  const r=await apiFetch(`/api/files/library?${q}`,{},30000);const d=await r.json();if(!r.ok){notify(d.detail||"Library unavailable");return}
  const empty=$("#emptyTrash");if(empty)empty.hidden=!isTrash||!d.files.length;
  const button=(action,f,label,extra="")=>`<button type="button" data-file-action="${action}" data-id="${f.id}" ${extra}>${label}</button>`;
  $("#fileList").innerHTML=d.files.map(f=>{
    const meta=[f.folder||"Unfiled",(f.tags||[]).join(", "),fileSize(f.size_bytes),f.created_at||""].filter(Boolean).map(esc).join(" · ");
    const badges=(f.missing?'<span class="file-badge bad" title="The file is no longer on disk. Upload it again.">Missing</span>':"")
      +(f.in_use?'<span class="file-badge info" title="Linked to a video project">In a project</span>':"");
    const missing=f.missing?"disabled":"";
    const actions=isTrash
      ?button("download",f,"Download",missing)+button("restore",f,"Restore")
        +button("delete",f,"Delete forever",f.in_use?'class="danger" disabled title="Used by a video project. Delete the project first."':'class="danger"')
      :button("attach",f,"Attach",missing)+button("download",f,"Download",missing)
        +button("favorite",f,f.favorite?"★":"☆",`aria-label="${f.favorite?"Remove from favorites":"Add to favorites"}"`)
        +button("organize",f,"Organize")+button("trash",f,"Trash");
    return `<div class="item${f.missing?" is-missing":""}"><div class="file-glyph"><svg class="i"><use href="#i-folder"/></svg></div><div class="grow"><strong>${esc(f.filename)}${badges}</strong><small>${meta}</small></div><div class="file-actions">${actions}</div></div>`;
  }).join("")||`<div class="empty-state">${isTrash?"Trash is empty.":"No matching files."}</div>`;
  $("#fileList").querySelectorAll("[data-file-action]").forEach(b=>b.onclick=async()=>{
    const f=d.files.find(x=>x.id===Number(b.dataset.id));if(!f)return;
    const action=b.dataset.fileAction;
    if(action==="attach"){state.files.push({file_id:f.local_file_id,filename:f.filename});attachments();showTab("chat");return}
    if(action==="download"){downloadLibraryFile(f);return}
    if(action==="delete"){deleteLibraryFile(f);return}
    let patch={};
    if(action==="favorite")patch.favorite=!f.favorite;
    if(action==="trash")patch.trashed=true;
    if(action==="restore")patch.trashed=false;
    if(action==="organize"){
      const folder=prompt("Folder name (leave blank for Unfiled):",f.folder||"");if(folder===null)return;
      const tags=prompt("Comma-separated tags:",(f.tags||[]).join(", "));if(tags===null)return;
      patch={folder,tags:tags.split(",").map(s=>s.trim()).filter(Boolean)};
    }
    const response=await apiFetch(`/api/files/library/${f.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)},30000);
    if(!response.ok){const err=await response.json();notify(err.detail||"Update failed");return}
    if(action==="trash")notify(`${f.filename} moved to Trash. It stays hidden from pickers until you restore it.`);
    loadFiles();
  });
  loadStorage();
}
function initVideoPresets(){
 document.querySelectorAll("[data-preset]").forEach(b=>b.addEventListener("click",()=>{
  const [platform,type,length]=b.dataset.preset.split("|");
  if($("#assistPlatform"))$("#assistPlatform").value=platform;if($("#videoType"))$("#videoType").value=type;if($("#videoLength"))$("#videoLength").value=length;
  document.querySelectorAll("[data-preset]").forEach(x=>x.classList.toggle("on",x===b));
  if(!$("#taskInput").value.trim())$("#taskInput").focus();else if(!$("#taskInstructions").value.trim())notify("Preset set — click “Expand with OMNIA” to write the brief, or describe it yourself.");
 }));
 const build=$("#buildImmediately"),label=$("#createVideoLabel");
 try{if(localStorage.getItem("omnia_build_immediately")==="0")build.checked=false}catch{}
 const sync=()=>{if(label)label.textContent=build?.checked?"Create & build video":"Create video project";try{localStorage.setItem("omnia_build_immediately",build.checked?"1":"0")}catch{}};
 build?.addEventListener("change",sync);sync();
}
function initVideoSpecialistStudio(){
 initVideoPresets();
 const openProjects=()=>{showTab("tasks");window.omniaVideoStudio?.refreshVisibility();$("#taskInput")?.focus()};
 $("#startVideoProject")?.addEventListener("click",openProjects);
 $("#openVideoProjects")?.addEventListener("click",()=>showTab("tasks"));
}
function renderTimeline(events=[],workflow={}){
 const latest=events.length?events[events.length-1]:null;
 const byStage=new Map();events.forEach(e=>byStage.set(e.stage,e));
 const compact=[...byStage.values()];
 const pctMatch=latest?.detail?.match(/(?:·\s*)?(\d{1,3})%/);
 const beatMatch=latest?.detail?.match(/(?:beat|scene)\s+(\d+)\/(\d+)/i);
 let percent=0;
 if(pctMatch)percent=Number(pctMatch[1]);
 else if(beatMatch)percent=15+Math.round((Number(beatMatch[1])/Math.max(1,Number(beatMatch[2])))*70);
 else if(latest?.stage==="production"&&latest?.status==="running")percent=90;
 else if(latest?.status==="completed")percent=100;
 percent=Math.max(0,Math.min(100,percent));
 const workflowLabel=workflow.run_id?`<small class="live-progress-text">${esc(workflow.phase)} · ${esc(workflow.status)} · Run ${esc(workflow.run_id.slice(0,8))}</small>`:"";
 return `${workflowLabel}<div class="timeline">${compact.map(e=>`<span class="stage ${esc(e.status)}" title="${esc(e.detail)}">${esc(e.stage)}</span>`).join("")}</div>${latest&&latest.status==="running"?`<div class="live-progress"><div class="live-progress-bar" style="width:${percent||8}%"></div></div><small class="live-progress-text">${esc(latest.detail||"Working…")}</small>`:""}`
}
function updateDashboard(tasks,artifactCount){
 $("#metricProjects").textContent=tasks.length;
 $("#metricRunning").textContent=tasks.filter(t=>t.status==="running").length;
 $("#metricCompleted").textContent=tasks.filter(t=>t.status==="completed").length;
 $("#metricArtifacts").textContent=artifactCount;
 $("#dashboardProjects").innerHTML=tasks.slice(0,5).map(t=>`<div class="item"><div class="grow"><strong>${esc(t.title)}</strong><small>${esc(t.status)}</small>${renderTimeline(t.events||[],t.workflow||{})}</div></div>`).join("")||'<div class="empty-state">No production activity yet.</div>';
}
// v86: Projects list renders incrementally. Polling used to rebuild every card every 1.5 s (restarting
// any video being watched and wiping typed revisions) and fetched each project's artifacts one by one.
const taskCardCache=new Map();
function artifactMarkup(a){
 const isVideo=a.mime_type&&a.mime_type.startsWith("video/"),isImage=a.mime_type&&a.mime_type.startsWith("image/");
 return `${isVideo?`<div class="artifact-preview"><video controls preload="metadata" src="/api/projects/artifacts/${a.id}/preview"></video></div>`:""}<div class="artifact-actions"><a class="artifact-link ${a.mime_type==="application/zip"?"package":""}" href="/api/projects/artifacts/${a.id}/download">${a.mime_type==="application/zip"?"Download project package":"Download"} ${esc(a.filename)}</a>${isVideo||isImage?`<button type="button" class="artifact-publish" data-publish-artifact="${a.id}"><svg class="i"><use href="#i-send"/></svg> Publish</button>`:""}</div>`;
}
function taskCardHtml(t){
 const status=t.status||"queued";
 return `<div class="grow"><div class="task-title"><strong>${esc(t.title)}</strong><span class="status ${esc(status)}">${esc(status.replace(/_/g," "))}</span></div>
  ${t.instructions?`<details class="task-brief"><summary>Brief</summary><small>${esc(t.instructions)}</small></details>`:""}${t.media?.length?`<div class="task-media-summary"><span>Client media: ${t.media.length}</span>${t.media.slice(0,4).map(m=>`<span>${esc(m.filename)}</span>`).join("")}</div>`:""}${renderTimeline(t.events||[],t.workflow||{})}
  ${status==="failed"&&t.result?`<p class="task-error">${esc(String(t.result).slice(0,400))}</p>`:""}
  ${t.result&&status!=="failed"?`<details><summary>View production report</summary><pre>${esc(t.result)}</pre></details>`:""}<div class="artifacts">${(t.artifacts||[]).map(artifactMarkup).join("")}</div>
  ${status==="awaiting_review"&&t.review?renderReviewBox(t):""}
  ${status==="completed"?`<div class="revision-box"><label>Want a change? Describe it and OMNIA will revise this video — no need to start over. Media waiting in the Media Studio above (logos, cards, photos, clips) is added to this video too.</label><div class="revision-row"><input type="text" data-revision-input="${t.id}" placeholder="e.g. make the narrator male, change the music, turn off subtitles, mention the 2023 rematch" maxlength="2000"><button data-revision-submit="${t.id}">Apply revision</button></div></div>`:""}</div>
  ${status==="awaiting_review"&&t.review?"":`<button class="run-task" data-run="${t.id}" ${status==="running"?"disabled":""}>${status==="running"?"Working…":status==="completed"?"Rebuild":status==="failed"?"Try again":"Build video"}</button>`}
  ${status==="running"?`<button class="cancel-task" data-cancel="${t.id}" title="Stops at the next safe point. Nothing is published.">Cancel</button>`:""}
  <button class="delete" data-delete="${t.id}" title="Delete project">×</button>`;
}
async function loadTasks(){
 const r=await apiFetch("/api/projects?compact=1",{},30000),d=await r.json();
 const list=$("#taskList");const tasks=d.tasks||[];let artifactCount=0;
 list.querySelector(".empty-state")?.remove();
 const keep=new Set();
 tasks.forEach((t,index)=>{
  artifactCount+=(t.artifacts||[]).length;
  const key=String(t.id);keep.add(key);
  const sig=JSON.stringify([t.status,t.updated_at,t.result?.length||0,(t.events||[]).map(e=>e.id+e.status),(t.artifacts||[]).map(a=>a.id),t.workflow?.phase,t.workflow?.status,!!t.review,(t.media||[]).length]);
  let card=list.querySelector(`:scope > [data-task-id="${key}"]`);
  if(!card||taskCardCache.get(key)!==sig){
   const drafts={};card?.querySelectorAll("[data-review-text],[data-revision-input]").forEach(el=>{drafts[el.dataset.reviewText||("rev"+el.dataset.revisionInput)]=el.value});
   const fresh=document.createElement("div");fresh.className="item task-card";fresh.dataset.taskId=key;fresh.innerHTML=taskCardHtml(t);
   fresh.querySelectorAll("[data-review-text],[data-revision-input]").forEach(el=>{const k=el.dataset.reviewText||("rev"+el.dataset.revisionInput);if(drafts[k]!==undefined)el.value=drafts[k]});
   fresh.querySelectorAll("[data-review-text]").forEach(syncReviewButtons);
   if(card)card.replaceWith(fresh);else list.append(fresh);
   card=fresh;taskCardCache.set(key,sig);
  }
  if(list.children[index]!==card)list.insertBefore(card,list.children[index]||null);
 });
 [...list.querySelectorAll(":scope > [data-task-id]")].forEach(c=>{if(!keep.has(c.dataset.taskId)){c.remove();taskCardCache.delete(c.dataset.taskId)}});
 if(!tasks.length)list.innerHTML='<div class="empty-state">No video projects yet. Describe one above and click “Create & build video”.</div>';
 updateDashboard(tasks,artifactCount);
 if(tasks.some(t=>t.status==="running")) startProjectPolling(); else stopProjectPollingIfIdle();
}
async function runProject(id,b){
 if(b){b.disabled=true;b.textContent="Building…"}
 notify("OMNIA IQ is planning, producing, packaging, and verifying the video.");startProjectPolling();
 try{const r=await apiFetch(`/api/projects/${id}/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({harmony:$("#web")?.checked||false,file_ids:state.files.map(f=>f.file_id),autonomous_production:true,review_script:!!$("#reviewBeforeRender")?.checked})},LONG_RENDER_TIMEOUT_MS);const d=await r.json();if(!r.ok)throw new Error(d.detail||"Project failed");if(d.awaiting_review)notify("The script is ready for your review. Nothing renders until you decide.");else if(d.cancelled)notify("Cancelled. Nothing was published.");else notify(`Video finished — ${(d.artifacts||[]).length} file(s) ready. Use Publish to post it.`);}
 catch(e){notify(/took too long/i.test(e.message)?"This video is still building in the background. Progress stays visible on the project card - you can keep working.":e.message)}
 finally{await loadTasks();stopProjectPollingIfIdle()}
}
(function bindTaskList(){
 const list=document.getElementById("taskList");if(!list)return;
 list.addEventListener("input",e=>{if(e.target.matches("[data-review-text]"))syncReviewButtons(e.target)});
 list.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.matches("[data-revision-input]")){e.preventDefault();list.querySelector(`[data-revision-submit="${e.target.dataset.revisionInput}"]`)?.click()}});
 list.addEventListener("click",async e=>{
  const b=e.target.closest("button");if(!b||!list.contains(b))return;
  if(b.dataset.review!==undefined)return decideReview(b);
  if(b.dataset.run)return runProject(b.dataset.run,b);
  if(b.dataset.publishArtifact){showTab("publishing");window.omniaPublishing?.selectArtifact(Number(b.dataset.publishArtifact));return}
  if(b.dataset.cancel){b.disabled=true;b.textContent="Cancelling…";try{const r=await apiFetch(`/api/projects/${b.dataset.cancel}/cancel`,{method:"POST"},30000);const d=await r.json();if(!r.ok)throw new Error(d.detail||"Could not cancel");notify("Cancelling - it stops at the next safe point, and nothing is published.")}catch(err){notify(err.message)}finally{await loadTasks()}return}
  if(b.dataset.delete){const card=b.closest("[data-task-id]");const title=card?.querySelector(".task-title strong")?.textContent||"this project";if(!confirm(`Delete “${title}” and its files?`))return;await apiFetch(`/api/projects/${b.dataset.delete}`,{method:"DELETE"});loadTasks();return}
  if(b.dataset.revisionSubmit){
   const taskId=b.dataset.revisionSubmit;const input=list.querySelector(`[data-revision-input="${taskId}"]`);const text=(input?.value||"").trim();
   if(!text){notify("Describe what you'd like to change first.");return}
   const revisionMedia=window.omniaVideoStudio?.getMediaItems()||[];b.disabled=true;const originalLabel=b.textContent;b.textContent="Revising…";notify("Applying your revision — OMNIA reuses what it can instead of starting over.");startProjectPolling();
   try{const r=await apiFetch(`/api/projects/${taskId}/revise`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({request:text,harmony:$("#web")?.checked||false,file_ids:state.files.map(f=>f.file_id),media_items:revisionMedia})},LONG_RENDER_TIMEOUT_MS);const d=await r.json();if(!r.ok)throw new Error(d.detail||"Revision failed");if(revisionMedia.length)window.omniaVideoStudio?.clear();const reused=d.revision&&d.revision.reused_script;notify((reused?"Revision applied (narration reused, only voice/music/visuals changed).":"Revision applied with updated narration.")+(revisionMedia.length?` ${revisionMedia.length} Media Studio asset(s) added to this video.`:""));}
   catch(err){notify(err.message);b.disabled=false;b.textContent=originalLabel}
   finally{await loadTasks();stopProjectPollingIfIdle()}
  }
 });
})();

let projectPollTimer=null;
let projectPollBusy=false;
function startProjectPolling(){
 if(projectPollTimer)return;
 projectPollTimer=setInterval(async()=>{if(projectPollBusy||document.hidden)return;projectPollBusy=true;try{await loadTasks()}catch(e){console.error("Live project refresh",e)}finally{projectPollBusy=false}},3000);
}
function stopProjectPollingIfIdle(){
 const running=document.querySelectorAll('.status.running').length>0;
 if(!running&&projectPollTimer){clearInterval(projectPollTimer);projectPollTimer=null}
}

async function loadMemory(){
 const q=($("#memorySearch")?.value||"").trim();
 const url=q?`/api/memory/search?query=${encodeURIComponent(q)}`:"/api/memory";
 const r=await apiFetch(url,{},30000),d=await r.json();
 if(!q && d.stats)$("#memoryStats").textContent=`${d.stats.c} memories · ${d.stats.chars.toLocaleString()} stored characters`;
 $("#memoryList").innerHTML=(d.memories||[]).map(m=>`<div class="item"><div class="grow"><strong>${esc(m.kind)}</strong><small>${esc(m.content)}</small><small>${esc(m.source||"")} · importance ${m.importance}</small></div><button data-edit-memory="${m.id}" title="Edit memory">Edit</button><button class="delete" data-forget="${m.id}" title="Delete memory">×</button></div>`).join("")||'<div class="empty-state">No matching memories.</div>';
 document.querySelectorAll("[data-forget]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this memory?"))return;await apiFetch(`/api/memory/${b.dataset.forget}`,{method:"DELETE"});loadMemory()});
 document.querySelectorAll("[data-edit-memory]").forEach(b=>b.onclick=async()=>{
  const item=(d.memories||[]).find(m=>String(m.id)===b.dataset.editMemory);if(!item)return;
  const updated=prompt("Edit memory",item.content);if(updated===null||!updated.trim()||updated===item.content)return;
  const response=await apiFetch(`/api/memory/${item.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:updated.trim()})});
  if(!response.ok){const err=await response.json().catch(()=>({}));notify(err.detail||"Unable to update memory");return;}loadMemory();
 });
}
$("#memorySearch")?.addEventListener("input",()=>loadMemory().catch(e=>notify(e.message)));

function showTab(name){document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));document.querySelectorAll("nav [data-tab]").forEach(b=>b.classList.remove("active"));$(`#${name}`).classList.add("active");document.querySelector(`[data-tab="${name}"]`).classList.add("active");$("#pageTitle").textContent=({admin:"Admin Dashboard",settings:"Settings",chat:"OMNIA IQ Chat",tasks:"Video Projects",studios:"Video Studio",publishing:"Publishing Center",launch:"Launch Center",agentstudio:"Agent Studio"})[name]||name[0].toUpperCase()+name.slice(1);document.body.dataset.tab=name;window.dispatchEvent(new CustomEvent("omnia:tab",{detail:name}))}
async function newChat(){if(state.newChatBusy)return;state.newChatBusy=true;const button=$("#newChat");button.disabled=true;try{state.conversationId=null;state.files=[];attachments();input.value="";messages.innerHTML=welcomeHTML();showTab("chat");await loadConversations();input.focus();notify("New conversation ready \u2014 your other conversations are still saved on the left.")}catch(err){notify(err.message)}finally{state.newChatBusy=false;button.disabled=false}}
function renderStatus(d){const ready=d.providers.filter(p=>p.ready);$("#status").textContent=d.ready?(d.multi_api?`${ready.length} models ready · OMNIA orchestrator`:`${ready[0].model} connected`):"LLM provider required";$("#providerList").innerHTML=d.providers.map(p=>`<div class="provider ${p.ready?"ready":""}"><span></span><div><strong>${esc(p.name)}</strong><small>${esc(p.ready?`${p.model} · ${p.role||"specialist"}`:"Not configured")}</small></div></div>`).join("");if(!d.ready&&document.body.dataset.role==="admin")notify("No AI provider is connected yet: open Admin → Settings → AI providers.")}
document.querySelectorAll("nav [data-tab]").forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$("#web").onchange=e=>{const on=e.target.checked;$("#modeLabel").textContent=on?"Analytical council":"Fast";notify(on?"Analytical council enabled. Multiple specialist models may be consulted.":"Fast specialist enabled for quicker responses.")};
$("#webSearch").onchange=e=>{const on=e.target.checked;$("#webSearchLabel").textContent=on?"Web search on":"No web search";notify(on?"Web search enabled. OMNIA IQ will look up current information and cite sources.":"Web search disabled. Answers come from the model's own knowledge.")};
$("#chatForm").onsubmit=send;$("#newChat").onclick=newChat;
["fileSearch","fileFolder","fileFavorites","fileTrash"].forEach(id=>{const el=$("#"+id);if(el)el.addEventListener(id==="fileSearch"||id==="fileFolder"?"change":"change",loadFiles)});
if($("#refreshFiles"))$("#refreshFiles").onclick=loadFiles;if($("#emptyTrash"))$("#emptyTrash").onclick=emptyTrash;
$("#chatFile").onchange=e=>{upload(e.target.files[0],true);e.target.value=""};$("#fileUpload").onchange=e=>{upload(e.target.files[0],false);e.target.value=""};
$("#assistPromptButton").onclick=async()=>{
 const title=$("#taskInput").value.trim();const seed=$("#taskInstructions").value.trim();
 const idea=seed||title;
 if(!idea){notify("Type a few words describing the video first (even just the topic).");$("#taskInput").focus();return}
 const btn=$("#assistPromptButton");btn.disabled=true;const original=btn.textContent;
 const sourcesBox=$("#assistPromptSources");sourcesBox.classList.add("hidden");sourcesBox.innerHTML="";
 const trendBox=$("#assistTrendBox");trendBox.classList.add("hidden");trendBox.innerHTML="";
 let stage=0;
 const stages=["Researching trending angles…","Rating candidate angles…","Writing your brief…"];
 btn.textContent=stages[0];
 const stageTimer=setInterval(()=>{stage=Math.min(stage+1,stages.length-1);btn.textContent=stages[stage]},12000);
 try{
  const r=await apiFetch("/api/projects/assist-prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,seed,platform:$("#assistPlatform").value,video_type:$("#videoType")?.value||"general",length_minutes:parseFloat($("#videoLength")?.value)||null})},480000);
  const d=await r.json();if(!r.ok)throw new Error(d.detail||"Could not expand that idea");
  $("#taskInstructions").value=ensureLanguageInstruction(d.brief,$("#narrationLanguage")?.value||"");
  if(d.trending_topics?.length){
   const winner=d.chosen_theme;
   trendBox.innerHTML=`<div class="assist-trend-head">Trending angles researched for ${esc(d.platform||"this platform")}</div>`+
    d.trending_topics.map(t=>`<div class="assist-trend-row ${winner&&t.topic===winner.topic?"chosen":""}"><span class="assist-trend-rating">${esc(String(t.rating))}/10</span><span class="assist-trend-topic">${esc(t.topic)}</span>${winner&&t.topic===winner.topic?'<span class="assist-trend-badge">Used for this brief</span>':""}</div>`).join("");
   trendBox.classList.remove("hidden");
  }
  if(d.researched&&d.sources?.length){
   sourcesBox.innerHTML=`<span class="message-sources-label">Grounded in</span>`+d.sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.snippet||"")}">${esc(s.title||s.url)}</a>`).join("");
   sourcesBox.classList.remove("hidden");
  }
  if(d.trending_topics?.length){
   notify(`OMNIA researched current ${esc(d.platform||"platform")} trends and built your brief around the highest-rated angle — feel free to edit it before creating the project.`);
  }else if(d.researched){
   notify("OMNIA researched the topic and expanded your idea into a full brief — feel free to edit it before creating the project.");
  }else{
   notify("OMNIA expanded your idea into a full brief — feel free to edit it before creating the project.");
  }
 }catch(e){notify(e.message)}
 finally{clearInterval(stageTimer);btn.disabled=false;btn.textContent=original}
};
const VIDEO_TYPE_LABELS={documentary:"documentary",explainer:"explainer",tutorial:"tutorial",product_demo:"product demo",promo_ad:"promo",storytelling:"story",news_recap:"news recap",listicle:"list",threed_model:"3D model product visualization"};
function ensureFormatInstructions(instructions,type,minutes){
 let out=instructions||"";
 const add=sentence=>{out=out?`${out}\n\n${sentence}`:sentence};
 const label=VIDEO_TYPE_LABELS[type];
 if(label&&!out.toLowerCase().includes(label.toLowerCase()))add(`Video type: ${label}.`);
 const m=parseFloat(minutes);
 // Only an explicitly LABELLED runtime counts as already stated ("runtime: 2 minutes"). Unlabelled durations
 // such as a chapter plan ("chapter one, about 90 seconds") must not suppress the target: the duration
 // parser prefers the labelled form, so this sentence is what keeps a 10-minute request at 10 minutes.
 if(m&&!/\b(?:length|duration|runtime)\s*(?:of|:|=|is|around|about)?\s*\d/i.test(out)){
  add(m<1?`Target length: ${Math.round(m*60)} seconds.`:`Target length: ${m===1?"1 minute":m+" minutes"}.`);
 }
 return out;
}
function renderVoicePrep(r){
 // Voice-over guide ch.02-03: the reviewer approves the delivery brief and the spoken readings with the text.
 const b=r.delivery_brief,a=r.spoken_text_audit;if(!b&&!a)return"";
 const brief=b?`<div class="voice-brief"><span class="vb-chip"><svg class="i"><use href="#i-globe"/></svg>${esc(b.locale)}</span><span class="vb-chip"><svg class="i"><use href="#i-user"/></svg>${esc(b.audience)}</span><span class="vb-chip"><svg class="i"><use href="#i-mic"/></svg>${esc(b.speaker_role)}</span><span class="vb-chip">${esc(b.intent)} · ${esc(b.formality)}</span></div>${(b.assumptions||[]).length?`<small class="vb-assume">Assumed because the brief didn't say: ${b.assumptions.map(esc).join("; ")}. Add it to the brief to change it.</small>`:""}`:"";
 const items=(a&&a.items)||[];
 const audit=a?`<details class="voice-audit" ${items.some(i=>i.severity==="fix")?"open":""}><summary><svg class="i"><use href="#i-${items.length?"alert":"check"}"/></svg>Spoken readings · ${esc(a.summary)}</summary>${items.length?`<ul>${items.map(i=>`<li class="${i.severity}"><code>${esc(i.text)}</code> ${esc(i.question)}</li>`).join("")}</ul><small>Rephrase in the script so each item is read the way you intend, then approve.</small>`:""}</details>`:"";
 return brief+audit;
}
function renderReviewBox(t){
 const r=t.review||{};
 const notes=(r.notes||[]).length?`<ul class="review-notes">${r.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:"";
 return `<div class="review-box" data-review-box="${t.id}"><strong>Review the script before it is rendered</strong><small>${esc(r.language||"English")} - about ${esc(String(r.word_count||0))} words${r.expected_words?` (roughly ${esc(String(r.expected_words))} fit this length)`:""}. Edit it freely, or approve it as written.</small>${notes}${renderVoicePrep(r)}<textarea data-review-text="${t.id}" data-original-sha="${esc(r.script_sha256||"")}" data-original="${esc(r.script||"")}" aria-label="Narration script">${esc(r.script||"")}</textarea><div class="review-actions"><button type="button" data-review="approve" data-id="${t.id}">Approve and render</button><button type="button" data-review="edit" data-id="${t.id}" disabled>Save my edits and render</button><button type="button" class="delete" data-review="reject" data-id="${t.id}">Reject</button></div></div>`;
}
function syncReviewButtons(textarea){
 const box=textarea.closest("[data-review-box]");if(!box)return;
 const changed=textarea.value.trim()!==(textarea.dataset.original||"").trim();
 // Approval refers to the exact text that was shown, so it is only offered while the text is unchanged.
 box.querySelector('[data-review="approve"]').disabled=changed;
 box.querySelector('[data-review="edit"]').disabled=!changed;
}
async function decideReview(button){
 const id=button.dataset.id,box=button.closest("[data-review-box]"),ta=box.querySelector("[data-review-text]");
 const decision=button.dataset.review;
 const body={decision,script_sha256:ta.dataset.originalSha||""};
 if(decision==="edit")body.edited_script=ta.value;
 box.querySelectorAll("button").forEach(b=>b.disabled=true);
 if(decision!=="reject"){notify("Rendering the approved script. This can take a while; progress stays visible.");startProjectPolling()}
 try{
  const r=await apiFetch(`/api/projects/${id}/review`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)},LONG_RENDER_TIMEOUT_MS);
  const d=await r.json();if(!r.ok)throw new Error(d.detail||"Could not record that decision");
  notify(decision==="reject"?"Script rejected. Nothing was rendered.":d.cancelled?"Cancelled. Nothing was published.":`Project completed with ${(d.artifacts||[]).length} artifacts`);
 }catch(e){notify(/took too long/i.test(e.message)?"This video is still building in the background. Progress stays visible on the project card.":e.message)}
 finally{await loadTasks();stopProjectPollingIfIdle()}
}
function ensureLanguageInstruction(instructions,language){
 if(!language)return instructions;
 if(instructions.toLowerCase().includes(language.toLowerCase()))return instructions;
 const sentence=`Narrate this video in ${language}.`;
 return instructions?`${instructions}\n\n${sentence}`:sentence;
}
async function getCinematicDirection(){
 const style=$("#directorStyle")?.value||"";
 if(!style)return "";
 const platform=$("#assistPlatform")?.value;
 const valid=["instagram_reels","tiktok","youtube_shorts","facebook","youtube","website"];
 const response=await apiFetch("/api/projects/director-plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({style,platform:valid.includes(platform)?platform:"instagram_reels",brand:$("#directorBrand")?.value||"",call_to_action:$("#directorCTA")?.value||"",captions:$("#directorCaptions")?.checked!==false})});
 const data=await response.json();
 if(!response.ok)throw new Error(data.detail||"Could not prepare cinematic direction");
 return data.production_brief;
}
$("#directorPreview")?.addEventListener("click",async()=>{
 const display=$("#directorPreviewResult");if(!display)return;
 try{const direction=await getCinematicDirection();display.textContent=direction||"Select an editing style to preview its direction.";display.hidden=false;}
 catch(error){notify(error.message)}
});
$("#taskForm").onsubmit=async e=>{e.preventDefault();const v=$("#taskInput").value.trim();const language=$("#narrationLanguage")?.value||"";let instructions=ensureFormatInstructions(ensureLanguageInstruction($("#taskInstructions").value.trim(),language),$("#videoType")?.value||"general",$("#videoLength")?.value||"");if(!v)return;try{const directorBrief=await getCinematicDirection();if(directorBrief)instructions += "\n\n"+directorBrief;}catch(error){notify(error.message);return;}const mediaFileIds=window.omniaVideoStudio?.getFileIds()||[];const mediaItems=window.omniaVideoStudio?.getMediaItems()||[];const r=await apiFetch("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:v,instructions,project_type:"video",media_file_ids:mediaFileIds,media_items:mediaItems})});const d=await r.json();if(!r.ok){notify(d.detail||"Could not create video project");return;}$("#taskInput").value="";$("#taskInstructions").value="";if($("#narrationLanguage"))$("#narrationLanguage").value="";if($("#videoType"))$("#videoType").value="general";if($("#videoLength"))$("#videoLength").value="";window.omniaVideoStudio?.clear();await loadTasks();if($("#buildImmediately")?.checked!==false&&d.id){runProject(d.id,document.querySelector(`[data-run="${d.id}"]`))}else notify("Video project created — click Build video when ready.")};
$("#memoryForm").onsubmit=async e=>{e.preventDefault();const content=$("#memoryInput").value.trim();if(!content)return;await apiFetch("/api/memory",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content,kind:$("#memoryKind")?.value||"knowledge",importance:3})}).then(async r=>{if(!r.ok){const d=await r.json().catch(()=>({}));notify(d.detail||"Could not save that memory");return false}return true}).then(ok=>{if(ok)$("#memoryInput").value="";loadMemory()})};
input.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("#chatForm").requestSubmit()}};
async function safeLoad(label,fn){if(["Pexels configuration","Freesound configuration","Web search configuration","Backups","LLM configuration"].includes(label)&&document.body.dataset.role!=="admin")return;try{await fn()}catch(e){console.error(label,e);notify(`${label} could not load: ${e.message}`)}}
(async()=>{
 /* sign-in is handled by auth.js before this script loads */
 await safeLoad("Conversations",async()=>{
  const r=await apiFetch("/api/chat/conversations",{cache:"no-store"},30000);const d=await r.json();
  const items=d.conversations||[];
  if(items.length){state.conversationId=items[0].id}
  await history();
  await loadConversations();
 });
 await Promise.all([safeLoad("Files",loadFiles),safeLoad("Projects",loadTasks),safeLoad("Memory",loadMemory)]);
 await safeLoad("Connection status",async()=>{const r=await apiFetch("/api/system/status",{},30000);const d=await r.json();if(!r.ok)throw new Error(d.detail||"Status unavailable");renderStatus(d)});
})().catch(e=>notify(e.message));

document.querySelectorAll("[data-open-projects]").forEach(b=>b.onclick=()=>showTab("tasks"));

function runtimeCard(name,item){
 const ready=!!item?.ready;
 const detail=item?.version||item?.path||item?.diagnostic||item?.engine||"Not detected";
 return `<div class="runtime-card ${ready?"ready":""}"><strong><span class="runtime-dot"></span>${esc(name)}</strong><small>${esc(detail)}</small>${item?.path&&item?.version?`<small>${esc(item.path)}</small>`:""}</div>`;
}
async function loadMediaRuntime(){
 const r=await apiFetch("/api/system/media",{},30000),d=await r.json();
 if(!r.ok)throw new Error(d.detail||"Media runtime status unavailable");
 const imagesReady=!!d.image_sources?.ready;
 $("#mediaSummary").textContent=d.ready&&d.speech?.ready&&imagesReady?"Ready to render MP4 videos with speech and sourced scene imagery.":(d.ready&&d.speech?.ready?"Video and speech are ready. Add a Pexels API key for stock imagery.":(d.ready?"Video is ready. Speech engine or image sourcing needs setup.":"Video runtime is incomplete."));
 const imageCards=(d.image_sources?.providers||[]).map(p=>runtimeCard(`${p.name} Images`,{ready:p.ready,path:p.ready?`${p.role} provider configured`:"API key not configured"})).join("");
 $("#mediaRuntime").innerHTML=runtimeCard("FFmpeg",d.ffmpeg)+runtimeCard("FFprobe",d.ffprobe)+runtimeCard("Speech Engine",d.speech)+imageCards;
 if($("#productionFeatures")) $("#productionFeatures").innerHTML=(d.production_features||[]).map(x=>`<span class="feature-chip">${x}</span>`).join("");
 const button=$("#installFfmpeg");
 button.disabled=!d.install_supported||d.ready;
 button.textContent=d.ready?"FFmpeg is ready":(d.install_supported?((d.broken_binaries||[]).length?"Repair FFmpeg":"Install FFmpeg automatically"):"Automatic install unavailable");
 const speechButton=$("#installSpeech");
 speechButton.disabled=false;
 speechButton.textContent=d.speech?.ready?`${d.speech.engine} is ready`:"Install Free Speech";
 $("#testSpeech").disabled=!d.speech?.ready;
 await loadVideoReadiness();
 return d;
}
async function refreshMediaRuntime(){
 const button=$("#refreshMedia");
 if(!button||button.disabled)return;
 const originalText=button.textContent;
 button.disabled=true;
 button.textContent="Refreshing…";
 button.setAttribute("aria-busy","true");
 try{
  const r=await apiFetch(`/api/system/media/refresh?t=${Date.now()}`,{method:"POST",cache:"no-store"},30000);
  const d=await r.json();
  if(!r.ok)throw new Error(d.detail||"Media runtime refresh failed");
  const status=d.status||d;
  const imagesReady=!!status.image_sources?.ready;
  $("#mediaSummary").textContent=status.ready&&status.speech?.ready&&imagesReady?"Ready to render MP4 videos with speech and sourced scene imagery.":(status.ready&&status.speech?.ready?"Video and speech are ready. Add a Pexels API key for stock imagery.":(status.ready?"Video is ready. Speech engine or image sourcing needs setup.":"Video runtime is incomplete."));
  const imageCards=(status.image_sources?.providers||[]).map(p=>runtimeCard(`${p.name} Images`,{ready:p.ready,path:p.ready?`${p.role} provider configured`:"API key not configured"})).join("");
  $("#mediaRuntime").innerHTML=runtimeCard("FFmpeg",status.ffmpeg)+runtimeCard("FFprobe",status.ffprobe)+runtimeCard("Speech Engine",status.speech)+imageCards;
  if($("#productionFeatures")) $("#productionFeatures").innerHTML=(status.production_features||[]).map(x=>`<span class="feature-chip">${x}</span>`).join("");
  const ffmpegButton=$("#installFfmpeg");
  ffmpegButton.disabled=!status.install_supported||status.ready;
  ffmpegButton.textContent=status.ready?"FFmpeg is ready":(status.install_supported?((status.broken_binaries||[]).length?"Repair FFmpeg":"Install FFmpeg automatically"):"Automatic install unavailable");
  const speechButton=$("#installSpeech");
  speechButton.disabled=false;
  speechButton.textContent=status.speech?.ready?`${status.speech.engine} is ready`:"Install Free Speech";
  $("#testSpeech").disabled=!status.speech?.ready;
  await loadVideoReadiness();
  notify("Production runtimes refreshed.");
 }catch(e){
  console.error("Media runtime refresh",e);
  notify(`Refresh failed: ${e.message}`);
 }finally{
  button.disabled=false;
  button.textContent=originalText;
  button.removeAttribute("aria-busy");
 }
}
const refreshMediaButton=$("#refreshMedia");
if(refreshMediaButton)refreshMediaButton.addEventListener("click",refreshMediaRuntime);
$("#installFfmpeg").onclick=async()=>{
 const button=$("#installFfmpeg");button.disabled=true;button.textContent="Installing FFmpeg…";notify("Installing or repairing FFmpeg. This can take several minutes.");
 try{const r=await apiFetch("/api/system/media/install-ffmpeg",{method:"POST"},900000),d=await r.json();if(!r.ok)throw new Error(d.detail||"FFmpeg installation failed");notify("FFmpeg is installed and working.");await loadMediaRuntime()}catch(e){notify(e.message);button.disabled=false;button.textContent="Install FFmpeg automatically"}
};
safeLoad("Media runtime",loadMediaRuntime);
window.omniaVideoStudio?.init();
initVideoSpecialistStudio();

$("#installSpeech").onclick=async()=>{
 const button=$("#installSpeech");button.disabled=true;button.textContent="Installing Free Speech…";notify("Installing free speech engines (Edge neural + Google voices). This can take a minute.");
 try{const r=await apiFetch("/api/system/media/install-speech",{method:"POST"},900000),d=await r.json();if(!r.ok)throw new Error(d.detail||"Speech installation failed");notify(d.message||"Free multilingual speech installed.");await loadMediaRuntime()}catch(e){notify(e.message);button.disabled=false;button.textContent="Retry speech install"}
};
$("#testSpeech").onclick=async()=>{
 const button=$("#testSpeech");button.disabled=true;button.textContent="Generating test…";
 try{const r=await apiFetch("/api/system/media/test-speech",{method:"POST"},300000);if(!r.ok){const d=await r.json();throw new Error(d.detail||"Speech test failed")}const blob=await r.blob();const url=URL.createObjectURL(blob);const audio=new Audio(url);await audio.play();audio.onended=()=>URL.revokeObjectURL(url);notify("Speech test generated successfully.")}catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test speech"}
};

// Handle failures from the backend even when a proxy or uncaught exception
// returns plain text/HTML instead of the normal JSON response.
async function readSettingsJson(response, operation){
 const body=await response.text();
 let data;
 try{data=JSON.parse(body);}catch{
  const description=response.status>=500
   ? `${operation} failed on the OMNIA IQ server (HTTP ${response.status}). Check logs/runtime.log for the underlying error.`
   : `${operation} returned an unexpected response (HTTP ${response.status}).`;
  throw new Error(description);
 }
 if(!data || typeof data!=="object")throw new Error(`${operation} returned an invalid response.`);
 if(!response.ok){
  const detail=data.detail?.message||data.detail||data.message||`${operation} failed (HTTP ${response.status}).`;
  throw new Error(typeof detail==="string"?detail:JSON.stringify(detail));
 }
 return data;
}
async function loadPexelsConfig(){
 const r=await apiFetch("/api/system/media/pexels",{cache:"no-store"},30000);
 const d=await readSettingsJson(r,"Pexels status");
 const label=$("#pexelsConfigStatus");
 if(label)label.textContent=d.configured?`API key configured (${d.masked_key||"saved"}).`:`API key not configured. Saved file: ${d.env_file||"project .env"}`;
 const test=$("#testPexels");if(test)test.disabled=!d.configured;
 return d;
}
async function savePexelsConfig(){
 const input=$("#pexelsApiKey"),button=$("#savePexels");
 const key=(input?.value||"").trim();
 if(!key){notify("Paste your Pexels API key first.");input?.focus();return;}
 button.disabled=true;button.textContent="Connecting…";
 try{
  const r=await apiFetch("/api/system/media/pexels",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:key})},45000);
  const d=await readSettingsJson(r,"Pexels connection");
  if(!d.ok){const detail=d.connection?.message||"Pexels connection failed";throw new Error(detail)}
  input.value="";
  notify(d.connection?.message||"Pexels API connected successfully.");
  await Promise.all([loadPexelsConfig(),loadMediaRuntime()]);
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Save & Connect"}
}
async function testPexelsConfig(){
 const button=$("#testPexels");button.disabled=true;button.textContent="Testing…";
 try{
  const r=await apiFetch("/api/system/media/pexels/test",{method:"POST",cache:"no-store"},45000);
  const d=await readSettingsJson(r,"Pexels test");
  notify(d.message||"Pexels API connected successfully.");
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test Pexels"}
}
const savePexelsButton=$("#savePexels");if(savePexelsButton)savePexelsButton.addEventListener("click",savePexelsConfig);
const testPexelsButton=$("#testPexels");if(testPexelsButton)testPexelsButton.addEventListener("click",testPexelsConfig);
safeLoad("Pexels configuration",loadPexelsConfig);

async function loadFreesoundConfig(){
 const r=await apiFetch("/api/system/media/freesound",{cache:"no-store"},30000),d=await r.json();
 if(!r.ok)throw new Error(d.detail||"Freesound status unavailable");
 const label=$("#freesoundConfigStatus");
 if(label)label.textContent=d.configured?`API key configured (${d.masked_key||"saved"}). CC0 auto-use enabled.`:`API key not configured. Audio will use FFmpeg fallback.`;
 const test=$("#testFreesound");if(test)test.disabled=!d.configured;
 return d;
}
async function saveFreesoundConfig(){
 const input=$("#freesoundApiKey"),button=$("#saveFreesound");
 const key=(input?.value||"").trim();
 if(!key){notify("Paste your Freesound API key first.");input?.focus();return;}
 button.disabled=true;button.textContent="Connecting…";
 try{
  const r=await apiFetch("/api/system/media/freesound",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:key})},45000);
  const d=await r.json();
  if(!r.ok||!d.ok){const detail=d.detail?.message||d.connection?.message||d.detail||"Freesound connection failed";throw new Error(detail)}
  input.value="";notify(d.connection?.message||"Freesound API connected successfully.");
  await Promise.all([loadFreesoundConfig(),loadMediaRuntime()]);
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Save & Connect"}
}
async function testFreesoundConfig(){
 const button=$("#testFreesound");button.disabled=true;button.textContent="Testing…";
 try{
  const r=await apiFetch("/api/system/media/freesound/test",{method:"POST",cache:"no-store"},45000),d=await r.json();
  if(!r.ok)throw new Error(d.detail?.message||d.detail||"Freesound test failed");
  notify(d.message||"Freesound API connected successfully.");
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test Freesound"}
}
const saveFreesoundButton=$("#saveFreesound");if(saveFreesoundButton)saveFreesoundButton.addEventListener("click",saveFreesoundConfig);
const testFreesoundButton=$("#testFreesound");if(testFreesoundButton)testFreesoundButton.addEventListener("click",testFreesoundConfig);
safeLoad("Freesound configuration",loadFreesoundConfig);

function webSearchProvider(d,id){return (d.providers||[]).find(p=>p.id===id)||{}}
async function loadWebSearchConfig(){
 const r=await apiFetch("/api/system/search/web",{cache:"no-store"},30000),d=await r.json();
 if(!r.ok)throw new Error(d.detail||"Web search status unavailable");
 const tavily=webSearchProvider(d,"tavily"),brave=webSearchProvider(d,"brave");
 const tavilyLabel=$("#tavilyConfigStatus");
 if(tavilyLabel)tavilyLabel.textContent=tavily.configured?`API key configured (${tavily.masked_key||"saved"}).`:`API key not configured. Saved file: ${d.env_file||"project .env"}`;
 const braveLabel=$("#braveConfigStatus");
 if(braveLabel)braveLabel.textContent=brave.configured?`API key configured (${brave.masked_key||"saved"}).`:(tavily.configured?"Not needed \u2014 Tavily is active.":"API key not configured.");
 const testTavilyBtn=$("#testTavily");if(testTavilyBtn)testTavilyBtn.disabled=!tavily.configured;
 const testBraveBtn=$("#testBrave");if(testBraveBtn)testBraveBtn.disabled=!brave.configured;
 return d;
}
async function saveTavilyConfig(){
 const input=$("#tavilyApiKey"),button=$("#saveTavily");
 const key=(input?.value||"").trim();
 if(!key){notify("Paste your Tavily API key first.");input?.focus();return;}
 button.disabled=true;button.textContent="Connecting…";
 try{
  const r=await apiFetch("/api/system/search/web/tavily",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:key})},45000);
  const d=await r.json();
  if(!r.ok||!d.ok){const detail=d.detail?.message||d.connection?.message||d.detail||"Tavily connection failed";throw new Error(detail)}
  input.value="";notify(d.connection?.message||"Tavily connected successfully.");
  await loadWebSearchConfig();
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Save & Connect"}
}
async function testTavilyConfig(){
 const button=$("#testTavily");button.disabled=true;button.textContent="Testing…";
 try{
  const r=await apiFetch("/api/system/search/web/tavily/test",{method:"POST",cache:"no-store"},45000),d=await r.json();
  if(!r.ok)throw new Error(d.detail?.message||d.detail||"Tavily test failed");
  notify(d.message||"Tavily connected successfully.");
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test Tavily"}
}
async function saveBraveConfig(){
 const input=$("#braveApiKey"),button=$("#saveBrave");
 const key=(input?.value||"").trim();
 if(!key){notify("Paste your Brave Search API key first.");input?.focus();return;}
 button.disabled=true;button.textContent="Connecting…";
 try{
  const r=await apiFetch("/api/system/search/web/brave",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:key})},45000);
  const d=await r.json();
  if(!r.ok||!d.ok){const detail=d.detail?.message||d.connection?.message||d.detail||"Brave Search connection failed";throw new Error(detail)}
  input.value="";notify(d.connection?.message||"Brave Search connected successfully.");
  await loadWebSearchConfig();
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Save & Connect"}
}
async function testBraveConfig(){
 const button=$("#testBrave");button.disabled=true;button.textContent="Testing…";
 try{
  const r=await apiFetch("/api/system/search/web/brave/test",{method:"POST",cache:"no-store"},45000),d=await r.json();
  if(!r.ok)throw new Error(d.detail?.message||d.detail||"Brave Search test failed");
  notify(d.message||"Brave Search connected successfully.");
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test Brave"}
}
const saveTavilyButton=$("#saveTavily");if(saveTavilyButton)saveTavilyButton.addEventListener("click",saveTavilyConfig);
const testTavilyButton=$("#testTavily");if(testTavilyButton)testTavilyButton.addEventListener("click",testTavilyConfig);
const saveBraveButton=$("#saveBrave");if(saveBraveButton)saveBraveButton.addEventListener("click",saveBraveConfig);
const testBraveButton=$("#testBrave");if(testBraveButton)testBraveButton.addEventListener("click",testBraveConfig);
safeLoad("Web search configuration",loadWebSearchConfig);

function humanBackupSize(bytes){if(!bytes&&bytes!==0)return"";if(bytes<1024)return`${bytes} B`;if(bytes<1024*1024)return`${(bytes/1024).toFixed(1)} KB`;return`${(bytes/1024/1024).toFixed(1)} MB`}
async function loadBackups(){
 const box=$("#backupList");if(!box)return;
 const r=await apiFetch("/api/system/backups",{cache:"no-store"},30000);const d=await r.json();
 const items=d.backups||[];
 if(!items.length){box.innerHTML='<div class="backup-empty">No backups yet.</div>';return}
 box.innerHTML=items.map(b=>`<div class="backup-row"><span class="backup-name">${esc(b.filename)}</span><span class="backup-size">${esc(humanBackupSize(b.size_bytes))}</span></div>`).join("");
}
async function createBackupNow(){
 const button=$("#createBackup");if(!button)return;
 button.disabled=true;const original=button.textContent;button.textContent="Backing up…";
 try{
  const r=await apiFetch("/api/system/backup",{method:"POST"},60000);const d=await r.json();
  if(!r.ok)throw new Error(d.detail||"Backup failed");
  notify(`Backup created and verified (${humanBackupSize(d.size_bytes)}).`);
  await loadBackups();
 }catch(e){notify(e.message)}
 finally{button.disabled=false;button.textContent=original}
}
const createBackupButton=$("#createBackup");if(createBackupButton)createBackupButton.addEventListener("click",createBackupNow);
const refreshBackupsButton=$("#refreshBackups");if(refreshBackupsButton)refreshBackupsButton.addEventListener("click",loadBackups);
safeLoad("Backups",loadBackups);

const LLM_PROVIDER_META={
 openrouter:{keyPlaceholder:"Paste your OpenRouter API key"},
 mistral:{keyPlaceholder:"Paste your Mistral API key"},
 huggingface:{keyPlaceholder:"Paste your Hugging Face token"},
 cloudflare:{keyPlaceholder:"Paste your Cloudflare API token"},
 gemini:{keyPlaceholder:"Paste your Gemini API key"}
};
function llmProviderCard(p){
 const meta=LLM_PROVIDER_META[p.id]||{};
 const extras=Object.entries(p.extra_fields||{}).map(([name,f])=>`<input data-llm-extra="${esc(name)}" value="${esc(f.value||"")}" autocomplete="off" spellcheck="false" placeholder="${esc(f.label||name)}">`).join("");
 return `<div class="llm-provider-config" data-llm-provider="${esc(p.id)}">
  <div class="llm-provider-copy"><strong>${esc(p.name)}</strong><small class="llm-provider-state ${p.configured?"ready":""}" data-llm-state>${p.configured?`Configured (${esc(p.masked_key||"saved")})`:"Not configured"}</small>${p.note?`<small>${esc(p.note)}</small>`:""}${p.signup?`<small><a href="${esc(p.signup)}" target="_blank" rel="noopener noreferrer">Get a free key ↗</a></small>`:""}</div>
  <input data-llm-key type="password" autocomplete="off" spellcheck="false" placeholder="${esc(meta.keyPlaceholder||"Paste API key/token")}">
  <input data-llm-model autocomplete="off" spellcheck="false" value="${esc(p.model||"")}" placeholder="Model name">
  ${extras}
  <button type="button" data-llm-save>Save &amp; Connect</button>
  <button type="button" class="secondary" data-llm-test ${p.configured?"":"disabled"}>Test</button>
 </div>`;
}
async function loadLlmConfig(){
 const r=await apiFetch("/api/system/llm/providers",{cache:"no-store"},30000),d=await r.json();
 if(!r.ok)throw new Error(d.detail||"LLM configuration status unavailable");
 const grid=$("#llmConfigGrid");if(!grid)return d;
 grid.innerHTML=(d.providers||[]).map(llmProviderCard).join("");
 grid.querySelectorAll("[data-llm-provider]").forEach(card=>{
  card.querySelector("[data-llm-save]").addEventListener("click",()=>saveLlmProvider(card));
  card.querySelector("[data-llm-test]").addEventListener("click",()=>testLlmProvider(card));
 });
 const configured=(d.providers||[]).filter(p=>p.configured).length;
 const summary=$("#llmConfigSummary");if(summary)summary.textContent=`${configured} of ${(d.providers||[]).length} free/cloud LLM providers connected. Each card links to its free key page; keys are saved locally in .env.`;
 return d;
}
async function saveLlmProvider(card){
 const providerId=card.dataset.llmProvider;
 const key=(card.querySelector("[data-llm-key]")?.value||"").trim();
 const model=(card.querySelector("[data-llm-model]")?.value||"").trim();
 if(!key){notify("Paste the API key/token first.");card.querySelector("[data-llm-key]")?.focus();return;}
 const extra={};card.querySelectorAll("[data-llm-extra]").forEach(i=>extra[i.dataset.llmExtra]=(i.value||"").trim());
 if(providerId==="cloudflare"&&!extra.account_id){notify("Cloudflare also requires the Account ID.");card.querySelector('[data-llm-extra="account_id"]')?.focus();return;}
 const button=card.querySelector("[data-llm-save]");button.disabled=true;button.textContent="Connecting…";
 try{
  const r=await apiFetch(`/api/system/llm/providers/${encodeURIComponent(providerId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({api_key:key,model,extra})},180000);
  const d=await r.json();
  if(!r.ok||!d.ok){const detail=d.detail?.message||d.connection?.message||d.detail||"LLM connection failed";throw new Error(detail)}
  notify(d.connection?.message||"LLM provider connected successfully.");
  await loadLlmConfig();
  const sr=await apiFetch("/api/system/status",{cache:"no-store"},30000),sd=await sr.json();if(sr.ok)renderStatus(sd);
 }catch(e){notify(e.message)}finally{if(document.body.contains(button)){button.disabled=false;button.textContent="Save & Connect"}}
}
async function testLlmProvider(card){
 const providerId=card.dataset.llmProvider,button=card.querySelector("[data-llm-test]");button.disabled=true;button.textContent="Testing…";
 try{
  const r=await apiFetch(`/api/system/llm/providers/${encodeURIComponent(providerId)}/test`,{method:"POST",cache:"no-store"},180000),d=await r.json();
  if(!r.ok)throw new Error(d.detail?.message||d.detail||"LLM test failed");
  notify(d.message||"LLM provider connected successfully.");
 }catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test"}
}
const refreshLlmButton=$("#refreshLlmConfig");if(refreshLlmButton)refreshLlmButton.addEventListener("click",async()=>{refreshLlmButton.disabled=true;refreshLlmButton.textContent="Refreshing…";try{await loadLlmConfig();notify("LLM configurations refreshed.")}catch(e){notify(e.message)}finally{refreshLlmButton.disabled=false;refreshLlmButton.textContent="Refresh"}});
safeLoad("LLM configuration",loadLlmConfig);

// Tell the creator BEFORE building what will limit video quality (no stock footage, no music source, ...).
async function loadVideoReadiness(){
 const box=$("#videoReadiness");if(!box)return;
 try{
  const r=await apiFetch("/api/system/video-readiness",{cache:"no-store"},30000);if(!r.ok)return;
  const d=await r.json();
  const issues=(d.items||[]).filter(i=>i.state!=="ok");
  if(!issues.length){box.hidden=true;return}
  box.className="readiness-notice "+(d.can_render?"warn":"blocked");
  box.innerHTML=`<strong>${esc(d.summary)}</strong><ul>${issues.map(i=>`<li><b>${esc(i.label)}:</b> ${esc(i.message)}${i.fix?` <em>${esc(i.fix)}</em>`:""}</li>`).join("")}</ul>`;
  box.hidden=false;
 }catch{/* a status problem must never block the creator */}
}
// Show which narration languages are ready now and which download on first use.
async function annotateLanguageOptions(){
 const select=$("#narrationLanguage");if(!select)return;
 try{
  const r=await apiFetch("/api/system/languages",{cache:"no-store"},30000);if(!r.ok)return;
  const d=await r.json();
  for(const lang of d.languages||[]){
   const option=select.querySelector(`option[value="${lang.name}"]`);if(!option)continue;
   option.textContent=`${lang.name}${lang.code==="en"?" (default)":""} - ${lang.status==="ready"?"voice ready":"install a speech engine first"}`;
  }
 }catch{/* labels are a convenience only */}
}
safeLoad("Video readiness",loadVideoReadiness);
safeLoad("Language voices",annotateLanguageOptions);

(function(){const box=document.getElementById("reviewBeforeRender");if(!box)return;try{box.checked=localStorage.getItem("omnia_review_before_render")==="1"}catch{}box.addEventListener("change",()=>{try{localStorage.setItem("omnia_review_before_render",box.checked?"1":"0")}catch{}})})();
// Learning switch in the Memory tab: lets the creator decide whether OMNIA learns from their finished videos.
async function loadLearningSetting(){
 const box=$("#learningToggle");if(!box)return;
 try{
  const r=await apiFetch("/api/system/learning",{cache:"no-store"},30000);if(!r.ok)return;const d=await r.json();
  box.checked=!!d.enabled;
  $("#learningStatus").textContent=`${d.learned_principles} learned so far. A learned principle expires after ${d.expiry_days} days unless it keeps proving useful, and you can delete any of them below.`;
 }catch{}
}
(function(){const box=document.getElementById("learningToggle");if(!box)return;box.addEventListener("change",async()=>{try{const r=await apiFetch("/api/system/learning",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:box.checked})},30000);if(!r.ok)throw new Error("Could not save that setting");notify(box.checked?"OMNIA will learn from your finished videos.":"OMNIA will not learn from your finished videos. What it already learned still applies.");await loadLearningSetting()}catch(e){box.checked=!box.checked;notify(e.message)}})})();
safeLoad("Learning setting",loadLearningSetting);

async function loadElevenlabsProvider(){
 try {const r=await apiFetch('/api/system/media/elevenlabs');const d=await r.json();
  const status=document.querySelector('#elevenlabsStatus');if(status)status.textContent=d.configured?'API key saved. Select a voice ID.':'Enter your ElevenLabs API key and voice ID.';
  for(const [id,key] of [['elevenlabsVoice','default_voice'],['elevenlabsMaleVoice','male_voice'],['elevenlabsFemaleVoice','female_voice'],['elevenlabsModel','model']]){
   const el=document.getElementById(id);if(el)el.value=d[key]||'';
  }
 }catch(e){console.warn('ElevenLabs status',e)}
}
const saveElevenlabs=document.getElementById('saveElevenlabs');
if(saveElevenlabs)saveElevenlabs.onclick=async()=>{
 try{
  const payload={api_key:document.querySelector('#elevenlabsApiKey').value,voice_id:document.querySelector('#elevenlabsVoice').value,
  male_voice_id:document.querySelector('#elevenlabsMaleVoice').value,female_voice_id:document.querySelector('#elevenlabsFemaleVoice').value,
  model_id:document.querySelector('#elevenlabsModel').value};
  const r=await apiFetch('/api/system/media/elevenlabs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!r.ok){const d=await r.json();throw Error(d.detail||'Unable to save ElevenLabs settings')}
  document.querySelector('#elevenlabsApiKey').value='';notify('ElevenLabs configuration saved.');await loadElevenlabsProvider();await loadMediaRuntime();
 }catch(e){notify(e.message)}
};
const listElevenlabs=document.getElementById('listElevenlabsVoices');
if(listElevenlabs)listElevenlabs.onclick=async()=>{
 const out=document.querySelector('#elevenlabsVoiceResults');out.textContent='Loading voice IDs…';
 try{const r=await apiFetch('/api/system/media/elevenlabs/voices');const d=await r.json();if(!r.ok)throw Error(d.detail||'Unable to list voices');
 out.textContent=(d.voices||[]).map(v=>`${v.name}: ${v.voice_id}`).join(' | ')||'No voices returned';
 }catch(e){out.textContent=e.message}
};
loadElevenlabsProvider();

$("#conversationSearch")?.addEventListener("input",()=>{loadConversations().catch(()=>{})});

// Free multilingual speech provider controls
(async function initFreeSpeech(){
 const $id=id=>document.getElementById(id);
 if(!$id('freeSpeechProvider')) return;
 const provider=$id('freeSpeechProvider'),locale=$id('freeSpeechLocale'),voice=$id('freeSpeechVoice'),info=$id('freeSpeechInfo');
 const parse=async(r,label)=>{const raw=await r.text();let d;try{d=JSON.parse(raw)}catch{throw Error(`${label}: server returned HTTP ${r.status} instead of JSON. Check logs/runtime.log.`)}if(!r.ok)throw Error(typeof d.detail==='string'?d.detail:label+' failed');return d};
 const MODE_TEXT={auto:'Automatic: Edge neural first, then Google voices, Piper offline and this computer\'s voices if a service fails. Narration never stops because one engine is down.',edge_tts:'Edge neural voices (online). If Edge fails, OMNIA still falls back to the other free engines.',gtts:'Google voices (online, one natural voice per language). Leave the voice on Auto.',piper:'Piper runs fully offline. Browse voices, pick one, and it downloads once (20-60 MB).',system:'Uses the voices built into this computer: works offline, quality depends on your OS.',elevenlabs:'ElevenLabs (requires your API key below).'};
 const showMode=()=>{info.textContent=MODE_TEXT[provider.value]||''};
 const engineParam=()=>provider.value==='edge_tts'?'':provider.value;
 const ENGINE_HELP={edge_tts:'Online · 70+ languages · best quality',gtts:'Online · ~60 languages incl. Filipino',piper:'Offline neural · ~40 languages · one-time voice download',system:'Offline · uses the voices installed in Windows/macOS/Linux',elevenlabs:'Paid API key'};
 async function renderEngines(d){
  const box=$id('speechEngines');if(!box||!d.engines)return;
  box.innerHTML=d.engines.filter(e=>e.id!=='elevenlabs'||e.installed).map(e=>`<div class="speech-engine ${e.installed?'ready':''} ${e.recently_failed?'failed':''}"><div><strong>${esc(e.label)}</strong><small>${esc(ENGINE_HELP[e.id]||'')}${e.id==='piper'&&e.voices_downloaded?.length?` · ${e.voices_downloaded.length} voice(s) downloaded`:''}${e.recently_failed?' · failed recently, using fallback':''}</small></div>${e.installed?`<span class="ok-tag">${e.id===d.chain?.[0]?'In use':'Ready'}</span>${e.installable?`<button type="button" class="ghost" data-speech-install="${e.id}">Update</button>`:''}`:(e.installable?`<button type="button" data-speech-install="${e.id}">Install</button>`:'<small>Not available on this computer</small>')}</div>`).join('');
  box.querySelectorAll('[data-speech-install]').forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent='Installing…';try{const r=await apiFetch('/api/system/media/install-speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({engine:b.dataset.speechInstall})},900000);const x=await parse(r,'Install');notify(x.message||'Installed');await refreshSpeech();await loadMediaRuntime()}catch(e){notify(e.message);b.disabled=false;b.textContent='Retry'}});
 }
 async function refreshSpeech(){const d=await parse(await apiFetch('/api/system/media/free-speech'),'Speech configuration');await renderEngines(d);return d}
 provider.addEventListener('change',showMode);
 locale.addEventListener('change',()=>{voice.replaceChildren(new Option('Browse voices for this locale',''));info.textContent='Language changed. Browse Native Voices to select an accent-matched voice.'});
 locale.addEventListener('input',()=>{if(voice.value)voice.replaceChildren(new Option('Browse voices for this locale',''))});
 try {const d=await parse(await apiFetch('/api/system/media/free-speech'),'Speech configuration');
  provider.value=['auto','edge_tts','gtts','piper','system','elevenlabs'].includes(d.provider)?d.provider:'auto';
  locale.value=d.locale||'en-US';
  if(d.voice){voice.appendChild(new Option(d.voice,d.voice));voice.value=d.voice}
  showMode();renderEngines(d);
  if(!(d.engines||[]).some(e=>e.installed))info.textContent='No speech engine yet. Click Install Free Speech (installs Edge + Google voices).';
 }catch(e){info.textContent=e.message}
 $id('listFreeVoices').onclick=async()=>{const button=$id('listFreeVoices');button.disabled=true;try{
  info.textContent='Loading available voices…';const current=locale.value.trim();
  const eng=provider.value==='auto'||provider.value==='elevenlabs'?'edge_tts':provider.value;
  const d=await parse(await apiFetch('/api/system/media/free-speech/voices?locale='+encodeURIComponent(current)+'&engine='+eng,{},60000),'Voice list');
  const previous=voice.value;voice.replaceChildren(new Option('Auto-select accent-matched voice',''));
  for(const v of d.voices||[]){voice.appendChild(new Option(`${v.name} (${[v.gender,v.quality,v.locale,v.downloaded?'downloaded':''].filter(Boolean).join(', ')})`,v.name))}
  if([...voice.options].some(x=>x.value===previous))voice.value=previous;
  info.textContent=`${(d.voices||[]).length} voices available for ${current||'all locales'}.`;
 }catch(e){info.textContent=e.message}finally{button.disabled=false}};
 $id('saveFreeSpeech').onclick=async()=>{const button=$id('saveFreeSpeech');button.disabled=true;try{
  await parse(await apiFetch('/api/system/media/free-speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider.value,locale:locale.value.trim(),voice:voice.value})}),'Save speech settings');
  if(provider.value==='piper'&&voice.value){info.textContent='Downloading the offline voice (one time)…';await parse(await apiFetch('/api/system/media/free-speech/piper-voice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:voice.value})},600000),'Voice download')}
  info.textContent='Saved. '+(MODE_TEXT[provider.value]||'');await refreshSpeech();
  notify('Speech settings saved');await loadMediaRuntime();
 }catch(e){info.textContent=e.message;notify(e.message)}finally{button.disabled=false}};
 // Retain a single preview and its object URL until playback actually completes.
 let currentPreview=null;
 const stopPreview=()=>{
  if(!currentPreview)return;
  const {audio,url}=currentPreview;
  currentPreview=null;
  audio.onended=null;audio.onerror=null;audio.onabort=null;
  audio.pause();audio.removeAttribute('src');audio.load();
  URL.revokeObjectURL(url);
 };
 $id('testSelectedFreeVoice').onclick=async()=>{
  const button=$id('testSelectedFreeVoice');
  if(button.disabled)return;
  stopPreview();button.disabled=true;
  info.textContent='Generating voice preview…';
  try{
   const r=await apiFetch('/api/system/media/free-speech/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locale:locale.value.trim(),voice:voice.value,engine:engineParam()})},600000);
   if(!r.ok)await parse(r,'Voice preview');
   const used=r.headers.get('X-Omnia-Speech-Engine');
   const blob=await r.blob();
   if(!blob.size||!((blob.type||r.headers.get('Content-Type')||'').toLowerCase().includes('audio/'))){
    throw Error('Speech preview returned no playable audio. See logs/runtime.log.');
   }
   const url=URL.createObjectURL(blob);
   const audio=new Audio(url);
   currentPreview={audio,url};
   const cleanup=(message,failed=false)=>{
    if(currentPreview?.audio!==audio)return;
    stopPreview();button.disabled=false;info.textContent=message;
    if(failed)notify(message);
   };
   audio.onended=()=>cleanup('Voice preview finished.');
   audio.onerror=()=>cleanup('Cannot decode or play speech preview. Check browser audio support.',true);
   audio.onabort=()=>cleanup('Voice preview was interrupted.',true);
   await audio.play();
   if(currentPreview?.audio===audio){info.textContent='Playing voice preview'+(used?` (engine: ${used})`:'')+'…';}
  }catch(e){
   stopPreview();button.disabled=false;info.textContent=e.message;notify(e.message);
  }
 };

})();;
