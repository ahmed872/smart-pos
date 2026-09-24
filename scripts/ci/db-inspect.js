// Prints a JSON summary of a Smart POS database using Node's built-in SQLite (Node 22+), so it
// works with plain `node` regardless of which ABI the project's better-sqlite3 is built for.
//   node scripts/ci/db-inspect.js <db file>
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
const users = db.prepare('SELECT * FROM users ORDER BY id').all().map((u) => ({
  username: u.username,
  role: u.role,
  active: !!u.is_active,
  hashed: typeof u.pin_hash === 'string' && u.pin_hash.startsWith('scrypt$'),
}));
// Name of the organization whose branding shipped in v1.0.0/v1.1.0; fresh installs must not contain it.
const ORG = '\u0627\u0644\u0645\u062c\u0646\u062f\u064a\u0646';
const dump = JSON.stringify([db.prepare('SELECT * FROM settings').all(), db.prepare('SELECT name FROM products').all(),
  db.prepare('SELECT name FROM categories').all()]);
console.log(JSON.stringify({
  containsOrganizationName: dump.includes(ORG),
  integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  hasPinHashColumn: cols.includes('pin_hash'),
  users,
  products: db.prepare('SELECT COUNT(*) AS c FROM products WHERE is_active = 1').get().c,
  sales: db.prepare('SELECT COUNT(*) AS c FROM sales').get().c,
  categories: db.prepare('SELECT COUNT(*) AS c FROM categories').get().c,
  settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all()
    .map((r) => [r.key, r.key === 'logo_data_url' ? (r.value ? 'set' : '') : r.value])),
}));
db.close();
