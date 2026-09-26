// Pre-delivery (Phase 4) regressions: each test pins down a defect found in the final client
// readiness audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, makeTempHome } = require('./harness.js');

const PIN = 'Owner-PIN-1';

async function admin(profile = { storeName: 'متجر' }) {
  const home = makeTempHome();
  const ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', PIN, profile);
  return { home, ctx, c: ctx.call };
}

async function today(c) {
  return (await c('sales:list', 1))[0].created_at.slice(0, 10);
}

const cents = (n) => Math.round(n * 100);

// ---------- Money is kept at the precision printed on invoices ----------

test('F1: invoice amounts are rounded to the currency precision, so closing = sum of printed receipts', async () => {
  const { ctx, c } = await admin();
  await c('settings:save', 'tax_percent', '14');
  const A = await c('products:save', { name: 'A', price: 33.33, cost: 20 });
  const totals = [];
  for (let i = 0; i < 3; i++) {
    const s = await c('sales:create', { items: [{ product_id: A, qty: 1 }], paymentMethod: 'cash' });
    // 33.33 * 14% = 4.6662 -> 4.67; total 38.00 (was stored as 37.9962)
    assert.equal(s.tax, 4.67);
    assert.equal(s.total, 38);
    totals.push(s.total);
  }
  const d = await today(c);
  const rep = await c('reports:summary', d, d);
  const close = await c('reports:dailyClosing', d);
  assert.equal(cents(rep.netTotal), 11400, 'report equals the three printed receipts (114.00)');
  assert.equal(cents(close.cash), 11400, 'cash in the closing equals the cash taken');
  assert.equal(cents(rep.totalTax), 1401);
  // line totals and subtotal are rounded the same way
  const B = await c('products:save', { name: 'B', price: 1.005 });
  const s = await c('sales:create', { items: [{ product_id: B, qty: 3 }] });
  const full = await c('sales:full', s.saleId);
  assert.equal(full.items[0].line_total, 3.02);
  assert.equal(full.sale.subtotal, 3.02);
  shutdown(ctx);
});

test('F1: partial refunds add up exactly to what was paid (no over- or under-refund)', async () => {
  const { ctx, c } = await admin();
  await c('settings:save', 'tax_percent', '14');
  const B = await c('products:save', { name: 'B', price: 10, cost: 5, stock_qty: 10, track_stock: true });
  const sale = await c('sales:create', { items: [{ product_id: B, qty: 3 }], discount: 0.01 });
  const full = await c('sales:full', sale.saleId);
  assert.equal(full.sale.total, 34.19); // 29.99 + 4.20
  const refunds = [];
  for (let i = 0; i < 3; i++) {
    refunds.push((await c('returns:create', { saleItemId: full.items[0].id, qty: 1 })).refundedAmount);
  }
  for (const r of refunds) assert.equal(r, Math.round(r * 100) / 100, `refund ${r} is a printable amount`);
  assert.equal(cents(refunds.reduce((a, b) => a + b, 0)), 3419, `refunds ${refunds} = paid 34.19`);
  const d = await today(c);
  const rep = await c('reports:summary', d, d);
  assert.equal(cents(rep.netTotal), 0);
  assert.equal(cents(rep.netTax), 0);
  assert.equal(cents(rep.netSales), 0);
  assert.equal((await c('products:list')).find((p) => p.id === B).stock_qty, 10);
  shutdown(ctx);
});

test('F1: multi-line invoice with discount and tax, returned line by line in odd quantities', async () => {
  const { ctx, c } = await admin();
  await c('settings:save', 'tax_percent', '15');
  const A = await c('products:save', { name: 'A', price: 7.77, cost: 3 });
  const B = await c('products:save', { name: 'B', price: 12.49, cost: 6 });
  const sale = await c('sales:create', { items: [{ product_id: A, qty: 7 }, { product_id: B, qty: 3 }], discount: 3.33 });
  const full = await c('sales:full', sale.saleId);
  // subtotal 54.39 + 37.47 = 91.86; taxable 88.53; tax 13.28 (13.2795); total 101.81
  assert.deepEqual([full.sale.subtotal, full.sale.tax, full.sale.total], [91.86, 13.28, 101.81]);
  const [la, lb] = full.items;
  let refunded = 0;
  for (const [line, qty] of [[la, 2], [lb, 1], [la, 4], [lb, 2], [la, 1]]) {
    refunded += (await c('returns:create', { saleItemId: line.id, qty })).refundedAmount;
  }
  assert.equal(cents(refunded), 10181, 'everything returned = everything paid');
  shutdown(ctx);
});

