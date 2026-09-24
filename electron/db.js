const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');
const Database = require('better-sqlite3');
const DEFAULT_LOGO_DATA_URL = require('./default-logo.js');

const dbDir = path.join(app.getPath('appData'), 'SystemDB');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'smart-pos.db');

// One-time migration: earlier installs stored the database in Electron's default
// per-app userData folder instead of the dedicated SystemDB folder.
const legacyDbPath = path.join(app.getPath('userData'), 'smart-pos.db');
if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
  fs.copyFileSync(legacyDbPath, dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const legacySidecar = legacyDbPath + suffix;
    if (fs.existsSync(legacySidecar)) fs.copyFileSync(legacySidecar, dbPath + suffix);
  }
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_kitchen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  track_stock INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  image_data_url TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pin TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'cashier',
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_number TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  kitchen_status TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  is_kitchen_item INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  product_id INTEGER REFERENCES products(id),
  qty REAL NOT NULL,
  refunded_amount REAL NOT NULL,
  reason TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  change_qty REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Lightweight migration for databases created before unit_cost existed.
const saleItemCols = db.prepare("PRAGMA table_info(sale_items)").all().map((c) => c.name);
if (!saleItemCols.includes('unit_cost')) {
  db.exec('ALTER TABLE sale_items ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0');
}

// Lightweight migration for databases created before product images existed.
const productCols = db.prepare("PRAGMA table_info(products)").all().map((c) => c.name);
if (!productCols.includes('image_data_url')) {
  db.exec('ALTER TABLE products ADD COLUMN image_data_url TEXT');
}

