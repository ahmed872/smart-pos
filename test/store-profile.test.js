// Store profile (address, phone, registration numbers, footer) and invoice identity rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { boot, shutdown, makeTempHome } = require('./harness.js');
const SI = require('../renderer/store-identity.js');

const PIN = 'Owner-PIN-1';
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PROFILE = {
  store_name: 'متجر النور',
  store_address: '12 شارع التحرير، القاهرة',
  store_phone: '+20 (2) 1234-5678',
  tax_number: '123-456-789',
  commercial_register: 'CR/2024.55',
  receipt_footer: 'نتشرف بزيارتكم',
  currency: 'ر.س',
};

async function admin() {
  const home = makeTempHome();
  const ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', PIN);
  return { home, ctx };
}

test('store profile fields are validated (length, characters, whitespace, type)', async () => {
  const { ctx } = await admin();
  const bad = [
    ['store_address', 'x'.repeat(201), /يزيد عن 200/],
    ['store_name', 'x'.repeat(101), /يزيد عن 100/],
    ['store_name', 'x'.repeat(100000), /يزيد/],
    ['store_phone', '0100-CALL-ME', /غير مسموحة/],
    ['store_phone', '1'.repeat(41), /يزيد عن 40/],
    ['tax_number', '<script>', /غير مسموحة/],
    ['commercial_register', 'abc;drop', /غير مسموحة/],
    ['receipt_footer', 'سطر\nسطر', /غير مسموحة/],
    ['store_name', 'متجر‮عكس', /غير مسموحة/], // bidi override
    ['store_address', 'a\u0000b', /غير مسموحة/],
    ['store_name', { toString: () => 'x' }, /غير صالح/],
    ['currency', '12345678901', /يزيد عن 10/],
  ];
  for (const [key, value, re] of bad) {
    await assert.rejects(ctx.call('settings:save', key, value), re, `${key}=${JSON.stringify(value)}`);
  }
  // accepted: Arabic-Indic digits, separators, HTML-special characters in free text, trimming, empty
  await ctx.call('settings:saveMany', {
    store_phone: '٠١٠ ١٢٣ ٤٥٦٧', tax_number: ' 123 456 ', store_name: '  <متجر> & "النور"  ', receipt_footer: '',
  });
  const s = await ctx.call('settings:get');
  assert.equal(s.store_phone, '٠١٠ ١٢٣ ٤٥٦٧');
  assert.equal(s.tax_number, '123 456');
  assert.equal(s.store_name, '<متجر> & "النور"');
  assert.equal(s.receipt_footer, '');
  shutdown(ctx);
});

test('saveMany is all-or-nothing and rejects unknown/prototype keys', async () => {
  const { ctx } = await admin();
  await ctx.call('settings:saveMany', { store_name: 'قبل' });
  await assert.rejects(ctx.call('settings:saveMany', { store_name: 'بعد', store_phone: 'bad phone!' }), /رقم الهاتف/);
  await assert.rejects(ctx.call('settings:saveMany', { store_name: 'بعد', is_admin: '1' }), /غير معروف/);
  await assert.rejects(ctx.call('settings:saveMany', JSON.parse('{"__proto__": "x"}')), /غير معروف/);
  await assert.rejects(ctx.call('settings:saveMany', ['store_name', 'x']), /غير صالحة/);
  assert.equal((await ctx.call('settings:get')).store_name, 'قبل', 'nothing saved from rejected batches');
  shutdown(ctx);
});

test('store profile is admin-only, persists across restart and travels with backup/restore', async () => {
  const { home, ctx } = await admin();
  await ctx.call('users:save', { username: 'c1', pin: 'c1-pin-11', role: 'cashier' });
  await ctx.call('settings:saveMany', PROFILE);
  await ctx.call('auth:login', 'c1', 'c1-pin-11');
  await assert.rejects(ctx.call('settings:saveMany', { store_name: 'x' }), /للمدير فقط/);
  await ctx.call('auth:login', 'owner', PIN);
  const backupFile = path.join(home, 'profile.db');
  ctx.dialogQueue.save.push({ canceled: false, filePath: backupFile });
  await ctx.call('backup:create');
  await ctx.call('settings:saveMany', { store_name: 'اسم لاحق', store_phone: '' });
  shutdown(ctx);

  let again = await boot({ home });
  await again.call('auth:login', 'owner', PIN);
  assert.equal((await again.call('settings:get')).store_name, 'اسم لاحق');
  again.dialogQueue.open.push({ canceled: false, filePaths: [backupFile] });
  again.dialogQueue.message.push({ response: 1 });
  assert.equal(await again.call('backup:restore'), true);
  again = await boot({ home });
  await again.call('auth:login', 'owner', PIN);
  const s = await again.call('settings:get');
  for (const [k, v] of Object.entries(PROFILE)) assert.equal(s[k], v, k);
  shutdown(again);
});

