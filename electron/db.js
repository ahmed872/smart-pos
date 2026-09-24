const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app } = require('electron');
const Database = require('better-sqlite3');
const DEFAULT_LOGO_DATA_URL = require('./default-logo.js');
const { hashPin, verifyPin, burnVerify, isDisclosedDefaultPin, pinPolicyError } = require('./auth.js');
const v = require('./validation.js');
const { applySchema } = require('./schema.js');

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

applySchema(db);

// Migration: PINs used to be stored and compared in plaintext. Each legacy PIN is
// hashed into pin_hash and the plaintext column is overwritten with random bytes
// (the column is NOT NULL, and an older build must never match an empty value).
// Accounts still on a publicly disclosed default PIN must choose a new one at next login.
// (The pin_hash / must_change_pin columns themselves are added by applySchema.)
function unusableLegacyPin() {
  return '!' + crypto.randomBytes(32).toString('hex');
}
const legacyUsers = db.prepare('SELECT id, pin FROM users WHERE pin_hash IS NULL').all();
if (legacyUsers.length > 0) {
  const migrateUser = db.prepare('UPDATE users SET pin_hash = ?, pin = ?, must_change_pin = ? WHERE id = ?');
  db.transaction(() => {
    for (const u of legacyUsers) {
      const legacyPin = u.pin == null ? '' : String(u.pin);
      // An empty legacy PIN cannot be verified, so it gets an unusable hash; an admin can reset it.
      const pinHash = legacyPin === '' ? hashPin(unusableLegacyPin()) : hashPin(legacyPin);
      migrateUser.run(pinHash, unusableLegacyPin(), isDisclosedDefaultPin(legacyPin) ? 1 : 0, u.id);
    }
  })();
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
  // No default users are created: on a fresh install the first admin account is
  // created from the login screen (see createInitialAdmin).
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

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, mustChangePin: !!user.must_change_pin };
}

function assertAnotherActiveAdmin(exceptUserId) {
  const others = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
    .get(exceptUserId).c;
  if (others === 0) throw new v.ValidationError('لا يمكن إيقاف أو تغيير صلاحية آخر مدير مفعل في النظام');
}

