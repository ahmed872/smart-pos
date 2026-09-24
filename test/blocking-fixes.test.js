const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { boot, shutdown, makeTempHome } = require('./harness.js');
const { BASE_SCHEMA_SQL } = require('../electron/schema.js');
const { validateBackupFile, BackupValidationError } = require('../electron/backup.js');

const OWNER_PIN = 'Owner-PIN-1';

function liveDbPath(home) {
  return path.join(home, 'appData', 'SystemDB', 'smart-pos.db');
}

async function appWithOwner() {
  const home = makeTempHome();
  const ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', OWNER_PIN);
  return { home, ctx };
}

// ---------------------------------------------------------------- Fix 1: role preservation

test('existing admin → change PIN only → role remains admin', async () => {
  const { ctx } = await appWithOwner();
  await ctx.call('users:save', { username: 'manager2', pin: 'Mgr2-PIN-1', role: 'admin' });
  const m2 = (await ctx.call('users:list')).find((u) => u.username === 'manager2');

  // exactly what the Users screen now sends when the role dropdown was not touched
  await ctx.call('users:save', { id: m2.id, username: 'manager2', pin: 'Mgr2-NEW-2' });
  assert.equal((await ctx.call('users:list')).find((u) => u.id === m2.id).role, 'admin');
  // empty/null role is also "not given"
  await ctx.call('users:save', { id: m2.id, username: 'manager2', pin: 'Mgr2-NEW-3', role: '' });
  await ctx.call('users:save', { id: m2.id, username: 'manager2', pin: 'Mgr2-NEW-4', role: null });
  assert.equal((await ctx.call('users:list')).find((u) => u.id === m2.id).role, 'admin');

  const session = await ctx.call('auth:login', 'manager2', 'Mgr2-NEW-4');
  assert.equal(session.role, 'admin');
  assert.ok(await ctx.call('users:list'), 'still has admin access');
  shutdown(ctx);
});

test('PIN-only change keeps a cashier a cashier, and the last admin can still change their own PIN', async () => {
  const { ctx } = await appWithOwner();
  await ctx.call('users:save', { username: 'c1', pin: 'c1-pin-11', role: 'cashier' });
  const users = await ctx.call('users:list');
  const c1 = users.find((u) => u.username === 'c1');
  const owner = users.find((u) => u.username === 'owner');
  await ctx.call('users:save', { id: c1.id, username: 'c1', pin: 'c1-pin-22' });
  assert.equal((await ctx.call('users:list')).find((u) => u.id === c1.id).role, 'cashier');
  // owner is the only admin: a PIN-only change must not trip the last-admin guard
  await ctx.call('users:save', { id: owner.id, username: 'owner', pin: 'Owner-PIN-2' });
  assert.equal((await ctx.call('auth:login', 'owner', 'Owner-PIN-2')).role, 'admin');
  // a new user without an explicit role is created as cashier
  await ctx.call('users:save', { username: 'c2', pin: 'c2-pin-33' });
  assert.equal((await ctx.call('users:list')).find((u) => u.username === 'c2').role, 'cashier');
  shutdown(ctx);
});

test('explicit role changes still work and still follow the permission rules', async () => {
  const { ctx } = await appWithOwner();
  await ctx.call('users:save', { username: 'manager2', pin: 'Mgr2-PIN-1', role: 'admin' });
  await ctx.call('users:save', { username: 'c1', pin: 'c1-pin-11', role: 'cashier' });
  let users = await ctx.call('users:list');
  const m2 = users.find((u) => u.username === 'manager2');
  const c1 = users.find((u) => u.username === 'c1');
  const owner = users.find((u) => u.username === 'owner');

  await ctx.call('users:save', { id: m2.id, username: 'manager2', pin: 'Mgr2-PIN-2', role: 'cashier' });
  await ctx.call('users:save', { id: c1.id, username: 'c1', pin: 'c1-pin-22', role: 'admin' });
  users = await ctx.call('users:list');
  assert.equal(users.find((u) => u.id === m2.id).role, 'cashier');
  assert.equal(users.find((u) => u.id === c1.id).role, 'admin');
  await assert.rejects(ctx.call('users:save', { id: c1.id, username: 'c1', role: 'root' }), /غير مسموحة/);

  // demote c1 back; owner is then the only admin and cannot be demoted explicitly
  await ctx.call('users:save', { id: c1.id, username: 'c1', role: 'cashier' });
  await assert.rejects(ctx.call('users:save', { id: owner.id, username: 'owner', role: 'cashier' }), /آخر مدير/);
  assert.equal((await ctx.call('users:list')).find((u) => u.id === owner.id).role, 'admin');

  // a cashier still cannot change anyone's role
  await ctx.call('auth:login', 'manager2', 'Mgr2-PIN-2');
  await assert.rejects(ctx.call('users:save', { id: m2.id, username: 'manager2', role: 'admin' }), /للمدير فقط/);
  shutdown(ctx);
});

