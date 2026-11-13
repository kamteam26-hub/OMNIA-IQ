/* Settings → Ollama models: installed models with capabilities, free agentic catalog, pull/remove. */
(() => {
  const $ = s => document.querySelector(s);
  if (!$('#ollamaLibrary')) return;
  let timer = null;
  const CAP = {tools: 'tools', vision: 'vision', thinking: 'thinking'};
  const badges = caps => (caps || []).filter(c => CAP[c]).map(c => `<span class="cap cap-${c}">${c}</span>`).join('');
  const gb = b => b ? (b / 1e9).toFixed(1) + ' GB' : '';

  function render(d) {
    $('#ollamaSummary').innerHTML = d.running
      ? `Ollama ${esc(d.version)} at <code>${esc(d.base_url)}</code> · ${d.models.length} model${d.models.length === 1 ? '' : 's'} installed · ${d.models.filter(m => (m.capabilities || []).includes('tools')).length} agent-ready (tools)`
      : `Ollama is not running at <code>${esc(d.base_url)}</code>. <a href="https://ollama.com/download" target="_blank" rel="noopener">Install Ollama</a>, start it, then Refresh.`;
    $('#ollamaInstalled').innerHTML = d.models.length ? d.models.map(m => `<div class="ollama-card ${d.loaded.includes(m.name) ? 'loaded' : ''}">
        <div><strong>${esc(m.name)}</strong><small>${esc([m.parameters, m.quantization, m.remote ? 'cloud' : gb(m.bytes)].filter(Boolean).join(' · '))}${d.loaded.includes(m.name) ? ' · in memory' : ''}</small><div class="caps">${badges(m.capabilities)}</div></div>
        <button type="button" class="ghost" data-remove="${esc(m.name)}" title="Remove from Ollama">Remove</button></div>`).join('')
      : `<p class="muted small">${d.running ? 'No models yet — add one below.' : 'Start Ollama to see installed models.'}</p>`;
    $('#ollamaCatalog').innerHTML = d.catalog.map(c => {
      const pull = d.pulls[c.tag];
      const busy = pull && !pull.done;
      const action = c.installed ? '<span class="ok-tag">Installed</span>'
        : busy ? `<div class="pull-bar"><i style="width:${pull.percent || 0}%"></i></div><small>${esc(pull.status)} ${pull.percent ? pull.percent + '%' : ''}</small>`
        : `<button type="button" class="primary" data-pull="${esc(c.tag)}">${c.cloud ? 'Add' : 'Download'}</button>${pull?.error ? `<small class="err">${esc(pull.error)}</small>` : ''}`;
      return `<div class="ollama-card ${c.recommended ? 'rec' : ''}"><div><strong>${esc(c.tag)}${c.recommended ? ' <em>recommended</em>' : ''}</strong><small>${esc(c.best_for)}</small><small>${c.cloud ? 'Runs on Ollama Cloud' : `≈${esc(c.size)} · needs ~${esc(c.ram)} RAM`}</small><div class="caps">${badges(c.caps)}${c.cloud ? '<span class="cap cap-cloud">cloud</span>' : ''}</div></div><div class="ollama-act">${action}</div></div>`;
    }).join('');
    const custom = Object.values(d.pulls).filter(p => !d.catalog.some(c => c.tag === p.tag));
    if (custom.length) $('#ollamaCatalog').insertAdjacentHTML('beforeend', custom.map(p => `<div class="ollama-card"><div><strong>${esc(p.tag)}</strong><small>${esc(p.error || p.status)}</small></div><div class="ollama-act">${p.done ? (p.error ? '' : '<span class="ok-tag">Installed</span>') : `<div class="pull-bar"><i style="width:${p.percent || 0}%"></i></div>`}</div></div>`).join(''));
    document.querySelectorAll('#ollamaLibrary [data-pull]').forEach(b => b.onclick = () => pull(b.dataset.pull, b));
    document.querySelectorAll('#ollamaLibrary [data-remove]').forEach(b => b.onclick = () => remove(b.dataset.remove));
    const active = Object.values(d.pulls).some(p => !p.done);
    clearTimeout(timer); if (active) timer = setTimeout(load, 1500);
    if (!active && window.omniaReloadAgentModels) window.omniaReloadAgentModels();
  }
  async function load() {
    try { const r = await apiFetch('/api/assistant/ollama', {}, 20000); render(await r.json()); }
    catch (e) { $('#ollamaSummary').textContent = e.message; }
  }
  async function post(path, tag) {
    const r = await apiFetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tag})}, 30000);
    const d = await r.json(); if (!r.ok) throw Error(d.detail || 'Request failed'); return d;
  }
  async function pull(tag, button) {
    if (button) { button.disabled = true; button.textContent = 'Starting…'; }
    try { await post('/api/assistant/ollama/pull', tag); notify(`Downloading ${tag}. You can keep working.`); } catch (e) { notify(e.message); }
    load();
  }
  async function remove(tag) {
    if (!confirm(`Remove ${tag} from Ollama? You can download it again later.`)) return;
    try { await post('/api/assistant/ollama/remove', tag); notify(`${tag} removed.`); } catch (e) { notify(e.message); }
    load();
  }
  $('#ollamaCustom').onsubmit = e => { e.preventDefault(); const t = $('#ollamaTag').value.trim(); if (t) { pull(t); $('#ollamaTag').value = ''; } };
  $('#ollamaRefresh').onclick = load;
  window.addEventListener('omnia:tab', e => { if (e.detail === 'settings') load(); });
})();
