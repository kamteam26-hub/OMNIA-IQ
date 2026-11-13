// Sign in, first-run admin setup, sign out and password change.
import { json, fail } from '../http.js';
import { one, run } from '../db.js';
import * as A from '../auth.js';
export async function accountRoutes(method, parts, b, url, request) {
  const a = parts[1];
  if (a === 'setup' && method === 'POST') { const u = await A.setupAdmin(b.setup_key, b.username, b.password, b.display_name); return json({ ok: true, user: { username: u.username, role: u.role } }, 200, { 'set-cookie': await A.createSession(u, request) }); }
  if (a === 'login' && method === 'POST') { const u = await A.login(b.username, b.password, request); return json({ ok: true, user: { username: u.username, display_name: u.display_name, role: u.role, must_change_password: !!u.must_change_password } }, 200, { 'set-cookie': await A.createSession(u, request) }); }
  if (a === 'logout') { await A.revokeSession(request); return json({ ok: true }, 200, { 'set-cookie': A.clearCookie }); }
  const me = A.currentUser(); if (!me) return fail(401, 'Sign in required');
  if (a === 'me') return json({ user: me });
  if (a === 'password' && method === 'POST') {
    const u = await one('SELECT * FROM users WHERE id=?', [me.id]);
    try { await A.login(u.username, b.current_password, request); } catch { return fail(401, 'Current password is not correct.'); }
    const bad = await A.checkPasswordPolicy(b.new_password, u.username); if (bad) return fail(422, bad);
    await run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', [await A.hashPassword(b.new_password), me.id]);
    await run('UPDATE user_sessions SET revoked=1 WHERE user_id=? AND id!=?', [me.id, me.session_id]);
    await A.audit(me, 'password_changed'); return json({ ok: true });
  }
  return null;
}
