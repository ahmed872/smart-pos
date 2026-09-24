// Financial correctness: explicit expected values for sales, discounts, tax, returns, reports
// and the daily closing. Model (see periodTotals in electron/db.js):
//   taxable = subtotal - discount, tax = taxable * rate, total = taxable + tax
//   revenue (excl. tax) = total - tax, profit = net revenue - net cost (before tax)
//   a return refunds qty * unit_price - its discount share + its tax share
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { boot, shutdown, makeTempHome } = require('./harness.js');

const EPS = 1e-9;
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < EPS, `${label}: expected ${expected}, got ${actual}`);
}
function nearAll(obj, expected, prefix) {
  for (const [k, v] of Object.entries(expected)) near(obj[k], v, `${prefix}.${k}`);
}

async function shop() {
  const home = makeTempHome();
  const ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', 'Owner-PIN-1');
  const id = async (name, price, cost) =>
    ctx.call('products:save', { name, price, cost, stock_qty: 50, track_stock: true });
  const A = await id('A', 100, 60);
  const B = await id('B', 50, 20);
  const C = await id('C', 25, 10);
  const tax = (pct) => ctx.call('settings:save', 'tax_percent', String(pct));
  const sell = async (items, discount = 0, paymentMethod = 'cash') => {
    const r = await ctx.call('sales:create', { items: items.map(([product_id, qty]) => ({ product_id, qty })), discount, paymentMethod });
    const full = await ctx.call('sales:full', r.saleId);
    return { ...r, full, line: (pid) => full.items.find((i) => i.product_id === pid) };
  };
  const ret = (sale, pid, qty) => ctx.call('returns:create', { saleId: sale.saleId, saleItemId: sale.line(pid).id, qty });
  const today = async () => (await ctx.call('sales:list', 1))[0].created_at.slice(0, 10);
  const report = async () => { const d = await today(); return ctx.call('reports:summary', d, d); };
  const closing = async () => ctx.call('reports:dailyClosing', await today());
  const stock = async (pid) => (await ctx.call('products:list')).find((p) => p.id === pid).stock_qty;
  return { home, ctx, A, B, C, tax, sell, ret, report, closing, stock };
}

// The daily closing and the sales report are two views of the same numbers.
function assertReportMatchesClosing(rep, close) {
  for (const k of ['invoiceCount', 'grossSales', 'totalDiscount', 'totalTax', 'salesTotal', 'cash', 'card',
    'totalReturns', 'returnsTax', 'netSales', 'netTax', 'netTotal', 'totalCost', 'profit']) {
    near(close[k], rep[k], `closing.${k} vs report.${k}`);
  }
  near(close.grossTotal, rep.salesTotal, 'closing.grossTotal');
  near(close.discount, rep.totalDiscount, 'closing.discount');
  near(close.tax, rep.totalTax, 'closing.tax');
  near(close.returns, rep.totalReturns, 'closing.returns');
  near(rep.netTotal, rep.netSales + rep.netTax, 'netTotal = netSales + netTax');
}

