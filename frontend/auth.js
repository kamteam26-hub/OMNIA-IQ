/* OMNIA IQ sign-in, first-run admin setup and admin/user dashboard separation.
   Runs before every other script: nothing loads until the visitor is signed in. */
(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ADMIN_PATH = location.pathname.replace(/\/+$/, '') === '/admin';
  const css = document.createElement('style');
  css.textContent = `
  .auth-screen{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#1b1440,#070b16 60%);padding:20px;font-family:inherit}
  .auth-card{width:min(420px,100%);background:rgba(17,24,39,.92);border:1px solid rgba(148,163,184,.18);border-radius:18px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.5);color:#e5e7eb}
  .auth-card h1{margin:0 0 4px;font-size:22px}.auth-card p{margin:0 0 18px;color:#94a3b8;font-size:14px;line-height:1.5}
  .auth-card label{display:block;font-size:13px;color:#cbd5e1;margin:12px 0 6px}
  .auth-card input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid rgba(148,163,184,.25);background:#0b1220;color:#f8fafc;font:inherit}
  .auth-card button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#6366f1);color:#fff;font-weight:600;font:inherit;cursor:pointer}
  .auth-card button:disabled{opacity:.6}.auth-err{color:#f87171;font-size:13px;margin-top:12px;min-height:18px}
  .auth-logo{width:44px;height:44px;margin-bottom:12px}
  body[data-mode="user"] [data-mode="admin"],body[data-mode="admin"] [data-mode="user"]{display:none!important}
  body[data-mode="admin"] #newChat,body[data-mode="admin"] #conversationSearch,body[data-mode="admin"] #conversationList,body[data-mode="admin"] .header-toggle-group{display:none!important}
  .account-box{margin:10px 12px;padding:10px 12px;border:1px solid rgba(148,163,184,.15);border-radius:12px;font-size:13px;color:#cbd5e1}
  .account-box strong{display:block;color:#f8fafc}.account-box small{color:#94a3b8}
  .account-box .acct-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .account-box a,.account-box button{font-size:12px;padding:5px 9px;border-radius:8px;border:1px solid rgba(148,163,184,.25);background:transparent;color:#e5e7eb;cursor:pointer;text-decoration:none}
  .account-box .mode-switch{border-color:#7c3aed;color:#c4b5fd}`;
  document.head.appendChild(css);

  function screen(html, onSubmit) {
    document.querySelector('.auth-screen')?.remove();
    const el = document.createElement('div'); el.className = 'auth-screen';
    el.innerHTML = `<form class="auth-card"><svg class="auth-logo" viewBox="0 0 64 64"><use href="#i-logo"/></svg>${html}<button type="submit">Continue</button><div class="auth-err" role="alert"></div></form>`;
    document.body.appendChild(el);
    const form = el.querySelector('form'), err = el.querySelector('.auth-err'), btn = el.querySelector('button');
    form.onsubmit = async e => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try { await onSubmit(Object.fromEntries(new FormData(form))); } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    };
    form.querySelector('input')?.focus();
  }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : 'Request failed'); return d;
  }
  const setupScreen = keyConfigured => screen(`<h1>Set up OMNIA IQ</h1><p>Create the administrator account. ${keyConfigured ? 'Enter the setup key you saved as OMNIA_ACCESS_KEY in Vercel.' : '<b>First add OMNIA_ACCESS_KEY (a private setup key) in Vercel → Settings → Environment Variables and redeploy.</b>'}</p>
      <label>Setup key</label><input name="setup_key" type="password" autocomplete="off" required>
      <label>Admin username</label><input name="username" autocomplete="username" required pattern="[A-Za-z0-9._-]{3,40}">
      <label>Your name</label><input name="display_name" autocomplete="name">
      <label>Password (10+ characters, letters and numbers)</label><input name="password" type="password" autocomplete="new-password" required minlength="10">`,
    async v => { await post('/api/auth/setup', v); location.href = '/admin'; });
  const loginScreen = () => screen(`<h1>Sign in to OMNIA IQ</h1><p>Use the account your administrator gave you.</p>
      <label>Username</label><input name="username" autocomplete="username" required>
      <label>Password</label><input name="password" type="password" autocomplete="current-password" required>`,
    async v => { const d = await post('/api/auth/login', v); location.href = d.user.role === 'admin' && ADMIN_PATH ? '/admin' : '/'; });
  const passwordScreen = () => screen(`<h1>Choose a new password</h1><p>Your administrator set a temporary password. Choose your own to continue.</p>
      <label>Current (temporary) password</label><input name="current_password" type="password" autocomplete="current-password" required>
      <label>New password (10+ characters, letters and numbers)</label><input name="new_password" type="password" autocomplete="new-password" required minlength="10">`,
    async v => { await post('/api/auth/password', v); location.reload(); });

  window.omniaSessionExpired = () => { if (!document.querySelector('.auth-screen')) loginScreen(); };
  window.omniaChangePassword = () => screen(`<h1>Change password</h1><p>All your other signed-in devices will be signed out.</p>
      <label>Current password</label><input name="current_password" type="password" autocomplete="current-password" required>
      <label>New password</label><input name="new_password" type="password" autocomplete="new-password" required minlength="10">`,
    async v => { await post('/api/auth/password', v); document.querySelector('.auth-screen')?.remove(); window.omniaNotify?.('Password changed.'); });

  function loadScripts(list) {
    list.forEach((src, i) => { const s = document.createElement('script'); s.src = `/static/${src}?v=88.5.1`; s.async = false; if (i === list.length - 1) s.onload = () => window.dispatchEvent(new Event('omnia:ready')); document.body.appendChild(s); });
  }
  function applyMode(user) {
    const mode = ADMIN_PATH && user.role === 'admin' ? 'admin' : 'user';
    document.body.dataset.mode = mode; document.body.dataset.role = user.role;
    window.OMNIA_USER = user;
    const box = document.getElementById('accountBox');
    if (box) {
      box.hidden = false;
      box.innerHTML = `<strong>${esc(user.display_name || user.username)}</strong><small>${user.role === 'admin' ? 'Administrator' : 'User'} · ${esc(user.username)}</small>
        <div class="acct-actions">${user.role === 'admin' ? (mode === 'admin' ? '<a class="mode-switch" href="/">Open workspace</a>' : '<a class="mode-switch" href="/admin">Admin dashboard</a>') : ''}
        <button type="button" data-act="pw">Password</button><button type="button" data-act="out">Sign out</button></div>`;
      box.querySelector('[data-act="pw"]').onclick = () => window.omniaChangePassword();
      box.querySelector('[data-act="out"]').onclick = async () => { await post('/api/auth/logout', {}).catch(() => {}); location.href = '/'; };
    }
    // Start on the right page for this dashboard once the app has loaded.
    window.addEventListener('omnia:ready', () => setTimeout(() => {
      const first = mode === 'admin' ? 'admin' : 'chat';
      if (typeof showTab === 'function') { const active = document.querySelector('nav [data-tab].active'); if (!active || active.dataset.mode !== mode) showTab(first); }
    }, 0));
  }

  (async () => {
    let d;
    try { d = await (await fetch('/api/system/auth-status', { cache: 'no-store', credentials: 'same-origin' })).json(); }
    catch { document.body.insertAdjacentHTML('beforeend', '<div class="auth-screen"><div class="auth-card"><h1>OMNIA IQ is unreachable</h1><p>Check your connection and reload.</p></div></div>'); return; }
    const a = d.auth || {};
    if (a.setup_required) return setupScreen(a.setup_key_configured);
    if (!a.user) return loginScreen();
    if (a.user.must_change_password) return passwordScreen();
    if (ADMIN_PATH && a.user.role !== 'admin') { location.replace('/'); return; }
    applyMode(a.user);
    loadScripts((window.OMNIA_SCRIPTS || []).filter(s => a.user.role === 'admin' || !['publishing.js', 'agent_studio.js', 'automation.js', 'admin.js'].includes(s)));
  })();
})();
