(() => {
  // OMNIA IQ Publishing (v88): Channels → New post → Your posts.
  // One request (/overview) loads the page; the background check asks only for posts, and only while the tab is visible.
  const el = id => document.getElementById(id);
  let media = [], accounts = [], posts = [], readiness = null, google = null, automationOn = false;
  let busy = false, filter = 'all', view = 'list', when = 'now', firstLoad = true, loaded = false;
  const blobs = [];
  let timer = null;
  const PLATFORM = {
    youtube: {name: 'YouTube', icon: 'play', title: 100, caption: 5000, types: ['.mp4'], note: 'MP4 only'},
    facebook: {name: 'Facebook Page', icon: 'flag', caption: 60000, types: ['.mp4', '.mov', '.webm', '.jpg', '.jpeg', '.png']},
    instagram: {name: 'Instagram', icon: 'camera', caption: 2200, types: ['.mp4', '.jpg', '.jpeg'], note: 'JPEG photo or MP4 Reel'},
    tiktok: {name: 'TikTok', icon: 'note', caption: 0, types: ['.mp4'], note: 'Caption is entered in TikTok'},
  };
  const DELIVERY = {
    pending: 'info', sending: 'info', container: 'info', publishing: 'info', processing: 'info', ready: 'info',
    uploaded: 'ok', published: 'ok', awaiting_creator: 'warn', failed: 'bad', uncertain: 'bad', cancelled: '',
  };
  const DELIVERY_TEXT = {pending: 'Waiting', sending: 'Uploading', container: 'Processing', publishing: 'Publishing', processing: 'Processing',
    uploaded: 'Uploaded', published: 'Posted', awaiting_creator: 'In your TikTok inbox', failed: 'Failed', uncertain: 'Check the platform', cancelled: 'Cancelled'};
  const icon = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
  const mark = platform => `<span class="platform-mark pm-${platform}">${icon((PLATFORM[platform] || {}).icon || 'send')}</span>`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const postName = p => p.payload.title || (p.payload.caption || '').split('\n')[0].slice(0, 70) || 'Untitled post';
  const fmt = s => new Date(s * 1000).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

  async function call(path, method = 'GET', body) {
    const r = await apiFetch('/api/publishing' + path, {method, ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})});
    const value = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(typeof value.detail === 'string' ? value.detail : 'Publishing request failed');
    return value;
  }
  function node(tag, text, parent, cls) {
    const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; if (parent) parent.append(n); return n;
  }
  function button(label, parent, cls, iconName) {
    const b = node('button', undefined, parent, cls); b.type = 'button';
    if (iconName) b.insertAdjacentHTML('afterbegin', icon(iconName));
    b.append(document.createTextNode(' ' + label)); return b;
  }
  function badge(text, tone, parent) { return node('span', text, parent, 'badge ' + (tone || '')); }
  function message(text) { el('publishMessage').textContent = text; }
  // Runs one action, then reloads. `full` reloads channels and media too; otherwise only the posts.
  async function operation(fn, done = 'Saved.', full = false) {
    if (busy) return;
    busy = true; message('Working…');
    try { const r = await fn(); await (full ? refresh() : loadPosts()); message(typeof done === 'function' ? done(r) : done); return r; }
    catch (e) { message(e.message); }
    finally { busy = false; }
  }
  function localValue(seconds) {
    const local = new Date(seconds * 1000);
    return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const editing = () => !!el('publishQueue').querySelector('[data-dirty="true"]') ||
    (el('publishQueue').contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
  const visible = () => el('publishing').classList.contains('active') && document.visibilityState === 'visible';

  // ------------------------------------------------------------------ post status (one place for every label)
  function status(p) {
    const released = !!p.payload.manual_released, future = p.due > Date.now() / 1000;
    if (p.state === 'draft') return {key: 'draft', label: 'Draft', tone: 'warn'};
    if (p.state === 'approved' && future && (released || (automationOn && p.payload.trigger !== 'manual'))) return {key: 'scheduled', label: 'Scheduled · ' + fmt(p.due), tone: 'brand'};
    if (p.state === 'approved' && !released && !(automationOn && p.payload.trigger !== 'manual')) return {key: 'approved', label: 'Approved · not released', tone: 'warn'};
    if (p.state === 'approved' || p.state === 'processing') return {key: 'sending', label: 'Uploading', tone: 'info'};
    if (p.state === 'completed') return {key: 'done', label: 'Posted', tone: 'ok'};
    if (p.state === 'needs_review') return {key: 'problem', label: 'Needs attention', tone: 'bad'};
    return {key: 'closed', label: p.state === 'rejected' ? 'Discarded' : 'Cancelled', tone: ''};
  }
  function matches(p) {
    const k = status(p).key;
    return filter === 'all' ? k !== 'closed' : filter === 'draft' ? ['draft', 'approved'].includes(k) :
      filter === 'scheduled' ? k === 'scheduled' : filter === 'done' ? ['done', 'sending'].includes(k) : k === 'problem';
  }
  function renderCounts() {
    const n = {all: 0, draft: 0, scheduled: 0, done: 0, problem: 0};
    posts.forEach(p => { const k = status(p).key; if (k !== 'closed') n.all++;
      if (['draft', 'approved'].includes(k)) n.draft++; else if (k === 'scheduled') n.scheduled++; else if (['done', 'sending'].includes(k)) n.done++; else if (k === 'problem') n.problem++; });
    const names = {all: 'All', draft: 'Drafts', scheduled: 'Scheduled', done: 'Posted', problem: 'Needs attention'};
    el('publishFilter').querySelectorAll('[data-filter]').forEach(b => { const k = b.dataset.filter; b.textContent = n[k] ? `${names[k]} ${n[k]}` : names[k]; b.classList.toggle('alert', k === 'problem' && n[k] > 0); });
    return n;
  }

  // ------------------------------------------------------------------ 3 · Your posts
  function renderPosts() {
    const counts = renderCounts();
    renderStatus(counts);
    const box = el('publishQueue'), cal = el('publishPlannerEvents');
    cal.hidden = view !== 'calendar'; box.hidden = view === 'calendar';
    if (view === 'calendar') return renderCalendar(cal);
    const preserved = new Map([...box.querySelectorAll('article')].filter(c => c.dataset.dirty === 'true' || c.contains(document.activeElement)).map(c => [c.dataset.postId, c]));
    if (!preserved.size) blobs.splice(0).forEach(URL.revokeObjectURL);
    box.replaceChildren();
    const shown = posts.filter(p => preserved.has(p.id) || matches(p));
    if (!shown.length) node('div', posts.length ? 'Nothing here.' : 'No posts yet. Your drafts, scheduled and posted videos will show up here.', box, 'empty-mini');
    for (const p of shown) box.append(preserved.get(p.id) || card(p));
    schedulePoll();
  }
  function renderCalendar(box) {
    box.replaceChildren();
    const items = posts.filter(p => status(p).key !== 'closed').sort((a, b) => a.due - b.due);
    if (!items.length) { node('p', 'Nothing on the calendar yet.', box, 'muted'); return; }
    const groups = new Map();
    items.forEach(p => { const day = new Date(p.due * 1000).toLocaleDateString(undefined, {weekday: 'short', month: 'long', day: 'numeric'}); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(p); });
    for (const [day, rows] of groups) {
      const section = node('section', undefined, box, 'publishing-card'); node('h4', day, section);
      rows.forEach(p => { const s = status(p); const line = node('div', undefined, section, 'delivery-row');
        node('span', new Date(p.due * 1000).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}), line, 'muted');
        node('strong', postName(p), line); badge(s.label.split(' · ')[0], s.tone, line);
        node('span', plural(p.payload.accounts.length, 'channel'), line, 'muted small'); });
    }
  }
  async function loadPosts() {
    const data = await call('/overview?include=posts');
    posts = data.posts; automationOn = data.automation; renderAutomation(); renderPosts();
  }

  function card(p) {
    const s = status(p), trig = p.payload.trigger || 'schedule';
    const editable = ['draft', 'approved'].includes(p.state);
    const c = node('article', undefined, undefined, 'publishing-card'); c.dataset.postId = p.id;
    c.addEventListener('input', () => { c.dataset.dirty = 'true'; });
    c.addEventListener('change', e => { if (!e.target.matches('.pc-consent input')) c.dataset.dirty = 'true'; });

    const head = node('div', undefined, c, 'pc-head');
    const titleBox = node('div', undefined, head);
    node('h4', postName(p), titleBox);
    const meta = node('div', undefined, titleBox, 'meta');
    p.payload.accounts.forEach(id => {
      const a = p.payload.destination_snapshot[id] || {};
      const chip = node('span', undefined, meta, 'badge'); chip.innerHTML = icon((PLATFORM[a.platform] || {}).icon || 'send');
      chip.append(document.createTextNode(' ' + (a.label || id)));
    });
    if (clients().length > 1) badge(p.payload.client_id || 'default', '', meta);
    if (s.key === 'draft') node('span', p.due > Date.now() / 1000 && trig !== 'manual' ? 'For ' + fmt(p.due) : 'Created ' + fmt(p.created), meta, 'muted small');
    badge(s.label, s.tone, head).classList.add('pc-state');

    // Edit fields stay folded away until needed.
    let unchanged = () => true;
    if (editable) {
      const edit = node('details', undefined, c, 'pc-edit'); node('summary', 'Edit post', edit);
      const fields = node('div', undefined, edit, 'pc-fields');
      const title = node('input', undefined, node('label', 'Title', fields, 'wide')); title.value = p.payload.title; title.maxLength = 100;
      const caption = node('textarea', undefined, node('label', 'Caption / description', fields, 'wide')); caption.value = p.payload.caption; caption.rows = 3;
      const due = node('input', undefined, node('label', 'Post at (leave empty for now)', fields)); due.type = 'datetime-local';
      due.value = trig === 'manual' && p.due <= p.created + 60 ? '' : localValue(p.due);
      node('div', `YouTube: ${p.payload.privacy} · ${p.payload.made_for_kids ? 'made for kids' : 'not made for kids'}`, fields, 'muted small');
      const newDue = () => due.value ? new Date(due.value).getTime() / 1000 : Date.now() / 1000;
      unchanged = () => caption.value === p.payload.caption && title.value === p.payload.title && due.value === (trig === 'manual' && p.due <= p.created + 60 ? '' : localValue(p.due));
      const save = button('Save changes', node('div', undefined, edit, 'pc-actions'), '', 'pen');
      save.onclick = () => operation(() => call('/posts/' + p.id, 'PUT', {revision: p.revision, title: title.value, caption: caption.value,
        due: newDue(), trigger: due.value && newDue() > Date.now() / 1000 ? 'schedule' : 'manual', privacy: p.payload.privacy, made_for_kids: p.payload.made_for_kids})
        .then(() => { c.dataset.dirty = 'false'; }), 'Changes saved. Approve the post again to publish it.');
      if (p.state === 'approved') node('small', 'Saving changes returns the post to draft so you can approve the new version.', edit, 'muted');
    }

    const actions = node('div', undefined, c, 'pc-actions');
    const future = p.due > Date.now() / 1000;
    const goLabel = future ? 'Approve & schedule' : 'Approve & publish';
    if (p.state === 'draft') {
      const consentLabel = node('label', undefined, undefined, 'publishing-consent pc-consent'); actions.before(consentLabel);
      const consent = node('input', undefined, consentLabel); consent.type = 'checkbox';
      consentLabel.append(document.createTextNode(' I checked this exact video, channels, title, caption and time, and I approve uploading it.'));
      const go = button(goLabel, actions, 'primary', future ? 'calendar' : 'send'); go.disabled = true;
      const changed = () => { go.disabled = !consent.checked || !unchanged(); go.title = unchanged() ? '' : 'Save your changes first'; };
      consent.onchange = changed; c.addEventListener('input', changed);
      go.onclick = () => operation(async () => {
        const approved = await call(`/posts/${p.id}/approve`, 'POST', {revision: p.revision, consent: true});
        await call(`/posts/${p.id}/release`, 'POST', {revision: approved.revision, consent: true});
        c.dataset.dirty = 'false';
      }, future ? 'Scheduled for ' + fmt(p.due) + '.' : 'Uploading now…');
      button('Discard', actions, 'danger', 'trash').onclick = () => { if (confirm('Discard this draft?')) operation(() => call(`/posts/${p.id}/reject`, 'POST', {revision: p.revision}), 'Draft discarded.'); };
    }
    if (p.state === 'approved') {
      if (s.key === 'approved') {
        const go = button(future ? 'Schedule it' : 'Publish now', actions, 'primary', future ? 'calendar' : 'upload');
        go.onclick = () => operation(() => call(`/posts/${p.id}/release`, 'POST', {revision: p.revision, consent: true}), future ? 'Scheduled.' : 'Uploading now…');
        c.addEventListener('input', () => { go.disabled = !unchanged(); });
      } else if (s.key === 'scheduled') node('span', 'Goes out automatically at ' + fmt(p.due) + '.', actions, 'muted small');
      button(s.key === 'scheduled' ? 'Cancel schedule' : 'Cancel', actions, 'danger', 'x').onclick = () => { if (confirm('Cancel this post? It will not be uploaded.')) operation(() => call(`/posts/${p.id}/cancel`, 'POST', {revision: p.revision}), 'Post cancelled.'); };
    }
    const preview = button('Preview', actions, 'ghost', 'eye');
    preview.onclick = async () => {
      preview.disabled = true;
      try {
        const r = await apiFetch(`/api/publishing/posts/${p.id}/preview`); if (!r.ok) throw Error('Preview unavailable');
        const b = await r.blob(); const u = URL.createObjectURL(b); blobs.push(u);
        const n = node(b.type.startsWith('image/') ? 'img' : 'video', undefined, undefined, 'publishing-preview'); n.src = u; n.alt = 'Media for this post'; n.controls = true;
        actions.after(n);
      } catch (e) { message(e.message); preview.disabled = false; }
    };

    const started = p.deliveries.some(d => !['pending', 'cancelled'].includes(d.state));
    if (started) {
      const list = node('div', undefined, c, 'pc-deliveries');
      for (const d of p.deliveries) {
        const row = node('div', undefined, list, 'delivery-row');
        const a = p.payload.destination_snapshot[d.account] || {};
        row.insertAdjacentHTML('beforeend', mark(a.platform));
        node('strong', a.label || d.account, row);
        badge(DELIVERY_TEXT[d.state] || d.state.replace(/_/g, ' '), DELIVERY[d.state] || '', row);
        if (d.remote_id) node('code', d.remote_id, row);
        if (d.state === 'uploaded') node('span', 'The platform accepted it and may still be processing.', row, 'muted small');
        if (d.state === 'uncertain') node('span', "We couldn't confirm the result. Check the platform before sending it again.", row, 'muted small');
        if (d.error) node('span', d.error, row, 'err');
        if (d.state === 'uncertain') {
          button('It was posted', row, 'ghost', 'check').onclick = () => operation(() => call(`/posts/${p.id}/resolve`, 'POST', {account: d.account, outcome: 'published', remote_id: prompt('Optional: the post or video ID from the platform') || ''}));
          button('Not posted, send again', row, 'ghost', 'refresh').onclick = () => { if (confirm('Only continue if you checked the platform and the post is NOT there. OMNIA will upload it again.')) operation(() => call(`/posts/${p.id}/resolve`, 'POST', {account: d.account, outcome: 'not_posted'})); };
        }
      }
      if (p.deliveries.some(d => d.state === 'failed') && p.approved) button('Retry failed channels', list, 'primary', 'refresh').onclick = () => operation(() => call(`/posts/${p.id}/retry`, 'POST'), 'Retrying…');
    }
    const detail = node('details', undefined, c); node('summary', 'History', detail);
    node('pre', (p.audit.map(a => `${new Date(a.time * 1000).toLocaleString()} · ${a.actor} · ${a.action} · r${a.revision}`).join('\n') || 'No history yet.') + '\nFile SHA-256 · ' + p.checksum, detail);
    return c;
  }

  // ------------------------------------------------------------------ 2 · New post
  const clients = () => [...new Set(accounts.map(a => a.client_id || 'default'))].sort();
  const selectedAccounts = () => [...el('publishDestinations').querySelectorAll('input:checked')].map(n => n.value);
  const chosenMedia = () => el('publishMedia').value === '' ? null : media[Number(el('publishMedia').value)];
  function renderDestinations(keep = []) {
    const box = el('publishDestinations'); box.replaceChildren(); node('legend', 'Post to', box);
    const list = accounts.filter(a => (a.client_id || 'default') === el('publishClient').value);
    if (!accounts.length) { const d = node('div', undefined, box, 'muted small'); d.append('No channels yet. '); const b = button('Connect a channel', d, 'ghost', 'plus'); b.onclick = () => { el('publishConnectPanel').open = true; el('publishConnectPanel').scrollIntoView({behavior: 'smooth'}); }; }
    else if (!list.length) node('div', 'This client has no channels yet.', box, 'muted small');
    for (const a of list) {
      const label = node('label', undefined, box, 'dest-option');
      const input = node('input', undefined, label); input.type = 'checkbox'; input.value = a.id; input.disabled = !a.configured;
      input.checked = a.configured && (keep.includes(a.id) || (list.filter(x => x.configured).length === 1));
      label.insertAdjacentHTML('beforeend', mark(a.platform));
      const text = node('span', undefined, label); node('b', a.label, text);
      node('small', `${(PLATFORM[a.platform] || {}).name || a.platform}${a.configured ? '' : ' · needs a token'}`, text);
    }
  }
  function counter(id, limit) {
    const c = document.querySelector(`[data-count-for="${id}"]`); if (!c) return;
    const n = el(id).value.length; c.textContent = limit ? `${n.toLocaleString()} / ${limit.toLocaleString()}` : (n ? n.toLocaleString() : '');
    c.classList.toggle('over', !!limit && n > limit);
  }
  function setWhen(value) {
    when = value;
    el('publishWhen').querySelectorAll('button').forEach(b => { const on = b.dataset.when === value; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    el('publishDue').hidden = value !== 'schedule'; el('publishDue').required = value === 'schedule';
    el('publishTrigger').value = value === 'schedule' ? 'schedule' : 'manual';
    if (value === 'schedule' && !el('publishDue').value) { const t = new Date(Date.now() + 3600e3); t.setMinutes(0, 0, 0); el('publishDue').value = localValue(t.getTime() / 1000); }
    composer();
  }
  // Recomputes preview, limits, the "still needed" line and the publish button.
  function composer() {
    const picked = selectedAccounts();
    const platforms = [...new Set(accounts.filter(a => picked.includes(a.id)).map(a => a.platform))];
    const m = chosenMedia(), yt = platforms.includes('youtube');
    const ext = m ? ((m.label || '').toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0] : '';
    const capLimit = Math.min(...platforms.map(p => PLATFORM[p]?.caption || Infinity));
    el('publishPrivacyWrap').hidden = el('publishKidsWrap').hidden = !yt;
    el('publishTitleHint').hidden = !yt;
    counter('publishTitle', yt ? 100 : 0);
    counter('publishCaption', Number.isFinite(capLimit) && capLimit ? capLimit : 0);
    const dueAt = el('publishDue').value ? new Date(el('publishDue').value).getTime() : 0;

    el('publishPreviewPlatform').textContent = platforms.length ? platforms.map(p => PLATFORM[p]?.name || p).join(' + ') : 'Pick a channel';
    el('publishPreviewTrigger').textContent = when === 'schedule' ? (dueAt ? 'Scheduled · ' + fmt(dueAt / 1000) : 'Scheduled') : 'Posts now';
    el('publishPreviewMedia').textContent = m ? m.label : 'Select a video to preview its name';
    el('publishPreviewTitle').textContent = el('publishTitle').value.trim() || (yt ? 'YouTube video title' : 'Post preview');
    el('publishPreviewCaption').textContent = el('publishCaption').value.trim() || 'Your caption will appear here.';

    const needs = [];
    if (!m) needs.push('a video or image');
    if (!picked.length) needs.push('a channel');
    if (yt && !el('publishTitle').value.trim()) needs.push('a title');
    if (yt && !el('publishKids').value) needs.push('the YouTube audience');
    if (when === 'schedule' && !(dueAt > Date.now())) needs.push('a future time');
    if (Number.isFinite(capLimit) && el('publishCaption').value.length > capLimit) needs.push('a shorter caption');
    const wrongType = ext && platforms.find(p => PLATFORM[p]?.types && !PLATFORM[p].types.includes(ext));
    if (wrongType) needs.push(`a file ${PLATFORM[wrongType].name} accepts (${PLATFORM[wrongType].note || PLATFORM[wrongType].types.join(', ')})`);
    const box = el('publishPreflight'); box.replaceChildren();
    if (needs.length) { box.className = 'span-2 pub-needs pending'; box.textContent = 'Still needed: ' + needs.join(', ') + '.'; }
    else { box.className = 'span-2 pub-needs ready'; box.innerHTML = icon('check'); box.append(' Ready to go.'); }

    const label = el('publishSubmit').querySelector('span');
    label.textContent = when === 'schedule' ? 'Schedule post' : 'Publish now';
    el('publishSubmit').disabled = !!needs.length || !el('publishApproveNow').checked;
    el('publishSubmit').title = needs.length ? 'Still needed: ' + needs.join(', ') : el('publishApproveNow').checked ? '' : 'Tick the approval box first';
    el('publishSaveDraft').disabled = !m || !picked.length;

    const lim = el('publishLimits'); lim.replaceChildren();
    if (!platforms.length) { node('div', 'Tick a channel to see its limits.', lim, 'empty-mini'); return; }
    for (const p of platforms) {
      const spec = PLATFORM[p] || {}; const row = node('div', undefined, lim, 'limit-row');
      const h = node('div', undefined, row, 'limit-row-head'); h.insertAdjacentHTML('beforeend', mark(p)); node('span', spec.name || p, h);
      const meter = (name, used, max) => {
        if (!max) return;
        const wrap = node('div', undefined, row); const bar = node('div', undefined, wrap, 'meter' + (used > max ? ' over' : ''));
        node('i', undefined, bar).style.width = Math.min(100, used / max * 100) + '%';
        const sm = node('small', undefined, wrap); node('span', name, sm); node('span', `${used.toLocaleString()} / ${max.toLocaleString()}`, sm);
      };
      if (spec.title) meter('Title', el('publishTitle').value.length, spec.title);
      if (spec.caption) meter('Caption', el('publishCaption').value.length, spec.caption);
      if (spec.note) node('small', spec.note, row);
    }
  }
  function draftBody(publish) {
    const m = chosenMedia(), schedule = when === 'schedule';
    return {approve_now: publish, consent: publish, release: publish, ...(m.artifact_id ? {artifact_id: m.artifact_id} : {upload_id: m.upload_id}),
      client_id: el('publishClient').value || 'default', trigger: schedule ? 'schedule' : 'manual', accounts: selectedAccounts(),
      title: el('publishTitle').value, caption: el('publishCaption').value, privacy: el('publishPrivacy').value,
      made_for_kids: el('publishKids').value === 'yes', due: schedule ? new Date(el('publishDue').value).getTime() / 1000 : Date.now() / 1000};
  }
  function resetComposer() {
    ['publishTitle', 'publishCaption'].forEach(id => { el(id).value = ''; });
    el('publishMedia').value = ''; el('publishApproveNow').checked = false; el('publishKids').value = ''; setWhen('now');
  }
  el('publishDraft').onsubmit = e => {
    e.preventDefault(); composer(); if (el('publishSubmit').disabled) return;
    const schedule = when === 'schedule', at = schedule ? fmt(new Date(el('publishDue').value).getTime() / 1000) : '';
    operation(async () => { await call('/posts', 'POST', draftBody(true)); resetComposer(); }, schedule ? `Scheduled for ${at}.` : 'Uploading now… progress shows below.');
  };
  el('publishSaveDraft').onclick = () => operation(async () => { await call('/posts', 'POST', draftBody(false)); resetComposer(); }, 'Draft saved. Approve it below when you are ready.');
  el('publishWhen').addEventListener('click', e => { const b = e.target.closest('[data-when]'); if (b) setWhen(b.dataset.when); });
  ['publishTitle', 'publishCaption', 'publishDue'].forEach(id => el(id).addEventListener('input', composer));
  ['publishMedia', 'publishKids', 'publishPrivacy', 'publishApproveNow', 'publishDue'].forEach(id => el(id).addEventListener('change', composer));
  el('publishDestinations').addEventListener('change', composer);
  el('publishClient').onchange = () => { renderDestinations(); composer(); };
  el('publishFile').onchange = async () => {
    const file = el('publishFile').files[0]; if (!file) return;
    const data = await operation(async () => {
      message(`Uploading ${file.name}…`);
      const form = new FormData(); form.append('document', file);
      const r = await apiFetch('/api/publishing/upload', {method: 'POST', body: form}, 600000);
      const d = await r.json(); if (!r.ok) throw Error(typeof d.detail === 'string' ? d.detail : 'Media upload failed');
      return d;
    }, d => `${d.filename} uploaded and selected.`, true);
    el('publishFile').value = '';
    const i = data ? media.findIndex(m => m.upload_id === data.file_id || m.label === data.filename) : -1;
    if (i >= 0) { el('publishMedia').value = String(i); composer(); }
  };

  // ------------------------------------------------------------------ 1 · Channels
  const CHECK_LABEL = {signing_key: 'Create signing key', media_base: 'Set public address', connect_youtube: 'Connect YouTube', google_app: 'Set up Google app', connect_meta: 'Connect'};
  function renderChecks() {
    document.querySelectorAll('.card-checks').forEach(box => {
      box.replaceChildren();
      const ids = box.dataset.platforms.split(' ');
      const plats = (readiness?.platforms || []).filter(p => ids.includes(p.id) && p.accounts);
      for (const p of plats) {
        const blocking = p.requirements.filter(r => r.ok === false);
        const row = node('div', undefined, box, 'card-check ' + (blocking.length ? 'bad' : 'ok'));
        row.innerHTML = icon(blocking.length ? 'alert' : 'check'); node('span', blocking.length ? `${p.name}: one more step` : `${p.name} ready`, row);
        for (const r of blocking.filter(r => !['connect_youtube', 'connect_meta', 'google_app'].includes(r.action))) {
          const li = node('div', undefined, box, 'card-fix'); node('span', r.fix || r.label, li);
          if (r.action) fixButton(r.action, li);
        }
      }
    });
  }
  function fixButton(action, parent) {
    const b = button(CHECK_LABEL[action] || 'Fix', parent, 'ghost fix-btn');
    b.onclick = () => {
      if (action === 'signing_key') return operation(async () => { await call('/settings/signing-key', 'POST'); }, 'Signing key created.', true);
      if (action === 'media_base') {
        const value = prompt('Public HTTPS address of this OMNIA (from Launch Center), e.g. https://omnia.example.com', readiness?.launch_domain || 'https://');
        if (value !== null) operation(async () => { await call('/settings', 'PUT', {media_base_url: value.trim()}); }, 'Public address saved.', true);
      }
    };
  }
  function renderChannels() {
    const connected = accounts.filter(a => a.configured);
    const chips = el('pubChannelChips'); chips.replaceChildren();
    connected.slice(0, 6).forEach(a => { const c = node('span', undefined, chips, 'badge ok'); c.innerHTML = icon((PLATFORM[a.platform] || {}).icon || 'send'); c.append(' ' + a.label); });
    if (connected.length > 6) badge('+' + (connected.length - 6), '', chips);
    const missing = accounts.length - connected.length;
    el('pubChannelsSummary').textContent = connected.length ? `${plural(connected.length, 'channel')} connected${missing ? ` · ${missing} need${missing === 1 ? 's' : ''} a token` : ''}` : 'Connect where you want to post. You only do this once.';
    if (firstLoad) el('publishConnectPanel').open = !connected.length;

    const yt = connected.filter(a => a.platform === 'youtube');
    el('connectYouTubeState').textContent = yt.length ? 'Connected: ' + yt.map(a => a.label).join(', ') : google?.configured ? 'Ready: click Connect and sign in' : 'Sign in with Google';
    el('connectYouTube').lastChild.textContent = yt.length ? ' Add another channel' : ' Connect YouTube';
    el('connectYouTube').className = yt.length ? 'ghost' : 'primary';
    el('connectGoogleSetup').hidden = !!google?.configured;
    if (google) el('connectRedirectUri').textContent = google.redirect_uri;
    const meta = connected.filter(a => ['facebook', 'instagram'].includes(a.platform));
    el('connectMetaState').textContent = meta.length ? 'Connected: ' + meta.map(a => a.label).join(', ') : 'Finds your Pages and linked Instagram accounts';
    el('connectMetaFind').lastChild.textContent = meta.length ? ' Find more Pages' : ' Find my Pages';

    const cl = clients();
    el('connectClientWrap').hidden = cl.length <= 1 && el('connectClient').value === 'default';
    const list = el('connectClientList'); list.replaceChildren(); cl.forEach(c => { node('option', undefined, list).value = c; });
    renderChecks(); renderAccounts();
  }
  function renderAccounts() {
    const box = el('publishAccountList'); box.replaceChildren();
    for (const a of accounts) {
      const row = node('div', undefined, box, 'account-row');
      row.insertAdjacentHTML('beforeend', mark(a.platform));
      const t = node('div', undefined, row);
      const strong = node('strong', `${a.label} `, t);
      badge(!a.configured ? 'Needs a token' : a.connection === 'oauth' ? 'Connected · renews itself' : 'Connected', a.configured ? 'ok' : 'bad', strong);
      node('small', `${(PLATFORM[a.platform] || {}).name || a.platform}${clients().length > 1 ? ' · ' + (a.client_id || 'default') : ''}${a.target_id ? ' · ' + a.target_id : ''}`, t);
      const btns = node('div', undefined, row, 'btn-row');
      const status = node('div', '', row, 'status-line'); status.setAttribute('role', 'status');
      const verify = button('Test', btns, 'ghost', 'shield'); verify.disabled = !a.configured || a.platform === 'tiktok';
      verify.onclick = async () => {
        verify.disabled = true;
        try { const v = await call('/accounts/' + a.id + '/verify', 'POST'); status.textContent = `✓ Signed in as ${v.name} (${v.id}). A first private test post confirms upload permission.`; }
        catch (e) { status.textContent = e.message; } finally { verify.disabled = false; }
      };
      const edit = button('Edit', btns, 'ghost', 'pen'); edit.disabled = a.platform === 'tiktok' && a.connection === 'env';
      edit.onclick = () => {
        el('publishAccountClient').value = a.client_id || 'default'; el('publishAccountId').value = a.id;
        el('publishAccountLabel').value = a.label; el('publishAccountPlatform').value = a.platform;
        el('publishAccountTarget').value = a.target_id || ''; el('publishAccountToken').value = a.token_env || ''; el('publishAccountSecret').value = '';
        el('publishAccountsPanel').open = true; envHint(); el('publishAccountSecret').focus();
      };
      if (a.connection !== 'env') button('Remove', btns, 'danger', 'x').onclick = () => { if (confirm(`Remove ${a.label}? Its saved token is deleted from this server.`)) operation(() => call('/accounts/' + encodeURIComponent(a.id), 'DELETE'), 'Channel removed.', true); };
    }
  }
  function connectMessage(text) { el('connectMessage').textContent = text; }
  const connectClient = () => el('connectClient').value.trim() || 'default';
  el('connectRedirectUri').addEventListener('click', () => navigator.clipboard?.writeText(el('connectRedirectUri').textContent).then(() => connectMessage('Redirect URI copied.')));
  el('connectGoogleSave').addEventListener('click', () => operation(async () => {
    await call('/google/app', 'PUT', {client_id: el('connectGoogleId').value.trim(), client_secret: el('connectGoogleSecret').value.trim()});
    el('connectGoogleSecret').value = ''; connectMessage('Google app saved. Now click Connect YouTube.');
  }, 'Google app saved.', true));
  el('connectYouTube').addEventListener('click', async () => {
    try {
      if (!google?.configured) { el('connectGoogleSetup').hidden = false; el('connectGoogleSetup').open = true; connectMessage('First, the one-time Google setup above.'); return; }
      const popup = window.open('about:blank', 'omnia-google', 'width=520,height=720');
      const r = await call('/connect/youtube/start', 'POST', {client_id: connectClient()});
      if (popup) popup.location.href = r.url; else location.href = r.url;
      connectMessage('Finish signing in with Google in the new window…');
    } catch (e) { connectMessage(e.message); }
  });
  window.addEventListener('message', e => {
    if (e.origin === location.origin && e.data?.omnia === 'youtube-connected') {
      connectMessage(e.data.ok ? 'YouTube connected.' : 'YouTube was not connected. The sign-in window shows why.');
      operation(async () => {}, e.data.ok ? 'YouTube connected.' : 'YouTube not connected.', true);
    }
  });
  el('connectMetaFind').addEventListener('click', () => operation(async () => {
    const box = el('connectMetaResults'); box.replaceChildren();
    if (el('connectMetaToken').value.trim().length < 10) { el('connectMetaHowto').open = true; throw Error('Paste a Meta access token first.'); }
    const r = await call('/connect/meta/discover', 'POST', {client_id: connectClient(), token: el('connectMetaToken').value.trim()});
    el('connectMetaToken').value = '';
    if (!r.destinations.length) { node('p', 'No Pages found for this token.', box, 'muted small'); return; }
    r.destinations.forEach(d => {
      const label = node('label', undefined, box, 'dest-option');
      const input = node('input', undefined, label); input.type = 'checkbox'; input.value = d.index; input.checked = true;
      label.insertAdjacentHTML('beforeend', mark(d.platform));
      const t = node('span', undefined, label); node('b', d.name, t); node('small', `${PLATFORM[d.platform].name}${d.page ? ' · via ' + d.page : ''}`, t);
    });
    button('Connect selected', box, 'primary', 'check').onclick = () => operation(async () => {
      const indexes = [...box.querySelectorAll('input:checked')].map(i => Number(i.value));
      if (!indexes.length) throw Error('Select at least one Page or Instagram account');
      const done = await call('/connect/meta/save', 'POST', {discovery: r.discovery, indexes, client_id: connectClient()});
      box.replaceChildren(); connectMessage(`Connected ${plural(done.saved.length, 'channel')}.`);
    }, 'Channels connected.', true);
    connectMessage(`Found ${plural(r.destinations.length, 'channel')}. Choose which to connect.`);
  }, 'Pages found.'));
  el('connectManual').addEventListener('click', () => { el('publishAccountsPanel').open = true; el('publishAccountPlatform').value = 'tiktok'; el('publishAccountClient').value = connectClient(); envHint(); el('publishAccountLabel').focus(); });

  const GUIDES = {
    youtube: ['Easiest: use “Connect YouTube” above. Sign-in adds the channel and renews access for you.', 'Manual: paste an access token and the channel ID (starts with UC). Plain access tokens expire after about an hour.', 'Click Test, then make one private test post.'],
    facebook: ['Easiest: use “Find my Pages” above with a token from Graph API Explorer.', 'Manual: paste a Page access token (pages_manage_posts) and the numeric Page ID.', 'Click Test, then publish one test post.'],
    instagram: ['Switch the Instagram account to Professional and link it to a Facebook Page.', 'Easiest: use “Find my Pages” above. It finds the account ID and token for you.', 'Instagram downloads media from your public address, so go live in Launch Center first.'],
    tiktok: ['Create a TikTok developer app with the Content Posting API (video.upload scope).', 'Authorize your TikTok account and copy the access token.', 'Paste the token here and save. Videos arrive in your TikTok inbox to finish posting.'],
  };
  function envHint() {
    const client = el('publishAccountClient').value.trim(), platform = el('publishAccountPlatform').value;
    const suggestion = 'OMNIA_SOCIAL_TOKEN_' + ((client || 'CLIENT') + '_' + platform).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    el('publishAccountToken').placeholder = suggestion;
    el('publishEnvHint').innerHTML = `Prefer .env? Put <code>${el('publishAccountToken').value || suggestion}=…</code> there and leave the token box empty.`;
    const guide = el('publishSetupGuide'); guide.innerHTML = `<h4>${mark(platform)} ${PLATFORM[platform].name}</h4>`;
    const ol = node('ol', undefined, guide); GUIDES[platform].forEach(s => node('li', s, ol));
  }
  ['publishAccountClient', 'publishAccountToken'].forEach(id => el(id).addEventListener('input', envHint));
  el('publishAccountPlatform').addEventListener('change', envHint);
  el('publishAccountForm').onsubmit = e => {
    e.preventDefault();
    operation(async () => {
      const r = await call('/accounts', 'PUT', {id: el('publishAccountId').value.trim(), client_id: el('publishAccountClient').value.trim() || 'default', label: el('publishAccountLabel').value.trim(), platform: el('publishAccountPlatform').value, target_id: el('publishAccountTarget').value.trim(), token_env: el('publishAccountToken').value.trim(), token: el('publishAccountSecret').value.trim()});
      el('publishAccountSecret').value = ''; el('publishAccountId').value = ''; el('publishAccountLabel').value = ''; el('publishAccountTarget').value = '';
      return r;
    }, r => r?.configured ? 'Channel saved and connected.' : 'Channel saved. Paste its access token to connect it.', true);
  };

  // ------------------------------------------------------------------ status + automation
  function renderStatus(n = renderCounts()) {
    const connected = accounts.filter(a => a.configured).length;
    const box = el('pubStatus'); box.replaceChildren();
    node('strong', connected ? plural(connected, 'channel') + ' connected' : 'No channels yet', box);
    const bits = [];
    if (n.scheduled) bits.push(`${n.scheduled} scheduled`);
    if (n.draft) bits.push(plural(n.draft, 'draft'));
    if (n.problem) bits.push(`${n.problem} need${n.problem === 1 ? 's' : ''} attention`);
    node('small', bits.join(' · ') || (connected ? 'Nothing waiting.' : 'Start with step 1.'), box);
    box.classList.toggle('alert', !!n.problem);
  }
  function renderAutomation() {
    el('publishAutomation').checked = automationOn;
    el('publishAutomationStatus').textContent = automationOn ? 'ON: approved workflow posts upload when due.' : 'OFF: workflow posts wait for you to publish them.';
  }
  el('publishAutomation').onchange = () => operation(async () => { const a = await call('/automation', 'PUT', {enabled: el('publishAutomation').checked}); automationOn = a.enabled; }, 'Setting saved.');

  // ------------------------------------------------------------------ loading
  async function refresh() {
    const keepMedia = chosenMedia(), keepDest = selectedAccounts();
    const d = await call('/overview');
    accounts = d.accounts; media = d.media; posts = d.posts; readiness = d.readiness; google = d.google; automationOn = d.automation; loaded = true;
    const cl = clients(), prev = el('publishClient').value;
    el('publishClient').replaceChildren(); cl.forEach(id => { node('option', id, el('publishClient')).value = id; });
    el('publishClient').value = cl.includes(prev) ? prev : (cl[0] || 'default');
    el('publishClientWrap').hidden = cl.length <= 1;
    renderDestinations(keepDest);
    el('publishMedia').replaceChildren();
    node('option', media.length ? 'Select a video or image' : 'No finished media yet: render a video or upload one', el('publishMedia')).value = '';
    media.forEach((m, i) => { node('option', (m.artifact_id ? 'Rendered · ' : 'Uploaded · ') + m.label, el('publishMedia')).value = String(i); });
    if (keepMedia) { const i = media.findIndex(m => m.artifact_id ? m.artifact_id === keepMedia.artifact_id : m.upload_id === keepMedia.upload_id); if (i >= 0) el('publishMedia').value = String(i); }
    el('publishAccounts').textContent = accounts.length ? `${plural(media.length, 'media file')} ready to post` : 'Connect a channel in step 1 first.';
    renderChannels(); renderAutomation(); renderPosts(); composer(); envHint();
    firstLoad = false;
  }

  el('publishRefresh').onclick = () => operation(async () => {}, 'Up to date.', true);
  el('publishFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]'); if (!b) return;
    filter = b.dataset.filter; el('publishFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (view === 'calendar') { view = 'list'; el('publishPlannerList').classList.add('on'); el('publishPlannerCalendar').classList.remove('on'); }
    renderPosts();
  });
  [['publishPlannerList', 'list'], ['publishPlannerCalendar', 'calendar']].forEach(([id, mode]) => el(id).addEventListener('click', () => {
    view = mode; el('publishPlannerList').classList.toggle('on', mode === 'list'); el('publishPlannerCalendar').classList.toggle('on', mode === 'calendar'); renderPosts();
  }));
  document.querySelector('[data-tab="publishing"]').addEventListener('click', () => operation(async () => {}, '', true));

  // Background check: posts only, only while this tab is on screen. Fast while something is uploading.
  function schedulePoll() {
    clearTimeout(timer);
    const active = posts.some(p => p.state === 'processing' || (p.state === 'approved' && p.payload.manual_released && p.due <= Date.now() / 1000 + 60));
    timer = setTimeout(async () => {
      if (visible() && loaded && !busy && !editing()) { try { await loadPosts(); } catch (e) { message(e.message); } }
      schedulePoll();
    }, active ? 5000 : 30000);
  }
  schedulePoll();
  let lastFocus = 0;
  window.addEventListener('focus', () => { if (visible() && loaded && !busy && !editing() && Date.now() - lastFocus > 10000) { lastFocus = Date.now(); refresh().catch(() => {}); } });
  envHint(); setWhen('now');

  // Video Studio → "Publish" hands a finished render straight to the composer.
  window.omniaPublishing = {
    async selectArtifact(artifactId) {
      await operation(async () => {}, '', true);
      const i = media.findIndex(m => m.artifact_id === artifactId);
      if (i >= 0) { el('publishMedia').value = String(i); composer(); message('Finished video selected. Pick channels and write the caption.'); }
      (accounts.length ? el('publishComposer') : el('publishConnectPanel')).scrollIntoView({behavior: 'smooth', block: 'start'});
    },
  };
})();
