// Admin dashboard API: users & roles, sessions, sign-in activity, audit log, security policy,
// usage & quotas, system health and maintenance. Reachable only by role=admin (checked in api/index.js).
import { json, fail } from '../http.js';
import { all, one, run, dbKind } from '../db.js';
import { store } from '../storage.js';
import * as llm from '../llm.js';
import * as A from '../auth.js';

const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;
const adminCount = async () => (await one("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1")).n;
const userRow = id => one('SELECT id,username,display_name,role,active,must_change_password,created_at,last_login FROM users WHERE id=?', [id]);

export async function adminRoutes(method, parts, b, url, request) {
  const me = A.currentUser(), [, a, id, sub] = parts, q = k => url.searchParams.get(k), t = Date.now() / 1000;
  const today = new Date().toISOString().slice(0, 10);

  if (a === 'overview') {
    const status = await llm.providerStatus();
    const counts = await one(`SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM users WHERE active=1) active_users,
      (SELECT COUNT(*) FROM user_sessions WHERE revoked=0 AND expires_at>?) sessions, (SELECT COUNT(*) FROM conversations) conversations,
      (SELECT COUNT(*) FROM tasks) projects, (SELECT COUNT(*) FROM tasks WHERE status='running') running_projects,
      (SELECT COALESCE(SUM(size_bytes),0) FROM uploads) storage_bytes, (SELECT COUNT(*) FROM uploads) files,
      (SELECT COUNT(*) FROM login_attempts WHERE ok=0 AND time>?) failed_logins_24h,
      (SELECT COALESCE(SUM(n),0) FROM usage_counters WHERE day=? AND kind='ai') ai_today, (SELECT COALESCE(SUM(n),0) FROM usage_counters WHERE day=? AND kind='video') videos_today`, [t, t - 86400, today, today]);
    const warnings = [];
    if (!status.ready) warnings.push({ level: 'error', text: 'No AI provider is working. Add a free key under Settings → AI providers, or add a card in Vercel AI Gateway.' });
    if (counts.failed_logins_24h >= 10) warnings.push({ level: 'warn', text: `${counts.failed_logins_24h} failed sign-ins in the last 24 hours. Review Sign-in activity.` });
    if ((await adminCount()) < 2) warnings.push({ level: 'info', text: 'Only one active administrator. Consider a second admin account as a backup.' });
    if (me.must_change_password) warnings.push({ level: 'warn', text: 'Change your temporary password.' });
    return json({ counts, warnings, health: { database: await dbKind(), storage: store.kind, ai_ready: status.ready, providers: status.providers.filter(p => p.ready).map(p => `${p.name} · ${p.model}`) }, recent: await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 12'), policy: await A.policy() });
  }

  if (a === 'users') {
    if (!id && method === 'GET') {
      const users = await all(`SELECT u.id,u.username,u.display_name,u.role,u.active,u.must_change_password,u.created_at,u.last_login,
        (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id=u.id AND s.revoked=0 AND s.expires_at>?) sessions,
        (SELECT COALESCE(SUM(size_bytes),0) FROM uploads WHERE owner_id=u.id) storage_bytes,
        (SELECT COUNT(*) FROM conversations WHERE owner_id=u.id) conversations, (SELECT COUNT(*) FROM tasks WHERE owner_id=u.id) projects,
        (SELECT COALESCE(SUM(n),0) FROM usage_counters WHERE user_id=u.id AND day=? AND kind='ai') ai_today,
        (SELECT COALESCE(SUM(n),0) FROM usage_counters WHERE user_id=u.id AND day=? AND kind='video') videos_today
        FROM users u ORDER BY u.role, u.username`, [t, today, today]);
      return json({ users, me: me.id });
    }
    if (!id && method === 'POST') {
      const username = String(b.username || '').trim(); if (!USERNAME.test(username)) return fail(422, 'Username: 3-40 letters, numbers, dot, dash or underscore.');
      if (await one('SELECT 1 x FROM users WHERE username=? COLLATE NOCASE', [username])) return fail(409, 'That username is taken.');
      const bad = await A.checkPasswordPolicy(b.password, username); if (bad) return fail(422, bad);
      const role = b.role === 'admin' ? 'admin' : 'user';
      const nid = (await run('INSERT INTO users(username,display_name,password_hash,role,must_change_password) VALUES(?,?,?,?,?)', [username, String(b.display_name || username).slice(0, 80), await A.hashPassword(b.password), role, b.must_change_password === false ? 0 : 1])).lastId;
      await A.audit(me, 'user_created', { detail: `${username} (${role})` }); return json(await userRow(nid));
    }
    const target = await userRow(Number(id)); if (!target) return fail(404, 'User not found');
    if (!sub && method === 'PATCH') {
      const role = b.role != null ? (b.role === 'admin' ? 'admin' : 'user') : target.role, active = b.active != null ? (b.active ? 1 : 0) : target.active;
      if (target.id === me.id && (role !== 'admin' || !active)) return fail(409, 'You cannot remove your own admin access or disable yourself.');
      if (target.role === 'admin' && (role !== 'admin' || !active) && (await adminCount()) <= 1) return fail(409, 'Keep at least one active administrator.');
      await run('UPDATE users SET display_name=?, role=?, active=? WHERE id=?', [b.display_name != null ? String(b.display_name).slice(0, 80) : target.display_name, role, active, target.id]);
      if (!active || role !== target.role) await run('UPDATE user_sessions SET revoked=1 WHERE user_id=?', [target.id]);
      await A.audit(me, 'user_updated', { detail: `${target.username}: role=${role} active=${active}` }); return json(await userRow(target.id));
    }
    if (sub === 'reset-password' && method === 'POST') {
      const bad = await A.checkPasswordPolicy(b.password, target.username); if (bad) return fail(422, bad);
      await run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [await A.hashPassword(b.password), target.id]);
      await run('UPDATE user_sessions SET revoked=1 WHERE user_id=?', [target.id]);
      await A.audit(me, 'password_reset', { detail: target.username }); return json({ ok: true });
    }
    if (sub === 'revoke-sessions' && method === 'POST') {
      const r = await run(target.id === me.id ? 'UPDATE user_sessions SET revoked=1 WHERE user_id=? AND id!=?' : 'UPDATE user_sessions SET revoked=1 WHERE user_id=?', target.id === me.id ? [target.id, me.session_id] : [target.id]);
      await A.audit(me, 'sessions_revoked', { detail: `${target.username} (${r.changes})` }); return json({ revoked: r.changes });
    }
    if (!sub && method === 'DELETE') {
      if (target.id === me.id) return fail(409, 'You cannot delete your own account.');
      if (target.role === 'admin' && (await adminCount()) <= 1) return fail(409, 'Keep at least one active administrator.');
      if (url.searchParams.get('confirm') !== 'true') return fail(400, 'Deleting a user cannot be undone. Repeat with confirm=true.');
      // Their work is kept and handed to the admin who deleted the account, so nothing is lost silently.
      for (const tbl of ['conversations', 'uploads', 'memories', 'tasks']) await run(`UPDATE ${tbl} SET owner_id=? WHERE owner_id=?`, [me.id, target.id]);
      await run('DELETE FROM user_sessions WHERE user_id=?', [target.id]); await run('DELETE FROM usage_counters WHERE user_id=?', [target.id]); await run('DELETE FROM users WHERE id=?', [target.id]);
      await A.audit(me, 'user_deleted', { detail: `${target.username} (data moved to ${me.username})` }); return json({ deleted: true, data_moved_to: me.username });
    }
  }

  if (a === 'sessions') {
    if (!id && method === 'GET') return json({ sessions: (await all('SELECT s.id,s.user_id,u.username,s.created_at,s.last_seen,s.expires_at,s.ip,s.user_agent FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.revoked=0 AND s.expires_at>? ORDER BY s.last_seen DESC LIMIT 200', [t])).map(s => ({ ...s, id: s.id.slice(0, 8) + '…', key: s.id, current: s.id === me.session_id })) });
    if (id && method === 'DELETE') {
      if (id === me.session_id) return fail(409, 'Use Sign out to end your own current session.');
      const r = await run('UPDATE user_sessions SET revoked=1 WHERE id=?', [id]); await A.audit(me, 'session_revoked', { detail: id.slice(0, 8) }); return json({ revoked: r.changes > 0 });
    }
  }
  if (a === 'logins') return json({ attempts: await all('SELECT username,ip,ok,time FROM login_attempts ORDER BY id DESC LIMIT 200') });

  if (a === 'audit') {
    const cond = [], args = [];
    if (q('user')) { cond.push('username=?'); args.push(q('user')); }
    if (q('action')) { cond.push('action=?'); args.push(q('action')); }
    if (q('q')) { cond.push('(path LIKE ? OR detail LIKE ?)'); args.push(`%${q('q')}%`, `%${q('q')}%`); }
    if (q('before')) { cond.push('id<?'); args.push(Number(q('before'))); }
    const rows = await all(`SELECT * FROM audit_log${cond.length ? ' WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, [...args, Math.min(500, Number(q('limit')) || 100)]);
    if (id === 'export') {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['time,username,action,method,path,status,ip,detail', ...rows.map(r => [new Date(r.time * 1000).toISOString(), r.username, r.action, r.method, r.path, r.status, r.ip, r.detail].map(esc).join(','))].join('\n');
      await A.audit(me, 'audit_exported'); return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="omnia-audit-${today}.csv"` } });
    }
    return json({ entries: rows, actions: (await all('SELECT DISTINCT action FROM audit_log ORDER BY action')).map(r => r.action) });
  }

  if (a === 'security') {
    if (method === 'PUT') { const p = await A.savePolicy(b); await A.audit(me, 'policy_changed', { detail: JSON.stringify(p) }); return json({ policy: p }); }
    return json({ policy: await A.policy(), defaults: A.DEFAULT_POLICY, setup_key_configured: !!process.env.OMNIA_ACCESS_KEY });
  }

  if (a === 'usage') return json({ days: await all('SELECT c.day,c.kind,c.user_id,u.username,c.n FROM usage_counters c LEFT JOIN users u ON u.id=c.user_id WHERE c.day>=? ORDER BY c.day DESC', [new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10)]), policy: await A.policy() });

  if (a === 'maintenance' && method === 'POST') {
    const p = await A.policy(), out = {};
    out.audit = (await run('DELETE FROM audit_log WHERE time<?', [t - p.audit_days * 86400])).changes;
    out.login_attempts = (await run('DELETE FROM login_attempts WHERE time<?', [t - 30 * 86400])).changes;
    out.sessions = (await run('DELETE FROM user_sessions WHERE expires_at<? OR revoked=1', [t])).changes;
    out.usage = (await run('DELETE FROM usage_counters WHERE day<?', [new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)])).changes;
    try { out.agent_runs = (await run("DELETE FROM agent_runs WHERE updated_at < datetime('now','-30 days')")).changes; } catch {}
    try { out.automation_events = (await run('DELETE FROM auto_events WHERE created_at<? AND id NOT IN (SELECT event_id FROM auto_runs WHERE state=\'pending\')', [t - 30 * 86400])).changes; } catch {}
    await A.audit(me, 'maintenance', { detail: JSON.stringify(out) }); return json({ ok: true, removed: out });
  }
  return null;
}
