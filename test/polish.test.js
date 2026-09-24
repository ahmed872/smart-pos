// Production polish: user-facing errors, wording, product identity and package metadata.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { boot, shutdown, makeTempHome, ROOT } = require('./harness.js');
const { userMessage } = require('../renderer/ui-messages.js');

const PIN = 'Owner-PIN-1';

async function admin() {
  const ctx = await boot({ home: makeTempHome() });
  await ctx.call('auth:setupAdmin', 'owner', PIN, { storeName: 'متجر' });
  return ctx;
}

test('database constraint errors reach the user as clear Arabic messages', async () => {
  const ctx = await admin();
  await ctx.call('products:save', { name: 'A', price: 1, barcode: '123' });
  await assert.rejects(ctx.call('products:save', { name: 'B', price: 1, barcode: '123' }), { message: 'الباركود مستخدم لمنتج آخر' });
  await ctx.call('users:save', { username: 'c1', pin: 'c1-pin-11', role: 'cashier' });
  await assert.rejects(ctx.call('users:save', { username: 'c1', pin: 'other-pin-2', role: 'cashier' }), { message: 'اسم المستخدم مستخدم بالفعل' });
  await ctx.call('categories:save', 'مشروبات', false);
  await assert.rejects(ctx.call('categories:save', 'مشروبات', false), { message: 'اسم الفئة موجود بالفعل' });
  shutdown(ctx);
});

test('unexpected internal errors are logged for diagnostics and shown as a generic Arabic message', async () => {
  const ctx = await admin();
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  ctx.store.getCategories = () => { throw new TypeError('Cannot read properties of undefined (reading "x")'); };
  try {
    await assert.rejects(ctx.call('categories:list'), { message: /^حدث خطأ غير متوقع/ });
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => l.includes('categories:list') && l.includes('Cannot read properties')), 'technical details logged');
  // expected Arabic errors pass through unchanged
  await assert.rejects(ctx.call('products:save', { name: 'x', price: -1 }), { message: 'السعر: لا يمكن أن تكون قيمة سالبة' });
  shutdown(ctx);
});

test('renderer userMessage strips the Electron IPC prefix and never shows English-only text', () => {
  assert.equal(userMessage(new Error("Error invoking remote method 'products:save': Error: السعر: لا يمكن أن تكون قيمة سالبة")),
    'السعر: لا يمكن أن تكون قيمة سالبة');
  assert.equal(userMessage(new Error("Error invoking remote method 'x': TypeError: boom")), userMessage(new Error('')));
  assert.match(userMessage(new Error('socket hang up')), /^حدث خطأ غير متوقع/);
  assert.match(userMessage(undefined), /^حدث خطأ غير متوقع/);
  assert.equal(userMessage(new Error('تعذرت الطباعة')), 'تعذرت الطباعة');
});

test('about information: product name and version', async () => {
  const ctx = await admin();
  const info = await ctx.call('app:info');
  assert.deepEqual(info, { name: 'سيستم كاشير', version: require('../package.json').version });
  await ctx.call('auth:logout');
  await assert.rejects(ctx.call('app:info'), /تسجيل الدخول/);
  shutdown(ctx);
});

test('window titles use the product name', async () => {
  const ctx = await admin();
  assert.equal(ctx.windows[0].opts.title, 'سيستم كاشير');
  await ctx.call('kitchen:openWindow');
  assert.equal(ctx.windows.find((w) => /kitchen\.html$/.test(w.loadedFile || '')).opts.title, 'شاشة المطبخ - سيستم كاشير');
  for (const f of ['index.html', 'login.html', 'kitchen.html']) {
    const title = /<title>([^<]*)<\/title>/.exec(fs.readFileSync(path.join(ROOT, 'renderer', f), 'utf8'))[1];
    assert.ok(title.endsWith('سيستم كاشير'), `${f}: ${title}`);
  }
  shutdown(ctx);
});

test('shipped UI text: formal Arabic, no raw error display, no developer identity in metadata', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join(ROOT, 'renderer', f)),
    ...fs.readdirSync(path.join(ROOT, 'electron')).map((f) => path.join(ROOT, 'electron', f)),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const word of ['لازم', 'هيتم', 'هيقفل', 'تاني', 'هيظهر', ' مش ']) {
      assert.ok(!text.includes(word), `${path.relative(ROOT, f)} contains colloquial "${word}"`);
    }
    assert.ok(!/alert\(err\.message\)/.test(text), `${path.relative(ROOT, f)} shows raw error text`);
  }
  const pkg = require('../package.json');
  assert.notEqual(JSON.stringify(pkg.author), JSON.stringify('ahmed872'));
  assert.equal(pkg.author.name, 'Cashier System');
  assert.match(pkg.build.copyright, /Cashier System/);
  assert.ok(pkg.build.files.includes('!**/node_modules/**/*.map'));
});