// ---------- Products and inventory ----------

test('F6: a deleted product releases its barcode (new product can use it, also for older deletions)', async () => {
  const { ctx, c } = await admin();
  const old = await c('products:save', { name: 'قديم', price: 5, barcode: '6221234567890' });
  await c('products:delete', old);
  const neu = await c('products:save', { name: 'جديد', price: 6, barcode: '6221234567890' });
  assert.equal((await c('products:list')).find((p) => p.barcode === '6221234567890').id, neu);
  // databases written before this fix: the deleted product still holds the barcode
  ctx.store.db.prepare("UPDATE products SET is_active = 0, barcode = '777' WHERE id = ?").run(old);
  const again = await c('products:save', { name: 'ثالث', price: 1, barcode: '777' });
  assert.ok(again > 0);
  // an ACTIVE product's barcode is still protected
  await assert.rejects(c('products:save', { name: 'x', price: 1, barcode: '777' }), { message: 'الباركود مستخدم لمنتج آخر' });
  shutdown(ctx);
});

test('F7: editing a product without touching the stock keeps sales made meanwhile; stock changes are logged', async () => {
  const { ctx, c } = await admin();
  const id = await c('products:save', { name: 'A', price: 10, stock_qty: 20, track_stock: true });
  const shown = (await c('products:list')).find((p) => p.id === id); // edit form opened (stock 20)
  await c('sales:create', { items: [{ product_id: id, qty: 3 }] }); // sale while the form is open
  const { stock_qty: _ignored, ...edited } = { ...shown, price: 12 }; // price edited, stock untouched
  await c('products:save', edited);
  const after = (await c('products:list')).find((p) => p.id === id);
  assert.equal(after.price, 12);
  assert.equal(after.stock_qty, 17, 'the sale deduction is not overwritten');
  await c('products:save', { ...edited, stock_qty: 25 }); // explicit stock count
  assert.equal((await c('products:list')).find((p) => p.id === id).stock_qty, 25);
  const moves = ctx.store.db.prepare('SELECT change_qty, reason FROM stock_movements WHERE product_id = ? ORDER BY id').all(id);
  assert.deepEqual(moves, [
    { change_qty: 20, reason: 'adjustment' }, { change_qty: -3, reason: 'sale' }, { change_qty: 8, reason: 'adjustment' },
  ]);
  // the product form only sends the stock when it was changed
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /value === loadedStockValue\s*\n?\s*\? \{\}/);
  shutdown(ctx);
});

test('F8: invoice numbering stays unique and sensible when the reset period is switched', async () => {
  const { ctx, c } = await admin();
  const A = await c('products:save', { name: 'A', price: 1 });
  const sell = async () => (await c('sales:create', { items: [{ product_id: A, qty: 1 }] })).saleNumber;
  const monthly = await sell();
  assert.match(monthly, /^INV-\d{6}-000001$/);
  await c('settings:save', 'invoice_reset_period', 'never');
  assert.deepEqual([await sell(), await sell()], ['INV-000001', 'INV-000002']); // was 'INV-202610'
  await c('settings:save', 'invoice_reset_period', 'weekly');
  assert.match(await sell(), /^INV-\d{4}W\d{2}-000001$/);
  await c('settings:save', 'invoice_reset_period', 'monthly');
  assert.match(await sell(), /^INV-\d{6}-000002$/);
  await c('settings:save', 'invoice_reset_period', 'never');
  assert.equal(await sell(), 'INV-000003');
  // a number already taken (e.g. by an older numbering scheme) is skipped instead of failing the sale
  ctx.store.db.prepare("UPDATE sales SET sale_number = 'INV-000004' WHERE sale_number = ?").run(monthly);
  assert.equal(await sell(), 'INV-000005');
  shutdown(ctx);
});

