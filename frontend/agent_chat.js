/* OMNIA Agent mode for Chat: tool-using runs with live steps, approvals, files and sources. */
(() => {
  const $ = s => document.querySelector(s);
  const toggle = $('#agentMode');
  if (!toggle) return;
  const KEY = 'omnia.agentMode';
  try { toggle.checked = localStorage.getItem(KEY) !== 'off'; } catch { toggle.checked = true; }
  const label = () => { $('#agentLabel').textContent = toggle.checked ? 'Agent mode' : 'Chat only'; };
  label();
  toggle.onchange = () => {
    try { localStorage.setItem(KEY, toggle.checked ? 'on' : 'off'); } catch {}
    label();
    notify(toggle.checked ? 'Agent mode: OMNIA can search, read pages, create files and use your browser (with approval).' : 'Chat only: single answers without tools.');
  };

  const ICON = {web_search: 'globe', fetch_url: 'link', list_files: 'folder', read_file: 'book', write_file: 'pen', run_python: 'server',
    memory_search: 'spark', remember: 'spark', browser_get_page: 'eye', browser_list_tabs: 'list', browser_find: 'target',
    browser_navigate: 'external', browser_click: 'target', browser_type: 'pen', browser_scroll: 'arrow-up'};
  const LABEL = {web_search: a => `Searched the web for “${a.query || ''}”`, fetch_url: a => `Read ${hostOf(a.url)}`,
    list_files: () => 'Listed workspace files', read_file: a => `Read ${a.path}`, write_file: a => `Created ${a.path}`,
    run_python: () => 'Ran Python', memory_search: a => `Searched memory for “${a.query || ''}”`, remember: () => 'Saved to memory',
    browser_get_page: () => 'Read your current tab', browser_list_tabs: () => 'Listed your tabs', browser_find: a => a.query ? `Looked for “${a.query}” on the page` : 'Scanned the page',
    browser_navigate: a => `Open ${a.url}`, browser_click: a => `Click element ${a.ref}`, browser_type: a => `Type into element ${a.ref}`, browser_scroll: a => `Scroll ${a.direction || 'down'}`};
  const hostOf = u => { try { return new URL(u).hostname; } catch { return u || 'page'; } };
  const icon = n => `<svg class="i"><use href="#i-${n}"/></svg>`;

  function stepHTML(s) {
    if (s.kind === 'thinking') return `<li class="agent-step running">${icon('spark')}<span>${esc(s.label)}…</span></li>`;
    const text = (LABEL[s.tool] || (() => s.tool))(s.arguments || {});
    return `<li class="agent-step ${esc(s.status)}">${icon(ICON[s.tool] || 'wand')}<div><span>${esc(text)}</span>${s.thought ? `<small>${esc(s.thought)}</small>` : ''}${s.status === 'error' && s.preview ? `<small class="err">${esc(s.preview)}</small>` : ''}</div></li>`;
  }

  function renderRun(node, run, startedAt) {
    const steps = run.steps || [];
    const tools = steps.filter(s => s.kind === 'tool');
    const done = ['completed', 'failed', 'cancelled'].includes(run.status);
    const secs = Math.max(1, Math.round(((run.finished || Date.now() / 1000) - run.created)));
    let html = '';
    if (tools.length || !done) {
      html += `<details class="agent-trace" ${done ? '' : 'open'}><summary>${done ? `Worked for ${secs}s · ${tools.length} step${tools.length === 1 ? '' : 's'}` : `<span class="agent-pulse"></span> Working · ${secs}s`}</summary><ol>${steps.map(stepHTML).join('')}</ol></details>`;
    }
    if (run.approval) {
      const a = run.approval;
      html += `<div class="agent-approval"><strong>${icon('shield')} Allow this browser action?</strong><p>${esc((LABEL[a.tool] || (() => a.tool))(a.arguments || {}))}${a.arguments?.text ? `: “${esc(String(a.arguments.text).slice(0, 200))}”` : ''}</p>${a.thought ? `<small>${esc(a.thought)}</small>` : ''}<div class="btn-row"><button type="button" class="primary" data-decide="allow">Allow once</button><button type="button" data-decide="deny">Deny</button></div></div>`;
    }
    if (run.status === 'failed') html += `<div class="agent-error">${esc(run.error || 'The agent stopped.')}</div>`;
    if (run.reply) html += `<div class="agent-reply">${renderMarkdown(run.reply)}</div>`;
    if (run.files?.length) {
      const unique = [...new Set(run.files)];
      html += `<div class="agent-files">${unique.map(f => `<button type="button" class="agent-file" data-file="${esc(f)}">${icon('download')} ${esc(f)}</button>`).join('')}</div>`;
    }
    if (!done) html += `<div class="agent-controls"><button type="button" class="ghost" data-cancel>Stop</button></div>`;
    node.className = 'message assistant agent-run' + (run.status === 'failed' ? ' error' : '');
    node.innerHTML = html;
    if (run.sources?.length && done) {
      const seen = new Set();
      appendSources(node, run.sources.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 8));
    }
    node.querySelectorAll('[data-decide]').forEach(b => b.onclick = () => decide(run.id, b.dataset.decide, node));
    node.querySelector('[data-cancel]')?.addEventListener('click', () => apiFetch(`/api/assistant/runs/${run.id}/cancel`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}, 15000));
    node.querySelectorAll('[data-file]').forEach(b => b.onclick = () => download(run.conversation_id, b.dataset.file));
    messages.scrollTop = messages.scrollHeight;
  }

  async function decide(runId, decision, node) {
    node.querySelectorAll('[data-decide]').forEach(b => { b.disabled = true; });
    await apiFetch(`/api/assistant/runs/${runId}/approval`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({decision})}, 15000);
  }

  async function download(conversationId, path) {
    try {
      const r = await apiFetch(`/api/assistant/workspace/${conversationId}/file?path=${encodeURIComponent(path)}`, {}, 60000);
      if (!r.ok) throw Error('File not available');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a'); a.href = url; a.download = path.split('/').pop(); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { notify(e.message); }
  }

  async function agentSend(e) {
    e.preventDefault();
    let text = input.value.trim();
    if (!text && state.files.length) text = 'Inspect the attached file and complete the work it describes.';
    if (!text || state.sending) return;
    state.sending = true; $('#send').disabled = true;
    add('user', text); input.value = '';
    const node = add('assistant', 'OMNIA is starting…', 'thinking');
    try {
      const r = await apiFetch('/api/assistant/runs', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: text, conversation_id: state.conversationId, file_ids: state.files.map(f => f.file_id), use_web: true, model_id: $('#agentModel')?.value || '', custom_agent_id: $('#chatAgent')?.value || ''})}, 60000);
      let run = await r.json();
      if (!r.ok) throw Error(typeof run.detail === 'string' ? run.detail : 'Agent failed to start');
      state.conversationId = run.conversation_id; state.files = []; attachments();
      const started = Date.now();
      while (!['completed', 'failed', 'cancelled'].includes(run.status)) {
        renderRun(node, run, started);
        await new Promise(res => setTimeout(res, run.approval ? 1200 : 700));
        const p = await apiFetch(`/api/assistant/runs/${run.id}`, {}, 30000);
        if (!p.ok) throw Error('Lost track of this run (was OMNIA restarted?)');
        run = await p.json();
      }
      renderRun(node, run, started);
      loadConversations();
    } catch (err) {
      setMessageText(node, 'assistant', err.message, 'error');
    } finally { state.sending = false; $('#send').disabled = false; input.focus(); }
  }

  const form = $('#chatForm');
  const original = form.onsubmit;
  // A chosen Agent Studio specialist always runs through Agent mode so its instructions are applied.
  form.onsubmit = e => ((toggle.checked || $('#chatAgent')?.value) ? agentSend(e) : original(e));

  // Agent Studio specialists in the composer: answer as a custom agent anywhere in Chat.
  const agentSel = $('#chatAgent');
  const AGENT_KEY = 'omnia.chatAgent';
  function fillAgents(list) {
    if (!agentSel) return;
    const keep = agentSel.value || (() => { try { return localStorage.getItem(AGENT_KEY) || ''; } catch { return ''; } })();
    const pub = list.filter(a => a.published), drafts = list.filter(a => !a.published);
    agentSel.innerHTML = `<option value="">OMNIA (default)</option>`
      + (pub.length ? `<optgroup label="Published">${pub.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</optgroup>` : '')
      + (drafts.length ? `<optgroup label="Drafts">${drafts.map(a => `<option value="${esc(a.id)}">${esc(a.name)} (draft)</option>`).join('')}</optgroup>` : '');
    agentSel.value = [...agentSel.options].some(o => o.value === keep) ? keep : '';
    agentLabel();
  }
  function agentLabel() {
    const name = agentSel?.selectedOptions[0]?.textContent || '';
    agentSel?.closest('label')?.classList.toggle('on', !!agentSel.value);
    input.placeholder = agentSel?.value ? `Ask ${name.replace(' (draft)', '')}…` : 'Ask OMNIA anything, or give it a task…';
  }
  agentSel?.addEventListener('change', () => {
    try { localStorage.setItem(AGENT_KEY, agentSel.value); } catch {}
    agentLabel();
    if (agentSel.value) notify(`Chat now answers as ${agentSel.selectedOptions[0].textContent}. OMNIA's tools and approvals still apply.`);
  });
  window.addEventListener('omnia:agents-changed', e => fillAgents(e.detail || []));
  window.omniaUseAgent = (id, name) => {
    if (agentSel && ![...agentSel.options].some(o => o.value === id)) agentSel.add(new Option(name || 'Custom agent', id));
    if (agentSel) { agentSel.value = id; try { localStorage.setItem(AGENT_KEY, id); } catch {} agentLabel(); }
    if (typeof showTab === 'function') showTab('chat');
    notify(`Chat now answers as ${name || 'your agent'}. Switch back with the Agent picker under the message box.`);
    input.focus();
  };

  // Extension status chip in the composer note.
  async function browserStatus() {
    try {
      const r = await apiFetch('/api/assistant/browser/status', {}, 8000); const d = await r.json();
      const chip = $('#agentBrowserChip'); if (!chip) return;
      chip.classList.toggle('on', !!d.connected);
      chip.innerHTML = `${icon('globe')} ${d.connected ? 'Browser extension connected' : 'Browser extension not connected'}`;
      chip.title = d.connected ? 'OMNIA can read your tabs and act in Chrome after you approve each action.' : 'Install the OMNIA extension from Settings → Browser extension.';
    } catch {}
  }
  browserStatus(); setInterval(browserStatus, 20000);

  // Model picker: every ready model (all installed Ollama models + connected free clouds), tool-capable first.
  async function loadModels() {
    const sel = $('#agentModel'); if (!sel) return;
    try {
      const r = await apiFetch('/api/assistant/models', {}, 15000); const d = await r.json();
      const keep = sel.value || (() => { try { return localStorage.getItem('omnia.agentModel') || ''; } catch { return ''; } })();
      sel.innerHTML = `<option value="">Auto · best tool-capable model</option>` + d.models.map(m =>
        `<option value="${esc(m.id)}">${esc(m.model)} · ${esc(m.name)}${m.tools ? ' · tools' : ''}</option>`).join('');
      if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    } catch {}
  }
  $('#agentModel')?.addEventListener('change', e => { try { localStorage.setItem('omnia.agentModel', e.target.value); } catch {} });
  loadModels(); setInterval(loadModels, 60000);
  window.omniaReloadAgentModels = loadModels;
})();

