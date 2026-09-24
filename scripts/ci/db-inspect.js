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
console.log(JSON.stringify({
  integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
  hasPinHashColumn: cols.includes('pin_hash'),
  users,
  products: db.prepare('SELECT COUNT(*) AS c FROM products WHERE is_active = 1').get().c,
  sales: db.prepare('SELECT COUNT(*) AS c FROM sales').get().c,
}));
db.close();