test('F9: absurd amounts and quantities are rejected with a clear message', async () => {
  const { ctx, c } = await admin();
  await assert.rejects(c('products:save', { name: 'x', price: 1e308 }), /السعر: يجب ألا تزيد عن 1,000,000,000/);
  await assert.rejects(c('products:save', { name: 'x', price: 1, cost: 5e9 }), /التكلفة: يجب ألا تزيد/);
  await assert.rejects(c('products:save', { name: 'x', price: 1, stock_qty: 1e12 }), /الكمية بالمخزون: يجب ألا تزيد/);
  const A = await c('products:save', { name: 'A', price: 999999999 });
  await assert.rejects(c('sales:create', { items: [{ product_id: A, qty: 1e20 }] }), /الكمية: يجب ألا تزيد عن 1,000,000/);
  await assert.rejects(c('sales:create', { items: [{ product_id: A, qty: 0.0001 }] }), /الكمية: يجب أن تكون أكبر من صفر/);
  await assert.rejects(c('sales:create', { items: [{ product_id: A, qty: 1 }], discount: 1e10 }), /الخصم: يجب ألا تزيد/);
  const big = await c('sales:create', { items: [{ product_id: A, qty: 1000 }] });
  assert.ok(Number.isFinite(big.total));
  shutdown(ctx);
});

test('F10: decimal quantities sell and return without floating-point rejections', async () => {
  const { ctx, c } = await admin();
  const W = await c('products:save', { name: 'W', price: 10, stock_qty: 1, track_stock: true });
  const s = await c('sales:create', { items: [{ product_id: W, qty: 0.1 }, { product_id: W, qty: 0.2 }] });
  const full = await c('sales:full', s.saleId);
  assert.equal((await c('products:list'))[0].stock_qty, 0.7);
  await c('sales:create', { items: [{ product_id: W, qty: 0.7 }] }); // exactly the rest of the stock
  assert.equal((await c('products:list'))[0].stock_qty, 0);
  const line = full.items[1]; // 0.2
  await c('returns:create', { saleItemId: line.id, qty: 0.1 });
  await c('returns:create', { saleItemId: line.id, qty: 0.1 }); // was rejected (0.2 - 0.1 = 0.09999...)
  await assert.rejects(c('returns:create', { saleItemId: line.id, qty: 0.001 }), /غير صحيحة/);
  assert.equal((await c('products:list'))[0].stock_qty, 0.2);
  shutdown(ctx);
});

test('F17: names, barcodes and reasons reject control and bidi-override characters', async () => {
  const { ctx, c } = await admin();
  await assert.rejects(c('products:save', { name: 'منتج‮معكوس', price: 1 }), /اسم المنتج: يحتوي على رموز غير مسموحة/);
  await assert.rejects(c('products:save', { name: 'ok', price: 1, barcode: 'a\nb' }), /الباركود: يحتوي/);
  await assert.rejects(c('categories:save', 'فئة\u0007', false), /اسم الفئة: يحتوي/);
  await assert.rejects(c('users:save', { username: 'a⁦b', pin: 'abcd-1234', role: 'cashier' }), /اسم المستخدم: يحتوي/);
  // ordinary Arabic, English, quotes and HTML-like text are fine (escaped when rendered)
  const id = await c('products:save', { name: 'عصير "Orange" <500ml> & ثلج', price: 1 });
  assert.equal((await c('products:list')).find((p) => p.id === id).name, 'عصير "Orange" <500ml> & ثلج');
  shutdown(ctx);
});

// ---------- Performance ----------