// Only these settings exist; each value is validated and normalized before it is stored.
const SETTING_VALIDATORS = {
  store_name: (value) => v.optionalText(value, 'اسم المتجر', 200) || '',
  currency: (value) => v.optionalText(value, 'رمز العملة', 20) || '',
  tax_percent: (value) => String(v.numberInRange(value, 'نسبة الضريبة', 0, 100)),
  receipt_width_mm: (value) => String(v.numberInRange(value, 'عرض الفاتورة', 30, 120)),
  invoice_reset_period: (value) => v.oneOf(value, 'تصفير ترقيم الفواتير', ['monthly', 'weekly', 'never']),
  low_stock_threshold: (value) => String(v.nonNegativeNumber(value, 'حد تنبيه المخزون')),
  logo_data_url: (value) => v.optionalImageDataUrl(value, 'الشعار') || '',
};

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
    if (typeof username !== 'string' || typeof pin !== 'string') return null;
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.trim());
    if (!user) {
      burnVerify(pin);
      return null;
    }
    if (!verifyPin(pin, user.pin_hash)) return null;
    return publicUser(user);
  },

  // Re-reads the user on every privileged request so deactivation or a role change
  // takes effect immediately, even for an already logged-in session.
  getActiveUser(id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(id);
    return user ? publicUser(user) : null;
  },

  hasAnyUser() {
    return db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0;
  },

  // First-run setup: only possible while the users table is completely empty.
  createInitialAdmin(username, pin) {
    const name = v.requiredText(username, 'اسم المستخدم', 50);
    const policyError = pinPolicyError(pin);
    if (policyError) throw new v.ValidationError(policyError);
    const pinHash = hashPin(pin);
    return db.transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) {
        throw new v.ValidationError('تم إعداد حساب المدير بالفعل');
      }
      const id = db.prepare("INSERT INTO users (username, pin, pin_hash, role) VALUES (?, ?, ?, 'admin')")
        .run(name, unusableLegacyPin(), pinHash).lastInsertRowid;
      return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    })();
  },

  changeOwnPin(userId, currentPin, newPin) {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
    if (!user || !verifyPin(typeof currentPin === 'string' ? currentPin : '', user.pin_hash)) {
      throw new v.ValidationError('الرقم السري الحالي غير صحيح');
    }
    const policyError = pinPolicyError(newPin);
    if (policyError) throw new v.ValidationError(policyError);
    if (verifyPin(newPin, user.pin_hash)) throw new v.ValidationError('الرقم السري الجديد لازم يختلف عن الحالي');
    db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 0 WHERE id = ?').run(hashPin(newPin), userId);
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  },

  getUsers() {
    return db.prepare('SELECT id, username, role, is_active FROM users ORDER BY username').all();
  },

  saveUser(user) {
    if (!user || typeof user !== 'object') throw new v.ValidationError('بيانات المستخدم غير صالحة');
    const username = v.requiredText(user.username, 'اسم المستخدم', 50);
    // On update, the role only changes when the caller explicitly sends one; otherwise the
    // user keeps their current role (changing a PIN must never change permissions).
    const roleGiven = user.role !== undefined && user.role !== null && user.role !== '';
    const requestedRole = roleGiven ? v.oneOf(user.role, 'الصلاحية', ['admin', 'cashier']) : null;
    const hasPin = user.pin !== undefined && user.pin !== null && user.pin !== '';
    if (hasPin) {
      const policyError = pinPolicyError(user.pin);
      if (policyError) throw new v.ValidationError(policyError);
    }
    const pinHash = hasPin ? hashPin(user.pin) : null;

    if (user.id) {
      const id = v.positiveId(user.id, 'المستخدم');
      return db.transaction(() => {
        const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!existing) throw new v.ValidationError('المستخدم غير موجود');
        const role = requestedRole || existing.role;
        if (existing.role === 'admin' && existing.is_active && role !== 'admin') assertAnotherActiveAdmin(id);
        if (pinHash) {
          db.prepare('UPDATE users SET username=?, pin_hash=?, must_change_pin=0, role=? WHERE id=?')
            .run(username, pinHash, role, id);
        } else {
          db.prepare('UPDATE users SET username=?, role=? WHERE id=?').run(username, role, id);
        }
        return id;
      })();
    }
    if (!pinHash) throw new v.ValidationError('الرقم السري مطلوب');
    const info = db.prepare('INSERT INTO users (username, pin, pin_hash, role) VALUES (?, ?, ?, ?)')
      .run(username, unusableLegacyPin(), pinHash, requestedRole || 'cashier');
    return info.lastInsertRowid;
  },

  setUserActive(id, isActive) {
    const userId = v.positiveId(id, 'المستخدم');
    db.transaction(() => {
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!existing) throw new v.ValidationError('المستخدم غير موجود');
      if (!isActive && existing.role === 'admin' && existing.is_active) assertAnotherActiveAdmin(userId);
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, userId);
    })();
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
    if (!product || typeof product !== 'object') throw new v.ValidationError('بيانات المنتج غير صالحة');
    const p = {
      name: v.requiredText(product.name, 'اسم المنتج'),
      barcode: v.optionalText(product.barcode, 'الباركود', 100),
      categoryId: v.optionalId(product.category_id, 'الفئة'),
      price: v.nonNegativeNumber(product.price, 'السعر'),
      cost: v.nonNegativeNumber(product.cost ?? 0, 'التكلفة'),
      stockQty: v.nonNegativeNumber(product.stock_qty ?? 0, 'الكمية بالمخزون'),
      trackStock: product.track_stock ? 1 : 0,
      image: v.optionalImageDataUrl(product.image_data_url, 'صورة المنتج'),
    };
    if (p.categoryId && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(p.categoryId)) {
      throw new v.ValidationError('الفئة غير موجودة');
    }
    if (product.id) {
      const id = v.positiveId(product.id, 'المنتج');
      const info = db.prepare(`
        UPDATE products SET name=?, barcode=?, category_id=?, price=?, cost=?, stock_qty=?, track_stock=?, image_data_url=?
        WHERE id=?
      `).run(p.name, p.barcode, p.categoryId, p.price, p.cost, p.stockQty, p.trackStock, p.image, id);
      if (info.changes === 0) throw new v.ValidationError('المنتج غير موجود');
      return id;
    }
    const info = db.prepare(`
      INSERT INTO products (name, barcode, category_id, price, cost, stock_qty, track_stock, image_data_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p.name, p.barcode, p.categoryId, p.price, p.cost, p.stockQty, p.trackStock, p.image);
    return info.lastInsertRowid;
  },

  deleteProduct(id) {
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(v.positiveId(id, 'المنتج'));
  },

  saveCategory(name, isKitchen) {
    const info = db.prepare('INSERT INTO categories (name, is_kitchen) VALUES (?, ?)')
      .run(v.requiredText(name, 'اسم الفئة', 100), isKitchen ? 1 : 0);
    return info.lastInsertRowid;
  },

  // ---------- Sales ----------
  // Prices, names, kitchen flags and the tax rate come from the database, never from the
  // renderer; the renderer only chooses which products, how many, the discount and payment method.
  createSale(payload) {
    if (!payload || typeof payload !== 'object') throw new v.ValidationError('بيانات الفاتورة غير صالحة');
    const { userId = null } = payload;
    if (!Array.isArray(payload.items) || payload.items.length === 0) throw new v.ValidationError('الفاتورة فارغة');
    if (payload.items.length > 1000) throw new v.ValidationError('عدد الأصناف كبير جدًا');
    const paymentMethod = v.oneOf(payload.paymentMethod ?? 'cash', 'طريقة الدفع', ['cash', 'card']);
    const discount = v.nonNegativeNumber(payload.discount ?? 0, 'الخصم');
    // Same interpretation as the POS screen: a blank/non-numeric stored rate means 0%.
    const taxPercent = Number(this.getSettings().tax_percent) || 0;
    if (taxPercent < 0 || taxPercent > 100) {
      throw new v.ValidationError('نسبة الضريبة المحفوظة في الإعدادات غير صالحة، يرجى تصحيحها من شاشة الإعدادات');
    }

    const getProductForSale = db.prepare(`
      SELECT p.id, p.name, p.price, p.is_active, c.is_kitchen AS category_is_kitchen
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ?
    `);
    const items = payload.items.map((raw) => {
      if (!raw || typeof raw !== 'object') throw new v.ValidationError('صنف غير صالح في الفاتورة');
      const productId = v.positiveId(raw.product_id, 'المنتج');
      const qty = v.positiveNumber(raw.qty, 'الكمية');
      const product = getProductForSale.get(productId);
      if (!product || !product.is_active) throw new v.ValidationError('منتج غير موجود في الفاتورة');
      return {
        product_id: product.id,
        name: product.name,
        qty,
        unit_price: product.price,
        is_kitchen_item: product.category_is_kitchen ? 1 : 0,
      };
    });

    const subtotal = items.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
    if (discount > subtotal) throw new v.ValidationError('الخصم لا يمكن أن يكون أكبر من إجمالي الفاتورة');
    const taxable = subtotal - discount;
    const tax = taxable * (taxPercent / 100);
    const total = taxable + tax;
    const customerId = null;
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
    return db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT ?').all(v.numberInRange(limit ?? 100, 'العدد', 1, 10000));
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
  createReturn(payload) {
    if (!payload || typeof payload !== 'object') throw new v.ValidationError('بيانات الإرجاع غير صالحة');
    const saleItemId = v.positiveId(payload.saleItemId, 'صنف الفاتورة');
    const qty = v.positiveNumber(payload.qty, 'الكمية المطلوب إرجاعها');
    const reason = v.optionalText(payload.reason, 'سبب الإرجاع', 500);
    const { userId } = payload;
    const item = db.prepare('SELECT * FROM sale_items WHERE id = ?').get(saleItemId);
    if (!item) throw new Error('صنف الفاتورة غير موجود');
    if (payload.saleId !== undefined && v.positiveId(payload.saleId, 'الفاتورة') !== item.sale_id) {
      throw new v.ValidationError('صنف الفاتورة لا يتبع هذه الفاتورة');
    }
    const saleId = item.sale_id;

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
    db.prepare("UPDATE sales SET kitchen_status = ? WHERE id = ? AND kitchen_status != 'none'")
      .run(v.oneOf(status, 'حالة الطلب', ['pending', 'preparing', 'ready']), v.positiveId(saleId, 'الفاتورة'));
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
    const normalize = SETTING_VALIDATORS[key];
    if (!normalize) throw new v.ValidationError('إعداد غير معروف');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, normalize(value));
  },

  // ---------- Backup ----------
  dbPath,

  flushToDisk() {
    // Forces all WAL-journaled changes into the main .db file so a plain file copy is a complete backup.
    db.pragma('wal_checkpoint(TRUNCATE)');
  },
};
