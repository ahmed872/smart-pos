const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { applySchema, MIGRATED_COLUMNS } = require('./schema.js');

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

class BackupValidationError extends Error {}

function removeSidecars(dbFile) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = dbFile + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
}

function hasSqliteHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    return read === buf.length && buf.equals(SQLITE_HEADER);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- Schema compatibility ----------
// The reference is built by running the application's own schema code (schema.js) on an
// empty in-memory database, so the rules below always match what db.js creates and expects.

function describeSchema(db) {
  const tables = new Map();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  for (const name of names) {
    const q = (pragma) => db.prepare(`PRAGMA ${pragma}(${JSON.stringify(name)})`).all();
    const list = db.prepare('PRAGMA table_list').all().find((t) => t.name === name && t.schema === 'main');
    const uniques = q('index_list').filter((i) => i.unique).map((i) => ({
      origin: i.origin,
      columns: db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name).join(','),
    }));
    tables.set(name, {
      withoutRowid: !!(list && list.wr),
      sql: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).sql || '',
      columns: new Map(q('table_xinfo').map((c) => [c.name, c])),
      uniques,
      foreignKeys: q('foreign_key_list').map((f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`).sort(),
    });
  }
  return tables;
}

let referenceSchema = null;
function getReferenceSchema() {
  if (!referenceSchema) {
    const mem = new Database(':memory:');
    try {
      applySchema(mem);
      referenceSchema = describeSchema(mem);
    } finally {
      mem.close();
    }
  }
  return referenceSchema;
}

const OPTIONAL_COLUMNS = new Set(MIGRATED_COLUMNS.map((m) => `${m.table}.${m.column}`));

// Returns a list of problems (empty when the backup's schema is compatible with this app).
function schemaProblems(db) {
  const expected = getReferenceSchema();
  const actual = describeSchema(db);
  const problems = [];

  for (const [table, ref] of expected) {
    const got = actual.get(table);
    if (!got) {
      problems.push(`جدول ناقص: ${table}`);
      continue;
    }
    if (got.withoutRowid) problems.push(`جدول غير متوافق: ${table}`);
    // Constraints the app never creates can make its normal inserts/updates fail.
    if (/\bCHECK\s*\(/i.test(got.sql)) problems.push(`قيود غير متوقعة في جدول: ${table}`);

    for (const [colName, refCol] of ref.columns) {
      const col = got.columns.get(colName);
      if (!col) {
        if (!OPTIONAL_COLUMNS.has(`${table}.${colName}`)) problems.push(`عمود ناقص: ${table}.${colName}`);
        continue;
      }
      if (String(col.type).toUpperCase() !== String(refCol.type).toUpperCase()) {
        problems.push(`نوع عمود غير متوافق: ${table}.${colName}`);
      }
      if (col.pk !== refCol.pk) problems.push(`مفتاح أساسي غير متوافق: ${table}.${colName}`);
      if (col.hidden !== 0) problems.push(`عمود غير متوافق: ${table}.${colName}`);
    }
    for (const [colName, col] of got.columns) {
      // An extra NOT NULL column without a default would make every insert by the app fail.
      if (!ref.columns.has(colName) && col.hidden === 0 && col.notnull && col.dflt_value === null && !col.pk) {
        problems.push(`عمود إضافي إجباري غير متوقع: ${table}.${colName}`);
      }
    }

    const key = (u) => `${u.origin === 'pk' ? 'pk' : 'u'}:${u.columns}`;
    const refUniques = new Set(ref.uniques.map(key));
    const gotUniques = new Set(got.uniques.map(key));
    for (const u of refUniques) if (!gotUniques.has(u)) problems.push(`قيد تفرد ناقص في جدول: ${table} (${u})`);
    for (const u of gotUniques) if (!refUniques.has(u)) problems.push(`قيد تفرد غير متوقع في جدول: ${table} (${u})`);

    if (ref.foreignKeys.join('|') !== got.foreignKeys.join('|')) {
      problems.push(`مفاتيح ربط (foreign keys) غير متوافقة في جدول: ${table}`);
    }
  }
  return problems;
}

// Throws BackupValidationError unless the file is an intact Smart POS database
// that still contains at least one active admin (so a restore cannot lock everyone out).
function validateBackupFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 512) throw new BackupValidationError('الملف ليس قاعدة بيانات صالحة');
  if (!hasSqliteHeader(filePath)) throw new BackupValidationError('الملف ليس قاعدة بيانات SQLite');

  let probe;
  try {
    probe = new Database(filePath, { fileMustExist: true });
    const integrity = probe.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new BackupValidationError('ملف النسخة الاحتياطية تالف (فشل فحص السلامة)');

    const objects = probe.prepare('SELECT type, name FROM sqlite_master').all();
    // This application never creates triggers; a backup containing them was not produced by it.
    if (objects.some((o) => o.type === 'trigger')) {
      throw new BackupValidationError('ملف النسخة الاحتياطية يحتوي على عناصر غير متوقعة');
    }
    const problems = schemaProblems(probe);
    if (problems.length > 0) {
      throw new BackupValidationError('الملف ليس نسخة احتياطية متوافقة مع هذا البرنامج: ' + problems.slice(0, 3).join('، '));
    }

    const admins = probe.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1").get().c;
    if (admins < 1) throw new BackupValidationError('النسخة الاحتياطية لا تحتوي على أي مدير مفعل');
  } catch (err) {
    if (err instanceof BackupValidationError) throw err;
    throw new BackupValidationError('تعذر قراءة ملف النسخة الاحتياطية: الملف تالف أو غير صالح');
  } finally {
    if (probe) probe.close();
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Copies the chosen file next to the live database and validates the copy, so the
// file that gets swapped in is exactly the one that was checked.
function stageRestore(sourcePath, dbPath) {
  const stagedPath = `${dbPath}.restore-${timestamp()}.tmp`;
  try {
    fs.copyFileSync(sourcePath, stagedPath);
    validateBackupFile(stagedPath);
    removeSidecars(stagedPath);
    return stagedPath;
  } catch (err) {
    discardStaged(stagedPath);
    throw err;
  }
}

function discardStaged(stagedPath) {
  try {
    removeSidecars(stagedPath);
    if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
  } catch {
    // Leftover temp files are harmless; they are never opened as the live database.
  }
}

// Consistent online copy of the live database, taken before it gets replaced.
// Throws if the live database cannot be copied into a valid backup (e.g. it is corrupted);
// a partial copy is removed so it is never mistaken for a good backup.
async function createSafetyBackup(db, dbPath) {
  const dir = path.join(path.dirname(dbPath), 'safety-backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `pre-restore-${timestamp()}.db`);
  try {
    await db.backup(target);
    validateBackupFile(target);
    return target;
  } catch (err) {
    discardStaged(target);
    throw err;
  }
}

// Fallback when no safety backup could be made (the live database is damaged): the live
// file and its WAL/SHM sidecars are moved, byte for byte, into a quarantine folder instead
// of being deleted. Rename on the same volume needs no free space. Must be called after the
// live connection is closed. Returns the quarantine folder.
function quarantineLiveDb(dbPath) {
  const dir = path.join(path.dirname(dbPath), 'quarantine', `before-restore-${timestamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  const moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = dbPath + suffix;
      if (!fs.existsSync(file)) continue;
      const target = path.join(dir, path.basename(file));
      fs.renameSync(file, target);
      moved.push([target, file]);
    }
  } catch (err) {
    // Put back whatever was already moved so the original database is left as it was.
    for (const [target, file] of moved.reverse()) fs.renameSync(target, file);
    throw err;
  }
  return dir;
}

// Undo quarantineLiveDb (used only if installing the restored file fails afterwards).
function releaseQuarantine(dir, dbPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const quarantined = path.join(dir, path.basename(dbPath + suffix));
    if (fs.existsSync(quarantined)) fs.renameSync(quarantined, dbPath + suffix);
  }
}

// Must be called after the live connection is closed and a safety backup exists. If anything
// fails before the rename, the original database file is left untouched.
function swapInStaged(stagedPath, dbPath) {
  removeSidecars(dbPath);
  fs.renameSync(stagedPath, dbPath);
}

// Used when the live database was quarantined: nothing is at dbPath any more.
function installStaged(stagedPath, dbPath) {
  fs.renameSync(stagedPath, dbPath);
}

module.exports = {
  BackupValidationError,
  validateBackupFile,
  stageRestore,
  discardStaged,
  createSafetyBackup,
  swapInStaged,
  quarantineLiveDb,
  releaseQuarantine,
  installStaged,
};