test('F3: the kitchen screen lists only current open orders and stays fast with a large history', async () => {
  const { ctx, c } = await admin();
  const kitchen = await c('categories:save', 'مطبخ', true);
  const drinks = await c('categories:save', 'مشروبات', false);
  const food = await c('products:save', { name: 'برجر', price: 50, category_id: kitchen });
  const juice = await c('products:save', { name: 'عصير', price: 10, category_id: drinks });
  // a shop that never marks orders ready: thousands of old open orders
  for (let i = 0; i < 3000; i++) await c('sales:create', { items: [{ product_id: food, qty: 1 }] });
  ctx.store.db.prepare("UPDATE sales SET created_at = datetime('now', 'localtime', '-3 days')").run();
  const fresh = await c('sales:create', { items: [{ product_id: food, qty: 2 }, { product_id: juice, qty: 1 }] });
  const done = await c('sales:create', { items: [{ product_id: food, qty: 1 }] });
  await c('kitchen:updateStatus', done.saleId, 'ready');
  const started = process.hrtime.bigint();
  const orders = await c('kitchen:list');
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(orders.map((o) => o.sale_id), [fresh.saleId]);
  assert.deepEqual(orders[0].items.map((it) => [it.name, it.qty]), [['برجر', 2]], 'only kitchen items');
  assert.ok(ms < 200, `kitchen list took ${ms} ms`);
  shutdown(ctx);
});

test('F4: uploaded product photos and logos are resized before they are stored', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /readImageFile\(file, \{ maxSize: 256, type: 'image\/jpeg' \}\)/);
  assert.match(src, /readImageFile\(file, \{ maxSize: 600, type: 'image\/png' \}\)/);
  assert.ok(!/reader\.onload = \(\) => \{\s*pending(ProductImage|DataUrl) = reader\.result/.test(src), 'no raw file is stored');
});

test('F17 follow-up: the multi-line invoice QR text is still accepted (line breaks only)', async () => {
  const { ctx, c } = await admin();
  const SI = require('../renderer/store-identity.js');
  const text = SI.invoiceQrText({ sale_number: 'INV-000001', created_at: '2026-09-26 10:00:00', total: 10, tax: 1 }, { store_name: 'متجر', tax_number: '123' });
  assert.ok(text.includes('\n'));
  assert.match(await c('print:qr', text), /^data:image\/png;base64,/);
  await assert.rejects(c('print:qr', 'a‮b'), /يحتوي على رموز غير مسموحة/);
  await assert.rejects(c('print:qr', 'x'.repeat(501)), /طويل جدًا/);
  shutdown(ctx);
});

// ---------- Cashier workflow ----------

test('F5: an older invoice can be found by its number (for returns), also by a cashier', async () => {
  const { ctx, c } = await admin();
  await c('settings:save', 'invoice_reset_period', 'never');
  const A = await c('products:save', { name: 'A', price: 1 });
  for (let i = 0; i < 150; i++) await c('sales:create', { items: [{ product_id: A, qty: 1 }] });
  assert.ok(!(await c('sales:list', 100)).some((s) => s.sale_number === 'INV-000007'), 'not in the latest 100');
  await c('users:save', { username: 'k', pin: 'kash-111', role: 'cashier' });
  await c('auth:login', 'k', 'kash-111');
  assert.deepEqual((await c('sales:find', 'INV-000007')).map((s) => s.sale_number), ['INV-000007']);
  assert.equal((await c('sales:find', '00012')).length, 11, 'partial number: 000012 and 000120-000129');
  assert.deepEqual(await c('sales:find', '%'), [], 'LIKE wildcards are matched literally');
  assert.deepEqual(await c('sales:find', '_'), []);
  await assert.rejects(c('sales:find', ''), /رقم الفاتورة مطلوب/);
  await c('auth:logout');
  await assert.rejects(c('sales:find', 'INV'), /تسجيل الدخول/);
  shutdown(ctx);
});

