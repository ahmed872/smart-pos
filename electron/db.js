const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { app } = require('electron');
const Database = require('better-sqlite3');
const { hashPin, verifyPin, burnVerify, isDisclosedDefaultPin, pinPolicyError } = require('./auth.js');
const v = require('./validation.js');
const { applySchema } = require('./schema.js');

// The data folder keeps its original name on purpose: renaming it would mean moving a customer's
// live database, safety backups and quarantine at first start, and older installers would no
// longer find the data after a reinstall. The risk to customer data outweighs a nicer name.
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

// Settings every installation has. Only missing keys are inserted, so values that already exist,
// including any store name, logo or currency a customer chose, are never changed. The product
// ships no store identity, currency or catalog: the first admin enters the store name and currency
// during first-run setup, and the catalog starts empty.
const SETTING_DEFAULTS = {
  store_name: '',
  currency: '',
  tax_percent: '0',
  receipt_width_mm: '58',
  invoice_reset_period: 'monthly',
  low_stock_threshold: '5',
  logo_data_url: '',
  store_address: '',
  store_phone: '',
  tax_number: '',
  commercial_register: '',
  receipt_footer: 'شكرًا لتعاملكم معنا',
};
const insertMissingSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(SETTING_DEFAULTS)) insertMissingSetting.run(key, value);

