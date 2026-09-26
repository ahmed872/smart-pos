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