test('F2/F11-F14: cashier screen guards (source checks backing the E2E run)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /checkoutBtn\.addEventListener\('click', \(\) => runOnce\(checkoutBtn, checkout\)\)/);
  assert.match(src, /\[data-return-item\][\s\S]*?runOnce\(btn/);
  assert.match(src, /saveProductBtn\.addEventListener\('click', \(\) => runOnce\(saveProductBtn/);
  assert.match(src, /confirm\(`هل تريد حذف المنتج/);
  assert.match(src, /alert\('السعر مطلوب'\)/);
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(src), 'dates use local time');
  assert.match(src, /يجب أن يكون تاريخ البداية قبل تاريخ النهاية/);
});

// ---------- Security ----------

test('F15: repeated wrong PINs lock that username for 30 seconds; other users are not affected', async (t) => {
  const { ctx, c } = await admin();
  await c('users:save', { username: 'k', pin: 'kash-111', role: 'cashier' });
  for (let i = 0; i < 5; i++) assert.equal(await c('auth:login', 'k', `wrong-${i}`), null);
  await assert.rejects(c('auth:login', 'k', 'kash-111'), /تم إيقاف تسجيل الدخول لهذا المستخدم مؤقتًا/);
  await assert.rejects(c('auth:login', ' K ', 'kash-111'), /مؤقتًا/, 'same account, other spelling');
  assert.equal((await c('auth:login', 'owner', PIN)).role, 'admin', 'the owner can still log in');
  // after the lock expires the correct PIN works again and the counter starts over
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 1000 });
  assert.equal((await c('auth:login', 'k', 'kash-111')).role, 'cashier');
  for (let i = 0; i < 4; i++) assert.equal(await c('auth:login', 'k', `wrong-${i}`), null);
  assert.equal((await c('auth:login', 'k', 'kash-111')).role, 'cashier', '4 failures do not lock');
  t.mock.timers.reset();
  shutdown(ctx);
});

test('F16: cost prices and profit are not sent to cashiers or the kitchen screen', async () => {
  const { ctx, c } = await admin();
  const kitchen = await c('categories:save', 'مطبخ', true);
  const A = await c('products:save', { name: 'A', price: 10, cost: 6, category_id: kitchen });
  const sale = await c('sales:create', { items: [{ product_id: A, qty: 1 }] });
  const d = await today(c);
  assert.equal((await c('products:list'))[0].cost, 6, 'admin sees cost');
  assert.equal((await c('reports:dailyClosing', d)).profit, 4, 'admin sees profit');
  await c('users:save', { username: 'k', pin: 'kash-111', role: 'cashier' });
  await c('auth:login', 'k', 'kash-111');
  assert.ok(!('cost' in (await c('products:list'))[0]));
  assert.ok(!('unit_cost' in (await c('sales:items', sale.saleId))[0]));
  assert.ok(!('unit_cost' in (await c('sales:full', sale.saleId)).items[0]));
  const closing = await c('reports:dailyClosing', d);
  assert.ok(!('profit' in closing) && !('totalCost' in closing));
  assert.equal(closing.netTotal, 10, 'the closing itself is complete');
  assert.ok(!('unit_cost' in (await c('kitchen:list'))[0].items[0]));
  shutdown(ctx);
});

// ---------- Financial deep audit (multi-day, hand-computed) ----------

test('Part 2: multi-day ledger - days add up, closing = report, returns land on their own day, stock = movements', async () => {
  const { ctx, c } = await admin();
  const db = ctx.store.db;
  const P = await c('products:save', { name: 'P', price: 12.5, cost: 7.25, stock_qty: 100, track_stock: true });
  const Q = await c('products:save', { name: 'Q', price: 3.99, cost: 1.1, stock_qty: 1000, track_stock: true });
  const R = await c('products:save', { name: 'R', price: 250000, cost: 180000, stock_qty: 10, track_stock: true });
  const at = (saleId, day) => db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(`${day} 10:00:00`, saleId);
  const D1 = '2026-01-10';
  const D2 = '2026-01-11';

  // Day 1 --------------------------------------------------------------
  await c('settings:save', 'tax_percent', '0');
  const s1 = await c('sales:create', { items: [{ product_id: P, qty: 2 }] }); // 25.00, no tax, no discount
  at(s1.saleId, D1);
  await c('settings:save', 'tax_percent', '14');
  const s2 = await c('sales:create', { items: [{ product_id: P, qty: 3 }, { product_id: Q, qty: 7 }], discount: 5.5, paymentMethod: 'card' });
  at(s2.saleId, D1);
  // s2: 37.50 + 27.93 = 65.43; taxable 59.93; tax 8.3902 -> 8.39; total 68.32; cost 3*7.25 + 7*1.1 = 29.45
  assert.deepEqual([s2.subtotal, s2.tax, s2.total], [65.43, 8.39, 68.32]);
  const s3 = await c('sales:create', { items: [{ product_id: R, qty: 2 }], discount: 1000 }); // large values
  at(s3.saleId, D1);
  // s3: 500000; taxable 499000; tax 69860; total 568860; cost 360000

  // Day 2: returns of day-1 sales and a new sale ---------------------------
  const f2 = await c('sales:full', s2.saleId);
  const r1 = await c('returns:create', { saleItemId: f2.items.find((i) => i.product_id === Q).id, qty: 3 });
  // Q line 27.93 * 3/7 = 11.97 gross; fraction 11.97/65.43; discount 5.5 -> 1.01 (1.00619); tax 8.39 -> 1.53 (1.5349)
  assert.deepEqual([r1.discountShare, r1.taxShare, r1.refundedAmount], [1.01, 1.53, 12.49]);
  const f3 = await c('sales:full', s3.saleId);
  const r2 = await c('returns:create', { saleItemId: f3.items[0].id, qty: 1 });
  // half of s3: gross 250000, discount 500, tax 34930 -> refund 284430
  assert.deepEqual([r2.discountShare, r2.taxShare, r2.refundedAmount], [500, 34930, 284430]);
  db.prepare('UPDATE returns SET created_at = ?').run(`${D2} 09:00:00`);
  const s4 = await c('sales:create', { items: [{ product_id: Q, qty: 10 }] }); // 39.90, tax 5.586 -> 5.59, total 45.49
  at(s4.saleId, D2);
  assert.deepEqual([s4.tax, s4.total], [5.59, 45.49]);

  const day1 = await c('reports:summary', D1, D1);
  const day2 = await c('reports:summary', D2, D2);
  const both = await c('reports:summary', D1, D2);
  const cents = (n) => Math.round(n * 100);
  // Day 1 by hand
  assert.deepEqual([day1.invoiceCount, cents(day1.grossSales), cents(day1.totalDiscount), cents(day1.totalTax), cents(day1.salesTotal),
    cents(day1.cash), cents(day1.card), day1.returnsCount, cents(day1.totalCost), cents(day1.profit)],
  [3, cents(25 + 65.43 + 500000), cents(5.5 + 1000), cents(8.39 + 69860), cents(25 + 68.32 + 568860),
    cents(25 + 568860), cents(68.32), 0, cents(14.5 + 29.45 + 360000), cents((25 + 59.93 + 499000) - (14.5 + 29.45 + 360000))]);
  // Day 2 by hand: one sale, two returns of day-1 invoices
  assert.deepEqual([day2.invoiceCount, cents(day2.salesTotal), day2.returnsCount, cents(day2.totalReturns), cents(day2.returnsTax),
    cents(day2.netSales), cents(day2.totalCost), cents(day2.profit)],
  [1, cents(45.49), 2, cents(12.49 + 284430), cents(1.53 + 34930),
    cents(39.9 - (12.49 - 1.53) - (284430 - 34930)), cents(10 * 1.1 - 3 * 1.1 - 180000),
    cents((39.9 - (12.49 - 1.53) - (284430 - 34930)) - (10 * 1.1 - 3 * 1.1 - 180000))]);
  // Days add up; each day's closing is the same numbers as its report
  for (const k of ['invoiceCount', 'grossSales', 'totalDiscount', 'totalTax', 'salesTotal', 'cash', 'card', 'returnsCount',
    'totalReturns', 'returnsTax', 'netSales', 'netTax', 'netTotal', 'totalCost', 'profit']) {
    assert.equal(cents(both[k]), cents(day1[k]) + cents(day2[k]), `${k}: D1..D2 = D1 + D2`);
  }
  for (const [day, rep] of [[D1, day1], [D2, day2]]) {
    const close = await c('reports:dailyClosing', day);
    for (const k of ['salesTotal', 'netTotal', 'cash', 'card', 'totalReturns', 'profit']) assert.equal(cents(close[k]), cents(rep[k]), `${day} ${k}`);
    assert.equal(cents(rep.netTotal), cents(rep.netSales + rep.netTax));
  }
  // Inventory: current stock = initial + all recorded movements, and matches sales/returns by hand
  const stock = Object.fromEntries((await c('products:list')).map((p) => [p.name, p.stock_qty]));
  assert.deepEqual(stock, { P: 95, Q: 1000 - 7 + 3 - 10, R: 9 });
  for (const id of [P, Q, R]) {
    const moved = db.prepare('SELECT SUM(change_qty) AS s FROM stock_movements WHERE product_id = ?').get(id).s;
    const cur = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(id).stock_qty;
    assert.equal(moved, cur, `product ${id}: stock equals the sum of its movements`);
  }
  // Empty period
  const empty = await c('reports:summary', '2025-01-01', '2025-01-31');
  assert.ok(Object.entries(empty).every(([k, val]) => (k === 'topProducts' ? val.length === 0 : val === 0)));
  shutdown(ctx);
});

// ---------- Data integrity ----------

test('Part 3: an unexpected database failure mid-sale or mid-return leaves no partial data', async () => {
  const { ctx, c } = await admin();
  const db = ctx.store.db;
  const A = await c('products:save', { name: 'A', price: 5, stock_qty: 10, track_stock: true });
  const B = await c('products:save', { name: 'B', price: 7, stock_qty: 10, track_stock: true });
  const ok = await c('sales:create', { items: [{ product_id: A, qty: 1 }, { product_id: B, qty: 1 }] });
  const snapshot = () => JSON.stringify(['sales', 'sale_items', 'returns', 'stock_movements', 'products']
    .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
  const before = snapshot();
  // simulate a disk/database error on the second line's stock movement
  db.exec(`CREATE TRIGGER fail_b AFTER INSERT ON stock_movements WHEN NEW.product_id = ${B}
           BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.rejects(c('sales:create', { items: [{ product_id: A, qty: 2 }, { product_id: B, qty: 2 }] }), /^Error: حدث خطأ غير متوقع/);
    const line = (await c('sales:full', ok.saleId)).items.find((i) => i.product_id === B);
    await assert.rejects(c('returns:create', { saleItemId: line.id, qty: 1 }), /حدث خطأ غير متوقع/);
  } finally {
    console.error = orig;
    db.exec('DROP TRIGGER fail_b');
  }
  assert.equal(snapshot(), before, 'sales, items, returns, stock and movements unchanged');
  assert.ok(logged.some((l) => l.includes('simulated disk failure')), 'the technical cause is logged for support');
  // and the POS keeps working afterwards
  assert.ok((await c('sales:create', { items: [{ product_id: B, qty: 1 }] })).saleId > ok.saleId);
  shutdown(ctx);
});

// ---------- Backup / restore ----------

test('Part 4: backup -> changes -> restore brings back every table exactly; bad files never touch live data', async () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const { home, ctx, c } = await admin({ storeName: 'متجر النسخ', currency: 'ج.م' });
  const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await c('settings:saveMany', { tax_percent: '14', store_address: 'شارع 1', store_phone: '0100', tax_number: '9-9', logo_data_url: LOGO });
  const cat = await c('categories:save', 'مشروبات', true);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await c('products:save', { name: `منتج ${i}`, barcode: `B${i}`, category_id: i % 2 ? cat : null, price: 1.25 * (i + 1), cost: i, stock_qty: 50, track_stock: i % 3 !== 0 }));
  await c('users:save', { username: 'k1', pin: 'kash-111', role: 'cashier' });
  for (let i = 0; i < 30; i++) {
    const s = await c('sales:create', { items: [{ product_id: ids[i % 20], qty: 1 + (i % 3) }, { product_id: ids[(i * 7) % 20], qty: 1 }], discount: i % 4, paymentMethod: i % 2 ? 'card' : 'cash' });
    if (i % 5 === 0) await c('returns:create', { saleItemId: (await c('sales:full', s.saleId)).items[0].id, qty: 1 });
  }
  const tables = ['categories', 'products', 'users', 'sales', 'sale_items', 'returns', 'stock_movements', 'settings'];
  const dump = (db) => JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const original = dump(ctx.store.db);
  const backupFile = path.join(home, 'store.db');
  ctx.dialogQueue.save.push({ canceled: false, filePath: backupFile });
  await c('backup:create');
  // life goes on after the backup
  await c('sales:create', { items: [{ product_id: ids[1], qty: 1 }] });
  await c('products:save', { name: 'بعد النسخة', price: 1 });
  await c('settings:save', 'store_name', 'اسم آخر');
  const afterChanges = dump(ctx.store.db);
  // rejected files: live data untouched
  const bad = {
    'random.db': Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 0x5a)]),
    'truncated.db': fs.readFileSync(backupFile).subarray(0, 8192),
    'text.db': Buffer.from('not a database at all '.repeat(100)),
  };
  for (const [name, bytes] of Object.entries(bad)) {
    fs.writeFileSync(path.join(home, name), bytes);
    ctx.dialogQueue.open.push({ canceled: false, filePaths: [path.join(home, name)] });
    assert.equal(await c('backup:restore'), false, name);
    assert.equal(dump(ctx.store.db), afterChanges, `${name}: live data unchanged`);
  }
  // restore the real backup
  ctx.dialogQueue.open.push({ canceled: false, filePaths: [backupFile] });
  ctx.dialogQueue.message.push({ response: 1 });
  assert.equal(await c('backup:restore'), true);
  const again = await boot({ home });
  assert.equal(dump(again.store.db), original, 'every row of every table is back, byte for byte');
  await again.call('auth:login', 'k1', 'kash-111');
  assert.equal((await again.call('auth:me')).role, 'cashier', 'employees and PINs restored');
  shutdown(again);
});