/* Settings → Assistant agent & browser extension */
(() => {
  const $ = s => document.querySelector(s);
  if (!$('#agentSettings')) return;
  const set = (card, ok, text) => { $(card).classList.toggle('ready', ok); $(card).querySelector('small').textContent = text; };
  async function refresh() {
    try {
      const r = await apiFetch('/api/assistant/tools', {}, 10000); const d = await r.json();
      set('#agentBrowserCard', d.browser.connected, d.browser.connected ? `Connected (${d.browser.clients.length} browser${d.browser.clients.length === 1 ? '' : 's'})` : 'Not connected. Install it with the steps below.');
      set('#agentCodeCard', d.code_execution, d.code_execution ? 'On: OMNIA can run Python inside each conversation workspace.' : 'Off. Add OMNIA_AGENT_CODE=true to .env and restart to let OMNIA run Python.');
      set('#agentToolsCard', true, d.tools.map(t => t.name).join(', '));
    } catch (e) { set('#agentToolsCard', false, e.message); }
    $('#agentServerUrl').textContent = location.origin;
  }
  $('#agentSettingsRefresh').onclick = refresh;
  $('#agentExtensionDownload').onclick = async () => {
    try {
      const r = await apiFetch('/api/assistant/extension.zip', {}, 30000); if (!r.ok) throw Error('Download failed');
      const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a');
      a.href = url; a.download = 'omnia-chrome-extension.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { notify(e.message); }
  };
  window.addEventListener('omnia:tab', e => { if (e.detail === 'settings') refresh(); });
  refresh();
})();
