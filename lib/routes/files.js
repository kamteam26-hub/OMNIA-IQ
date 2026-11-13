import { createHash } from 'node:crypto';
import { json, fail } from '../http.js';
import { all, one, run } from '../db.js';
import { store } from '../storage.js';
import { extractText } from '../extract.js';
import { ownerId, checkStorage } from '../auth.js';

export const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel request body limit is 4.5 MB
const mediaType = (mime, name) => /^image\//.test(mime) || /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : /^video\//.test(mime) || /\.(mp4|mov|webm|mkv)$/i.test(name) ? 'video' : /^audio\//.test(mime) || /\.(mp3|wav|m4a|ogg|aac)$/i.test(name) ? 'audio' : 'document';

export async function saveUpload(file, { mediaOnly = false } = {}) {
  if (!file || typeof file === 'string') throw Object.assign(new Error('No file received'), { status: 400 });
  if (file.size > MAX_UPLOAD) throw Object.assign(new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB. The cloud version accepts files up to 4 MB per upload.`), { status: 413 });
  await checkStorage(file.size);
  const buf = Buffer.from(await file.arrayBuffer()), mime = file.type || 'application/octet-stream', mt = mediaType(mime, file.name);
  if (mediaOnly && mt === 'document') throw Object.assign(new Error('Unsupported media type. Upload an image, video or audio file.'), { status: 415 });
  const saved = await store.put(`uploads/${Date.now()}/${file.name.replace(/[^\w.\- ]+/g, '_')}`, buf, mime);
  const checksum = createHash('sha256').update(buf).digest('hex');
  const text = mt === 'document' ? extractText(file.name, mime, buf) : '';
  const id = (await run('INSERT INTO uploads(filename,local_file_id,size_bytes,media_type,mime_type,checksum_sha256,extracted_text,owner_id) VALUES (?,?,?,?,?,?,?,?)', [file.name, saved.url, buf.length, mt, mime, checksum, text, ownerId()])).lastId;
  return { id, filename: file.name, file_id: saved.url, local_file_id: saved.url, size_bytes: buf.length, media_type: mt, mime_type: mime, checksum_sha256: checksum };
}

const LIB_SELECT = `SELECT u.id,u.filename,u.local_file_id,u.size_bytes,u.media_type,u.mime_type,u.checksum_sha256,u.created_at,COALESCE(m.folder,'') AS folder,COALESCE(m.tags,'[]') AS tags,COALESCE(m.favorite,0) AS favorite,m.trashed_at FROM uploads u LEFT JOIN file_library m ON m.upload_id=u.id`;
async function libraryUpdate(id, { folder, tags, favorite, trash } = {}) {
  if (!(await one('SELECT 1 x FROM uploads WHERE id=? AND owner_id=?', [id, ownerId()]))) return null;
  await run('INSERT OR IGNORE INTO file_library(upload_id) VALUES(?)', [id]);
  const ch = [], args = [], detail = {};
  if (folder != null) { ch.push('folder=?'); args.push(folder); detail.folder = folder; }
  if (tags != null) { ch.push('tags=?'); args.push(JSON.stringify(tags)); detail.tags = tags; }
  if (favorite != null) { ch.push('favorite=?'); args.push(favorite ? 1 : 0); detail.favorite = favorite; }
  if (trash != null) { ch.push('trashed_at=' + (trash ? 'CURRENT_TIMESTAMP' : 'NULL')); detail.trash = trash; }
  if (ch.length) {
    await run(`UPDATE file_library SET ${ch.join(',')},updated_at=CURRENT_TIMESTAMP WHERE upload_id=?`, [...args, id]);
    await run('INSERT INTO file_library_events(upload_id,operation,detail) VALUES(?,?,?)', [id, 'metadata_change', JSON.stringify(detail)]);
  }
  const r = await one(`SELECT u.id,u.filename,COALESCE(m.folder,'') folder,m.tags,m.favorite,m.trashed_at FROM uploads u JOIN file_library m ON m.upload_id=u.id WHERE u.id=?`, [id]);
  return { ...r, tags: JSON.parse(r.tags || '[]') };
}
async function deleteForever(id) {
  const r = await one(`SELECT u.local_file_id, m.trashed_at FROM uploads u LEFT JOIN file_library m ON m.upload_id=u.id WHERE u.id=? AND u.owner_id=?`, [id, ownerId()]);
  if (!r) throw Object.assign(new Error('File not found'), { status: 404 });
  if (!r.trashed_at) throw Object.assign(new Error('Move the file to Trash before deleting it forever.'), { status: 409 });
  if (await one('SELECT 1 x FROM project_media WHERE local_file_id=?', [r.local_file_id])) throw Object.assign(new Error('This file is used by a project. Remove it from the project first.'), { status: 409 });
  try { await store.del([r.local_file_id]); } catch {}
  await run('DELETE FROM file_library WHERE upload_id=?', [id]); await run('DELETE FROM uploads WHERE id=?', [id]);
  return { ok: true, deleted: id };
}

export async function filesRoutes(method, parts, b, url, request) {
  const [, a, id, sub] = parts;
  if ((a === 'upload' || a === 'media-upload') && method === 'POST') {
    const form = await request.formData().catch(() => null);
    const saved = await saveUpload(form?.get('document'), { mediaOnly: a === 'media-upload' });
    return json(a === 'upload' ? { filename: saved.filename, file_id: saved.file_id, size_bytes: saved.size_bytes } : { ...saved, polish: { applied: [], note: 'Cloud upload stored as-is.' } });
  }
  if (a === 'uploads') return json({ uploads: await all(`SELECT u.filename,u.local_file_id,u.size_bytes,u.media_type,u.mime_type,u.created_at FROM uploads u LEFT JOIN file_library m ON m.upload_id=u.id WHERE m.trashed_at IS NULL AND u.owner_id=? ORDER BY u.id DESC`, [ownerId()]) });
  if (a === 'media') return json({ media: await all(`SELECT u.filename,u.local_file_id,u.size_bytes,u.media_type,u.mime_type,u.created_at FROM uploads u LEFT JOIN file_library m ON m.upload_id=u.id WHERE m.trashed_at IS NULL AND u.owner_id=? AND u.media_type IN ('image','video','audio') ORDER BY u.id DESC`, [ownerId()]) });
  if (a === 'library') {
    if (id === 'trash' && sub === 'empty') {
      if (!b.confirm) return fail(400, 'Emptying the Trash cannot be undone. Send {"confirm": true}.');
      const rows = await all('SELECT f.upload_id FROM file_library f JOIN uploads u ON u.id=f.upload_id WHERE f.trashed_at IS NOT NULL AND u.owner_id=?', [ownerId()]); const deleted = [], kept = [];
      for (const r of rows) { try { await deleteForever(r.upload_id); deleted.push(r.upload_id); } catch (e) { kept.push({ id: r.upload_id, reason: e.message }); } }
      return json({ ok: true, deleted: deleted.length, kept });
    }
    if (!id && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase(), folder = url.searchParams.get('folder'), trash = url.searchParams.get('trash') === 'true', fav = url.searchParams.get('favorite') === 'true';
      let sql = LIB_SELECT + ' WHERE u.owner_id=? AND ' + (trash ? 'm.trashed_at IS NOT NULL' : 'm.trashed_at IS NULL'); const args = [ownerId()];
      if (q) { sql += " AND (lower(u.filename) LIKE ? OR lower(COALESCE(m.tags,'')) LIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
      if (folder != null) { sql += " AND COALESCE(m.folder,'')=?"; args.push(folder); }
      if (fav) sql += ' AND m.favorite=1';
      sql += ' ORDER BY u.id DESC LIMIT ?'; args.push(Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 200, 500)));
      const used = new Set((await all('SELECT local_file_id FROM project_media')).map(r => r.local_file_id));
      return json({ files: (await all(sql, args)).map(r => ({ ...r, tags: JSON.parse(r.tags || '[]'), missing: false, in_use: used.has(r.local_file_id) })) });
    }
    const uid = Number(id); if (!(uid >= 1)) return fail(404, 'File not found');
    if (!sub && method === 'PATCH') {
      let folder = b.folder; if (folder != null) { folder = String(folder).trim(); if (['.', '..'].includes(folder) || /[\/\\\x00-\x1f]/.test(folder)) return fail(422, 'Folder must be a simple name'); }
      let tags = b.tags; if (tags != null) { tags = [...new Set(tags.map(t => String(t).trim()))]; if (tags.some(t => !t || t.length > 40)) return fail(422, 'Invalid tag'); }
      const r = await libraryUpdate(uid, { folder, tags, favorite: b.favorite, trash: b.trashed }); return r ? json(r) : fail(404, 'File not found');
    }
    if (sub === 'history') { if (!(await libraryUpdate(uid))) return fail(404, 'File not found'); return json({ events: await all('SELECT operation,detail,created_at FROM file_library_events WHERE upload_id=? ORDER BY id DESC LIMIT 50', [uid]) }); }
    if (sub === 'download') {
      const r = await one('SELECT filename,local_file_id,mime_type FROM uploads WHERE id=? AND owner_id=?', [uid, ownerId()]); if (!r) return fail(404, 'File not found');
      const data = await store.read(r.local_file_id);
      return new Response(data, { headers: { 'content-type': r.mime_type || 'application/octet-stream', 'content-disposition': `attachment; filename="${r.filename.replace(/"/g, '')}"` } });
    }
    if (!sub && method === 'DELETE') { if (url.searchParams.get('confirm') !== 'true') return fail(400, 'Deleting forever cannot be undone. Repeat the request with confirm=true.'); return json(await deleteForever(uid)); }
  }
  if (a === 'storage' && !id && method === 'GET') {
    const lib = await one(`SELECT COUNT(*) files, SUM(CASE WHEN m.trashed_at IS NOT NULL THEN 1 ELSE 0 END) trashed, COALESCE(SUM(CASE WHEN m.trashed_at IS NOT NULL THEN u.size_bytes ELSE 0 END),0) trashed_bytes, COALESCE(SUM(u.size_bytes),0) bytes FROM uploads u LEFT JOIN file_library m ON m.upload_id=u.id WHERE u.owner_id=?`, [ownerId()]);
    const art = await one('SELECT COUNT(*) n FROM task_artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.owner_id=?', [ownerId()]);
    return json({ library: { files: Number(lib.files) - Number(lib.trashed || 0), trashed: Number(lib.trashed || 0), trashed_bytes: Number(lib.trashed_bytes), missing: 0, missing_files: [] }, areas: { uploads: { bytes: Number(lib.bytes) }, artifacts: { bytes: 0, files: Number(art.n) }, projects: { bytes: 0 } }, orphans: { uploads: { count: 0, names: [] } }, storage: 'Vercel Blob (private)' });
  }
  if (a === 'storage' && id === 'recover') return json({ recovered: [], folder: 'Recovered' });
  return null;
}