test('Part 8: native date fields use DD/MM/YYYY (Chromium UI language pinned to en-GB)', async () => {
  const { ctx } = await admin();
  assert.deepEqual(ctx.state.appendedSwitches, [['lang', 'en-GB']]);
  shutdown(ctx);
});

// Compares the same machine with a short and a long history (instead of an absolute time, which
// depends on the machine and on the other test files running in parallel): the cost of a sale must
// not grow with the number of invoices. Best of several rounds filters out scheduling noise.
test('performance: creating a sale does not slow down with a long invoice history (30,000 invoices)', async () => {
  const { ctx, c } = await admin();
  const A = await c('products:save', { name: 'A', price: 2 });
  const perSale = async () => {
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 20; i++) await c('sales:create', { items: [{ product_id: A, qty: 1 }] });
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6 / 20);
    }
    return best;
  };
  const shortHistory = await perSale(); // 100 invoices
  const prefix = (await c('sales:list', 1))[0].sale_number.slice(0, -6);
  const insert = ctx.store.db.prepare('INSERT INTO sales (sale_number, subtotal, total) VALUES (?, 2, 2)');
  ctx.store.db.transaction(() => {
    for (let i = 101; i <= 30100; i++) insert.run(prefix + String(i).padStart(6, '0'));
  })();
  const longHistory = await perSale(); // 30,100 invoices
  assert.equal((await c('sales:list', 1))[0].sale_number, prefix + '030200', 'numbering continues correctly');
  // The index-and-sort lookup this guards against made each sale about 20x slower at this size.
  assert.ok(longHistory < shortHistory * 4 + 1,
    `${longHistory.toFixed(2)} ms per sale with 30,100 invoices vs ${shortHistory.toFixed(2)} ms with 100`);
  shutdown(ctx);
});