test('Users screen only sends a role for an existing user when the dropdown was changed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /getElementById\('uRole'\)\.addEventListener\('change'/);
  assert.match(src, /\? \{ id: existing\.id, username, pin, \.\.\.\(roleChangedByUser \? \{ role \} : \{\}\) \}/);
});

// ---------------------------------------------------------------- Fix 2: restore over a damaged database

// Fills the live database with data and then damages the tail of the file.
async function corruptLiveDb(home, ctx) {
  await ctx.call('products:save', { name: 'MARKER-CURRENT-DATA', price: 1 });
  for (let i = 0; i < 1500; i++) await ctx.call('products:save', { name: `filler ${i} ${'x'.repeat(150)}`, price: 1 });
  shutdown(ctx);
  const file = liveDbPath(home);
  const buf = fs.readFileSync(file);
  for (let i = buf.length - 20000; i < buf.length - 12000; i++) buf[i] ^= 0x5a;
  fs.writeFileSync(file, buf);
}

async function makeValidBackup(ctx, home) {
  const backupPath = path.join(home, 'good-backup.db');
  await ctx.call('products:save', { name: 'FROM-VALID-BACKUP', price: 7 });
  ctx.dialogQueue.save.push({ canceled: false, filePath: backupPath });
  assert.equal(await ctx.call('backup:create'), backupPath);
  return backupPath;
}

test('current DB corrupted + valid backup → restore succeeds, damaged files quarantined, app starts with backup data', async () => {
  let { home, ctx } = await appWithOwner();
  const backupPath = await makeValidBackup(ctx, home);
  await corruptLiveDb(home, ctx);

  ctx = await boot({ home });
  assert.equal((await ctx.call('auth:login', 'owner', OWNER_PIN)).role, 'admin', 'app still runs on the damaged DB');
  assert.notEqual(ctx.store.db.pragma('integrity_check', { simple: true }), 'ok', 'live DB really is corrupted');

  ctx.dialogQueue.open.push({ canceled: false, filePaths: [backupPath] });
  ctx.dialogQueue.message.push({ response: 1 }); // confirm restore
  assert.equal(await ctx.call('backup:restore'), true);
  assert.equal(ctx.state.exitCode, 0);
  assert.equal(ctx.state.relaunched, true);
  assert.match(ctx.state.messageBoxes.at(-1).message, /تم نقل ملفاتها كما هي/);

  const sysDir = path.dirname(liveDbPath(home));
  const safety = path.join(sysDir, 'safety-backups');
  assert.deepEqual(fs.existsSync(safety) ? fs.readdirSync(safety) : [], [], 'no partial safety backup left behind');
  const qRoot = path.join(sysDir, 'quarantine');
  const [qDir] = fs.readdirSync(qRoot);
  const quarantined = fs.readFileSync(path.join(qRoot, qDir, 'smart-pos.db'));
  assert.ok(quarantined.includes(Buffer.from('MARKER-CURRENT-DATA')), 'damaged database preserved, not deleted');

  // relaunch
  const after = await boot({ home });
  await after.call('auth:login', 'owner', OWNER_PIN);
  assert.equal(after.store.db.pragma('integrity_check', { simple: true }), 'ok');
  const names = (await after.call('products:list')).map((p) => p.name);
  assert.ok(names.includes('FROM-VALID-BACKUP'));
  assert.ok(!names.includes('MARKER-CURRENT-DATA'));
  const p = (await after.call('products:list')).find((x) => x.name === 'FROM-VALID-BACKUP');
  assert.ok(await after.call('sales:create', { items: [{ product_id: p.id, qty: 1 }] }), 'app fully usable');
  shutdown(after);
});