test('invoice data carries refunds for the receipt', async () => {
  const { ctx } = await admin();
  await ctx.call('settings:save', 'tax_percent', '10');
  const pid = await ctx.call('products:save', { name: 'A', price: 100, cost: 60 });
  const sale = await ctx.call('sales:create', { items: [{ product_id: pid, qty: 2 }], discount: 20, paymentMethod: 'card' });
  let full = await ctx.call('sales:full', sale.saleId);
  assert.deepEqual(full.refunds, { count: 0, amount: 0, tax: 0 });
  await ctx.call('returns:create', { saleId: sale.saleId, saleItemId: full.items[0].id, qty: 1 });
  full = await ctx.call('sales:full', sale.saleId);
  // subtotal 200, taxable 180, tax 18, total 198; returning half -> 99 incl. 9 tax
  assert.equal(full.refunds.count, 1);
  assert.ok(Math.abs(full.refunds.amount - 99) < 1e-9);
  assert.ok(Math.abs(full.refunds.tax - 9) < 1e-9);
  assert.equal(full.sale.payment_method, 'card');
  shutdown(ctx);
});

test('header rendering: full vs compact, escaping, empty fields omitted, unsafe logo ignored', () => {
  const full = SI.headerHtml({ ...PROFILE, logo_data_url: LOGO });
  for (const v of [PROFILE.store_name, PROFILE.store_address, PROFILE.store_phone, PROFILE.tax_number, PROFILE.commercial_register]) {
    assert.ok(full.includes(v), `full header shows ${v}`);
  }
  assert.ok(full.includes(`src="${LOGO}"`));
  const compact = SI.headerHtml({ ...PROFILE, logo_data_url: LOGO }, { compact: true });
  assert.ok(compact.includes(PROFILE.store_name) && !compact.includes(PROFILE.store_phone) && !compact.includes(PROFILE.tax_number));
  const minimal = SI.headerHtml({ store_name: 'X', store_phone: '', tax_number: '', logo_data_url: '' });
  assert.ok(!minimal.includes('هاتف') && !minimal.includes('الرقم الضريبي') && !minimal.includes('<img'));
  const hostile = SI.headerHtml({ store_name: '<img src=x onerror=alert(1)>', store_address: '"><script>', logo_data_url: 'javascript:alert(1)' });
  assert.ok(!hostile.includes('<img src=x') && !hostile.includes('<script>') && !hostile.includes('javascript:'));
  assert.ok(hostile.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('invoice QR text, tax rate and dates', () => {
  const sale = { sale_number: 'INV-202609-000007', created_at: '2026-09-24 13:55:02', subtotal: 200, tax: 25.2, total: 205.2 };
  const qr = SI.invoiceQrText(sale, PROFILE);
  assert.equal(qr, [
    'متجر النور', 'الرقم الضريبي: 123-456-789', 'فاتورة: INV-202609-000007', 'التاريخ: 24/09/2026 13:55',
    'الإجمالي: 205.20 ر.س', 'الضريبة: 25.20 ر.س',
  ].join('\n'));
  assert.equal(SI.invoiceQrText({ ...sale, tax: 0, total: 180 }, { store_name: '' }),
    'فاتورة: INV-202609-000007\nالتاريخ: 24/09/2026 13:55\nالإجمالي: 180.00');
  assert.equal(SI.taxRate(sale), 14);
  assert.equal(SI.taxRate({ tax: 0, total: 100 }), 0);
  assert.equal(SI.formatDateTimeText('2026-09-24 13:55:02'), '24/09/2026 13:55');
  assert.equal(SI.formatDate('2026-09-24'), '<bdi dir="ltr">24/09/2026</bdi>');
  assert.equal(SI.paymentLabel('card'), 'بطاقة');
  assert.equal(SI.paymentLabel('cash'), 'نقدًا');
  assert.equal(SI.money(5, ''), '5.00');
});
