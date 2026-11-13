// Studio "Production principles" panel: renders the rule packs served by GET /api/system/principles.
(() => {
  const el = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[c]));
  const icon = n => `<svg class="i"><use href="#i-${n}"/></svg>`;
  let data = null, voices = null, tab = 'checklist';

  const views = {
    checklist: d => `<p class="muted small">Every finished render is scored against this checklist and saved as <code>principles_report.json</code>. Items code cannot judge are marked for a human look, never auto-passed.</p>` +
      d.social_checklist.map((c, i) => `<div class="cl-row"><b>${i + 1}</b><strong>${esc(c.label)}</strong><span>${esc(c.question)}</span></div>`).join('') +
      `<div class="rule-card"><b>DECISION TEST</b>${d.decision_test.map(esc).join(' ')}</div>`,
    rules: d => `<div class="rule-grid">${d.editing_rules.map((r, i) => {
      const [head, ...rest] = r.split(':');
      return `<div class="rule-card"><b>RULE ${String(i + 1).padStart(2, '0')}</b><strong>${esc(head)}</strong>${rest.length ? `<div>${esc(rest.join(':').trim())}</div>` : ''}</div>`;
    }).join('')}</div>`,
    voice: d => `<div class="two-col"><div><h4>Before synthesis</h4><ol>${d.before_synthesis.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>
      <div><h4>If it is too long</h4><ol>${d.duration_hierarchy.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div></div>
      <h4>Listening rubric (1–5 per dimension)</h4><div class="rubric">${d.voice_rubric.map(r => `<div><strong>${esc(r.label)}</strong><small>${esc(r.question)}</small></div>`).join('')}</div>
      <div class="anchor-row">${Object.entries(d.rating_anchors).map(([k, v]) => `<span class="badge">${esc(k)} · ${esc(v)}</span>`).join('')}</div>
      <div class="rule-card"><b>RELEASE GATE</b>Median ≥ ${esc(d.release_gate.median_minimum)} on every dimension and none of: ${d.release_gate.critical_failures.map(esc).join(', ')}. ${esc(d.release_gate.note)}</div>
      <h4>Repair guide</h4><div class="rule-grid">${d.repair_guide.map(r => `<div class="rule-card"><b>${esc(r.symptom.toUpperCase())}</b>${esc(r.check)}<div class="muted small" style="margin-top:6px">${esc(r.repair)}</div></div>`).join('')}</div>`,
    voices: () => !voices ? '<div class="skeleton">Loading voices…</div>' :
      `<p class="muted small">${esc(voices.note)}</p><div style="overflow-x:auto"><table class="voice-table"><thead><tr><th>Language</th><th>Locale</th><th>Voices</th><th>Availability</th><th>Status</th></tr></thead><tbody>${voices.voices.map(v => {
        const tone = {qualified: 'ok', tested: 'warn', available: 'info'}[v.capability_status] || '';
        return `<tr><td>${esc(v.name)}</td><td><code>${esc(v.locale)}</code></td><td><code>${esc([v.male_voice, v.female_voice].filter(Boolean).join(', ') || 'bundled default')}</code></td><td>${esc(v.availability)}</td><td><span class="badge ${tone}">${esc(v.capability_status)}</span></td></tr>`;
      }).join('')}</tbody></table></div>`,
    glossary: d => `<input class="gloss-search" id="glossSearch" type="search" placeholder="Search terms (J-cut, ducking, safe zone…)" aria-label="Search glossary">` +
      Object.entries(d.vocabulary).map(([cat, terms]) => `<div class="gloss-cat"><h4>${esc(cat)}</h4><div class="gloss-grid">${terms.map(t => `<div data-term="${esc((t.term + ' ' + t.meaning).toLowerCase())}"><strong>${esc(t.term)}</strong>${esc(t.meaning)}</div>`).join('')}</div></div>`).join(''),
  };

  function draw() {
    const body = el('principlesBody'); if (!body) return;
    if (!data) { body.innerHTML = '<div class="skeleton">Principles are unavailable — is the backend running?</div>'; return; }
    body.innerHTML = views[tab](data);
    const search = el('glossSearch');
    if (search) search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      body.querySelectorAll('[data-term]').forEach(n => { n.hidden = q && !n.dataset.term.includes(q); });
    };
  }
  async function load() {
    try {
      const r = await apiFetch('/api/system/principles'); if (!r.ok) throw Error();
      data = await r.json();
      el('principlesMeta').textContent = data.packs.map(p => `${p.title} v${p.version}`).join(' · ');
    } catch { data = null; }
    draw();
  }
  async function loadVoices() {
    try { const r = await apiFetch('/api/system/principles/voices'); voices = r.ok ? await r.json() : null; } catch { voices = null; }
    if (tab === 'voices') draw();
  }
  el('principlesTabs')?.addEventListener('click', e => {
    const b = e.target.closest('[data-ptab]'); if (!b) return;
    tab = b.dataset.ptab; el('principlesTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (tab === 'voices' && !voices) loadVoices();
    draw();
  });
  let loaded = false;
  window.addEventListener('omnia:tab', e => { if (e.detail === 'studios' && !loaded) { loaded = true; load(); } });
})();
