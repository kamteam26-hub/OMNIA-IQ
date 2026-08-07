const state={files:[],sending:false,newChatBusy:false};
const $=s=>document.querySelector(s);
const messages=$("#messages"),input=$("#message"),toast=$("#toast");
const welcomeHTML=()=>`<div id="welcome" class="welcome"><img class="welcome-logo" src="/static/omnia-iq-logo.svg" alt="OMNIA IQ logo"><h3>How can OMNIA IQ help?</h3><p>Reason, research, create, analyse files, and coordinate work from one adaptive assistant.</p></div>`;
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function notify(t){toast.textContent=t;toast.classList.remove("hidden");clearTimeout(window.__toast);window.__toast=setTimeout(()=>toast.classList.add("hidden"),3500)}

async function apiFetch(url,options={},timeoutMs=900000){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{return await fetch(url,{...options,signal:controller.signal})}
 catch(err){
  if(err.name==="AbortError")throw new Error("OMNIA IQ took too long to respond. The local model may be overloaded.");
  throw new Error("Connection to the OMNIA IQ backend was lost. Keep the OMNIA window open, check logs/runtime.log, and try Fast local mode for large files.");
 }finally{clearTimeout(timer)}
}
function add(role,text,extra=""){const w=$("#welcome");if(w)w.remove();const n=document.createElement("div");n.className=`message ${role} ${extra}`;n.textContent=text;messages.appendChild(n);messages.scrollTop=messages.scrollHeight;return n}
async function history(){const r=await apiFetch("/api/chat/history",{},30000);const d=await r.json();messages.innerHTML="";if(!d.messages.length){messages.innerHTML=welcomeHTML();return}d.messages.forEach(m=>add(m.role,m.content))}
function attachments(){const box=$("#attachments");box.innerHTML=state.files.map((f,i)=>`<span class="chip">${esc(f.filename)} <button type="button" onclick="removeFile(${i})">×</button></span>`).join("")}
window.removeFile=i=>{state.files.splice(i,1);attachments()};
async function send(e){e.preventDefault();let text=input.value.trim();if(!text&&state.files.length)text="Inspect the attached file, determine the requested work from its contents and project context, then complete as much as possible and clearly report any blocker.";if(!text||state.sending)return;state.sending=true;$("#send").disabled=true;add("user",text);input.value="";const wait=add("assistant",state.files.length?"OMNIA IQ is reading the attached project and working on the request…":"OMNIA IQ is thinking…","thinking");
try{const r=await apiFetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:text,use_web:false,harmony:$("#web").checked,file_ids:state.files.map(f=>f.file_id)})},900000);const d=await r.json();if(!r.ok)throw new Error(typeof d.detail==="string"?d.detail:JSON.stringify(d.detail));wait.textContent=d.reply;wait.classList.remove("thinking");if(d.providers_used?.length>1)notify(`OMNIA IQ harmonized ${d.providers_used.length} local models`);state.files=[];attachments()}catch(err){wait.textContent=err.message;wait.classList.remove("thinking");wait.classList.add("error")}finally{state.sending=false;$("#send").disabled=false;input.focus()}}
async function upload(file,attach=false){if(!file)return;const form=new FormData();form.append("document",file);notify(`Uploading ${file.name}…`);const r=await apiFetch("/api/files/upload",{method:"POST",body:form},600000),d=await r.json();if(!r.ok){notify(d.detail||"Upload failed");return}if(attach){state.files.push(d);attachments()}notify(`${file.name} attached and ready for processing`);loadFiles()}
async function loadFiles(){const r=await apiFetch("/api/files/uploads",{},30000),d=await r.json();$("#fileList").innerHTML=d.uploads.map(f=>`<div class="item"><div class="file-glyph">▱</div><div class="grow"><strong>${esc(f.filename)}</strong><small>${esc(f.created_at||"")}</small></div><button data-id="${f.local_file_id}" data-name="${esc(f.filename)}">Attach</button></div>`).join("")||'<div class="empty-state">No files yet.</div>';document.querySelectorAll("[data-id]").forEach(b=>b.onclick=()=>{state.files.push({file_id:b.dataset.id,filename:b.dataset.name});attachments();showTab("chat")})}
async function loadStudios(){
 const r=await apiFetch("/api/projects/studios",{},30000),d=await r.json();
 $("#studioGrid").innerHTML=(d.studios||[]).map(x=>`<article class="studio-card"><div class="studio-icon">${esc(x.icon)}</div><h3>${esc(x.name)}</h3><p>${esc(x.description)}</p><button type="button" data-studio="${esc(x.id)}">Create project</button></article>`).join("");
 document.querySelectorAll("[data-studio]").forEach(b=>b.onclick=()=>{$("#projectType").value=b.dataset.studio;showTab("tasks");$("#taskInput").focus()});
}
function renderTimeline(events=[]){return `<div class="timeline">${events.map(e=>`<span class="stage ${esc(e.status)}" title="${esc(e.detail)}">${esc(e.stage)}</span>`).join("")}</div>`}
function updateDashboard(tasks,artifactCount){
 $("#metricProjects").textContent=tasks.length;
 $("#metricRunning").textContent=tasks.filter(t=>t.status==="running").length;
 $("#metricCompleted").textContent=tasks.filter(t=>t.status==="completed").length;
 $("#metricArtifacts").textContent=artifactCount;
 $("#dashboardProjects").innerHTML=tasks.slice(0,5).map(t=>`<div class="item"><div class="grow"><strong>${esc(t.title)}</strong><small>${esc(t.status)}</small>${renderTimeline(t.events||[])}</div></div>`).join("")||'<div class="empty-state">No production activity yet.</div>';
}
async function loadTasks(){
 const r=await apiFetch("/api/projects",{},30000),d=await r.json();
 let artifactCount=0;
 $("#taskList").innerHTML=d.tasks.map(t=>`<div class="item task-card">
  <div class="grow"><div class="task-title"><strong>${esc(t.title)}</strong><span class="status ${esc(t.status||"queued")}">${esc(t.status||"queued")}</span></div>
  ${t.instructions?`<small>${esc(t.instructions)}</small>`:""}${renderTimeline(t.events||[])}
  ${t.result?`<details><summary>View production report</summary><pre>${esc(t.result)}</pre></details>`:""}<div class="artifacts" data-artifacts="${t.id}"></div></div>
  <button class="run-task" data-run="${t.id}" ${t.status==="running"?"disabled":""}>${t.status==="running"?"Working…":"Build project"}</button>
  <button class="delete" data-delete="${t.id}">×</button></div>`).join("")||'<div class="empty-state">No projects yet. Choose a studio or create a project.</div>';
 document.querySelectorAll("[data-run]").forEach(b=>b.onclick=async()=>{b.disabled=true;b.textContent="Building…";notify("OMNIA IQ is planning, producing, packaging, and verifying the project.");try{const r=await apiFetch(`/api/projects/${b.dataset.run}/run`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({harmony:$("#web").checked,file_ids:state.files.map(f=>f.file_id),autonomous_production:true})});const d=await r.json();if(!r.ok)throw new Error(d.detail||"Project failed");notify(`Project completed with ${(d.artifacts||[]).length} artifacts`);}catch(e){notify(e.message)}finally{loadTasks()}});
 document.querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{await apiFetch(`/api/projects/${b.dataset.delete}`,{method:"DELETE"});loadTasks()});
 for(const box of document.querySelectorAll("[data-artifacts]")){const r=await apiFetch(`/api/projects/${box.dataset.artifacts}/artifacts`,{},30000),d=await r.json();artifactCount+=(d.artifacts||[]).length;box.innerHTML=(d.artifacts||[]).map(a=>`<a class="artifact-link ${a.mime_type==="application/zip"?"package":""}" href="/api/projects/artifacts/${a.id}/download">${a.mime_type==="application/zip"?"Download project package":"Download"} ${esc(a.filename)}</a>`).join("")}
 updateDashboard(d.tasks,artifactCount);
}
async function loadMemory(){const r=await apiFetch("/api/memory",{},30000),d=await r.json();$("#memoryStats").textContent=`${d.stats.c} memories · ${d.stats.chars.toLocaleString()} stored characters`;$("#memoryList").innerHTML=(d.memories||[]).map(m=>`<div class="item"><div class="grow"><strong>${esc(m.kind)}</strong><small>${esc(m.content)}</small></div><button class="delete" data-forget="${m.id}">×</button></div>`).join("")||'<div class="empty-state">No long-term memories yet.</div>';document.querySelectorAll("[data-forget]").forEach(b=>b.onclick=async()=>{await apiFetch(`/api/memory/${b.dataset.forget}`,{method:"DELETE"});loadMemory()})}
function showTab(name){document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));document.querySelectorAll("nav [data-tab]").forEach(b=>b.classList.remove("active"));$(`#${name}`).classList.add("active");document.querySelector(`[data-tab="${name}"]`).classList.add("active");$("#pageTitle").textContent=name==="chat"?"OMNIA IQ Chat":name[0].toUpperCase()+name.slice(1)}
async function newChat(){if(state.newChatBusy)return;state.newChatBusy=true;const button=$("#newChat");button.disabled=true;button.innerHTML="<span>↻</span> Resetting…";try{const r=await apiFetch("/api/chat/history",{method:"DELETE"},30000);if(!r.ok)throw new Error("Could not clear conversation history");state.files=[];attachments();input.value="";messages.innerHTML=welcomeHTML();showTab("chat");input.focus();notify("New conversation started")}catch(err){notify(err.message)}finally{state.newChatBusy=false;button.disabled=false;button.innerHTML="<span>＋</span> New conversation"}}
function renderStatus(d){const ready=d.providers.filter(p=>p.ready);$("#status").textContent=d.ready?(d.multi_api?`${ready.length} models ready · OMNIA orchestrator`:`${ready[0].model} connected`):"Local model required";$("#providerList").innerHTML=d.providers.map(p=>`<div class="provider ${p.ready?"ready":""}"><span></span><div><strong>${esc(p.name)}</strong><small>${esc(p.ready?`${p.model} · ${p.role||"specialist"}`:"Not configured")}</small></div></div>`).join("");if(!d.ready)notify("Start Ollama and install at least one model listed in .env.")}
document.querySelectorAll("nav [data-tab]").forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$("#web").onchange=e=>{const on=e.target.checked;$("#modeLabel").textContent=on?"Full harmony":"Fast local";notify(on?"Full harmony enabled. Responses may take longer.":"Fast local enabled for quicker responses.")};
$("#chatForm").onsubmit=send;$("#newChat").onclick=newChat;
$("#chatFile").onchange=e=>{upload(e.target.files[0],true);e.target.value=""};$("#fileUpload").onchange=e=>{upload(e.target.files[0],false);e.target.value=""};
$("#taskForm").onsubmit=async e=>{e.preventDefault();const v=$("#taskInput").value.trim(),instructions=$("#taskInstructions").value.trim();if(!v)return;await apiFetch("/api/projects",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:v,instructions,project_type:$("#projectType").value})});$("#taskInput").value="";$("#taskInstructions").value="";loadTasks()};
$("#memoryForm").onsubmit=async e=>{e.preventDefault();const content=$("#memoryInput").value.trim();if(!content)return;await apiFetch("/api/memory",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content,kind:"knowledge",importance:3})});$("#memoryInput").value="";loadMemory()};
input.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("#chatForm").requestSubmit()}};
async function safeLoad(label,fn){try{await fn()}catch(e){console.error(label,e);notify(`${label} could not load: ${e.message}`)}}
(async()=>{
 await safeLoad("Chat history",history);
 await Promise.all([safeLoad("Files",loadFiles),safeLoad("Projects",loadTasks),safeLoad("Studios",loadStudios),safeLoad("Memory",loadMemory)]);
 await safeLoad("Connection status",async()=>{const r=await apiFetch("/api/system/status",{},30000);const d=await r.json();if(!r.ok)throw new Error(d.detail||"Status unavailable");renderStatus(d)});
})().catch(e=>notify(e.message));

