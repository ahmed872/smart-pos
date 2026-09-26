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
