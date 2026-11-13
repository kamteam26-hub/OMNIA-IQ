// OMNIA IQ database layer — the same SQLite schema as v88.5.
// Production: Turso (libSQL) via TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.
// Local tests: Node's built-in node:sqlite (OMNIA_SQLITE path or in-memory).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT 'New conversation', instructions TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)`,
  `CREATE TABLE IF NOT EXISTS uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, local_file_id TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, media_type TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', duration_seconds REAL, width INTEGER, height INTEGER, checksum_sha256 TEXT NOT NULL DEFAULT '', extracted_text TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS file_library (upload_id INTEGER PRIMARY KEY, folder TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', favorite INTEGER NOT NULL DEFAULT 0, trashed_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS file_library_events (id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id INTEGER NOT NULL, operation TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'knowledge', content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'conversation', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS memory_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id INTEGER NOT NULL, operation TEXT NOT NULL, old_content TEXT, new_content TEXT, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', result TEXT NOT NULL DEFAULT '', completed INTEGER NOT NULL DEFAULT 0, last_script TEXT NOT NULL DEFAULT '', orchestration TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS project_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS task_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, filename TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS project_media (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, filename TEXT NOT NULL, local_file_id TEXT NOT NULL, media_type TEXT NOT NULL, media_role TEXT NOT NULL DEFAULT 'auto', mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', creator_note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, path TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
];

function nodeSqlite() {
  // eslint-disable-next-line no-undef
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(process.env.OMNIA_SQLITE || ':memory:');
  const norm = args => (args || []).map(v => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v));
  return {
    kind: 'sqlite',
    async all(sql, args) { return d.prepare(sql).all(...norm(args)).map(r => ({ ...r })); },
    async run(sql, args) { const r = d.prepare(sql).run(...norm(args)); return { lastId: Number(r.lastInsertRowid), changes: Number(r.changes) }; },
  };
}
async function turso() {
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const norm = args => (args || []).map(v => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v));
  const rows = r => r.rows.map(row => Object.fromEntries(r.columns.map((col, i) => {
    const v = row[i]; return [col, typeof v === 'bigint' ? Number(v) : v];
  })));
  return {
    kind: 'turso',
    async all(sql, args) { return rows(await c.execute({ sql, args: norm(args) })); },
    async run(sql, args) { const r = await c.execute({ sql, args: norm(args) }); return { lastId: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected }; },
  };
}

let ready;
export function db() {
  return (ready ||= (async () => {
    const d = process.env.TURSO_DATABASE_URL ? await turso() : nodeSqlite();
    for (const s of SCHEMA) await d.run(s);
    // columns added after the first cloud release
    const cols = new Set((await d.all('PRAGMA table_info(uploads)')).map(r => r.name));
    if (!cols.has('extracted_text')) await d.run(`ALTER TABLE uploads ADD COLUMN extracted_text TEXT NOT NULL DEFAULT ''`);
    return d;
  })().catch(e => { ready = null; throw e; }));
}
export const all = async (sql, args) => (await db()).all(sql, args);
export const one = async (sql, args) => (await all(sql, args))[0] || null;
export const run = async (sql, args) => (await db()).run(sql, args);
export const dbKind = async () => (await db()).kind;
