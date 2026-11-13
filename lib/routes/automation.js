// Workflow automation (port of v88.5 automation/automation_engine.py) for Vercel.
// No background thread exists on serverless: due runs and schedules are processed on every API call
// (in the background), by the page while it is open, and by Vercel Cron via /api/automation/tick.
import { randomUUID, createHash } from 'node:crypto';
import { json, fail, HttpError } from '../http.js';
import { all, one, run } from '../db.js';
import * as settings from '../settings.js';

const SECTIONS = ['chat', 'files', 'dashboard', 'studios', 'tasks', 'memory', 'publishing', 'launch', 'settings', 'schedule'];
const NODE_TYPES = new Set(['notify', 'wait', 'condition', 'if', 'else', 'end_if', 'set_variable', 'increment', 'stop', 'audit', 'filter', 'format_text', 'webhook', 'publish_draft']);
const OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty'];
const RETRY_DELAYS = [30, 120, 600];
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]{0,80})\s*\}\}/g;
const bad = m => { throw new HttpError(400, m); };
const t = () => Date.now() / 1000;
const isIdent = k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(k || ''));

export const EVENT_CATALOG = {
  publishing: [['*', 'Any publishing event'], ['post.created', 'Post draft created'], ['post.approved', 'Post approved'], ['delivery.published', 'Post published'], ['delivery.uploaded', 'Upload accepted by platform'], ['delivery.awaiting_creator', 'TikTok waiting for creator'], ['delivery.needs_attention', 'Upload failed / needs attention'], ['post.rejected', 'Post rejected'], ['post.cancelled', 'Post cancelled']],
  tasks: [['*', 'Any project event'], ['artifact.created', 'Video or image finished rendering'], ['projects.post', 'Project action'], ['projects.put', 'Project updated'], ['projects.delete', 'Project deleted']],
  schedule: [['interval', 'Every N minutes'], ['daily', 'Every day at a time']],
  chat: [['*', 'Any chat event'], ['chat.post', 'Chat message or action']],
  files: [['*', 'Any files event'], ['files.post', 'File uploaded or changed'], ['files.delete', 'File deleted']],
  memory: [['*', 'Any memory event'], ['memory.post', 'Memory saved'], ['memory.delete', 'Memory deleted']],
  launch: [['*', 'Any launch event'], ['launch.post', 'Launch action']],
  settings: [['*', 'Any settings event'], ['system.post', 'Settings changed'], ['system.put', 'Settings updated']],
  studios: [['*', 'Any studio event']], dashboard: [['*', 'Any dashboard event']],
};
const TEMPLATES = [
  { key: 'post_failed', name: 'Alert me when an upload needs attention', description: 'Notification whenever a publishing destination fails or is uncertain.', section: 'publishing', event_type: 'delivery.needs_attention', steps: [{ type: 'notify', title: 'Upload needs attention: {{title}}', message: '{{account}}: {{error}} — open Publishing to retry or resolve.' }] },
  { key: 'post_published', name: 'Celebrate published posts', description: 'Notification each time a post goes live on a platform.', section: 'publishing', event_type: 'delivery.published', steps: [{ type: 'notify', title: 'Published: {{title}}', message: 'Live on {{account}} (remote ID {{remote_id}}).' }] },
  { key: 'render_to_draft', name: 'Finished video → publishing draft', description: 'When a video finishes rendering, prepare a draft for your channels. You still approve it.', section: 'tasks', event_type: 'artifact.created', steps: [{ type: 'condition', field: 'media_type', operator: 'equals', value: 'video' }, { type: 'publish_draft', accounts: [], title: '{{title}}', caption: '', privacy: 'private' }, { type: 'notify', title: 'Draft ready to approve: {{title}}', message: 'Open Publishing → Review queue to approve the upload.' }] },
  { key: 'slack_published', name: 'Post to Slack/Discord when published', description: 'Send a chat message to your team channel through an incoming webhook.', section: 'publishing', event_type: 'delivery.published', steps: [{ type: 'webhook', url: '', format: 'slack', message: '✅ “{{title}}” is live on {{account}}' }] },
  { key: 'daily_review', name: 'Daily review reminder', description: 'Every morning, remind me to review drafts waiting for approval.', section: 'schedule', event_type: 'daily', schedule: { daily_at: '09:00' }, steps: [{ type: 'notify', title: 'Daily publishing review', message: 'Check Publishing for drafts waiting for approval ({{time}}).' }] },
  { key: 'zapier_any', name: 'Send every publishing event to Zapier / Make', description: 'Forward events as JSON to connect OMNIA with 5,000+ apps.', section: 'publishing', event_type: '*', steps: [{ type: 'webhook', url: '', format: 'json', message: '{{event_type}}: {{title}}' }] },
];
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS auto_workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, section TEXT NOT NULL, event_type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, definition TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL)`,
  `CREATE TABLE IF NOT EXISTS auto_events (id TEXT PRIMARY KEY, section TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auto_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, event_id TEXT NOT NULL, state TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, due REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at REAL NOT NULL, manual INTEGER NOT NULL DEFAULT 0, UNIQUE(workflow_id,event_id))`,
  `CREATE TABLE IF NOT EXISTS auto_notifications (id TEXT PRIMARY KEY, section TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, workflow_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at REAL NOT NULL, read INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS auto_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT, created_at REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auto_run_context (run_id TEXT PRIMARY KEY, variables TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS auto_due ON auto_runs(state,due)`,
];
let ready; const ensure = () => (ready ||= (async () => { for (const s of SCHEMA) await run(s); })().catch(e => { ready = null; throw e; }));

function checkWebhook(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch { bad('Webhook URL must start with https:// (Slack, Discord, Zapier, Make, n8n …)'); }
  if (u.protocol !== 'https:' || u.username || u.password) bad('Webhook URL must start with https:// (Slack, Discord, Zapier, Make, n8n …)');
  if (String(url).length > 2000) bad('Webhook URL is too long');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)|\.(local|internal)$/i.test(u.hostname)) bad('Webhooks may only call public internet addresses');
  return u;
}
function validate(item) {
  const name = String(item.name || '').trim(), section = String(item.section || ''), event_type = String(item.event_type || '').trim(), steps = item.steps;
  if (!name || name.length > 100 || !SECTIONS.includes(section) || !event_type || event_type.length > 100) bad('Name, valid section and event type are required');
  let schedule = null;
  if (section === 'schedule') {
    const raw = item.schedule || {};
    if (event_type === 'interval') { const m = parseInt(raw.every_minutes || 0); if (!(m >= 5 && m <= 10080)) bad('Repeat every 5 minutes to 7 days'); schedule = { every_minutes: m }; }
    else if (event_type === 'daily') { const at = String(raw.daily_at || ''); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) bad('Choose a daily time like 09:00'); schedule = { daily_at: at }; }
    else bad('Choose “Every N minutes” or “Every day at”');
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 60) bad('Use 1 to 60 steps');
  steps.forEach((s, i0) => {
    const i = i0 + 1; if (!s || !NODE_TYPES.has(s.type)) bad(`Step ${i}: unsupported action`);
    const k = s.type;
    if (k === 'notify' && (!String(s.title || '').trim() || String(s.message || '').length > 2000)) bad(`Step ${i}: notification title required and message must be ≤ 2000 characters`);
    if (k === 'wait' && !(parseInt(s.seconds || 0) >= 1 && parseInt(s.seconds) <= 604800)) bad(`Step ${i}: wait must be 1 second to 7 days`);
    if (['condition', 'if', 'filter'].includes(k) && (!String(s.field || '').trim() || !OPERATORS.includes(s.operator))) bad(`Step ${i}: choose a field and a comparison`);
    if (['set_variable', 'increment', 'format_text'].includes(k) && (!isIdent(s.key) || String(s.key).length > 64)) bad(`Step ${i}: variable name must be a simple word (letters, numbers, _)`);
    if (k === 'format_text' && String(s.template || '').length > 2000) bad(`Step ${i}: text template exceeds 2000 characters`);
    if (k === 'webhook') { checkWebhook(s.url); if (!['json', 'slack', 'discord'].includes(s.format || 'json')) bad(`Step ${i}: choose JSON, Slack or Discord format`); if (String(s.message || '').length > 2000) bad(`Step ${i}: webhook message must be ≤ 2000 characters`); }
    if (k === 'publish_draft') { const a = s.accounts || []; if (!Array.isArray(a) || !a.length || a.length > 20) bad(`Step ${i}: choose at least one publishing destination`); if (String(s.title || '').length > 200 || String(s.caption || '').length > 5000) bad(`Step ${i}: title or caption template is too long`); }
  });
  const stack = [];
  for (const s of steps) {
    if (s.type === 'if') stack.push(false);
    else if (s.type === 'else') { if (!stack.length) bad('ELSE requires IF'); if (stack.at(-1)) bad('An IF can have only one ELSE'); stack[stack.length - 1] = true; }
    else if (s.type === 'end_if') { if (!stack.length) bad('END IF requires IF'); stack.pop(); }
  }
  if (stack.length) bad('Every IF requires END IF');
  return { name, section, event_type, steps, ...(schedule ? { schedule } : {}) };
}

async function listWorkflows() {
  await ensure();
  const rows = await all('SELECT * FROM auto_workflows ORDER BY COALESCE(updated_at, created_at) DESC');
  const stats = Object.fromEntries((await all("SELECT workflow_id, COUNT(*) total, SUM(state='completed') completed, SUM(state='failed') failed, MAX(created_at) last_run FROM auto_runs GROUP BY workflow_id")).map(r => [r.workflow_id, r]));
  return rows.map(r => { const d = JSON.parse(r.definition); return { ...r, steps: d.steps, schedule: d.schedule || {}, stats: stats[r.id] || { total: 0, completed: 0, failed: 0, last_run: null } }; });
}
async function saveWorkflow(data) {
  const obj = validate(data), now = t(), id = String(data.id || randomUUID());
  const ex = await one('SELECT enabled, created_at FROM auto_workflows WHERE id=?', [id]);
  await run('INSERT OR REPLACE INTO auto_workflows(id,name,section,event_type,enabled,definition,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [id, obj.name, obj.section, obj.event_type, ex ? ex.enabled : 0, JSON.stringify(obj), ex ? ex.created_at : now, now]);
  return id;
}

export async function emit(section, eventType, payload = {}, eventId = null) {
  await ensure();
  if (!SECTIONS.includes(section)) return null;
  const eid = eventId || randomUUID(), now = t();
  const added = await run('INSERT OR IGNORE INTO auto_events VALUES(?,?,?,?,?)', [eid, section, eventType, JSON.stringify(payload).slice(0, 4096), now]);
  if (added.changes) for (const rule of await all('SELECT id FROM auto_workflows WHERE enabled=1 AND section=? AND (event_type=? OR event_type=?)', [section, eventType, '*']))
    await run('INSERT OR IGNORE INTO auto_runs(id,workflow_id,event_id,state,cursor,due,attempts,error,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [randomUUID(), rule.id, eid, 'pending', 0, now, 0, null, now]);
  return eid;
}

// ---------------- schedules (in the creator's time zone)
async function tz() { return (await settings.get('OMNIA_TIMEZONE')) || 'Asia/Manila'; }
function localParts(ts, zone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, minutes: +p.hour * 60 + +p.minute };
}
function slot(def, now, zone) {
  const s = def.schedule || {};
  if (s.every_minutes) return String(Math.floor(now / (s.every_minutes * 60)));
  if (s.daily_at) { const lp = localParts(now, zone), [h, m] = s.daily_at.split(':').map(Number); return lp.minutes >= h * 60 + m ? lp.date : null; }
  return null;
}
function nextSchedule(def, now, zone) {
  const s = def.schedule || {};
  if (s.every_minutes) { const p = s.every_minutes * 60; return (Math.floor(now / p) + 1) * p; }
  if (s.daily_at) { const lp = localParts(now, zone), [h, m] = s.daily_at.split(':').map(Number); let d = (h * 60 + m - lp.minutes) * 60; if (d <= 0) d += 86400; return Math.floor(now) + d - (Math.floor(now) % 60); }
  return null;
}
async function fireSchedules(now = t()) {
  const zone = await tz(); let fired = 0;
  for (const rule of await all("SELECT * FROM auto_workflows WHERE enabled=1 AND section='schedule'")) {
    const def = JSON.parse(rule.definition), sl = slot(def, now, zone); if (sl == null) continue;
    const eid = `schedule:${rule.id}:${sl}`, lp = localParts(now, zone);
    if ((await run('INSERT OR IGNORE INTO auto_events VALUES(?,?,?,?,?)', [eid, 'schedule', rule.event_type, JSON.stringify({ status: 'scheduled', slot: sl, time: `${lp.date} ${lp.hm}` }), now])).changes) {
      await run('INSERT OR IGNORE INTO auto_runs(id,workflow_id,event_id,state,cursor,due,attempts,error,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [randomUUID(), rule.id, eid, 'pending', 0, now, 0, null, now]); fired++;
    }
  }
  return fired;
}

// ---------------- execution
const step = (r, idx, state, detail = '') => run('INSERT INTO auto_steps(run_id,step_index,status,detail,created_at) VALUES(?,?,?,?,?)', [r.id, idx, state, String(detail).slice(0, 1000), t()]);
function resolved(field, r, payload, vars) { field = String(field || ''); if (field.startsWith('var.')) return vars[field.slice(4)]; if (field.startsWith('payload.')) return payload[field.slice(8)]; if (['section', 'event_type'].includes(field)) return r[field]; return payload[field]; }
const render = (text, r, payload, vars) => String(text ?? '').replace(PLACEHOLDER, (_, k) => { let v = resolved(k, r, payload, vars); if (v == null && !k.includes('.')) v = vars[k]; return v == null ? '' : String(v); });
function matches(s, r, payload, vars) {
  const actual = resolved(s.field, r, payload, vars), value = render(s.value || '', r, payload, vars), op = s.operator || 'equals';
  if (op === 'greater_than' || op === 'less_than') { const a = parseFloat(actual), b = parseFloat(value); if (isNaN(a) || isNaN(b)) return false; return op === 'greater_than' ? a > b : a < b; }
  const empty = actual == null || actual === '' || (Array.isArray(actual) && !actual.length);
  if (op === 'is_empty') return empty; if (op === 'is_not_empty') return !empty;
  if (op === 'contains') return String(actual ?? '').toLowerCase().includes(value.toLowerCase());
  if (op === 'not_contains') return !String(actual ?? '').toLowerCase().includes(value.toLowerCase());
  const eq = String(actual ?? '').toLowerCase() === value.toLowerCase(); return op === 'equals' ? eq : !eq;
}
function branchIndex(steps, pos, seekElse) { let depth = 0; for (let i = pos + 1; i < steps.length; i++) { const k = steps[i].type; if (k === 'if') depth++; else if (k === 'end_if') { if (!depth) return i; depth--; } else if (k === 'else' && !depth && seekElse) return i; } throw new Error('Malformed branch'); }
class RetryLater extends Error {}
async function webhook(s, r, payload, vars, wfName) {
  checkWebhook(s.url);
  const text = render(s.message || 'OMNIA · {{section}} · {{event_type}}', r, payload, vars), fmt = s.format || 'json';
  const body = fmt === 'slack' ? { text } : fmt === 'discord' ? { content: text.slice(0, 2000) } : { source: 'omnia', workflow: wfName, section: r.section, event_type: r.event_type, message: text, payload, variables: vars, time: t() };
  let res; const c = new AbortController(), tm = setTimeout(() => c.abort(), 10000);
  try { res = await fetch(s.url, { method: 'POST', redirect: 'manual', signal: c.signal, headers: { 'content-type': 'application/json', 'user-agent': 'OMNIA-Automation/1.0' }, body: JSON.stringify(body) }); }
  catch (e) { throw new RetryLater(`Webhook unreachable (${e.name})`); } finally { clearTimeout(tm); }
  if (res.status >= 500 || res.status === 429) throw new RetryLater(`Webhook HTTP ${res.status}`);
  if (res.status >= 400) throw new Error(`Webhook rejected the request (HTTP ${res.status}); check the URL`);
  return `HTTP ${res.status}`;
}
async function execute(r, steps, payload, vars, wfName) {
  let cursor = r.cursor, ops = 0;
  const saveVars = () => run('INSERT OR REPLACE INTO auto_run_context(run_id,variables) VALUES(?,?)', [r.id, JSON.stringify(vars)]);
  while (cursor < steps.length) {
    if (++ops > 120) throw new Error('Execution limit reached');
    const s = steps[cursor], k = s.type;
    if (['condition', 'filter', 'if'].includes(k)) {
      const ok = matches(s, r, payload, vars); await step(r, cursor, ok ? 'passed' : 'skipped', `${s.field} ${s.operator} ${s.value || ''} → ${ok ? 'True' : 'False'}`);
      if (!ok) { if (k === 'if') { cursor = branchIndex(steps, cursor, true) + 1; continue; } await run('UPDATE auto_runs SET state=?,cursor=? WHERE id=?', ['skipped', cursor + 1, r.id]); return; }
    } else if (k === 'else') { cursor = branchIndex(steps, cursor, false) + 1; continue; }
    else if (k === 'end_if') await step(r, cursor, 'completed', 'branch joined');
    else if (k === 'wait') { const due = t() + parseInt(s.seconds); await step(r, cursor, 'waiting', 'until ' + new Date(due * 1000).toISOString().replace('T', ' ').slice(0, 19)); await run('UPDATE auto_runs SET cursor=?,due=? WHERE id=?', [cursor + 1, due, r.id]); return; }
    else if (['set_variable', 'increment', 'format_text'].includes(k)) {
      if (k === 'increment') vars[s.key] = (parseFloat(vars[s.key] || 0) || 0) + (parseFloat(render(s.value || '', r, payload, vars)) || 1);
      else if (k === 'format_text') vars[s.key] = render(s.template || '', r, payload, vars).replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, n) => vars[n] != null ? String(vars[n]) : m);
      else vars[s.key] = render(s.value || '', r, payload, vars).slice(0, 2000);
      if (JSON.stringify(vars).length > 16384) throw new Error('Variable storage limit exceeded');
      await saveVars(); await step(r, cursor, 'completed', `${k} ${s.key}`);
    } else if (k === 'notify') {
      const nid = createHash('sha1').update(r.id + ':' + cursor).digest('hex'), title = render(s.title, r, payload, vars).slice(0, 160);
      await run('INSERT OR IGNORE INTO auto_notifications(id,section,title,message,workflow_id,event_id,created_at) VALUES(?,?,?,?,?,?,?)', [nid, r.section, title, render(s.message || '', r, payload, vars).slice(0, 2000), r.workflow_id, r.event_id, t()]);
      await step(r, cursor, 'completed', 'notification: ' + title);
    } else if (k === 'webhook') await step(r, cursor, 'completed', 'webhook ' + await webhook(s, r, payload, vars, wfName));
    else if (k === 'publish_draft') {
      const pub = await import('./publishing.js').catch(() => null);
      if (!pub?.draftFromAutomation) throw new Error('Publishing is not available yet in the cloud version');
      await step(r, cursor, 'completed', await pub.draftFromAutomation(s, payload, vars, x => render(x, r, payload, vars))); await saveVars();
    } else if (k === 'audit') await step(r, cursor, 'completed', render(s.message || 'audit checkpoint', r, payload, vars).slice(0, 500));
    else if (k === 'stop') { await step(r, cursor, 'completed', 'explicit stop'); await run('UPDATE auto_runs SET state=?,cursor=? WHERE id=?', ['completed', cursor + 1, r.id]); return; }
    cursor++; await run('UPDATE auto_runs SET cursor=? WHERE id=?', [cursor, r.id]);
  }
  await run('UPDATE auto_runs SET state=?,cursor=?,error=NULL WHERE id=?', ['completed', cursor, r.id]);
}
export async function processDue(limit = 25, onlyRun = null) {
  await ensure(); let done = 0;
  const pending = await all(`SELECT r.*, w.definition, w.name AS workflow_name, e.payload, e.section, e.event_type FROM auto_runs r JOIN auto_workflows w ON w.id=r.workflow_id JOIN auto_events e ON e.id=r.event_id WHERE r.state='pending' AND r.due<=? AND (w.enabled=1 OR r.manual=1)${onlyRun ? ' AND r.id=?' : ''} ORDER BY r.due LIMIT ?`, onlyRun ? [t(), onlyRun, limit] : [t(), limit]);
  for (const p of pending) {
    // claim the run so two serverless instances never execute the same step twice
    const claimed = await run("UPDATE auto_runs SET state='running' WHERE id=? AND state='pending'", [p.id]); if (!claimed.changes) continue;
    const r = { ...p, state: 'running' };
    try {
      const ctx = await one('SELECT variables FROM auto_run_context WHERE run_id=?', [r.id]);
      await execute(r, JSON.parse(r.definition).steps, JSON.parse(r.payload), ctx ? JSON.parse(ctx.variables) : {}, r.workflow_name);
      await run("UPDATE auto_runs SET state='pending' WHERE id=? AND state='running'", [r.id]); // a wait step leaves it pending for later
      done++;
    } catch (e) {
      if (e instanceof RetryLater) {
        const attempts = r.attempts + 1;
        if (attempts > RETRY_DELAYS.length) await run('UPDATE auto_runs SET state=?,error=?,attempts=? WHERE id=?', ['failed', String(e.message).slice(0, 500) + ' — gave up after retries', attempts, r.id]);
        else { const delay = RETRY_DELAYS[attempts - 1]; await step(r, r.cursor, 'retrying', `${e.message}; retry in ${delay}s`); await run("UPDATE auto_runs SET state='pending',due=?,attempts=?,error=? WHERE id=?", [t() + delay, attempts, String(e.message).slice(0, 500), r.id]); }
      } else { const msg = e instanceof HttpError || e.message ? e.message : 'Unexpected error'; await step(r, r.cursor, 'failed', msg); await run('UPDATE auto_runs SET state=?,error=? WHERE id=?', ['failed', String(msg).slice(0, 500), r.id]); }
    }
  }
  return done;
}
let lastTick = 0;
export async function tick(force = false) {
  if (!force && Date.now() - lastTick < 20000) return 0;
  lastTick = Date.now(); await ensure();
  await run("UPDATE auto_runs SET state='pending' WHERE state='running' AND created_at < ?", [t() - 600]); // recover runs cut off by a timeout
  await fireSchedules(); const n = await processDue();
  try { const pub = await import('./publishing.js'); await pub.tick(); } catch {}
  return n;
}
async function runSteps(id) { return all('SELECT step_index,status,detail,created_at FROM auto_steps WHERE run_id=? ORDER BY id', [id]); }
async function snapshot() {
  const totals = Object.fromEntries((await all('SELECT state,COUNT(*) n FROM auto_runs GROUP BY state')).map(r => [r.state, r.n]));
  const notifications = await all('SELECT * FROM auto_notifications ORDER BY created_at DESC LIMIT 60');
  const unread = (await one('SELECT COUNT(*) n FROM auto_notifications WHERE read=0')).n;
  const runs = await all('SELECT r.id,r.workflow_id,r.event_id,r.state,r.cursor,r.due,r.error,r.created_at,r.attempts,r.manual,w.name,e.event_type FROM auto_runs r JOIN auto_workflows w ON r.workflow_id=w.id LEFT JOIN auto_events e ON e.id=r.event_id ORDER BY r.created_at DESC LIMIT 100');
  return { totals, notifications, unread, runs };
}

export async function automationRoutes(method, parts, b, url) {
  await ensure();
  const [, a, id, sub] = parts;
  if (a === 'tick') { const n = await tick(true); return json({ ok: true, processed: n }); }
  await tick();
  if (a === 'overview') {
    const zone = await tz(), workflows = await listWorkflows();
    for (const w of workflows) if (w.section === 'schedule' && w.enabled) w.next_run = nextSchedule({ schedule: w.schedule || {} }, t(), zone);
    return json({ workflows, ...(await snapshot()), timezone: zone });
  }
  if (a === 'catalog') {
    let destinations = [];
    try { const pub = await import('./publishing.js'); destinations = await pub.publicAccounts(); } catch {}
    return json({ events: Object.fromEntries(Object.entries(EVENT_CATALOG).map(([k, v]) => [k, v.map(([value, label]) => ({ value, label }))])), templates: TEMPLATES.map(({ key, name, description, section }) => ({ key, name, description, section })), destinations });
  }
  if (a === 'templates') { const tp = TEMPLATES.find(x => x.key === id); if (!tp) return fail(404, 'Unknown template'); const { key, description, ...rest } = tp; return json(JSON.parse(JSON.stringify(rest))); }
  if (a === 'workflows' && !id && method === 'POST') return json({ id: await saveWorkflow(b) });
  if (a === 'workflows' && id) {
    const rule = (await listWorkflows()).find(r => r.id === id); if (!rule) return fail(404, 'Workflow not found');
    if (sub === 'enabled' && method === 'PUT') { if (b.enabled) { try { validate(rule); } catch (e) { return fail(400, 'Fix before publishing: ' + e.message); } } await run('UPDATE auto_workflows SET enabled=? WHERE id=?', [b.enabled ? 1 : 0, id]); return json({ enabled: !!b.enabled }); }
    if (!sub && method === 'DELETE') { await run('DELETE FROM auto_workflows WHERE id=?', [id]); await run("UPDATE auto_runs SET state='cancelled' WHERE workflow_id=? AND state='pending'", [id]); return json({ deleted: true }); }
    if (sub === 'duplicate') return json({ id: await saveWorkflow({ name: (rule.name + ' (copy)').slice(0, 100), section: rule.section, event_type: rule.event_type, steps: rule.steps, schedule: rule.schedule }) });
    if (sub === 'test') {
      const sample = { method: 'TEST', status: 'test', title: 'Sample post title', post_id: 'test', client_id: 'default', account: 'sample-account', filename: 'sample.mp4', test: true };
      const eid = 'test:' + randomUUID(), rid = randomUUID(), now = t();
      await run('INSERT INTO auto_events VALUES(?,?,?,?,?)', [eid, rule.section, rule.event_type !== '*' ? rule.event_type : 'test', JSON.stringify(sample), now]);
      await run('INSERT INTO auto_runs(id,workflow_id,event_id,state,cursor,due,attempts,error,created_at,manual) VALUES(?,?,?,?,?,?,?,?,?,1)', [rid, id, eid, 'pending', 0, now, 0, null, now]);
      await processDue(25, rid);
      return json({ event_id: eid, run_id: rid, steps: await runSteps(rid) });
    }
  }
  if (a === 'runs' && id && !sub) return json({ steps: await runSteps(id) });
  if (a === 'runs' && sub === 'retry') { const r = await run("UPDATE auto_runs SET state='pending',due=?,attempts=0,error=NULL WHERE id=? AND state='failed'", [t(), id]); if (!r.changes) return fail(400, 'Only failed runs can be retried'); await processDue(25, id); return json({ steps: await runSteps(id) }); }
  if (a === 'notifications' && !id) { const since = parseFloat(url.searchParams.get('since') || '0') || 0; return json({ notifications: await all('SELECT * FROM auto_notifications WHERE created_at>? ORDER BY created_at LIMIT 20', [since]), unread: (await one('SELECT COUNT(*) n FROM auto_notifications WHERE read=0')).n, now: t() }); }
  if (a === 'notifications' && id === 'read') { await run('UPDATE auto_notifications SET read=1 WHERE read=0'); return json({ unread: 0 }); }
  if (a === 'timezone' && method === 'PUT') { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { return fail(400, 'Unknown time zone'); } await settings.set({ OMNIA_TIMEZONE: b.timezone }); return json({ timezone: b.timezone }); }
  return null;
}