function seedIfEmpty() {
  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (productCount === 0) {
    const insertCategory = db.prepare('INSERT INTO categories (name, is_kitchen) VALUES (?, ?)');
    const foodCat = insertCategory.run('مأكولات', 1).lastInsertRowid;
    const drinksCat = insertCategory.run('مشروبات', 1).lastInsertRowid;
    const generalCat = insertCategory.run('عام', 0).lastInsertRowid;

    const insertProduct = db.prepare(`
      INSERT INTO products (name, barcode, category_id, price, cost, stock_qty, track_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertProduct.run('برجر لحم', '1001', foodCat, 85, 45, 0, 0);
    insertProduct.run('بيتزا مارجريتا', '1002', foodCat, 120, 60, 0, 0);
    insertProduct.run('بطاطس مقلية', '1003', foodCat, 35, 15, 0, 0);
    insertProduct.run('عصير برتقال', '2001', drinksCat, 25, 10, 40, 1);
    insertProduct.run('مياه معدنية', '2002', drinksCat, 10, 4, 100, 1);
    insertProduct.run('قهوة تركي', '2003', drinksCat, 20, 8, 0, 0);
    insertProduct.run('منتج عام', '3001', generalCat, 15, 7, 25, 1);

    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('store_name', 'الإدارة العامة لشئون المجندين');
    insertSetting.run('currency', 'ج.م');
    insertSetting.run('tax_percent', '0');
    insertSetting.run('receipt_width_mm', '58');
    insertSetting.run('logo_data_url', DEFAULT_LOGO_DATA_URL);
  }

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare('INSERT INTO users (username, pin, role) VALUES (?, ?, ?)');
    insertUser.run('admin', '00102026', 'admin');
    insertUser.run('cashier', '1111', 'cashier');
  }
}
seedIfEmpty();

// One-time migration: earlier installs seeded a placeholder store name and no receipt width.
const currentStoreName = db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get();
if (currentStoreName && currentStoreName.value === 'متجري') {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'store_name'").run('الإدارة العامة لشئون المجندين');
}
const hasReceiptWidth = db.prepare("SELECT 1 FROM settings WHERE key = 'receipt_width_mm'").get();
if (!hasReceiptWidth) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('receipt_width_mm', '58')").run();
}
const hasResetPeriod = db.prepare("SELECT 1 FROM settings WHERE key = 'invoice_reset_period'").get();
if (!hasResetPeriod) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('invoice_reset_period', 'monthly')").run();
}
const hasLowStockThreshold = db.prepare("SELECT 1 FROM settings WHERE key = 'low_stock_threshold'").get();
if (!hasLowStockThreshold) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('low_stock_threshold', '5')").run();
}
const hasLogo = db.prepare("SELECT 1 FROM settings WHERE key = 'logo_data_url'").get();
if (!hasLogo) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('logo_data_url', ?)").run(DEFAULT_LOGO_DATA_URL);
}
// One-time migration: installs still on the original default admin PIN get the new one.
db.prepare("UPDATE users SET pin = '00102026' WHERE username = 'admin' AND pin = '1234'").run();

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}W${String(weekNo).padStart(2, '0')}`;
}

function currentPeriodKey() {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'invoice_reset_period'").get();
  const period = setting ? setting.value : 'monthly';
  const now = new Date();
  if (period === 'weekly') return isoWeekKey(now);
  if (period === 'monthly') return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return null;
}

function nextSaleNumber() {
  const periodKey = currentPeriodKey();
  const prefix = periodKey ? `INV-${periodKey}-` : 'INV-';
  const row = db.prepare(`SELECT sale_number FROM sales WHERE sale_number LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%');
  const lastNum = row ? parseInt(row.sale_number.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(lastNum + 1).padStart(6, '0');
}

module.exports = {
  db,

  // ---------- Auth & users ----------
  verifyLogin(username, pin) {
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND pin = ? AND is_active = 1').get(username, pin);
    if (!user) return null;
    return { id: user.id, username: user.username, role: user.role };
  },

  getUsers() {
    return db.prepare('SELECT id, username, role, is_active FROM users ORDER BY username').all();
  },

  saveUser(user) {
    if (user.id) {
      if (user.pin) {
        db.prepare('UPDATE users SET username=?, pin=?, role=? WHERE id=?')
          .run(user.username, user.pin, user.role, user.id);
      } else {
        db.prepare('UPDATE users SET username=?, role=? WHERE id=?')
          .run(user.username, user.role, user.id);
      }
      return user.id;
    }
    const info = db.prepare('INSERT INTO users (username, pin, role) VALUES (?, ?, ?)')
      .run(user.username, user.pin, user.role || 'cashier');
    return info.lastInsertRowid;
  },

  setUserActive(id, isActive) {
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
  },

  // ---------- Categories & products ----------
  getCategories() {
    return db.prepare('SELECT * FROM categories ORDER BY name').all();
  },

  getProducts() {
    return db.prepare(`
      SELECT p.*, c.name AS category_name, c.is_kitchen AS category_is_kitchen
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = 1
      ORDER BY p.name
    `).all();
  },

  saveProduct(product) {
    if (product.id) {
      db.prepare(`
        UPDATE products SET name=?, barcode=?, category_id=?, price=?, cost=?, stock_qty=?, track_stock=?, image_data_url=?
        WHERE id=?
      `).run(product.name, product.barcode || null, product.category_id || null,
        product.price, product.cost || 0, product.stock_qty || 0, product.track_stock ? 1 : 0,
        product.image_data_url || null, product.id);
      return product.id;
    }
    const info = db.prepare(`
      INSERT INTO products (name, barcode, category_id, price, cost, stock_qty, track_stock, image_data_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(product.name, product.barcode || null, product.category_id || null,
      product.price, product.cost || 0, product.stock_qty || 0, product.track_stock ? 1 : 0,
      product.image_data_url || null);
    return info.lastInsertRowid;
  },

  deleteProduct(id) {
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(id);
  },

  saveCategory(name, isKitchen) {
    const info = db.prepare('INSERT INTO categories (name, is_kitchen) VALUES (?, ?)').run(name, isKitchen ? 1 : 0);
    return info.lastInsertRowid;
  },

  // ---------- Sales ----------
  createSale(payload) {
    const { items, discount = 0, taxPercent = 0, paymentMethod = 'cash', customerId = null, userId = null } = payload;
    const subtotal = items.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
    const taxable = Math.max(subtotal - discount, 0);
    const tax = taxable * (taxPercent / 100);
    const total = taxable + tax;
    const hasKitchenItems = items.some((it) => it.is_kitchen_item);

    const getProductCost = db.prepare('SELECT cost FROM products WHERE id = ?');
    const getProductStock = db.prepare('SELECT stock_qty, track_stock, name FROM products WHERE id = ?');
    const insertSale = db.prepare(`
      INSERT INTO sales (sale_number, user_id, customer_id, subtotal, discount, tax, total, payment_method, kitchen_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, name, qty, unit_price, unit_cost, line_total, is_kitchen_item)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const decrementStock = db.prepare(`
      UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND track_stock = 1
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason) VALUES (?, ?, 'sale')
    `);

    const saleNumber = nextSaleNumber();

    const tx = db.transaction(() => {
      const saleId = insertSale.run(
        saleNumber, userId, customerId, subtotal, discount, tax, total,
        paymentMethod, hasKitchenItems ? 'pending' : 'none'
      ).lastInsertRowid;

      for (const it of items) {
        if (it.product_id) {
          const current = getProductStock.get(it.product_id);
          if (current && current.track_stock && current.stock_qty < it.qty) {
            throw new Error(`الكمية المتاحة من "${current.name}" غير كافية (المتاح: ${current.stock_qty})`);
          }
        }

        const unitCost = it.product_id ? (getProductCost.get(it.product_id)?.cost || 0) : 0;
        insertItem.run(saleId, it.product_id || null, it.name, it.qty, it.unit_price, unitCost,
          it.qty * it.unit_price, it.is_kitchen_item ? 1 : 0);
        if (it.product_id) {
          decrementStock.run(it.qty, it.product_id);
          insertMovement.run(it.product_id, -it.qty);
        }
      }
      return saleId;
    });

    const saleId = tx();
    return { saleId, saleNumber, subtotal, tax, total };
  },

  getSales(limit = 100) {
    return db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT ?').all(limit);
  },

  getSaleItems(saleId) {
    return db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  },

  getSaleFull(saleId) {
    const sale = db.prepare(`
      SELECT s.*, u.username AS cashier_name
      FROM sales s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `).get(saleId);
    if (!sale) return null;
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    const returnedByItem = db.prepare(`
      SELECT sale_item_id, SUM(qty) AS returned_qty FROM returns WHERE sale_id = ? GROUP BY sale_item_id
    `).all(saleId);
    const returnedMap = Object.fromEntries(returnedByItem.map((r) => [r.sale_item_id, r.returned_qty]));
    return {
      sale,
      items: items.map((it) => ({ ...it, returned_qty: returnedMap[it.id] || 0 })),
      settings: this.getSettings(),
    };
  },

  getSalesDetailRows(fromDate, toDate) {
    const range = { from: `${fromDate} 00:00:00`, to: `${toDate} 23:59:59` };
    return db.prepare(`
      SELECT
        s.sale_number, s.created_at, s.payment_method, s.total AS invoice_total,
        u.username AS cashier_name,
        si.name AS product_name, si.qty, si.unit_price, si.line_total
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.created_at BETWEEN ? AND ?
      ORDER BY s.id ASC
    `).all(range.from, range.to);
  },

  // ---------- Returns ----------
  createReturn({ saleId, saleItemId, qty, reason, userId }) {
    const item = db.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    if (!item) throw new Error('صنف الفاتورة غير موجود');

    const alreadyReturned = db.prepare(
      'SELECT COALESCE(SUM(qty), 0) AS q FROM returns WHERE sale_item_id = ?'
    ).get(saleItemId).q;
    const availableToReturn = item.qty - alreadyReturned;
    if (qty <= 0 || qty > availableToReturn) {
      throw new Error('الكمية المطلوب إرجاعها غير صحيحة');
    }

    const refundedAmount = qty * item.unit_price;

    const insertReturn = db.prepare(`
      INSERT INTO returns (sale_id, sale_item_id, product_id, qty, refunded_amount, reason, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const restoreStock = db.prepare(`
      UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND track_stock = 1
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason) VALUES (?, ?, 'return')
    `);

    const tx = db.transaction(() => {
      const returnId = insertReturn.run(
        saleId, saleItemId, item.product_id, qty, refundedAmount, reason || null, userId || null
      ).lastInsertRowid;
      if (item.product_id) {
        restoreStock.run(qty, item.product_id);
        insertMovement.run(item.product_id, qty);
      }
      return returnId;
    });

    return { returnId: tx(), refundedAmount };
  },

  getReturnsForSale(saleId) {
    return db.prepare('SELECT * FROM returns WHERE sale_id = ?').all(saleId);
  },

  // ---------- Kitchen ----------
  getKitchenOrders() {
    return db.prepare(`
      SELECT s.id AS sale_id, s.sale_number, s.kitchen_status, s.created_at
      FROM sales s
      WHERE s.kitchen_status IN ('pending', 'preparing')
      ORDER BY s.id ASC
    `).all().map((sale) => ({
      ...sale,
      items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND is_kitchen_item = 1').all(sale.sale_id),
    }));
  },

  updateKitchenStatus(saleId, status) {
    db.prepare('UPDATE sales SET kitchen_status = ? WHERE id = ?').run(status, saleId);
  },

  // ---------- Reports ----------
  getSalesSummary(fromDate, toDate) {
    const range = { from: `${fromDate} 00:00:00`, to: `${toDate} 23:59:59` };

    const totals = db.prepare(`
      SELECT
        COUNT(DISTINCT s.id) AS invoice_count,
        COALESCE(SUM(si.line_total), 0) AS gross_sales,
        COALESCE(SUM(si.qty * si.unit_cost), 0) AS total_cost,
        COALESCE(SUM(s.discount), 0) AS total_discount,
        COALESCE(SUM(s.tax), 0) AS total_tax
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.created_at BETWEEN ? AND ?
    `).get(range.from, range.to);

    const totalReturns = db.prepare(`
      SELECT COALESCE(SUM(r.refunded_amount), 0) AS amount, COALESCE(SUM(r.qty * si.unit_cost), 0) AS cost
      FROM returns r
      JOIN sale_items si ON si.id = r.sale_item_id
      WHERE r.created_at BETWEEN ? AND ?
    `).get(range.from, range.to);

    const netSales = totals.gross_sales - totalReturns.amount;
    const netCost = totals.total_cost - totalReturns.cost;

    const topProducts = db.prepare(`
      SELECT si.name, SUM(si.qty) AS qty_sold, SUM(si.line_total) AS revenue
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.created_at BETWEEN ? AND ?
      GROUP BY si.name
      ORDER BY revenue DESC
      LIMIT 10
    `).all(range.from, range.to);

    return {
      invoiceCount: totals.invoice_count,
      grossSales: totals.gross_sales,
      totalReturns: totalReturns.amount,
      netSales,
      totalCost: netCost,
      profit: netSales - netCost,
      totalDiscount: totals.total_discount,
      totalTax: totals.total_tax,
      topProducts,
    };
  },

  getDailyClosing(date) {
    const range = { from: `${date} 00:00:00`, to: `${date} 23:59:59` };

    const byPayment = db.prepare(`
      SELECT payment_method, COALESCE(SUM(total), 0) AS total, COUNT(*) AS cnt
      FROM sales
      WHERE created_at BETWEEN ? AND ?
      GROUP BY payment_method
    `).all(range.from, range.to);

    const cash = byPayment.find((p) => p.payment_method === 'cash')?.total || 0;
    const card = byPayment.find((p) => p.payment_method === 'card')?.total || 0;
    const invoiceCount = byPayment.reduce((sum, p) => sum + p.cnt, 0);

    const totals = db.prepare(`
      SELECT COALESCE(SUM(discount), 0) AS discount, COALESCE(SUM(tax), 0) AS tax, COALESCE(SUM(total), 0) AS total
      FROM sales
      WHERE created_at BETWEEN ? AND ?
    `).get(range.from, range.to);

    const returns = db.prepare(`
      SELECT COALESCE(SUM(refunded_amount), 0) AS amount
      FROM returns
      WHERE created_at BETWEEN ? AND ?
    `).get(range.from, range.to);

    return {
      date,
      invoiceCount,
      cash,
      card,
      grossTotal: totals.total,
      discount: totals.discount,
      tax: totals.tax,
      returns: returns.amount,
      netTotal: totals.total - returns.amount,
    };
  },

  // ---------- Settings ----------
  getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  saveSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  },

  // ---------- Backup ----------
  dbPath,

  flushToDisk() {
    // Forces all WAL-journaled changes into the main .db file so a plain file copy is a complete backup.
    db.pragma('wal_checkpoint(TRUNCATE)');
  },
};
