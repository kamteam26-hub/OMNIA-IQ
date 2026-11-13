(() => {
  const el = id => document.getElementById(id);
  const icon = name => `<svg class="i"><use href="#i-${name}"/></svg>`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[c]));
  let latest = null, preflight = null, busy = false, chosenPath = null;

  // ---------------------------------------------------------------- state → pipeline
  const STATE_UI = {
    DRAFT: ['CONFIGURED', ''], BUILDING: ['BUILDING', 'warn'], READY: ['RELEASE READY', ''], VALIDATING: ['VALIDATING', 'warn'],
    DEPLOYING: ['DEPLOYING', 'warn'], VERIFYING: ['VERIFYING', 'warn'], LOCAL_READY: ['RUNNING LOCALLY', 'ok'], LAN_READY: ['RUNNING ON LAN', 'ok'],
    PENDING_VERIFICATION: ['PENDING VERIFICATION', 'warn'], LIVE: ['LIVE', 'live'], DEGRADED: ['DEGRADED', 'bad'], FAILED: ['FAILED', 'bad'],
    STOPPED: ['STOPPED', ''], PUBLIC_STOPPED: ['PUBLIC ACCESS STOPPED', ''],
  };
  function stepStatus(s) {
    const steps = {configure: 'todo', runtime: 'todo', dns: 'todo', https: 'todo', verify: 'todo', live: 'todo'};
    if (!s) { steps.configure = 'now'; return steps; }
    const pub = s.mode === 'public';
    steps.configure = 'done';
    const runtimeOk = s.healthy || ['LOCAL_READY', 'LAN_READY', 'PENDING_VERIFICATION', 'LIVE'].includes(s.state);
    steps.runtime = runtimeOk ? 'done' : (s.state === 'FAILED' ? 'blocked' : 'now');
    if (!pub) {
      steps.dns = steps.https = 'skip';
      steps.verify = s.state === 'LOCAL_READY' || s.state === 'LAN_READY' ? 'done' : (runtimeOk ? 'now' : 'todo');
      steps.live = steps.verify === 'done' ? 'done' : 'todo';
      return steps;
    }
    const checks = s.checks || {};
    const dnsOk = !!s.dns_change || Array.isArray(checks.dns_local_resolver);
    steps.dns = dnsOk ? 'done' : (runtimeOk ? 'now' : 'todo');
    steps.https = s.proxy_running || checks.https_release === true ? 'done' : (dnsOk ? 'now' : 'todo');
    steps.verify = checks.https_release === true ? 'done' : (steps.https === 'done' ? 'now' : 'todo');
    steps.live = s.state === 'LIVE' ? 'done' : s.state === 'DEGRADED' ? 'blocked' : (steps.verify === 'done' ? 'now' : 'todo');
    return steps;
  }
  function render(s) {
    latest = s;
    const [label, tone] = s ? (STATE_UI[s.state] || [s.state, '']) : ['NOT CONFIGURED', ''];
    const pill = el('launchStatePill'); pill.textContent = label; pill.className = 'state-pill ' + tone;
    const steps = stepStatus(s);
    el('launchPipeline').querySelectorAll('li').forEach(li => { li.className = steps[li.dataset.step] || ''; });
    document.querySelectorAll('[data-step-panel]').forEach(p => {
      const st = steps[p.dataset.stepPanel];
      p.classList.toggle('is-done', st === 'done'); p.classList.toggle('is-skipped', st === 'skip');
    });
    renderChecks(s); renderDnsRecipe();
    el('hostHealth').textContent = !s ? 'Not configured' : s.healthy ? 'Healthy' : s.running ? 'Needs attention' : 'Offline';
    el('hostAccess').textContent = s?.mode === 'public' ? 'Public domain' : s?.mode === 'lan' ? 'Local network' : 'Private';
    el('hostHttps').textContent = s?.checks?.https_release === true ? 'Verified' : s?.proxy_running ? 'Proxy running' : 'Not verified';
    el('hostRelease').textContent = s?.release_id ? (s.target === 'omnia' ? 'OMNIA runtime' : String(s.release_id).slice(0, 9)) : 'None';
    if (s) {
      const {log, proxy_log, ...rest} = s;
      el('launchStatus').textContent = JSON.stringify(rest, null, 2) + (log ? '\n\n--- server.log ---\n' + log : '') + (proxy_log ? '\n\n--- proxy.log ---\n' + proxy_log : '');
    }
  }
  const CHECK_LABELS = {
    origin: 'Origin health', https_release: 'HTTPS serves this release', frontend: 'Interface loads', assets: 'Static assets',
    api_protected: 'API requires access key', launch_control_blocked: 'Launch controls blocked publicly',
    dns_local_resolver: 'DNS (this computer)', dns_cloudflare: 'DNS (Cloudflare 1.1.1.1)', dns_google: 'DNS (Google 8.8.8.8)',
    external_network_verification: 'Outside-network check',
  };
  function renderChecks(s) {
    const box = el('launchChecks'); box.innerHTML = '';
    const checks = (s && s.checks) || {};
    for (const [key, value] of Object.entries(checks)) {
      let tone = 'info', detail = '';
      if (value === true) tone = 'ok';
      else if (value === false) { tone = 'fail'; detail = 'Failed'; }
      else if (Array.isArray(value)) { tone = 'ok'; detail = value.join(', '); }
      else if (value && typeof value === 'object') {
        tone = value.error ? 'fail' : value.matches_expected === false ? 'fail' : 'ok';
        detail = value.error || (value.answers || []).join(', ') || 'No answer';
      } else detail = String(value);
      box.insertAdjacentHTML('beforeend', `<div class="check-tile ${tone}">${icon(tone === 'ok' ? 'check' : tone === 'fail' ? 'x' : 'info')}<div><strong>${esc(CHECK_LABELS[key] || key)}</strong><small>${esc(detail)}</small></div></div>`);
    }
  }
  function renderDnsRecipe() {
    const domain = el('launchDomain').value.trim(), ip = preflight?.public_ip || '';
    const box = el('launchDnsRecipe');
    if (!domain) { box.innerHTML = 'Set a domain hostname in step 1 to get the exact DNS record to create.'; return; }
    if (chosenPath === 'tunnel') {
      box.innerHTML = `With Cloudflare Tunnel you don't create an A record: <code>cloudflared tunnel route dns &lt;tunnel-name&gt; ${esc(domain)}</code> creates the CNAME for you.`;
      return;
    }
    box.innerHTML = `Create this record at your DNS provider (or apply it below via Cloudflare):<table><tr><th>Type</th><th>Name</th><th>Value</th><th>TTL</th><th>Proxy</th></tr><tr><td>A</td><td>${esc(domain)}</td><td>${esc(ip || '<your public IP>')}</td><td>300</td><td>DNS only</td></tr></table>`;
  }

  // ---------------------------------------------------------------- preflight → readiness + paths
  async function runPreflight(network = false) {
    const list = el('launchPreflight');
    list.innerHTML = `<li class="skeleton">${network ? 'Detecting public IP and re-checking…' : 'Running preflight…'}</li>`;
    try {
      const r = await apiFetch('/api/launch/' + project() + '/preflight' + (network ? '?network=true' : ''));
      const d = await r.json(); if (!r.ok) throw Error(d.detail || 'Preflight failed');
      preflight = d;
      const ACTIONS = {install_caddy: 'Install Caddy', generate_key: 'Generate access key'};
      list.innerHTML = d.items.map(i => `<li class="${i.status}">${icon({ok: 'check', warn: 'alert', fail: 'x', info: 'info'}[i.status])}<div><strong>${esc(i.label)}</strong><small>${esc(i.detail)}</small>${i.fix ? `<div class="fix">${esc(i.fix)}</div>` : ''}</div>${ACTIONS[i.action] ? `<button type="button" class="ghost fix-action" data-fix="${esc(i.action)}">${esc(ACTIONS[i.action])}</button>` : ''}</li>`).join('');
      list.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => fixAction(b.dataset.fix, b));
      if (!el('goLiveDomain').value && latest?.domain) el('goLiveDomain').value = latest.domain;
      el('launchPreflightSummary').textContent = d.public_ready
        ? 'This computer can publish OMNIA over HTTPS right now.'
        : d.local_ready ? `Private use works now. Public launch still needs: ${d.public_blockers.join(', ') || 'a domain'}.` : 'Start OMNIA on its origin port, then re-check.';
      if (d.public_ip && !el('launchTarget').value) el('launchTarget').placeholder = d.public_ip;
      markPaths(d);
      renderDnsRecipe();
    } catch (e) {
      list.innerHTML = `<li class="fail">${icon('x')}<div><strong>Preflight unavailable</strong><small>${esc(e.message)}</small></div></li>`;
    }
  }
  function markPaths(d) {
    document.querySelectorAll('.path-card').forEach(c => {
      const b = c.querySelector('.path-badge'); const p = c.dataset.path;
      const ok = p === 'local' ? d.local_ready : p === 'public' ? d.public_ready : !!d.tunnel_command;
      b.textContent = p === d.recommended_path ? 'Recommended' : ok ? 'Available' : 'Needs setup';
      b.className = 'path-badge' + (p === d.recommended_path ? ' rec' : '');
    });
    if (!chosenPath) choosePath(latest ? (latest.mode === 'public' ? 'public' : 'local') : d.recommended_path, false);
  }
  function choosePath(path, apply = true) {
    chosenPath = path;
    document.querySelectorAll('.path-card').forEach(c => c.setAttribute('aria-checked', String(c.dataset.path === path)));
    if (apply) {
      if (path !== 'local') el('launchManual').open = true;
      el('launchMode').value = path === 'local' ? 'local' : 'public';
      el('launchBind').value = '127.0.0.1';
      if (path !== 'local') el('launchDomain').focus();
    }
    const guide = el('launchTunnelGuide');
    guide.hidden = path !== 'tunnel';
    if (path === 'tunnel') {
      const port = preflight?.tunnel_port || 8081;
      guide.innerHTML = `<strong>Cloudflare Tunnel (no router changes)</strong><ol>
        <li>Install <code>cloudflared</code> and Caddy, add your domain to a free Cloudflare account, and set <code>OMNIA_ACCESS_KEY</code>.</li>
        <li>Save the configuration with Public mode, then <a href="#" id="launchTunnelCaddy">download the tunnel Caddyfile</a> and run <code>caddy run --config Caddyfile.tunnel --adapter caddyfile</code>.</li>
        <li><code>cloudflared tunnel login</code> → <code>cloudflared tunnel create omnia</code> → <code>cloudflared tunnel route dns omnia ${esc(el('launchDomain').value || 'app.example.com')}</code></li>
        <li><code>cloudflared tunnel run --url http://127.0.0.1:${port} omnia</code>, then Run verification below.</li></ol>`;
      el('launchTunnelCaddy').onclick = ev => { ev.preventDefault(); downloadCaddy('tunnel'); };
    }
    document.querySelector('[data-step-panel="https"]').classList.toggle('is-skipped', path === 'tunnel' || path === 'local');
    document.querySelector('[data-step-panel="dns"]').classList.toggle('is-skipped', path === 'local');
    renderDnsRecipe();
  }
  document.querySelectorAll('.path-card').forEach(c => c.addEventListener('click', () => choosePath(c.dataset.path)));

  // ---------------------------------------------------------------- target-specific copy
  function targetUI() {
    const omnia = el('launchTargetApp').value === 'omnia';
    el('launchStaticRelease').hidden = omnia; el('launchRollback').hidden = omnia; el('launchAppNote').hidden = !omnia;
    el('launchStart').textContent = omnia ? 'Validate OMNIA runtime' : 'Start web server';
    el('launchStop').textContent = omnia ? 'Stop public access' : 'Stop web server';
    el('launchMode').querySelector('[value="lan"]').disabled = omnia;
  }
  el('launchTargetApp').onchange = () => { el('launchPort').value = el('launchTargetApp').value === 'omnia' ? '8000' : '8088'; targetUI(); };
  targetUI();

  // ---------------------------------------------------------------- API
  const project = () => encodeURIComponent(el('launchProject').value.trim());
  const token = () => crypto.randomUUID();
  async function call(path = '', options = {}, quiet = false) {
    if (busy) return;
    busy = true;
    const buttons = [...document.querySelectorAll('#launch button')]; buttons.forEach(b => { b.disabled = true; });
    try {
      const r = await apiFetch('/api/launch/' + project() + path, options);
      const value = await r.json();
      if (!r.ok) throw Error(value.detail || 'Launch request failed');
      render(value); return value;
    } catch (e) {
      if (!quiet) { el('launchStatus').textContent = e.message; notify(e.message); }
      if (/Save project configuration first/.test(e.message)) render(null);
    } finally { busy = false; buttons.forEach(b => { b.disabled = false; }); targetUI(); }
  }
  const post = (path, body) => call(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  function fill(s) {
    for (const [id, key] of [['launchTargetApp', 'target'], ['launchMode', 'mode'], ['launchEnv', 'env'], ['launchBind', 'bind'], ['launchPort', 'port'], ['launchDomain', 'domain'], ['launchZone', 'zone_id'], ['launchRegistrar', 'registrar'], ['launchEmail', 'email']]) el(id).value = s[key] || '';
    if (s.domain) el('goLiveDomain').value = s.domain;
    if (s.email) el('goLiveEmail').value = s.email;
    targetUI();
  }
  async function load(quiet = true) { const s = await call('', {}, quiet); if (s) fill(s); await runPreflight(false); }

  el('launchConfig').onsubmit = async e => {
    e.preventDefault();
    const s = await call('', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({target: el('launchTargetApp').value, mode: el('launchMode').value, env: el('launchEnv').value, bind: el('launchBind').value, port: Number(el('launchPort').value), domain: el('launchDomain').value, zone_id: el('launchZone').value, registrar: el('launchRegistrar').value, email: el('launchEmail').value})});
    if (s) { notify('Configuration saved.'); runPreflight(false); }
  };
  el('launchRefresh').onclick = () => load(false);
  el('launchRecheck').onclick = () => runPreflight(false);
  el('launchDetectIp').onclick = () => runPreflight(true);
  el('launchUseIp').onclick = () => {
    if (preflight?.public_ip) { el('launchTarget').value = preflight.public_ip; el('launchRecord').value = preflight.public_ip.includes(':') ? 'AAAA' : 'A'; }
    else notify('Click "Detect public IP" first.');
  };
  el('launchDomain').addEventListener('input', renderDnsRecipe);
  el('launchUpload').onsubmit = e => { e.preventDefault(); const f = new FormData(); f.append('file', el('launchZip').files[0]); f.append('token', token()); call('/release', {method: 'POST', body: f}); };
  document.querySelectorAll('[data-launch-action]').forEach(b => b.onclick = async () => { await post('/' + b.dataset.launchAction, {token: token()}); if (['start', 'proxy-start', 'verify'].includes(b.dataset.launchAction)) runPreflight(false); });
  el('launchAttest').onsubmit = e => { e.preventDefault(); post('/attest', {token: token(), note: el('launchAttestNote').value}); };
  el('launchDNS').onsubmit = e => { e.preventDefault(); post('/dns/apply', {token: token(), name: el('launchDomain').value, type: el('launchRecord').value, content: el('launchTarget').value}); };
  el('launchOpen').onclick = async () => { const s = await call(); if (s?.healthy) window.open(s.local_url, '_blank', 'noopener'); else notify('The server has not passed its health check yet.'); };
  async function downloadCaddy(variant = 'direct') {
    try {
      const r = await apiFetch('/api/launch/' + project() + '/proxy/caddy' + (variant === 'tunnel' ? '?variant=tunnel' : ''));
      if (!r.ok) throw Error('Save a configuration with a domain first');
      const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a');
      a.href = url; a.download = variant === 'tunnel' ? 'Caddyfile.tunnel' : 'Caddyfile'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { notify(e.message); }
  }
  el('launchCaddy').onclick = () => downloadCaddy('direct');

  async function refreshBackups() {
    const box = el('hostBackupList');
    try {
      const r = await apiFetch('/api/launch/' + project() + '/config-backups');
      const data = await r.json();
      if (!r.ok) throw Error(data.detail || 'Unable to list backups');
      box.replaceChildren();
      const records = Array.isArray(data) ? data : data.backups || [];
      const initial = document.createElement('option'); initial.value = ''; initial.textContent = records.length ? 'Choose a snapshot' : 'No snapshots available'; box.append(initial);
      records.forEach(b => { const option = document.createElement('option'); option.value = b.id; option.textContent = new Date(b.created_at * 1000).toLocaleString() + ' · ' + b.id.slice(0, 8); box.append(option); });
    } catch (e) { el('hostBackupFeedback').textContent = e.message; }
  }
  async function configBackupRequest(path, body) {
    const r = await apiFetch('/api/launch/' + project() + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const d = await r.json(); if (!r.ok) throw Error(d.detail || 'Operation failed'); return d;
  }
  el('hostBackup').onclick = async () => {
    try { await configBackupRequest('/config-backups', {token: token()}); el('hostBackupFeedback').textContent = 'Configuration snapshot created.'; await refreshBackups(); }
    catch (e) { el('hostBackupFeedback').textContent = e.message; }
  };
  el('hostRefreshBackups').onclick = refreshBackups;
  el('hostRestore').onclick = async () => {
    const id = el('hostBackupList').value;
    if (!id) { el('hostBackupFeedback').textContent = 'Select a snapshot first.'; return; }
    if (!confirm('Restore this saved launcher configuration? Stop managed servers first. Current settings will be replaced.')) return;
    try { await configBackupRequest('/config-backups/restore', {backup_id: id, token: token()}); el('hostBackupFeedback').textContent = 'Configuration restored. Reloading status…'; await load(false); }
    catch (e) { el('hostBackupFeedback').textContent = e.message; }
  };
  // ---------------------------------------------------------------- one-click fixes + Go live
  function showKey(key) {
    const box = el('goLiveKey');
    box.hidden = false;
    try { if (typeof setStoredAccessKey === 'function') setStoredAccessKey(key); } catch {}
    box.innerHTML = `<strong>${icon('lock')} Your new access key — save it now</strong><p class="muted small">It is saved in OMNIA's .env file and will not be shown again. You need it to sign in from your phone or any other device. This computer stays signed in.</p><div class="input-row"><input readonly value="${esc(key)}" id="goLiveKeyValue"><button type="button" class="ghost" id="goLiveCopy">Copy</button></div>`;
    el('goLiveCopy').onclick = () => { navigator.clipboard?.writeText(key).then(() => notify('Access key copied.'), () => el('goLiveKeyValue').select()); };
  }
  async function fixAction(action, button) {
    const label = button.textContent; button.disabled = true;
    button.textContent = action === 'install_caddy' ? 'Downloading Caddy…' : 'Generating…';
    try {
      const path = action === 'install_caddy' ? '/caddy/install' : '/access-key';
      const r = await apiFetch('/api/launch/' + project() + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token: token()})});
      const d = await r.json(); if (!r.ok) throw Error(d.detail || 'Request failed');
      if (d.access_key) showKey(d.access_key);
      notify(action === 'install_caddy' ? `Caddy ready: ${d.version || d.path}` : 'Access key created and saved to .env.');
    } catch (e) { notify(e.message); button.disabled = false; button.textContent = label; return; }
    runPreflight(false);
  }
  const STEP_ICON = {ok: 'check', warn: 'alert', fail: 'x'};
  el('goLiveForm').onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    const steps = el('goLiveSteps'), button = el('goLiveButton');
    steps.hidden = false;
    steps.innerHTML = `<li class="run">${icon('refresh')}<div><strong>Working…</strong><small>Configuring, installing Caddy if needed, starting HTTPS and waiting for the certificate. This can take up to a minute.</small></div></li>`;
    busy = true; button.disabled = true;
    try {
      const r = await apiFetch('/api/launch/' + project() + '/go-live', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: token(), domain: el('goLiveDomain').value.trim(), email: el('goLiveEmail').value.trim(), port: Number(el('launchPort').value) || 8000})});
      const d = await r.json(); if (!r.ok) throw Error(d.detail || 'Go live failed');
      steps.innerHTML = d.steps.map(x => `<li class="${x.status}">${icon(STEP_ICON[x.status] || 'info')}<div><strong>${esc(x.label)}</strong><small>${esc(x.detail)}</small></div></li>`).join('')
        + (d.ok && d.url ? `<li class="ok">${icon('external')}<div><strong>Open your site</strong><small><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a> — then confirm LIVE from your phone on mobile data (Advanced → step 5).</small></div></li>` : '');
      if (d.access_key) showKey(d.access_key);
      if (d.status) { render(d.status); fill(d.status); }
    } catch (err) {
      steps.innerHTML = `<li class="fail">${icon('x')}<div><strong>Go live failed</strong><small>${esc(err.message)}</small></div></li>`;
    } finally { busy = false; button.disabled = false; runPreflight(false); }
  };

  let loaded = false;
  window.addEventListener('omnia:tab', e => { if (e.detail === 'launch' && !loaded) { loaded = true; load(true); refreshBackups(); } });
  render(null);
})();