test('current DB valid + valid backup → restore succeeds and a safety backup exists (no quarantine)', async () => {
  const { home, ctx } = await appWithOwner();
  const backupPath = await makeValidBackup(ctx, home);
  await ctx.call('products:save', { name: 'AFTER-BACKUP', price: 3 });
  ctx.dialogQueue.open.push({ canceled: false, filePaths: [backupPath] });
  ctx.dialogQueue.message.push({ response: 1 });
  assert.equal(await ctx.call('backup:restore'), true);

  const sysDir = path.dirname(liveDbPath(home));
  const safeties = fs.readdirSync(path.join(sysDir, 'safety-backups'));
  assert.equal(safeties.length, 1);
  const s = new Database(path.join(sysDir, 'safety-backups', safeties[0]), { readonly: true });
  assert.ok(s.prepare("SELECT 1 FROM products WHERE name = 'AFTER-BACKUP'").get());
  s.close();
  assert.equal(fs.existsSync(path.join(sysDir, 'quarantine')), false);

  const after = await boot({ home });
  await after.call('auth:login', 'owner', OWNER_PIN);
  const names = (await after.call('products:list')).map((p) => p.name);
  assert.ok(names.includes('FROM-VALID-BACKUP') && !names.includes('AFTER-BACKUP'));
  shutdown(after);
});

test('a safety-backup failure for any other reason does not block recovery either', async () => {
  const { home, ctx } = await appWithOwner();
  const backupPath = await makeValidBackup(ctx, home);
  await ctx.call('products:save', { name: 'CURRENT-ONLY', price: 3 });
  // make the safety-backups folder impossible to create
  fs.writeFileSync(path.join(path.dirname(liveDbPath(home)), 'safety-backups'), 'not a folder');
  ctx.dialogQueue.open.push({ canceled: false, filePaths: [backupPath] });
  ctx.dialogQueue.message.push({ response: 1 });
  assert.equal(await ctx.call('backup:restore'), true);

  const qRoot = path.join(path.dirname(liveDbPath(home)), 'quarantine');
  const [qDir] = fs.readdirSync(qRoot);
  const q = new Database(path.join(qRoot, qDir, 'smart-pos.db'), { readonly: true });
  assert.ok(q.prepare("SELECT 1 FROM products WHERE name = 'CURRENT-ONLY'").get(), 'previous data kept in quarantine');
  q.close();
  const after = await boot({ home });
  await after.call('auth:login', 'owner', OWNER_PIN);
  assert.ok((await after.call('products:list')).some((p) => p.name === 'FROM-VALID-BACKUP'));
  shutdown(after);
});

// ---------------------------------------------------------------- Fix 3: strict schema validation

// Builds a database from the app's own schema with one deliberate change.
function schemaVariant(dir, name, transform = (sql) => sql, after = '') {
  const file = path.join(dir, `${name}.db`);
  const db = new Database(file);
  db.exec(transform(BASE_SCHEMA_SQL));
  db.exec(after);
  db.prepare("INSERT INTO users (username, pin, role) VALUES ('boss', 'boss-pin-1', 'admin')").run();
  db.close();
  return file;
}

function expectReject(file, re) {
  assert.throws(() => validateBackupFile(file), (err) => err instanceof BackupValidationError && re.test(err.message));
}

test('settings table exists but value column missing → backup rejected', () => {
  const dir = makeTempHome();
  const file = schemaVariant(dir, 'no-value', (sql) => sql.replace(/CREATE TABLE IF NOT EXISTS settings \([^)]*\);/,
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, val TEXT);'));
  expectReject(file, /عمود ناقص: settings\.value/);
});

test('missing required table / column → rejected', () => {
  const dir = makeTempHome();
  for (const table of ['users', 'categories', 'products', 'customers', 'sales', 'sale_items', 'returns', 'stock_movements', 'settings']) {
    if (table === 'users') continue; // an admin row is inserted below
    const file = schemaVariant(dir, `no-${table}`, (sql) => sql, `DROP TABLE ${table};`);
    expectReject(file, new RegExp(`جدول ناقص: ${table}`));
  }
  expectReject(schemaVariant(dir, 'no-price', (sql) => sql.replace('  price REAL NOT NULL DEFAULT 0,\n', '')), /عمود ناقص: products\.price/);
  expectReject(schemaVariant(dir, 'no-kstatus', (sql) => sql.replace("  kitchen_status TEXT NOT NULL DEFAULT 'none',\n", '')),
    /عمود ناقص: sales\.kitchen_status/);
});

