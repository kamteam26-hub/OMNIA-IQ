/* OMNIA IQ Admin Dashboard: overview, users, sessions & sign-ins, audit log, security policy, usage, maintenance. */
(() => {
  const root = document.getElementById('adminConsole'); if (!root) return;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (path, opts = {}) => {
    const r = await window.omniaApiFetch('/api/admin' + path, { headers: { 'Content-Type': 'application/json' }, ...opts }, 60000);
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : 'Request failed'); return d;
  };
  const toast = m => (window.omniaNotify || window.notify || alert)(m);
  const when = t => t ? new Date((typeof t === 'number' ? t * 1000 : t.replace(' ', 'T') + 'Z')).toLocaleString() : '—';
  const size = b => b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round((b || 0) / 1024) + ' KB';
  const style = document.createElement('style');
  style.textContent = `
  .adm-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 18px}.adm-tabs button{padding:8px 14px;border-radius:10px;border:1px solid rgba(148,163,184,.2);background:transparent;color:inherit;cursor:pointer}
  .adm-tabs button.on{background:rgba(124,58,237,.18);border-color:#7c3aed;color:#ddd6fe}
  .adm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:18px}
  .adm-stat{padding:14px;border-radius:14px;border:1px solid rgba(148,163,184,.15);background:rgba(15,23,42,.5)}.adm-stat b{display:block;font-size:24px}.adm-stat small{color:#94a3b8}
  .adm-warn{padding:10px 14px;border-radius:10px;margin-bottom:8px;font-size:14px}.adm-warn.error{background:rgba(239,68,68,.12);color:#fecaca}.adm-warn.warn{background:rgba(245,158,11,.12);color:#fde68a}.adm-warn.info{background:rgba(99,102,241,.12);color:#c7d2fe}
  .adm-table{width:100%;border-collapse:collapse;font-size:13px}.adm-table th,.adm-table td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(148,163,184,.12);vertical-align:top}.adm-table th{color:#94a3b8;font-weight:500}
  .adm-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:rgba(148,163,184,.15)}.adm-pill.admin{background:rgba(124,58,237,.25);color:#ddd6fe}.adm-pill.off{background:rgba(239,68,68,.2);color:#fecaca}.adm-pill.ok{background:rgba(34,197,94,.18);color:#bbf7d0}
  .adm-actions button,.adm-panel button{padding:5px 10px;border-radius:8px;border:1px solid rgba(148,163,184,.25);background:transparent;color:inherit;cursor:pointer;font-size:12px;margin:2px}
  .adm-actions button.danger{border-color:rgba(239,68,68,.5);color:#fca5a5}.adm-panel button.primary{background:#7c3aed;border-color:#7c3aed;color:#fff;padding:8px 14px;font-size:13px}
  .adm-panel{padding:16px;border-radius:14px;border:1px solid rgba(148,163,184,.15);background:rgba(15,23,42,.45);margin-bottom:16px}
  .adm-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;align-items:end}.adm-form label{font-size:12px;color:#94a3b8;display:block;margin-bottom:4px}
  .adm-form input,.adm-form select,.adm-filters input,.adm-filters select{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(148,163,184,.25);background:#0b1220;color:inherit;font:inherit}
  .adm-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.adm-filters>*{flex:1 1 160px}.adm-scroll{overflow:auto}`;
  document.head.appendChild(style);
  const TABS = [['overview', 'Overview'], ['users', 'Users'], ['sessions', 'Sessions & sign-ins'], ['audit', 'Audit log'], ['security', 'Security policy'], ['usage', 'Usage'], ['maintenance', 'Maintenance']];
  let tab = 'overview';
  root.innerHTML = `<div class="section-heading"><div><div class="eyebrow">ADMINISTRATION</div><h2>Admin Dashboard</h2><p>Manage who can use OMNIA IQ, watch activity and keep the system secure.</p></div></div>
    <div class="adm-tabs">${TABS.map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}</div><div id="admBody"></div>`;
  const body = root.querySelector('#admBody');
  root.querySelectorAll('.adm-tabs button').forEach(b => b.onclick = () => { tab = b.dataset.k; render(); });

  async function render() {
    root.querySelectorAll('.adm-tabs button').forEach(b => b.classList.toggle('on', b.dataset.k === tab));
    body.innerHTML = '<p class="muted">Loading…</p>';
    try { await VIEWS[tab](); } catch (e) { body.innerHTML = `<div class="adm-warn error">${esc(e.message)}</div>`; }
  }
  const VIEWS = {
    async overview() {
      const d = await api('/overview'), c = d.counts;
      const stats = [['Users', `${c.active_users}/${c.users}`, 'active / total'], ['Signed in now', c.sessions, 'active sessions'], ['AI requests today', c.ai_today, 'all users'], ['Videos today', c.videos_today, `${c.running_projects} rendering`],
        ['Conversations', c.conversations, 'all users'], ['Projects', c.projects, 'all users'], ['Storage', size(c.storage_bytes), `${c.files} files`], ['Failed sign-ins', c.failed_logins_24h, 'last 24 hours']];
      body.innerHTML = `${d.warnings.map(w => `<div class="adm-warn ${w.level}">${esc(w.text)}</div>`).join('')}
        <div class="adm-grid">${stats.map(([l, v, s]) => `<div class="adm-stat"><small>${l}</small><b>${esc(v)}</b><small>${s}</small></div>`).join('')}</div>
        <div class="adm-panel"><strong>System health</strong><p>Database: <span class="adm-pill ok">${esc(d.health.database)}</span> · Storage: <span class="adm-pill ok">${esc(d.health.storage)}</span> · AI: <span class="adm-pill ${d.health.ai_ready ? 'ok' : 'off'}">${d.health.ai_ready ? 'ready' : 'not connected'}</span></p>
        <p class="muted small">${d.health.providers.length ? esc(d.health.providers.join(' · ')) : 'Add AI provider keys under Settings.'}</p></div>
        <div class="adm-panel"><strong>Recent activity</strong>${auditTable(d.recent)}</div>`;
    },
    async users() {
      const d = await api('/users');
      body.innerHTML = `<div class="adm-panel"><strong>Add a user</strong><p class="muted small">They must choose their own password at first sign-in.</p>
        <form class="adm-form" id="admNewUser"><div><label>Username</label><input name="username" required pattern="[A-Za-z0-9._-]{3,40}"></div><div><label>Name</label><input name="display_name"></div>
        <div><label>Temporary password</label><input name="password" type="text" required minlength="10" autocomplete="off"></div><div><label>Role</label><select name="role"><option value="user">User — workspace only</option><option value="admin">Administrator</option></select></div>
        <div><button class="primary" type="submit">Create user</button></div></form></div>
        <div class="adm-panel adm-scroll"><table class="adm-table"><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Today</th><th>Data</th><th></th></tr>
        ${d.users.map(u => `<tr><td><b>${esc(u.display_name || u.username)}</b><br><small class="muted">${esc(u.username)}</small></td>
          <td><span class="adm-pill ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span></td>
          <td>${u.active ? '<span class="adm-pill ok">active</span>' : '<span class="adm-pill off">disabled</span>'}${u.must_change_password ? ' <span class="adm-pill">temp password</span>' : ''}<br><small class="muted">${u.sessions} session(s)</small></td>
          <td>${when(u.last_login)}</td><td>${u.ai_today} AI · ${u.videos_today} video</td><td>${u.conversations} chats · ${u.projects} projects<br><small class="muted">${size(u.storage_bytes)}</small></td>
          <td class="adm-actions">${u.id === d.me ? '<small class="muted">you</small>' : `
            <button data-a="role" data-id="${u.id}" data-v="${u.role === 'admin' ? 'user' : 'admin'}">${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
            <button data-a="active" data-id="${u.id}" data-v="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>
            <button data-a="reset" data-id="${u.id}" data-n="${esc(u.username)}">Reset password</button>
            <button data-a="revoke" data-id="${u.id}">Sign out everywhere</button>
            <button class="danger" data-a="delete" data-id="${u.id}" data-n="${esc(u.username)}">Delete</button>`}</td></tr>`).join('')}</table></div>`;
      body.querySelector('#admNewUser').onsubmit = async e => { e.preventDefault(); try { await api('/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); toast('User created. Share the temporary password privately.'); render(); } catch (x) { toast(x.message); } };
      body.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => {
        const id = b.dataset.id;
        try {
          if (b.dataset.a === 'role') await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role: b.dataset.v }) });
          if (b.dataset.a === 'active') await api(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ active: b.dataset.v === '1' }) });
          if (b.dataset.a === 'reset') { const pw = prompt(`New temporary password for ${b.dataset.n} (10+ characters, letters and numbers):`); if (!pw) return; await api(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); toast('Password reset. The user must choose a new one at sign-in.'); }
          if (b.dataset.a === 'revoke') { const r = await api(`/users/${id}/revoke-sessions`, { method: 'POST', body: '{}' }); toast(`${r.revoked} session(s) signed out.`); }
          if (b.dataset.a === 'delete') { if (!confirm(`Delete ${b.dataset.n}? Their chats, files and projects move to your account. This cannot be undone.`)) return; await api(`/users/${id}?confirm=true`, { method: 'DELETE' }); toast('User deleted.'); }
          render();
        } catch (x) { toast(x.message); }
      });
    },
    async sessions() {
      const [s, l] = await Promise.all([api('/sessions'), api('/logins')]);
      body.innerHTML = `<div class="adm-panel adm-scroll"><strong>Active sessions</strong><table class="adm-table"><tr><th>User</th><th>Signed in</th><th>Last active</th><th>Expires</th><th>Device</th><th></th></tr>
        ${s.sessions.map(x => `<tr><td>${esc(x.username)}${x.current ? ' <span class="adm-pill ok">this device</span>' : ''}</td><td>${when(x.created_at)}</td><td>${when(x.last_seen)}</td><td>${when(x.expires_at)}</td><td><small>${esc(x.ip)}<br>${esc(x.user_agent.slice(0, 70))}</small></td>
        <td class="adm-actions">${x.current ? '' : `<button class="danger" data-k="${esc(x.key)}">Sign out</button>`}</td></tr>`).join('') || '<tr><td colspan="6">No sessions.</td></tr>'}</table></div>
        <div class="adm-panel adm-scroll"><strong>Sign-in activity</strong><table class="adm-table"><tr><th>Time</th><th>Username</th><th>Result</th><th>IP</th></tr>
        ${l.attempts.map(x => `<tr><td>${when(x.time)}</td><td>${esc(x.username)}</td><td>${x.ok ? '<span class="adm-pill ok">success</span>' : '<span class="adm-pill off">failed</span>'}</td><td>${esc(x.ip)}</td></tr>`).join('') || '<tr><td colspan="4">No sign-ins yet.</td></tr>'}</table></div>`;
      body.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => { try { await api(`/sessions/${encodeURIComponent(b.dataset.k)}`, { method: 'DELETE' }); render(); } catch (x) { toast(x.message); } });
    },
    async audit() {
      const f = VIEWS.audit.f ||= { q: '', user: '', action: '' };
      const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
      const d = await api('/audit' + (qs ? '?' + qs : ''));
      body.innerHTML = `<div class="adm-filters"><input id="afq" placeholder="Search path or detail" value="${esc(f.q)}"><input id="afu" placeholder="Username" value="${esc(f.user)}">
        <select id="afa"><option value="">All actions</option>${d.actions.map(a => `<option ${a === f.action ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
        <button type="button" id="afgo">Filter</button><button type="button" id="afcsv">Export CSV</button></div><div class="adm-panel adm-scroll">${auditTable(d.entries)}</div>`;
      body.querySelector('#afgo').onclick = () => { Object.assign(f, { q: body.querySelector('#afq').value.trim(), user: body.querySelector('#afu').value.trim(), action: body.querySelector('#afa').value }); render(); };
      body.querySelector('#afcsv').onclick = async () => { const r = await window.omniaApiFetch('/api/admin/audit/export' + (qs ? '?' + qs : ''), {}, 60000); const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = 'omnia-audit.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); };
    },
    async security() {
      const d = await api('/security'), p = d.policy;
      const F = [['session_hours', 'Session length (hours)'], ['idle_minutes', 'Sign out after idle (minutes)'], ['lockout_attempts', 'Failed sign-ins before lockout'], ['lockout_minutes', 'Lockout duration (minutes)'], ['min_password_length', 'Minimum password length'], ['rate_per_minute', 'Requests per user per minute'], ['ai_per_day', 'AI requests per user per day'], ['videos_per_day', 'Video builds per user per day'], ['storage_mb_per_user', 'Storage per user (MB)'], ['audit_days', 'Keep audit log (days)']];
      body.innerHTML = `<div class="adm-panel"><strong>Security & limits</strong><p class="muted small">Limits apply to users; administrators are not limited. Changes apply immediately.</p>
        <form class="adm-form" id="admPolicy">${F.map(([k, l]) => `<div><label>${l}</label><input type="number" name="${k}" value="${p[k]}"></div>`).join('')}<div><button class="primary" type="submit">Save policy</button></div></form></div>
        <div class="adm-panel"><strong>Built-in protections</strong><ul class="muted small">
        <li>Passwords are hashed with scrypt; sessions are signed, HttpOnly cookies that can be revoked at any time.</li>
        <li>Each user only sees their own chats, files, memory and projects.</li><li>Settings, Agent Studio, Automation and Publishing are administrator-only.</li>
        <li>Every change, failed sign-in and blocked request is written to the audit log.</li><li>API keys are encrypted at rest and never sent back to the browser.</li>
        <li>Setup key (OMNIA_ACCESS_KEY): ${d.setup_key_configured ? 'configured — keep it private; it is only needed for first-time setup' : 'not set'}.</li></ul></div>`;
      body.querySelector('#admPolicy').onsubmit = async e => { e.preventDefault(); try { await api('/security', { method: 'PUT', body: JSON.stringify(Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]))) }); toast('Security policy saved.'); render(); } catch (x) { toast(x.message); } };
    },
    async usage() {
      const d = await api('/usage'), by = {};
      for (const r of d.days) { const k = r.username || ('#' + r.user_id); (by[k] ||= {})[r.day] ||= { ai: 0, video: 0 }; by[k][r.day][r.kind] = r.n; }
      const days = [...new Set(d.days.map(r => r.day))].sort().reverse();
      body.innerHTML = `<div class="adm-panel adm-scroll"><strong>Usage (last 14 days)</strong><p class="muted small">Daily limits per user: ${d.policy.ai_per_day} AI requests · ${d.policy.videos_per_day} video builds.</p>
        <table class="adm-table"><tr><th>User</th>${days.map(x => `<th>${x.slice(5)}</th>`).join('')}</tr>${Object.entries(by).map(([u, row]) => `<tr><td>${esc(u)}</td>${days.map(x => `<td>${row[x] ? `${row[x].ai} AI${row[x].video ? ` · ${row[x].video} 🎬` : ''}` : '—'}</td>`).join('')}</tr>`).join('') || '<tr><td>No usage yet.</td></tr>'}</table></div>`;
    },
    async maintenance() {
      body.innerHTML = `<div class="adm-panel"><strong>Clean up</strong><p class="muted small">Removes audit entries older than the policy, old sign-in attempts, ended sessions, old agent runs and old automation events. Your users' work is never touched.</p><button class="primary" id="admClean">Run clean-up</button><div id="admCleanOut" class="muted small"></div></div>
        <div class="adm-panel"><strong>Backups</strong><p class="muted small">Create and list database backups under Settings → Backups.</p><button id="admGoSettings">Open Settings</button></div>`;
      body.querySelector('#admClean').onclick = async () => { try { const r = await api('/maintenance', { method: 'POST', body: '{}' }); body.querySelector('#admCleanOut').textContent = 'Removed: ' + Object.entries(r.removed).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · '); } catch (x) { toast(x.message); } };
      body.querySelector('#admGoSettings').onclick = () => showTab('settings');
    },
  };
  function auditTable(rows) {
    return `<table class="adm-table"><tr><th>Time</th><th>User</th><th>Action</th><th>Request</th><th>Detail</th></tr>${rows.map(r => `<tr><td>${when(r.time)}</td><td>${esc(r.username || '—')}</td><td><span class="adm-pill ${/fail|forbid|lock/.test(r.action) ? 'off' : ''}">${esc(r.action)}</span></td><td><small>${esc(r.method)} ${esc(r.path)}${r.status ? ' · ' + r.status : ''}</small></td><td><small>${esc(r.detail)}${r.ip ? ' · ' + esc(r.ip) : ''}</small></td></tr>`).join('') || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table>`;
  }
  window.addEventListener('omnia:tab', e => { if (e.detail === 'admin') render(); });
  if (document.getElementById('admin')?.classList.contains('active')) render();
})();