test('1. sale without discount or tax', async () => {
  const s = await shop();
  const sale = await s.sell([[s.A, 1]]);
  nearAll(sale, { subtotal: 100, tax: 0, total: 100 }, 'sale');
  const rep = await s.report();
  nearAll(rep, { grossSales: 100, totalDiscount: 0, totalTax: 0, salesTotal: 100, netSales: 100, netTax: 0, netTotal: 100, totalCost: 60, profit: 40 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  shutdown(s.ctx);
});

test('2. sale with discount: profit is reduced by the discount', async () => {
  const s = await shop();
  const sale = await s.sell([[s.A, 1]], 10);
  nearAll(sale, { subtotal: 100, tax: 0, total: 90 }, 'sale');
  const rep = await s.report();
  nearAll(rep, { grossSales: 100, totalDiscount: 10, salesTotal: 90, netSales: 90, netTotal: 90, totalCost: 60, profit: 30 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  shutdown(s.ctx);
});

test('3. sale with tax: tax is not revenue and not profit', async () => {
  const s = await shop();
  await s.tax(14);
  const sale = await s.sell([[s.A, 1]]);
  nearAll(sale, { subtotal: 100, tax: 14, total: 114 }, 'sale');
  const rep = await s.report();
  nearAll(rep, { grossSales: 100, totalTax: 14, salesTotal: 114, netSales: 100, netTax: 14, netTotal: 114, profit: 40 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  shutdown(s.ctx);
});

test('4. sale with discount + tax: tax applies after the discount', async () => {
  const s = await shop();
  await s.tax(14);
  const sale = await s.sell([[s.A, 2]], 20);
  nearAll(sale, { subtotal: 200, tax: 25.2, total: 205.2 }, 'sale');
  const rep = await s.report();
  nearAll(rep, { grossSales: 200, totalDiscount: 20, totalTax: 25.2, salesTotal: 205.2, netSales: 180, netTax: 25.2, netTotal: 205.2, totalCost: 120, profit: 60 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  shutdown(s.ctx);
});

test('5 + 12. multiple items: invoice discount/tax counted once, not once per line', async () => {
  const s = await shop();
  await s.tax(10);
  const sale = await s.sell([[s.A, 2], [s.B, 1], [s.C, 2]], 30); // 200 + 50 + 50 = 300
  nearAll(sale, { subtotal: 300, tax: 27, total: 297 }, 'sale');
  const rep = await s.report();
  nearAll(rep, { invoiceCount: 1, grossSales: 300, totalDiscount: 30, totalTax: 27, salesTotal: 297, netSales: 270, netTax: 27, netTotal: 297, totalCost: 160, profit: 110 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  near(await s.stock(s.A), 48, 'stock A');
  near(await s.stock(s.B), 49, 'stock B');
  near(await s.stock(s.C), 48, 'stock C');
  shutdown(s.ctx);
});

test('6. partial return of a line (no discount/tax): refund, stock, report', async () => {
  const s = await shop();
  const sale = await s.sell([[s.A, 2], [s.B, 1]]); // 250
  const r = await s.ret(sale, s.A, 1);
  nearAll(r, { refundedAmount: 100, discountShare: 0, taxShare: 0 }, 'return');
  near(await s.stock(s.A), 49, 'stock A restored by 1');
  const rep = await s.report();
  nearAll(rep, { salesTotal: 250, totalReturns: 100, netSales: 150, netTotal: 150, totalCost: 80, profit: 70 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  shutdown(s.ctx);
});

test('7. full return of a discounted + taxed invoice brings everything back to zero', async () => {
  const s = await shop();
  await s.tax(10);
  const sale = await s.sell([[s.A, 1], [s.B, 2]], 40); // subtotal 200, taxable 160, tax 16, total 176
  nearAll(sale, { subtotal: 200, tax: 16, total: 176 }, 'sale');
  const rA = await s.ret(sale, s.A, 1); // fraction 0.5
  nearAll(rA, { refundedAmount: 88, discountShare: 20, taxShare: 8 }, 'return A');
  const rB = await s.ret(sale, s.B, 2); // fraction 0.5
  nearAll(rB, { refundedAmount: 88, discountShare: 20, taxShare: 8 }, 'return B');
  near(rA.refundedAmount + rB.refundedAmount, sale.total, 'refunds = invoice total');
  near(await s.stock(s.A), 50, 'stock A fully restored');
  near(await s.stock(s.B), 50, 'stock B fully restored');
  const rep = await s.report();
  nearAll(rep, { salesTotal: 176, totalReturns: 176, returnsTax: 16, netSales: 0, netTax: 0, netTotal: 0, totalCost: 0, profit: 0 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  await assert.rejects(s.ret(sale, s.A, 1), /غير صحيحة/); // nothing left to return
  shutdown(s.ctx);
});

test('8. return after discount carries its discount share; repeated partial returns add up', async () => {
  const s = await shop();
  await s.tax(10);
  const sale = await s.sell([[s.A, 1], [s.B, 2]], 40); // total 176
  const r1 = await s.ret(sale, s.B, 1); // fraction 0.25: discount 10, tax 4
  nearAll(r1, { refundedAmount: 44, discountShare: 10, taxShare: 4 }, 'first B');
  const r2 = await s.ret(sale, s.B, 1);
  nearAll(r2, { refundedAmount: 44, discountShare: 10, taxShare: 4 }, 'second B');
  const rep = await s.report();
  // revenue 160 - returned revenue (40 + 40) = 80; tax 16 - 8 = 8; cost 100 - 40 = 60
  nearAll(rep, { totalReturns: 88, returnsTax: 8, netSales: 80, netTax: 8, netTotal: 88, totalCost: 60, profit: 20 }, 'report');
  assertReportMatchesClosing(rep, await s.closing());
  shutdown(s.ctx);
});

test('9-11. mixed day: report, daily closing, profit, discount, tax, inventory and returns all agree', async () => {
  const s = await shop();
  await s.sell([[s.A, 1]]); // S1: 100
  await s.sell([[s.A, 1]], 10); // S2: 90
  await s.tax(14);
  await s.sell([[s.A, 1]], 0, 'card'); // S3: 114 by card
  await s.tax(0);
  const s4 = await s.sell([[s.A, 1], [s.B, 2], [s.C, 2]], 25); // S4: 250 - 25 = 225
  const r = await s.ret(s4, s.B, 1); // fraction 0.2 -> discount share 5, refund 45
  nearAll(r, { refundedAmount: 45, discountShare: 5, taxShare: 0 }, 'return');

  const rep = await s.report();
  nearAll(rep, {
    invoiceCount: 4, grossSales: 550, totalDiscount: 35, totalTax: 14, salesTotal: 529,
    cash: 415, card: 114, returnsCount: 1, totalReturns: 45, returnsTax: 0,
    netSales: 470, netTax: 14, netTotal: 484, totalCost: 280, profit: 190,
  }, 'report');
  const close = await s.closing();
  nearAll(close, { grossTotal: 529, discount: 35, tax: 14, returns: 45, netTotal: 484, cash: 415, card: 114 }, 'closing');
  assertReportMatchesClosing(rep, close);
  near(await s.stock(s.A), 46, 'stock A');
  near(await s.stock(s.B), 49, 'stock B');
  near(await s.stock(s.C), 48, 'stock C');
  shutdown(s.ctx);
});

test('returns before this fix (no shares recorded) and uncapped legacy discounts stay consistent', async () => {
  const s = await shop();
  const sale = await s.sell([[s.A, 1]]);
  shutdown(s.ctx);
  // simulate history written by an older version
  const raw = new Database(path.join(s.home, 'appData', 'SystemDB', 'smart-pos.db'));
  raw.prepare("INSERT INTO returns (sale_id, sale_item_id, product_id, qty, refunded_amount, created_at) VALUES (?, ?, ?, 1, 100, datetime('now','localtime'))")
    .run(sale.saleId, sale.line(s.A).id, s.A);
  // pre-v1.1 invoice where the discount exceeded the subtotal and the total was clamped to 0
  raw.prepare("INSERT INTO sales (sale_number, subtotal, discount, tax, total, created_at) VALUES ('LEGACY-1', 150, 200, 0, 0, datetime('now','localtime'))").run();
  raw.close();
  const ctx = await boot({ home: s.home });
  await ctx.call('auth:login', 'owner', 'Owner-PIN-1');
  const d = (await ctx.call('sales:list', 5))[0].created_at.slice(0, 10);
  const rep = await ctx.call('reports:summary', d, d);
  // legacy clamp: its revenue is total - tax = 0 (not 150 - 200 = -50), effective discount 150
  nearAll(rep, { invoiceCount: 2, grossSales: 250, totalDiscount: 150, salesTotal: 100, totalReturns: 100, netSales: 0, netTotal: 0, totalCost: 0, profit: 0 }, 'report');
  assertReportMatchesClosing(rep, await ctx.call('reports:dailyClosing', d));
  shutdown(ctx);
});