// ---------- Financial model (single source for reports and daily closing) ----------
// Per invoice: taxable = subtotal - discount, tax = taxable * rate, total = taxable + tax.
// Revenue excludes tax (tax is collected for the authority): revenue = total - tax. Using
// total - tax instead of subtotal - discount also stays correct for invoices recorded before the
// discount was capped at the subtotal. Profit = net revenue - net cost, i.e. before tax.
// A return reverses qty * unit_price minus its discount share plus its tax share.
// Sales are attributed to their invoice date and returns to the date they were recorded.
function periodTotals(fromTs, toTs) {
  // Invoice-level amounts come only from the sales table (never joined to its items), so each
  // invoice's discount/tax/total is counted exactly once.
  const s = db.prepare(`
    SELECT
      COUNT(*) AS invoice_count,
      COALESCE(SUM(subtotal), 0) AS subtotal,
      COALESCE(SUM(total - tax), 0) AS revenue,
      COALESCE(SUM(tax), 0) AS tax,
      COALESCE(SUM(total), 0) AS total,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0) AS card
    FROM sales
    WHERE created_at BETWEEN ? AND ?
  `).get(fromTs, toTs);
  const cost = db.prepare(`
    SELECT COALESCE(SUM(si.qty * si.unit_cost), 0) AS cost
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.created_at BETWEEN ? AND ?
  `).get(fromTs, toTs).cost;
  // One row per return (each return references exactly one sale item).
  const r = db.prepare(`
    SELECT
      COUNT(*) AS return_count,
      COALESCE(SUM(r.refunded_amount), 0) AS amount,
      COALESCE(SUM(r.tax_share), 0) AS tax,
      COALESCE(SUM(r.qty * si.unit_cost), 0) AS cost
    FROM returns r
    JOIN sale_items si ON si.id = r.sale_item_id
    WHERE r.created_at BETWEEN ? AND ?
  `).get(fromTs, toTs);

  const returnsRevenue = r.amount - r.tax;
  const netSales = s.revenue - returnsRevenue;
  const netCost = cost - r.cost;
  return {
    invoiceCount: s.invoice_count,
    grossSales: s.subtotal, // before discount and tax
    totalDiscount: s.subtotal - s.revenue,
    totalTax: s.tax,
    salesTotal: s.total, // what customers paid (after discount, including tax)
    cash: s.cash,
    card: s.card,
    returnsCount: r.return_count,
    totalReturns: r.amount, // refunded to customers, including tax
    returnsTax: r.tax,
    netSales, // revenue after discounts and returns, excluding tax
    netTax: s.tax - r.tax,
    netTotal: s.total - r.amount, // = netSales + netTax
    totalCost: netCost,
    profit: netSales - netCost,
  };
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
  store_name: (value) => v.displayText(value, 'اسم المتجر', 100),
  currency: (value) => v.displayText(value, 'رمز العملة', 10),
  store_address: (value) => v.displayText(value, 'العنوان', 200),
  store_phone: (value) => v.identifierText(value, 'رقم الهاتف', 40, v.PHONE_RE),
  tax_number: (value) => v.identifierText(value, 'الرقم الضريبي', 50, v.REGISTRATION_RE),
  commercial_register: (value) => v.identifierText(value, 'السجل التجاري', 50, v.REGISTRATION_RE),
  receipt_footer: (value) => v.displayText(value, 'رسالة أسفل الفاتورة', 200),
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

  // First-run setup: only possible while the users table is completely empty. The store name and
  // currency entered on the setup screen are saved in the same transaction.
  createInitialAdmin(username, pin, profile = {}) {
    const name = v.requiredText(username, 'اسم المستخدم', 50);
    const policyError = pinPolicyError(pin);
    if (policyError) throw new v.ValidationError(policyError);
    const storeProfile = profile && typeof profile === 'object' ? profile : {};
    const storeName = storeProfile.storeName === undefined ? undefined : SETTING_VALIDATORS.store_name(storeProfile.storeName);
    const currency = storeProfile.currency === undefined ? undefined : SETTING_VALIDATORS.currency(storeProfile.currency);
    const pinHash = hashPin(pin);
    return db.transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) {
        throw new v.ValidationError('تم إعداد حساب المدير بالفعل');
      }
      const id = db.prepare("INSERT INTO users (username, pin, pin_hash, role) VALUES (?, ?, ?, 'admin')")
        .run(name, unusableLegacyPin(), pinHash).lastInsertRowid;
      const setSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      if (storeName !== undefined) setSetting.run('store_name', storeName);
      if (currency !== undefined) setSetting.run('currency', currency);
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
    if (verifyPin(newPin, user.pin_hash)) throw new v.ValidationError('يجب أن يختلف الرقم السري الجديد عن الرقم الحالي');
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
    const refunds = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(refunded_amount), 0) AS amount, COALESCE(SUM(tax_share), 0) AS tax
      FROM returns WHERE sale_id = ?
    `).get(saleId);
    return {
      sale,
      items: items.map((it) => ({ ...it, returned_qty: returnedMap[it.id] || 0 })),
      refunds,
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

    // The returned goods carry their proportional share of the invoice discount and tax, so a
    // refund reverses exactly what the customer paid for them (see periodTotals for the model).
    const sale = db.prepare('SELECT subtotal, tax, total FROM sales WHERE id = ?').get(saleId);
    const lineGross = qty * item.unit_price;
    const fraction = sale && sale.subtotal > 0 ? lineGross / sale.subtotal : 0;
    const effectiveDiscount = sale ? Math.max(sale.subtotal - (sale.total - sale.tax), 0) : 0;
    const discountShare = effectiveDiscount * fraction;
    const taxShare = (sale ? sale.tax : 0) * fraction;
    const refundedAmount = lineGross - discountShare + taxShare;

    const insertReturn = db.prepare(`
      INSERT INTO returns (sale_id, sale_item_id, product_id, qty, refunded_amount, discount_share, tax_share, reason, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const restoreStock = db.prepare(`
      UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND track_stock = 1
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (product_id, change_qty, reason) VALUES (?, ?, 'return')
    `);

    const tx = db.transaction(() => {
      const returnId = insertReturn.run(
        saleId, saleItemId, item.product_id, qty, refundedAmount, discountShare, taxShare, reason || null, userId || null
      ).lastInsertRowid;
      if (item.product_id) {
        restoreStock.run(qty, item.product_id);
        insertMovement.run(item.product_id, qty);
      }
      return returnId;
    });

    return { returnId: tx(), refundedAmount, discountShare, taxShare };
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
    const totals = periodTotals(range.from, range.to);

    const topProducts = db.prepare(`
      SELECT si.name, SUM(si.qty) AS qty_sold, SUM(si.line_total) AS revenue
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.created_at BETWEEN ? AND ?
      GROUP BY si.name
      ORDER BY revenue DESC
      LIMIT 10
    `).all(range.from, range.to);

    return { ...totals, topProducts };
  },

  getDailyClosing(date) {
    const range = { from: `${date} 00:00:00`, to: `${date} 23:59:59` };
    const t = periodTotals(range.from, range.to);
    return {
      ...t,
      date,
      grossTotal: t.salesTotal,
      discount: t.totalDiscount,
      tax: t.totalTax,
      returns: t.totalReturns,
    };
  },

  // ---------- Settings ----------
  getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  saveSetting(key, value) {
    this.saveSettings({ [key]: value });
  },

  // Validates every value first and then saves them in one transaction: either all of them are
  // stored or none is.
  saveSettings(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new v.ValidationError('بيانات الإعدادات غير صالحة');
    const entries = Object.entries(values).map(([key, value]) => {
      const normalize = Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key) ? SETTING_VALIDATORS[key] : null;
      if (!normalize) throw new v.ValidationError('إعداد غير معروف');
      return [key, normalize(value)];
    });
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    db.transaction(() => { for (const [key, value] of entries) upsert.run(key, value); })();
  },

  // ---------- Backup ----------
  dbPath,

  flushToDisk() {
    // Forces all WAL-journaled changes into the main .db file so a plain file copy is a complete backup.
    db.pragma('wal_checkpoint(TRUNCATE)');
  },
};
