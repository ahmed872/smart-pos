const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const REQUIRED_TABLES = ['users', 'categories', 'products', 'sales', 'sale_items', 'settings'];

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
    const tables = new Set(objects.filter((o) => o.type === 'table').map((o) => o.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length > 0) {
      throw new BackupValidationError('الملف ليس نسخة احتياطية من هذا البرنامج (جداول ناقصة: ' + missing.join('، ') + ')');
    }
    // This application never creates triggers; a backup containing them was not produced by it.
    if (objects.some((o) => o.type === 'trigger')) {
      throw new BackupValidationError('ملف النسخة الاحتياطية يحتوي على عناصر غير متوقعة');
    }

    const userCols = probe.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    for (const col of ['id', 'username', 'role', 'is_active']) {
      if (!userCols.includes(col)) throw new BackupValidationError('جدول المستخدمين في النسخة الاحتياطية غير صالح');
    }
    if (!userCols.includes('pin') && !userCols.includes('pin_hash')) {
      throw new BackupValidationError('جدول المستخدمين في النسخة الاحتياطية غير صالح');
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
async function createSafetyBackup(db, dbPath) {
  const dir = path.join(path.dirname(dbPath), 'safety-backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `pre-restore-${timestamp()}.db`);
  await db.backup(target);
  validateBackupFile(target);
  return target;
}

// Must be called after the live connection is closed. If anything fails before the
// rename, the original database file is left untouched.
function swapInStaged(stagedPath, dbPath) {
  removeSidecars(dbPath);
  fs.renameSync(stagedPath, dbPath);
}

module.exports = {
  BackupValidationError,
  validateBackupFile,
  stageRestore,
  discardStaged,
  createSafetyBackup,
  swapInStaged,
};
