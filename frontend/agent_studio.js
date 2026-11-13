/* OMNIA Agent Studio v87: build → test → publish → use in Chat, in one screen. */
(() => {
  const $ = id => document.getElementById(id);
  if (!$('agentstudio')) return;
  const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[c]));
  const toast = t => (window.notify ? window.notify(t) : console.log(t));

  const CATEGORIES = [
    ['general', 'General Assistant', 'Flexible question answering and planning', '◈'],
    ['video_creator', 'Video Creator', 'Scripts, shot lists and storyboards', '▶'],
    ['video_editor', 'Video Editor', 'Edit plans, pacing, captions and cut lists', '✂'],
    ['researcher', 'Researcher', 'Research plans, analysis and source review', '⌕'],
    ['coder', 'Coder', 'Architecture, code drafting and debugging', '</>'],
    ['graphics_designer', 'Graphics Maker', 'Visual briefs, design systems and layout prompts', '▧'],
    ['copywriter', 'Copywriter', 'Clear brand copy and content drafts', '✎'],
    ['marketing', 'Marketing Strategist', 'Campaign ideas and channel planning', '◎'],
    ['data_analyst', 'Data Analyst', 'Data interpretation and reporting', '▥'],
    ['website_builder', 'Website Builder', 'Page structure, UI and implementation plans', '⌘'],
    ['automation_builder', 'Automation Builder', 'Trigger, condition and workflow designs', '⤨'],
    ['customer_support', 'Customer Support', 'Support replies and triage rules', '☷'],
    ['document_creator', 'Document Creator', 'Outlines and professional document drafts', '▤']
  ];
  const CATEGORY_RULES = {
    video_creator: 'Produce production-ready creative briefs, original scripts, visual scene descriptions, shot lists, and storyboards. Do not claim to render a video or edit media without a connected tool.',
    video_editor: 'Create timecoded editing plans, transition guidance, caption drafts, pacing advice, and export checklists. Do not claim to modify media files without an editor tool.',
    researcher: 'Define a focused research question, separate verified sources from uncertainty, synthesize findings and report gaps. Do not invent citations or claim to have browsed without a connected tool.',
    coder: 'Help write, review, explain and debug source code. Explain tests and security implications. Never claim code was executed, built or deployed without verified tooling.',
    graphics_designer: 'Create detailed design briefs, original visual concepts, typography, color palettes and precise image-generation prompts. Do not claim image files have been rendered without an image tool.',
    copywriter: 'Draft concise, audience-appropriate copy with explicit tone and accuracy requirements.',
    marketing: 'Develop practical audience, channel, messaging and campaign plans. Do not invent performance results.',
    data_analyst: 'Describe data transformations, statistics and charts; identify data gaps without inventing numbers.',
    website_builder: 'Plan accessible, responsive website layouts, components, and implementation code.',
    automation_builder: 'Map triggers, typed actions, IF/ELSE branches, limits, error paths, and safe approvals.',
    customer_support: 'Triage support questions, ask for missing facts when necessary and draft accurate responses.',
    document_creator: 'Structure professional documents with appropriate headings, clear prose, and validation requirements.',
    general: 'Assist with questions and structured tasks; separate verified information from assumptions.'
  };
  const catOf = key => CATEGORIES.find(x => x[0] === key) || CATEGORIES[0];

  // ---------- state ----------
  const S = {id: '', version: 0, environment: 'draft', saved: null, agents: [], models: [], busy: false, detail: null};

  async function api(path, options = {}) {
    const r = await (window.omniaApiFetch || fetch)('/api/agent-studio' + path, {credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, ...options});
    let body = {}; try { body = await r.json(); } catch {}
    if (!r.ok) throw Error(typeof body.detail === 'string' ? body.detail : (body.detail?.[0]?.msg || 'Request failed'));
    return body;
  }
  async function guard(button, fn) {
    if (S.busy) return; S.busy = true;
    const btns = button ? [button] : [];
    btns.forEach(b => { b.disabled = true; b.dataset.label = b.innerHTML; b.classList.add('as-loading'); });
    try { return await fn(); } catch (e) { toast(e.message); showRaw('Error: ' + e.message); } finally {
      S.busy = false; btns.forEach(b => { b.disabled = false; b.classList.remove('as-loading'); });
      updateUI();
    }
  }
  const showRaw = v => { $('agentResults').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2); };

  // ---------- templates ----------
  for (const [key, title, description, symbol] of CATEGORIES) {
    $('agentCategory').add(new Option(title, key));
    const b = document.createElement('button'); b.type = 'button'; b.className = 'as-template'; b.dataset.category = key; b.title = description;
    b.innerHTML = `<span class="as-template-sym">${h(symbol)}</span><span>${h(title)}</span>`;
    b.onclick = () => selectCategory(key, true);
    $('agentCategoryGrid').append(b);
  }
  function selectCategory(key, applyTemplate = false) {
    const item = catOf(key);
    $('agentCategory').value = item[0];
    document.querySelectorAll('.as-template').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.category === item[0])));
    $('agentCategoryDescription').textContent = item[2] + '.';
    if (applyTemplate) {
      const name = $('agentName'), text = $('agentInstructions');
      const wasDefaultName = !name.value.trim() || CATEGORIES.some(c => name.value === c[1] + ' Agent');
      const wasDefaultText = !text.value.trim() || Object.values(CATEGORY_RULES).includes(text.value.trim());
      if (wasDefaultName) name.value = item[1] + ' Agent';
      if (wasDefaultText) text.value = CATEGORY_RULES[item[0]];
    }
    updateUI();
  }
  $('asUseTemplate').onclick = () => { $('agentInstructions').value = CATEGORY_RULES[$('agentCategory').value]; updateUI(); $('agentInstructions').focus(); };

  // ---------- model picker (mode + provider in one control) ----------
  async function loadModels() {
    try {
      const r = await (window.omniaApiFetch || fetch)('/api/assistant/models', {}, 15000);
      S.models = (await r.json()).models || [];
    } catch { S.models = []; }
    renderModels();
  }
  function renderModels(keep) {
    const sel = $('asModel'); const current = keep ?? sel.value;
    const opts = [`<option value="det">Quick check · no AI (text tools only)</option>`];
    if (S.models.length) opts.push(`<optgroup label="AI models ready now">${S.models.map(m => `<option value="p:${h(m.id)}">${h(m.model)} · ${h(m.name)}${m.tools ? ' · tools' : ''}</option>`).join('')}</optgroup>`);
    else opts.push(`<option value="" disabled>No AI model ready. Connect one in Settings.</option>`);
    opts.push(`<option value="local">Offline model on this computer (GGUF)</option>`);
    if (current && current.startsWith('p:') && !S.models.some(m => 'p:' + m.id === current)) opts.push(`<option value="${h(current)}">${h(current.slice(2))} · not ready</option>`);
    sel.innerHTML = opts.join('');
    if ([...sel.options].some(o => o.value === current && !o.disabled)) sel.value = current;
  }
  const modelToSpec = v => v === 'det' ? {mode: 'deterministic_test', provider_id: ''} : v === 'local' ? {mode: 'embedded_local', provider_id: ''} : {mode: 'model_response', provider_id: v.slice(2)};
  const specToModel = s => s.mode === 'deterministic_test' ? 'det' : s.mode === 'embedded_local' ? 'local' : 'p:' + (s.provider_id || '');
  const defaultModel = () => S.models.find(m => m.tools) || S.models[0];

  // ---------- form <-> spec ----------
  function readSpec() {
    const m = modelToSpec($('asModel').value || 'det');
    const handoffs = m.mode === 'model_response' ? [...document.querySelectorAll('#asHandoffs input:checked')].map(x => x.value) : [];
    return {category: $('agentCategory').value, name: $('agentName').value.trim(), instructions: $('agentInstructions').value.trim(),
      tools: [...document.querySelectorAll('.agentTool:checked')].map(x => x.value), max_steps: Number($('agentMaxSteps').value) || 4,
      max_model_calls: Number($('agentMaxModelCalls').value) || 12, mode: m.mode, provider_id: m.provider_id, handoffs, output_format: 'json'};
  }
  const specKey = s => JSON.stringify(s ? {...s, tools: [...(s.tools || [])].sort(), handoffs: [...(s.handoffs || [])].sort()} : null);
  const comparable = s => s && ({category: s.category || 'general', name: s.name, instructions: s.instructions, tools: s.tools || [], max_steps: s.max_steps, max_model_calls: s.max_model_calls || 12, mode: s.mode, provider_id: s.provider_id || '', handoffs: s.handoffs || [], output_format: 'json'});
  const dirty = () => specKey(readSpec()) !== specKey(comparable(S.saved));

  function fillForm(spec) {
    selectCategory(spec.category || 'general');
    $('agentName').value = spec.name || ''; $('agentInstructions').value = spec.instructions || '';
    $('agentMaxSteps').value = spec.max_steps || 4; $('agentMaxModelCalls').value = spec.max_model_calls || 12;
    renderModels(specToModel(spec));
    document.querySelectorAll('.agentTool').forEach(c => { c.checked = (spec.tools || []).includes(c.value); });
    renderHandoffs(spec.handoffs || []);
  }

  function renderHandoffs(selected) {
    selected = selected ?? [...document.querySelectorAll('#asHandoffs input:checked')].map(x => x.value);
    const box = $('asHandoffs');
    const options = S.agents.filter(a => a.published && a.id !== S.id);
    if (!options.length) { box.innerHTML = '<span class="muted small">Publish other agents first; then they can be called as specialists.</span>'; return; }
    box.innerHTML = options.map(a => `<label class="as-check"><input type="checkbox" value="${h(a.id)}" ${selected.includes(a.id) ? 'checked' : ''}> ${h(a.name)}</label>`).join('');
    box.querySelectorAll('input').forEach(i => i.onchange = () => {
      if (box.querySelectorAll('input:checked').length > 4) { i.checked = false; toast('Up to 4 specialists.'); }
      updateUI();
    });
  }

  // ---------- agent list ----------
  const STATUS = a => a.published ? (a.environment === 'production' ? ['ok', 'Published'] : ['info', 'Edited · v' + a.active_version + ' live']) : a.environment === 'staging' ? ['warn', 'Staged'] : ['', 'Draft'];
  async function refreshList() {
    S.agents = await api('/overview');
    renderList(); renderHandoffs();
    window.dispatchEvent(new CustomEvent('omnia:agents-changed', {detail: S.agents}));
  }
  function renderList() {
    const q = $('asSearch').value.trim().toLowerCase();
    const items = S.agents.filter(a => !q || a.name.toLowerCase().includes(q) || catOf(a.category)[1].toLowerCase().includes(q));
    $('asCount').textContent = S.agents.length;
    const list = $('asAgentList');
    if (!items.length) { list.innerHTML = `<li class="empty-mini">${S.agents.length ? 'No match.' : 'No agents yet. Pick a template and save.'}</li>`; return; }
    list.innerHTML = items.map(a => { const [cls, label] = STATUS(a); const c = catOf(a.category);
      return `<li><button type="button" class="as-agent ${a.id === S.id ? 'active' : ''}" data-id="${h(a.id)}"><span class="as-template-sym">${h(c[3])}</span><span class="as-agent-text"><strong>${h(a.name)}</strong><small>${h(c[1])} · v${a.latest_version}${a.pending_memory ? ` · ${a.pending_memory} to review` : ''}</small></span><span class="badge ${cls}">${h(label)}</span></button></li>`; }).join('');
    list.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
      if (dirty() && !confirm('Discard unsaved changes to this agent?')) return;
      guard(null, () => load(b.dataset.id));
    });
  }
  $('asSearch').oninput = renderList;

  async function load(target) {
    S.id = target || ''; S.version = 0; S.environment = 'draft'; S.saved = null; S.detail = null;
    clearTranscript();
    $('agentResearchResults').replaceChildren(); $('agentMemoryList').replaceChildren(); showRaw('');
    if (S.id) {
      const v = await api('/agents/' + encodeURIComponent(S.id));
      S.version = v.version; S.environment = v.environment; S.saved = v.spec;
      fillForm(v.spec);
      await refreshMemory().catch(() => {});
    } else {
      $('agentName').value = ''; $('agentInstructions').value = '';
      $('agentMaxSteps').value = 4; $('agentMaxModelCalls').value = 12;
      document.querySelectorAll('.agentTool').forEach(c => { c.checked = false; });
      const m = defaultModel(); renderModels(m ? 'p:' + m.id : 'det');
      renderHandoffs([]);
      selectCategory('general', true);
    }
    renderList();
  }

  // ---------- save ----------
  async function save() {
    const spec = readSpec();
    if (!spec.name) throw Error('Give the agent a name.');
    if (!spec.instructions) throw Error('Write instructions (or use the template text).');
    if (spec.mode === 'model_response' && !spec.provider_id) throw Error('Choose a model.');
    const r = await api('/agents', {method: 'POST', body: JSON.stringify({agent_id: S.id || null, spec})});
    S.id = r.agent_id; S.version = r.version; S.environment = 'draft'; S.saved = spec;
    clearTranscript(true);
    await refreshList();
    toast(`Saved version ${r.version}` + (r.memory_carried ? ` · ${r.memory_carried} ${r.memory_carried === 1 ? "memory" : "memories"} carried over` : ''));
    return r;
  }
  const ensureSaved = async () => { if (!S.id || dirty()) await save(); };
  $('agentSave').onclick = () => guard($('agentSave'), save);
  $('asNew').onclick = () => { if (dirty() && !confirm('Discard unsaved changes?')) return; guard(null, () => load('')).then(() => $('agentName').focus()); };

  // ---------- test ----------
  const sessionId = () => S.id ? 'studio-' + S.id.slice(0, 12) : null;
  function clearTranscript(keepNote) {
    $('asTranscript').innerHTML = `<p class="empty-mini">${keepNote && S.version ? `Testing version ${S.version}. ` : ''}Ask the agent something it will do for you, and check the answer.</p>`;
  }
  function bubble(role, html, cls = '') {
    const t = $('asTranscript'); t.querySelector('.empty-mini')?.remove();
    const d = document.createElement('div'); d.className = `as-msg ${role} ${cls}`; d.innerHTML = html; t.append(d); t.scrollTop = t.scrollHeight; return d;
  }
  function describeResult(r) {
    if (r.execution_mode === 'deterministic_test') {
      const parts = Object.entries(r.output || {}).map(([k, v]) => `${k === 'text.length' ? 'Text length' : k === 'text.keyword_count' ? 'Keyword count' : k}: <b>${h(v)}</b>`);
      return parts.length ? parts.join(' · ') : 'Quick check finished. Turn on a test tool in Advanced settings, or pick an AI model to get real answers.';
    }
    if (r.status === 'COMPLETED' && r.output) return window.renderMarkdown ? window.renderMarkdown(r.output) : h(r.output);
    return h(r.error || r.reason || r.status || 'No answer');
  }
  async function runTest() {
    const text = $('agentInput').value.trim();
    if (!text) { $('agentInput').focus(); throw Error('Type a test request first.'); }
    await ensureSaved();
    const spec = S.saved;
    bubble('user', h(text)); $('agentInput').value = '';
    const pending = bubble('agent', '<span class="agent-pulse"></span> Thinking…', 'pending');
    const t0 = performance.now();
    const endpoint = spec.mode === 'deterministic_test' ? 'test' : 'model-run';
    const remember = spec.mode !== 'deterministic_test' && $('asRemember').checked;
    try {
      const r = await api(`/agents/${S.id}/${endpoint}`, {method: 'POST', body: JSON.stringify({version: S.version, message: text, keyword: $('agentKeyword').value,
        session_id: remember ? sessionId() : null, web_search: spec.mode === 'embedded_local' && $('agentUseWeb').checked})});
      const ok = r.status === 'COMPLETED';
      pending.className = 'as-msg agent' + (ok ? '' : ' error');
      pending.innerHTML = describeResult(r) + `<small class="as-meta">${ok ? 'Passed' : h(r.status)} · ${((performance.now() - t0) / 1000).toFixed(1)}s · v${S.version}</small>`;
      showRaw(r);
      if (ok) await refreshList();
    } catch (e) { pending.className = 'as-msg agent error'; pending.textContent = e.message; throw e; }
  }
  $('agentTest').onclick = () => guard($('agentTest'), runTest);
  $('agentInput').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('agentTest').click(); } });
  $('agentSessionClear').onclick = () => guard($('agentSessionClear'), async () => {
    if (S.id && S.version && S.saved?.mode !== 'deterministic_test') await api(`/agents/${encodeURIComponent(S.id)}/sessions/${sessionId()}?version=${S.version}`, {method: 'DELETE'}).catch(() => {});
    clearTranscript(true);
  });

  // ---------- publish ----------
  const current = () => S.agents.find(a => a.id === S.id);
  async function promote(target) {
    if (!S.id || !S.version) throw Error('Save the agent first.');
    const r = await api(`/agents/${S.id}/promote`, {method: 'POST', body: JSON.stringify({version: S.version, target})});
    S.environment = r.environment; return r;
  }
  async function pendingApproval() {
    const list = await api(`/agents/${S.id}/approvals`);
    return list.find(r => r.version === S.version && r.status === 'PENDING');
  }
  async function publishAll() {
    await ensureSaved();
    const a = current();
    if (!a?.completed_tests) { $('asTest').scrollIntoView({behavior: 'smooth'}); $('agentInput').focus(); throw Error('Run one successful test of this version first.'); }
    if (S.environment === 'production') { toast('This version is already published.'); return; }
    if (!confirm(`Publish "${S.saved.name}" version ${S.version}?\n\nYou are approving it as the operator. Published versions can't be changed; edits create a new version.`)) return;
    if (S.environment === 'draft') await promote('staging');
    let pending = await pendingApproval();
    if (!pending) { const req = await api(`/agents/${S.id}/approvals`, {method: 'POST', body: JSON.stringify({version: S.version, message: ''})}); pending = {id: req.approval_id}; }
    await api(`/approvals/${pending.id}/decision`, {method: 'POST', body: JSON.stringify({decision: 'APPROVED', note: 'Operator approval from Agent Studio'})});
    const r = await promote('production'); showRaw(r);
    await refreshList();
    toast(`Published version ${S.version}. It's ready in Chat.`);
  }
  $('asPublishAll').onclick = () => guard($('asPublishAll'), publishAll);
  $('agentStage').onclick = () => guard($('agentStage'), async () => { await ensureSaved(); showRaw(await promote('staging')); await refreshList(); });
  $('agentPublish').onclick = () => guard($('agentPublish'), async () => { await ensureSaved(); showRaw(await api(`/agents/${S.id}/approvals`, {method: 'POST', body: JSON.stringify({version: S.version, message: ''})})); await refreshList(); });
  $('agentApprove').onclick = () => guard($('agentApprove'), async () => {
    if (!S.id) throw Error('Select an agent first.');
    const p = await pendingApproval(); if (!p) throw Error('No pending approval for this version.');
    showRaw(await api(`/approvals/${p.id}/decision`, {method: 'POST', body: JSON.stringify({decision: 'APPROVED', note: 'Operator approval'})})); await refreshList();
  });
  $('agentFinalize').onclick = () => guard($('agentFinalize'), async () => { showRaw(await promote('production')); await refreshList(); });

  // ---------- use in chat ----------
  $('asUseInChat').onclick = () => guard($('asUseInChat'), async () => {
    await ensureSaved();
    if (window.omniaUseAgent) window.omniaUseAgent(S.id, S.saved.name);
  });

  // ---------- memory & research ----------
  async function refreshMemory() {
    if (!S.id || !S.version) { $('agentMemoryList').innerHTML = '<p class="muted small">Save the agent to add memory.</p>'; return; }
    const entries = await api(`/agents/${S.id}/memory?version=${S.version}`);
    const list = $('agentMemoryList'); list.replaceChildren();
    $('asLearnCount').textContent = entries.length ? `${entries.filter(e => e.status === 'approved').length} approved · ${entries.filter(e => e.status === 'proposed').length} to review` : 'reviewed memory & web research';
    if (!entries.length) { list.innerHTML = '<p class="muted small">No memory yet.</p>'; return; }
    for (const entry of entries) {
      const row = document.createElement('div'); row.className = 'as-memory-entry';
      row.innerHTML = `<span class="badge ${entry.status === 'approved' ? 'ok' : entry.status === 'rejected' ? 'bad' : 'warn'}">${h(entry.status)}</span><p>${h(entry.content)}</p>`;
      const btns = document.createElement('div'); btns.className = 'btn-row';
      const add = (label, fn, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'as-mini ' + cls; b.textContent = label; b.onclick = () => guard(b, fn); btns.append(b); };
      if (entry.status === 'proposed') {
        add('Approve', async () => { await review(entry.id, 'approved'); }, 'primary');
        add('Reject', async () => { await review(entry.id, 'rejected'); });
      }
      add('Delete', async () => { await api(`/agents/${S.id}/memory/${entry.id}?version=${S.version}`, {method: 'DELETE'}); await refreshMemory(); }, 'ghost');
      row.append(btns); list.append(row);
    }
  }
  async function review(memoryId, decision) {
    await api(`/agents/${S.id}/memory/${memoryId}/review`, {method: 'POST', body: JSON.stringify({version: S.version, decision})});
    await refreshMemory(); await refreshList();
  }
  $('agentMemoryPropose').onclick = () => guard($('agentMemoryPropose'), async () => {
    const content = $('agentMemoryText').value.trim(); if (!content) throw Error('Type the fact or correction first.');
    await ensureSaved();
    const m = await api(`/agents/${S.id}/memory`, {method: 'POST', body: JSON.stringify({version: S.version, content, provenance: 'operator_feedback'})});
    // You typed it yourself, so it is approved in the same step; web results still wait for review.
    if (m?.memory_id) await api(`/agents/${S.id}/memory/${m.memory_id}/review`, {method: 'POST', body: JSON.stringify({version: S.version, decision: 'approved'})}).catch(() => {});
    $('agentMemoryText').value = ''; await refreshMemory(); await refreshList();
  });
  $('agentMemoryRefresh').onclick = () => guard($('agentMemoryRefresh'), refreshMemory);
  $('agentResearch').onclick = () => guard($('agentResearch'), async () => {
    const query = $('agentResearchQuery').value.trim(); if (query.length < 2) throw Error('Type what to research.');
    await ensureSaved();
    const result = await api(`/agents/${S.id}/web-research`, {method: 'POST', body: JSON.stringify({version: S.version, query, count: 5})});
    const box = $('agentResearchResults'); box.replaceChildren();
    if (!result.results.length) { box.innerHTML = '<p class="muted small">No results.</p>'; return; }
    result.results.forEach((item, index) => {
      const row = document.createElement('div'); row.className = 'as-memory-entry';
      const link = document.createElement('a'); link.href = item.url; link.textContent = item.title || item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const excerpt = document.createElement('p'); excerpt.textContent = item.excerpt;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'as-mini'; b.textContent = 'Add to memory for review';
      b.onclick = () => guard(b, async () => { await api(`/agents/${S.id}/web-research/memory`, {method: 'POST', body: JSON.stringify({version: S.version, research_id: result.research_id, result_index: index})}); b.textContent = 'Added'; b.disabled = true; await refreshMemory(); });
      row.append(link, excerpt, b); box.append(row);
    });
    showRaw({research_id: result.research_id, retrieved_at: result.retrieved_at, count: result.results.length});
  });

  // ---------- derived UI ----------
  function updateUI() {
    const spec = readSpec(); const isDirty = dirty(); const a = current();
    $('asTitle').textContent = spec.name || 'New agent';
    $('asInstrCount').textContent = spec.instructions.length > 7000 ? `${spec.instructions.length} / 8000` : '';
    $('asDirty').textContent = !S.id ? 'Not saved yet' : isDirty ? 'Unsaved changes' : `Saved · version ${S.version}`;
    $('asDirty').classList.toggle('as-warn', !S.id || isDirty);
    $('agentSave').disabled = S.busy || (!!S.id && !isDirty);
    // test options follow the chosen model
    $('asKeywordWrap').hidden = !(spec.mode === 'deterministic_test' && spec.tools.includes('text.keyword_count'));
    $('asSessionWrap').hidden = spec.mode === 'deterministic_test';
    $('asWebWrap').hidden = spec.mode !== 'embedded_local';
    document.querySelectorAll('#asHandoffs input').forEach(i => { i.disabled = spec.mode !== 'model_response'; });
    // badges + pipeline
    const tested = !!a?.completed_tests && !isDirty;
    const env = isDirty ? 'draft' : S.environment;
    const approved = a?.approval_status === 'APPROVED' || a?.approval_status === 'CONSUMED' || env === 'production';
    const state = {saved: !!S.id && !isDirty, tested, staged: env !== 'draft', approved: approved && !isDirty, published: env === 'production'};
    document.querySelectorAll('#asPipeline li').forEach(li => li.classList.toggle('done', !!state[li.dataset.k]));
    const step = !state.saved ? 'build' : !state.tested ? 'test' : !state.published ? 'publish' : 'use';
    document.querySelectorAll('.as-steps li').forEach(li => { const order = ['build', 'test', 'publish', 'use']; li.className = order.indexOf(li.dataset.step) < order.indexOf(step) ? 'done' : li.dataset.step === step ? 'current' : ''; });
    const pub = $('asPublishAll');
    pub.disabled = S.busy || state.published;
    pub.lastChild.textContent = state.published ? ' Published' : !state.tested ? ' Test, then publish' : ' Publish this version';
    $('asPublishHint').textContent = state.published ? `Version ${S.version} is live. Other agents can call it as a specialist, and Chat uses it.` :
      !S.id ? 'Save the agent first. You can use any saved agent in Chat right away; publishing locks a tested version.' :
      !state.tested ? 'Run one successful test of this version, then publish it in one click.' : 'Ready. Publishing records your operator approval and locks this version.';
    $('agentVersion').textContent = S.id ? `Version ${S.version} · ${env}${a?.published && env !== 'production' ? ` · v${a.active_version} is live` : ''}` : '';
    const badges = [];
    if (a) { const [cls, label] = STATUS(a); badges.push(`<span class="badge ${cls}">${h(label)}</span>`); }
    if (a?.approved_memory) badges.push(`<span class="badge brand">${a.approved_memory} ${a.approved_memory === 1 ? "memory" : "memories"}</span>`);
    $('asBadges').innerHTML = badges.join('');
  }
  ['agentName', 'agentInstructions', 'agentMaxSteps', 'agentMaxModelCalls', 'asModel'].forEach(k => $(k).addEventListener('input', updateUI));
  $('asModel').addEventListener('change', updateUI);
  document.querySelectorAll('.agentTool').forEach(c => c.addEventListener('change', updateUI));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && document.body.dataset.tab === 'agentstudio') { e.preventDefault(); if (!$('agentSave').disabled) $('agentSave').click(); }
  });
  window.addEventListener('beforeunload', e => { if (S.id && dirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- boot ----------
  let booted = false;
  async function boot() {
    await loadModels();
    await refreshList().catch(e => toast(e.message));
    if (!booted) { booted = true; if (!S.id) await load(S.agents[0]?.id || ''); }
    updateUI();
  }
  window.addEventListener('omnia:tab', e => { if (e.detail === 'agentstudio') guard(null, boot); });
  window.omniaAgentStudio = {open: id => { if (window.showTab) window.showTab('agentstudio'); guard(null, async () => { await boot(); if (id) await load(id); }); }};
  selectCategory('general', true); updateUI();
  // Load the list once in the background so the Chat picker is filled without visiting the Studio.
  refreshList().catch(() => {});
})();