test('wrong / incompatible schema → rejected', () => {
  const dir = makeTempHome();
  const cases = [
    ['wrong-type', (s) => s.replace('  price REAL NOT NULL DEFAULT 0,', '  price TEXT NOT NULL DEFAULT 0,'), /نوع عمود غير متوافق: products\.price/],
    ['settings-no-pk', (s) => s.replace('  key TEXT PRIMARY KEY,', '  key TEXT,'), /مفتاح أساسي غير متوافق: settings\.key/],
    ['username-not-unique', (s) => s.replace('  username TEXT NOT NULL UNIQUE,', '  username TEXT NOT NULL,'), /قيد تفرد ناقص في جدول: users/],
    ['extra-unique', (s) => s.replace('CREATE TABLE IF NOT EXISTS products (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,',
      'CREATE TABLE IF NOT EXISTS products (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL UNIQUE,'), /قيد تفرد غير متوقع في جدول: products/],
    ['fk-missing', (s) => s.replace('  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,', '  sale_id INTEGER NOT NULL,'),
      /foreign keys\) غير متوافقة في جدول: sale_items/],
    ['fk-extra', (s) => s.replace('  change_qty REAL NOT NULL,', '  change_qty REAL NOT NULL REFERENCES users(id),'),
      /foreign keys\) غير متوافقة في جدول: stock_movements/],
    ['extra-required-col', (s) => s.replace('  image_data_url TEXT\n);', '  image_data_url TEXT,\n  supplier TEXT NOT NULL\n);'),
      /عمود إضافي إجباري غير متوقع: products\.supplier/],
    ['check-constraint', (s) => s.replace('  image_data_url TEXT\n);', '  image_data_url TEXT,\n  CHECK (price < 0)\n);'), /قيود غير متوقعة في جدول: products/],
    ['without-rowid', (s) => s.replace('CREATE TABLE IF NOT EXISTS settings (\n  key TEXT PRIMARY KEY,\n  value TEXT\n);',
      'CREATE TABLE IF NOT EXISTS settings (\n  key TEXT PRIMARY KEY,\n  value TEXT\n) WITHOUT ROWID;'), /جدول غير متوافق: settings/],
  ];
  for (const [name, transform, re] of cases) {
    const file = schemaVariant(dir, name, (s) => {
      const out = transform(s);
      assert.notEqual(out, s, `${name}: transform did not apply`);
      return out;
    });
    expectReject(file, re);
  }
});

test('valid schemas → accepted (current, pre-migration v1.0.0, extra nullable column)', async () => {
  const dir = makeTempHome();
  // exactly the app's schema (no migrated columns yet = what v1.0.0 users table looked like)
  validateBackupFile(schemaVariant(dir, 'base'));
  // an older database missing the migrated columns is accepted (they are added on open)
  validateBackupFile(schemaVariant(dir, 'pre-images', (s) => s.replace(',\n  image_data_url TEXT\n);', '\n);')));
  validateBackupFile(schemaVariant(dir, 'pre-unit-cost', (s) => s.replace('  unit_cost REAL NOT NULL DEFAULT 0,\n', '')));
  // an unknown but harmless (nullable) extra column is accepted
  validateBackupFile(schemaVariant(dir, 'extra-nullable', (s) => s.replace('  notes TEXT\n);', '  notes TEXT,\n  email TEXT\n);')));
  // and a backup produced by the app itself (all migrations applied) is accepted
  const { home, ctx } = await appWithOwner();
  const b = path.join(home, 'self.db');
  ctx.dialogQueue.save.push({ canceled: false, filePath: b });
  await ctx.call('backup:create');
  validateBackupFile(b);
  shutdown(ctx);
});

test('a schema-incompatible backup is refused by restore; live DB untouched and app still boots', async () => {
  const { home, ctx } = await appWithOwner();
  const bad = schemaVariant(home, 'no-value', (sql) => sql.replace(/CREATE TABLE IF NOT EXISTS settings \([^)]*\);/,
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, val TEXT);'));
  const before = fs.readFileSync(liveDbPath(home));
  ctx.dialogQueue.open.push({ canceled: false, filePaths: [bad] });
  assert.equal(await ctx.call('backup:restore'), false);
  assert.match(ctx.state.messageBoxes.at(-1).message, /لم يتم تغيير أي بيانات.*settings\.value/s);
  assert.equal(ctx.state.exitCode, null);
  assert.ok(before.equals(fs.readFileSync(liveDbPath(home))));
  shutdown(ctx);
  const again = await boot({ home });
  assert.ok(await again.call('auth:login', 'owner', OWNER_PIN));
  shutdown(again);
});