document.querySelectorAll("[data-open-projects]").forEach(b=>b.onclick=()=>showTab("tasks"));

function runtimeCard(name,item){
 const ready=!!item?.ready;
 const detail=item?.version||item?.path||"Not detected";
 return `<div class="runtime-card ${ready?"ready":""}"><strong><span class="runtime-dot"></span>${esc(name)}</strong><small>${esc(detail)}</small>${item?.path&&item?.version?`<small>${esc(item.path)}</small>`:""}</div>`;
}
async function loadMediaRuntime(){
 const r=await apiFetch("/api/system/media",{},30000),d=await r.json();
 if(!r.ok)throw new Error(d.detail||"Media runtime status unavailable");
 $("#mediaSummary").textContent=d.ready&&d.speech?.ready?"Ready to render MP4 videos with speech.":(d.ready?"Video is ready. Speech engine needs setup.":"Video runtime is incomplete.");
 $("#mediaRuntime").innerHTML=runtimeCard("FFmpeg",d.ffmpeg)+runtimeCard("FFprobe",d.ffprobe)+runtimeCard("Speech Engine",d.speech);
 const button=$("#installFfmpeg");
 button.disabled=!d.install_supported||d.ready;
 button.textContent=d.ready?"FFmpeg is ready":(d.install_supported?"Install FFmpeg automatically":"Automatic install unavailable");
 const speechButton=$("#installSpeech");
 speechButton.disabled=!!d.speech?.ready;
 speechButton.textContent=d.speech?.ready?`${d.speech.engine} is ready`:"Install Piper speech engine";
 $("#testSpeech").disabled=!d.speech?.ready;
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
  $("#mediaSummary").textContent=status.ready&&status.speech?.ready?"Ready to render MP4 videos with speech.":(status.ready?"Video is ready. Speech engine needs setup.":"Video runtime is incomplete.");
  $("#mediaRuntime").innerHTML=runtimeCard("FFmpeg",status.ffmpeg)+runtimeCard("FFprobe",status.ffprobe)+runtimeCard("Speech Engine",status.speech);
  const ffmpegButton=$("#installFfmpeg");
  ffmpegButton.disabled=!status.install_supported||status.ready;
  ffmpegButton.textContent=status.ready?"FFmpeg is ready":(status.install_supported?"Install FFmpeg automatically":"Automatic install unavailable");
  const speechButton=$("#installSpeech");
  speechButton.disabled=!!status.speech?.ready;
  speechButton.textContent=status.speech?.ready?`${status.speech.engine} is ready`:"Install Piper speech engine";
  $("#testSpeech").disabled=!status.speech?.ready;
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
 const button=$("#installFfmpeg");button.disabled=true;button.textContent="Installing FFmpeg…";notify("Installing FFmpeg. This can take several minutes.");
 try{const r=await apiFetch("/api/system/media/install-ffmpeg",{method:"POST"},900000),d=await r.json();if(!r.ok)throw new Error(d.detail||"FFmpeg installation failed");notify("FFmpeg installed. Restart OMNIA IQ if it is not detected immediately.");await loadMediaRuntime()}catch(e){notify(e.message);button.disabled=false;button.textContent="Install FFmpeg automatically"}
};
safeLoad("Media runtime",loadMediaRuntime);

$("#installSpeech").onclick=async()=>{
 const button=$("#installSpeech");button.disabled=true;button.textContent="Installing Piper…";notify("Installing the local Piper speech engine.");
 try{const r=await apiFetch("/api/system/media/install-speech",{method:"POST"},900000),d=await r.json();if(!r.ok)throw new Error(d.detail||"Piper installation failed");notify("Piper speech engine installed.");await loadMediaRuntime()}catch(e){notify(e.message);button.disabled=false;button.textContent="Install Piper speech engine"}
};
$("#testSpeech").onclick=async()=>{
 const button=$("#testSpeech");button.disabled=true;button.textContent="Generating test…";
 try{const r=await apiFetch("/api/system/media/test-speech",{method:"POST"},300000);if(!r.ok){const d=await r.json();throw new Error(d.detail||"Speech test failed")}const blob=await r.blob();const url=URL.createObjectURL(blob);const audio=new Audio(url);await audio.play();audio.onended=()=>URL.revokeObjectURL(url);notify("Speech test generated successfully.")}catch(e){notify(e.message)}finally{button.disabled=false;button.textContent="Test speech"}
};
