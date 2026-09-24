const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { boot, shutdown, makeTempHome } = require('./harness.js');

// Builds a database exactly as v1.0.0 stored users: plaintext PINs, no pin_hash column.
function createLegacyDatabase(home, users) {
  const dir = path.join(home, 'appData', 'SystemDB');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'smart-pos.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_kitchen INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT UNIQUE,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0, stock_qty REAL NOT NULL DEFAULT 0, track_stock INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1, image_data_url TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pin TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier', is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_number TEXT NOT NULL UNIQUE, user_id INTEGER REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id), subtotal REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL, payment_method TEXT NOT NULL DEFAULT 'cash', kitchen_status TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, notes TEXT);
    CREATE TABLE sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id), name TEXT NOT NULL, qty REAL NOT NULL, unit_price REAL NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL, is_kitchen_item INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE returns (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id),
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id), product_id INTEGER REFERENCES products(id), qty REAL NOT NULL,
      refunded_amount REAL NOT NULL, reason TEXT, user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
    CREATE TABLE stock_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
      change_qty REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
  `);
  db.prepare("INSERT INTO products (name, price, cost, stock_qty, track_stock) VALUES ('قديم', 10, 4, 5, 1)").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('tax_percent', '0')").run();
  const insert = db.prepare('INSERT INTO users (username, pin, role, is_active) VALUES (?, ?, ?, ?)');
  for (const u of users) insert.run(u.username, u.pin, u.role, u.active === false ? 0 : 1);
  db.prepare("INSERT INTO sales (sale_number, user_id, subtotal, total) VALUES ('INV-OLD-1', 1, 10, 10)").run();
  db.close();
  return path.join(dir, 'smart-pos.db');
}

const LEGACY_USERS = [
  { username: 'manager', pin: 'MgrSecret99', role: 'admin' },
  { username: 'sara', pin: '5678', role: 'cashier' },
  { username: 'weak', pin: '1234', role: 'cashier' }, // a publicly disclosed default PIN
  { username: 'gone', pin: 'old-pin-x', role: 'cashier', active: false },
];

test('migration hashes every legacy plaintext PIN and keeps existing logins working', async () => {
  const home = makeTempHome();
  const file = createLegacyDatabase(home, LEGACY_USERS);
  const ctx = await boot({ home });

  const raw = new Database(file, { readonly: true });
  const rows = raw.prepare('SELECT username, pin, pin_hash, must_change_pin FROM users ORDER BY id').all();
  raw.close();
  for (const [i, r] of rows.entries()) {
    assert.match(r.pin_hash, /^scrypt\$/);
    assert.notEqual(r.pin, LEGACY_USERS[i].pin, 'plaintext must be gone');
    assert.ok(!r.pin_hash.includes(LEGACY_USERS[i].pin));
  }
  assert.deepEqual(rows.map((r) => r.must_change_pin), [0, 0, 1, 0]);

  assert.equal((await ctx.call('auth:login', 'manager', 'MgrSecret99')).role, 'admin');
  assert.equal((await ctx.call('auth:login', 'sara', '5678')).mustChangePin, false);
  assert.equal(await ctx.call('auth:login', 'gone', 'old-pin-x'), null, 'inactive users stay blocked');
  assert.equal(await ctx.call('auth:needsSetup'), false);

  // existing business data is untouched
  await ctx.call('auth:login', 'manager', 'MgrSecret99');
  assert.equal((await ctx.call('products:list'))[0].name, 'قديم');
  assert.equal((await ctx.call('sales:list', 10))[0].sale_number, 'INV-OLD-1');
  shutdown(ctx);
});

test('accounts on a disclosed default PIN must change it before doing anything else', async () => {
  const home = makeTempHome();
  createLegacyDatabase(home, LEGACY_USERS);
  const ctx = await boot({ home });
  const user = await ctx.call('auth:login', 'weak', '1234');
  assert.equal(user.mustChangePin, true);
  await assert.rejects(ctx.call('products:list'), /تغيير الرقم السري/);
  await assert.rejects(ctx.call('nav:goToApp'), /تغيير الرقم السري/);
  await assert.rejects(ctx.call('auth:changePin', 'wrong', 'fresh-pin-1'), /الحالي غير صحيح/);
  await assert.rejects(ctx.call('auth:changePin', '1234', '1111'), /افتراضي/);
  await assert.rejects(ctx.call('auth:changePin', '1234', '12'), /4/);
  const changed = await ctx.call('auth:changePin', '1234', 'fresh-pin-1');
  assert.equal(changed.mustChangePin, false);
  assert.ok((await ctx.call('products:list')).length > 0);
  assert.equal(await ctx.call('auth:login', 'weak', '1234'), null);
  assert.equal((await ctx.call('auth:login', 'weak', 'fresh-pin-1')).mustChangePin, false);
  shutdown(ctx);
});

test('migration is idempotent across restarts', async () => {
  const home = makeTempHome();
  const file = createLegacyDatabase(home, LEGACY_USERS);
  shutdown(await boot({ home }));
  const read = () => {
    const raw = new Database(file, { readonly: true });
    const r = raw.prepare('SELECT pin, pin_hash FROM users ORDER BY id').all();
    raw.close();
    return r;
  };
  const first = read();
  const ctx = await boot({ home });
  assert.deepEqual(read(), first);
  assert.ok(await ctx.call('auth:login', 'sara', '5678'));
  shutdown(ctx);
});

test('restoring an old (pre-migration) backup keeps its users able to log in', async () => {
  const home = makeTempHome();
  const legacyBackup = path.join(home, 'old-backup.db');
  // make a legacy database in a separate location to use as the backup file
  const other = makeTempHome();
  fs.copyFileSync(createLegacyDatabase(other, LEGACY_USERS), legacyBackup);

  const ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', 'Owner-PIN-1');
  ctx.dialogQueue.open.push({ canceled: false, filePaths: [legacyBackup] });
  ctx.dialogQueue.message.push({ response: 1 });
  assert.equal(await ctx.call('backup:restore'), true);

  const after = await boot({ home });
  assert.equal((await after.call('auth:login', 'manager', 'MgrSecret99')).role, 'admin');
  assert.equal(await after.call('auth:login', 'owner', 'Owner-PIN-1'), null);
  shutdown(after);
});
