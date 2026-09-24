const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { boot, shutdown, makeTempHome } = require('./harness.js');

const ADMIN_PIN = 'Adm1n-Test-PIN';
const CASHIER_PIN = 'cash-4821';

function dbFile(home) {
  return path.join(home, 'appData', 'SystemDB', 'smart-pos.db');
}

// Fresh install with one admin (created via first-run setup) and one cashier.
async function freshApp() {
  const home = makeTempHome();
  const ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', ADMIN_PIN);
  await ctx.call('users:save', { username: 'cashier1', pin: CASHIER_PIN, role: 'cashier' });
  await ctx.call('auth:logout');
  return { home, ctx };
}

async function loginAs(ctx, username, pin) {
  const user = await ctx.call('auth:login', username, pin);
  assert.ok(user, `login failed for ${username}`);
  return user;
}

// ---------------------------------------------------------------- Authentication

test('fresh install has no default accounts and requires first-run admin setup', async () => {
  const home = makeTempHome();
  const ctx = await boot({ home });
  assert.equal(await ctx.call('auth:needsSetup'), true);
  assert.equal(await ctx.call('auth:login', 'admin', '00102026'), null);
  assert.equal(await ctx.call('auth:login', 'cashier', '1111'), null);
  await assert.rejects(ctx.call('products:list'), /تسجيل الدخول/);

  await assert.rejects(ctx.call('auth:setupAdmin', 'owner', '12'), /4/); // PIN policy
  const admin = await ctx.call('auth:setupAdmin', 'owner', ADMIN_PIN);
  assert.equal(admin.role, 'admin');
  assert.equal(await ctx.call('auth:needsSetup'), false);
  await assert.rejects(ctx.call('auth:setupAdmin', 'intruder', 'another-pin'), /بالفعل/);
  shutdown(ctx);
});

test('PINs are stored as salted scrypt hashes, never plaintext', async () => {
  const { home, ctx } = await freshApp();
  shutdown(ctx);
  const raw = new Database(dbFile(home), { readonly: true });
  const rows = raw.prepare('SELECT username, pin, pin_hash FROM users').all();
  raw.close();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.match(r.pin_hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.ok(!r.pin_hash.includes(ADMIN_PIN) && !r.pin_hash.includes(CASHIER_PIN));
    assert.notEqual(r.pin, ADMIN_PIN);
    assert.notEqual(r.pin, CASHIER_PIN);
  }
  assert.notEqual(rows[0].pin_hash.split('$')[4], rows[1].pin_hash.split('$')[4], 'salts must differ');
});

test('login: correct PIN works, wrong PIN / unknown user / non-string input fail', async () => {
  const { ctx } = await freshApp();
  assert.equal((await ctx.call('auth:login', 'owner', ADMIN_PIN)).role, 'admin');
  assert.equal(await ctx.call('auth:login', 'owner', 'wrong-pin'), null);
  assert.equal(await ctx.call('auth:login', 'nobody', ADMIN_PIN), null);
  assert.equal(await ctx.call('auth:login', 'owner', { $ne: 1 }), null);
  assert.equal(await ctx.call('auth:login', "owner' OR '1'='1", "' OR '1'='1"), null);
  // a failed login ends any previous session
  await assert.rejects(ctx.call('products:list'), /تسجيل الدخول/);
  shutdown(ctx);
});

test('admin can change a user PIN; old PIN stops working, new PIN works', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  const cashier = (await ctx.call('users:list')).find((u) => u.username === 'cashier1');
  await ctx.call('users:save', { id: cashier.id, username: 'cashier1', pin: 'new-cash-77', role: 'cashier' });
  assert.equal(await ctx.call('auth:login', 'cashier1', CASHIER_PIN), null);
  assert.ok(await ctx.call('auth:login', 'cashier1', 'new-cash-77'));
  shutdown(ctx);
});

test('disclosed default PINs cannot be set as new PINs', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  for (const pin of ['00102026', '1234', '1111']) {
    await assert.rejects(ctx.call('users:save', { username: 'x' + pin, pin, role: 'cashier' }), /افتراضي/);
  }
  shutdown(ctx);
});

// ---------------------------------------------------------------- Authorization

test('cashier is rejected from every admin-only operation (enforced in main process)', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'cashier1', CASHIER_PIN);
  const products = await ctx.call('products:list');
  const denied = /للمدير فقط/;

  await assert.rejects(ctx.call('users:save', { username: 'evil', pin: 'evil-pin-1', role: 'admin' }), denied);
  await assert.rejects(ctx.call('users:list'), denied);
  await assert.rejects(ctx.call('users:setActive', 1, false), denied);
  await assert.rejects(ctx.call('products:save', { ...products[0], price: 0.01 }), denied);
  await assert.rejects(ctx.call('products:save', { name: 'new', price: 1 }), denied);
  await assert.rejects(ctx.call('products:delete', products[0].id), denied);
  await assert.rejects(ctx.call('categories:save', 'x', false), denied);
  await assert.rejects(ctx.call('settings:save', 'tax_percent', '0'), denied);
  await assert.rejects(ctx.call('settings:save', 'store_name', 'hacked'), denied);
  await assert.rejects(ctx.call('backup:restore'), denied);
  await assert.rejects(ctx.call('backup:create'), denied);
  await assert.rejects(ctx.call('backup:currentPath'), denied);
  await assert.rejects(ctx.call('reports:summary', '2020-01-01', '2030-01-01'), denied);
  await assert.rejects(ctx.call('reports:detailRows', '2020-01-01', '2030-01-01'), denied);
  await assert.rejects(ctx.call('reports:exportPdf', '2020-01-01', '2030-01-01'), denied);
  await assert.rejects(ctx.call('reports:exportExcel', '2020-01-01', '2030-01-01'), denied);
  assert.equal(ctx.state.messageBoxes.length, 0, 'restore dialog must never open for a cashier');

  // nothing changed
  const after = await ctx.call('products:list');
  assert.deepEqual(after.map((p) => [p.id, p.price]), products.map((p) => [p.id, p.price]));
  assert.equal((await ctx.call('settings:get')).store_name, (await ctx.call('settings:get')).store_name);
  assert.equal(await ctx.call('auth:login', 'evil', 'evil-pin-1'), null);
  shutdown(ctx);
});

test('cashier keeps the operations the POS needs', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'cashier1', CASHIER_PIN);
  const products = await ctx.call('products:list');
  assert.ok(products.length > 0);
  assert.ok((await ctx.call('categories:list')).length > 0);
  assert.ok(await ctx.call('settings:get'));
  const water = products.find((p) => p.track_stock);
  const sale = await ctx.call('sales:create', { items: [{ product_id: water.id, qty: 2 }], discount: 0, paymentMethod: 'cash' });
  assert.equal(sale.total, water.price * 2);
  const full = await ctx.call('sales:full', sale.saleId);
  assert.equal(full.sale.user_id, (await ctx.call('auth:me')).id);
  await ctx.call('returns:create', { saleId: sale.saleId, saleItemId: full.items[0].id, qty: 1 });
  assert.equal((await ctx.call('sales:list', 10)).length, 1);
  assert.ok(await ctx.call('reports:dailyClosing', '2024-01-01'));
  assert.ok((await ctx.call('print:qr', sale.saleNumber)).startsWith('data:image/png'));
  shutdown(ctx);
});

test('admin can perform all admin operations', async () => {
  const { home, ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  const id = await ctx.call('products:save', { name: 'منتج اختبار', price: 12.5, cost: 5, stock_qty: 3, track_stock: true });
  await ctx.call('products:save', { id, name: 'منتج اختبار 2', price: 13, cost: 5, stock_qty: 4, track_stock: true });
  assert.equal((await ctx.call('products:list')).find((p) => p.id === id).price, 13);
  await ctx.call('products:delete', id);
  assert.equal((await ctx.call('products:list')).find((p) => p.id === id), undefined);
  await ctx.call('categories:save', 'فئة جديدة', true);
  await ctx.call('settings:save', 'tax_percent', '14');
  await ctx.call('settings:save', 'store_name', 'محل الاختبار');
  assert.equal((await ctx.call('settings:get')).tax_percent, '14');
  await ctx.call('users:save', { username: 'admin2', pin: 'second-admin', role: 'admin' });
  const users = await ctx.call('users:list');
  await ctx.call('users:setActive', users.find((u) => u.username === 'cashier1').id, false);
  assert.ok(await ctx.call('reports:summary', '2020-01-01', '2030-01-01'));
  assert.equal(await ctx.call('backup:currentPath'), dbFile(home));
  shutdown(ctx);
});

test('requests from anything other than the bundled pages are rejected', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  for (const url of ['https://evil.example/', 'file:///tmp/evil.html', 'data:text/html,x', 'devtools://devtools/x', '']) {
    await assert.rejects(ctx.callFrom({ senderFrame: { url }, sender: {} }, 'users:list'), /غير مصرح/);
  }
  await assert.rejects(ctx.callFrom({ senderFrame: null, sender: {} }, 'users:list'), /غير مصرح/);
  shutdown(ctx);
});

test('deactivating or demoting a user takes effect on their live session immediately', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  await ctx.call('users:save', { username: 'admin2', pin: 'second-admin', role: 'admin' });
  await loginAs(ctx, 'admin2', 'second-admin');
  const admin2 = (await ctx.call('users:list')).find((u) => u.username === 'admin2');
  // demote from the database layer, as another admin would
  ctx.store.saveUser({ id: admin2.id, username: 'admin2', role: 'cashier' });
  await assert.rejects(ctx.call('users:list'), /للمدير فقط/);
  ctx.store.setUserActive(admin2.id, false);
  await assert.rejects(ctx.call('products:list'), /تسجيل الدخول/);
  shutdown(ctx);
});

test('the last active admin cannot be deactivated or demoted', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  const owner = (await ctx.call('users:list')).find((u) => u.username === 'owner');
  await assert.rejects(ctx.call('users:setActive', owner.id, false), /آخر مدير/);
  await assert.rejects(ctx.call('users:save', { id: owner.id, username: 'owner', role: 'cashier' }), /آخر مدير/);
  await assert.rejects(ctx.call('users:save', { username: 'x', pin: 'abcdef', role: 'superuser' }), /غير مسموحة/);
  shutdown(ctx);
});

test('kitchen window keeps working without a session, but only for kitchen channels', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'cashier1', CASHIER_PIN);
  await ctx.call('kitchen:openWindow');
  const kitchenWin = ctx.windows.find((w) => /kitchen\.html$/.test(w.loadedFile || ''));
  assert.ok(kitchenWin);
  await ctx.call('auth:logout');
  const kitchenEvent = { ...ctx.pageEvent('kitchen.html'), sender: kitchenWin.webContents };
  assert.ok(Array.isArray(await ctx.callFrom(kitchenEvent, 'kitchen:list')));
  await assert.rejects(ctx.callFrom(kitchenEvent, 'products:save', { name: 'x', price: 1 }), /تسجيل الدخول/);
  await assert.rejects(ctx.callFrom(kitchenEvent, 'kitchen:updateStatus', 1, 'hacked'), /غير مسموحة/);
  shutdown(ctx);
});

// ---------------------------------------------------------------- DevTools / hardening

test('packaged build disables DevTools on every window; dev build keeps them', async () => {
  const prod = await boot({ home: makeTempHome(), isPackaged: true });
  await prod.call('auth:setupAdmin', 'owner', ADMIN_PIN);
  await prod.call('kitchen:openWindow');
  assert.ok(prod.windows.length >= 2);
  for (const w of prod.windows) {
    assert.equal(w.opts.webPreferences.devTools, false);
    assert.equal(w.opts.webPreferences.contextIsolation, true);
    assert.equal(w.opts.webPreferences.nodeIntegration, false);
    assert.equal(w.opts.webPreferences.sandbox, true);
  }
  shutdown(prod);
  const dev = await boot({ home: makeTempHome(), isPackaged: false });
  assert.equal(dev.windows[0].opts.webPreferences.devTools, true);
  shutdown(dev);
});

test('packaged build refuses to start with remote-debugging / inspect switches', async () => {
  for (const sw of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk']) {
    const ctx = await boot({ home: makeTempHome(), isPackaged: true, switches: [sw] });
    assert.equal(ctx.state.exitCode, 1, sw);
    assert.equal(ctx.handlers.size, 0, 'no IPC handlers may be registered');
    assert.equal(ctx.windows.length, 0);
  }
});

test('renderers cannot navigate away from bundled pages or open new windows', async () => {
  const ctx = await boot({ home: makeTempHome() });
  const onCreated = ctx.appListeners.get('web-contents-created');
  const listeners = {};
  let openHandler;
  onCreated({}, {
    on: (name, fn) => { listeners[name] = fn; },
    setWindowOpenHandler: (fn) => { openHandler = fn; },
  });
  const nav = (url) => {
    let prevented = false;
    listeners['will-navigate']({ preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  assert.equal(nav('https://evil.example/'), true);
  assert.equal(nav('file:///etc/passwd'), true);
  assert.equal(nav(ctx.pageEvent('index.html').senderFrame.url), false);
  assert.deepEqual(openHandler({ url: 'https://evil.example' }), { action: 'deny' });
  shutdown(ctx);
});

// ---------------------------------------------------------------- Validation

test('product validation rejects negative and non-numeric values', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  const base = { name: 'صنف', price: 10, cost: 5, stock_qty: 1, track_stock: true };
  const bad = [
    [{ price: -1 }, /سالبة/], [{ cost: -0.01 }, /سالبة/], [{ stock_qty: -5 }, /سالبة/],
    [{ price: NaN }, /رقمية/], [{ price: Infinity }, /رقمية/], [{ price: 'abc' }, /رقمية/],
    [{ price: '' }, /رقمية/], [{ price: null }, /رقمية/], [{ cost: {} }, /رقمية/], [{ stock_qty: '1e999' }, /رقمية/],
    [{ name: '   ' }, /مطلوب/], [{ category_id: 99999 }, /غير موجودة/],
    [{ image_data_url: 'javascript:alert(1)' }, /صورة/],
    [{ image_data_url: 'data:image/png;base64,AAA" onerror="alert(1)' }, /صورة/],
  ];
  const before = (await ctx.call('products:list')).length;
  for (const [patch, re] of bad) {
    await assert.rejects(ctx.call('products:save', { ...base, ...patch }), re, JSON.stringify(patch));
  }
  assert.equal((await ctx.call('products:list')).length, before);
  // editing an existing product with a negative price is rejected too
  const p = (await ctx.call('products:list'))[0];
  await assert.rejects(ctx.call('products:save', { ...p, price: -3 }), /سالبة/);
  assert.equal((await ctx.call('products:list'))[0].price, p.price);
  // valid values (including numeric strings and zero) are accepted
  assert.ok(await ctx.call('products:save', { ...base, price: '0', cost: '2.5', stock_qty: 0 }));
  assert.ok(await ctx.call('products:save', { ...base, image_data_url: 'data:image/png;base64,iVBORw0KGgo=' }));
  shutdown(ctx);
});

test('sale validation: discount, quantity, payment method; price and tax come from the database', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  await ctx.call('settings:save', 'tax_percent', '10');
  await loginAs(ctx, 'cashier1', CASHIER_PIN);
  const burger = (await ctx.call('products:list')).find((p) => !p.track_stock);
  const item = { product_id: burger.id, qty: 1 };

  await assert.rejects(ctx.call('sales:create', { items: [item], discount: -10 }), /سالبة/);
  await assert.rejects(ctx.call('sales:create', { items: [item], discount: 'abc' }), /رقمية/);
  await assert.rejects(ctx.call('sales:create', { items: [item], discount: NaN }), /رقمية/);
  await assert.rejects(ctx.call('sales:create', { items: [item], discount: burger.price + 1 }), /أكبر من إجمالي/);
  await assert.rejects(ctx.call('sales:create', { items: [{ ...item, qty: -1 }] }), /أكبر من صفر/);
  await assert.rejects(ctx.call('sales:create', { items: [{ ...item, qty: 0 }] }), /أكبر من صفر/);
  await assert.rejects(ctx.call('sales:create', { items: [{ ...item, qty: 'x' }] }), /رقمية/);
  await assert.rejects(ctx.call('sales:create', { items: [] }), /فارغة/);
  await assert.rejects(ctx.call('sales:create', { items: [{ product_id: 99999, qty: 1 }] }), /غير موجود/);
  await assert.rejects(ctx.call('sales:create', { items: [item], paymentMethod: 'free' }), /غير مسموحة/);
  assert.equal((await ctx.call('sales:list', 10)).length, 0, 'rejected sales must not be recorded');

  // tampered unit_price and taxPercent from the renderer are ignored
  const sale = await ctx.call('sales:create', {
    items: [{ ...item, unit_price: 0.01, name: 'fake' }], discount: 5, taxPercent: -50, paymentMethod: 'card',
  });
  const expectedTax = (burger.price - 5) * 0.10;
  assert.ok(Math.abs(sale.tax - expectedTax) < 1e-9);
  assert.ok(Math.abs(sale.total - (burger.price - 5 + expectedTax)) < 1e-9);
  const full = await ctx.call('sales:full', sale.saleId);
  assert.equal(full.items[0].unit_price, burger.price);
  assert.equal(full.items[0].name, burger.name);
  shutdown(ctx);
});

test('settings validation rejects negative/invalid tax and unknown keys', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  await assert.rejects(ctx.call('settings:save', 'tax_percent', '-5'), /بين 0 و 100/);
  await assert.rejects(ctx.call('settings:save', 'tax_percent', '150'), /بين 0 و 100/);
  await assert.rejects(ctx.call('settings:save', 'tax_percent', 'abc'), /رقمية/);
  await assert.rejects(ctx.call('settings:save', 'tax_percent', ''), /رقمية/);
  await assert.rejects(ctx.call('settings:save', 'low_stock_threshold', '-1'), /سالبة/);
  await assert.rejects(ctx.call('settings:save', 'receipt_width_mm', '5'), /بين/);
  await assert.rejects(ctx.call('settings:save', 'invoice_reset_period', 'daily'), /غير مسموحة/);
  await assert.rejects(ctx.call('settings:save', 'is_admin', '1'), /غير معروف/);
  await assert.rejects(ctx.call('settings:save', 'logo_data_url', '"><img src=x onerror=alert(1)>'), /صورة/);
  assert.equal((await ctx.call('settings:get')).tax_percent, '0');
  await ctx.call('settings:save', 'tax_percent', '14.5');
  assert.equal((await ctx.call('settings:get')).tax_percent, '14.5');
  shutdown(ctx);
});

test('return validation rejects negative / excessive quantities and mismatched sale ids', async () => {
  const { ctx } = await freshApp();
  await loginAs(ctx, 'cashier1', CASHIER_PIN);
  const p = (await ctx.call('products:list')).find((x) => !x.track_stock);
  const s1 = await ctx.call('sales:create', { items: [{ product_id: p.id, qty: 2 }] });
  const s2 = await ctx.call('sales:create', { items: [{ product_id: p.id, qty: 1 }] });
  const itemId = (await ctx.call('sales:full', s1.saleId)).items[0].id;
  await assert.rejects(ctx.call('returns:create', { saleId: s1.saleId, saleItemId: itemId, qty: -1 }), /أكبر من صفر/);
  await assert.rejects(ctx.call('returns:create', { saleId: s1.saleId, saleItemId: itemId, qty: 3 }), /غير صحيحة/);
  await assert.rejects(ctx.call('returns:create', { saleId: s2.saleId, saleItemId: itemId, qty: 1 }), /لا يتبع/);
  assert.ok(await ctx.call('returns:create', { saleId: s1.saleId, saleItemId: itemId, qty: 2 }));
  shutdown(ctx);
});

// ---------------------------------------------------------------- Backup / restore

async function adminWithBackup() {
  const { home, ctx } = await freshApp();
  await loginAs(ctx, 'owner', ADMIN_PIN);
  const backupPath = path.join(home, 'my-backup.db');
  ctx.dialogQueue.save.push({ canceled: false, filePath: backupPath });
  assert.equal(await ctx.call('backup:create'), backupPath);
  return { home, ctx, backupPath };
}

function safetyBackups(home) {
  const dir = path.join(home, 'appData', 'SystemDB', 'safety-backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
}

test('valid backup restores successfully after a safety backup of the current data', async () => {
  const { home, ctx, backupPath } = await adminWithBackup();
  const addedAfterBackup = await ctx.call('products:save', { name: 'بعد النسخة', price: 1 });

  ctx.dialogQueue.open.push({ canceled: false, filePaths: [backupPath] });
  ctx.dialogQueue.message.push({ response: 1 }); // confirm
  assert.equal(await ctx.call('backup:restore'), true);
  assert.equal(ctx.state.relaunched, true);
  assert.equal(ctx.state.exitCode, 0);

  const safeties = safetyBackups(home);
  assert.equal(safeties.length, 1);
  const safety = new Database(path.join(home, 'appData', 'SystemDB', 'safety-backups', safeties[0]), { readonly: true });
  assert.ok(safety.prepare('SELECT 1 FROM products WHERE id = ?').get(addedAfterBackup), 'safety backup has pre-restore data');
  safety.close();

  // "relaunch": restored data is live, login still works
  const after = await boot({ home });
  await loginAs(after, 'owner', ADMIN_PIN);
  assert.equal((await after.call('products:list')).find((p) => p.id === addedAfterBackup), undefined);
  shutdown(after);
});

test('corrupted / foreign / truncated backups are rejected and the live database keeps working', async () => {
  const { home, ctx, backupPath } = await adminWithBackup();
  const live = dbFile(home);
  const bad = {
    random: Buffer.from(require('node:crypto').randomBytes(8192)),
    text: Buffer.from('this is not a database'.repeat(100)),
    truncated: fs.readFileSync(backupPath).subarray(0, 4096 + 100),
    empty: Buffer.alloc(0),
  };
  // flipped bytes in the middle of an otherwise valid backup
  const corrupt = Buffer.from(fs.readFileSync(backupPath));
  for (let i = 4096; i < corrupt.length; i += 7) corrupt[i] ^= 0xff;
  bad.corruptPages = corrupt;
  // a valid SQLite database from some other application
  const foreignPath = path.join(home, 'foreign.db');
  const foreign = new Database(foreignPath);
  foreign.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
  foreign.close();
  bad.foreign = fs.readFileSync(foreignPath);
  // a valid backup whose admins were all deactivated
  const noAdminPath = path.join(home, 'no-admin.db');
  fs.copyFileSync(backupPath, noAdminPath);
  const noAdmin = new Database(noAdminPath);
  noAdmin.exec("UPDATE users SET is_active = 0 WHERE role = 'admin'");
  noAdmin.close();
  bad.noAdmin = fs.readFileSync(noAdminPath);
  // a backup carrying a trigger
  const trigPath = path.join(home, 'trigger.db');
  fs.copyFileSync(backupPath, trigPath);
  const trig = new Database(trigPath);
  trig.exec("CREATE TRIGGER t AFTER INSERT ON sales BEGIN UPDATE users SET role='admin'; END;");
  trig.close();
  bad.trigger = fs.readFileSync(trigPath);

  const liveBefore = fs.readFileSync(live);
  for (const [name, bytes] of Object.entries(bad)) {
    const file = path.join(home, `bad-${name}.db`);
    fs.writeFileSync(file, bytes);
    ctx.dialogQueue.open.push({ canceled: false, filePaths: [file] });
    ctx.state.messageBoxes.length = 0;
    assert.equal(await ctx.call('backup:restore'), false, name);
    assert.equal(ctx.state.messageBoxes[0].type, 'error', name);
    assert.match(ctx.state.messageBoxes[0].message, /لم يتم تغيير أي بيانات/, name);
    assert.equal(ctx.state.exitCode, null, `${name}: app must not exit`);
    assert.ok(ctx.store.db.open, `${name}: database must stay open`);
  }
  assert.ok(liveBefore.equals(fs.readFileSync(live)), 'live database file unchanged');
  assert.deepEqual(safetyBackups(home), [], 'no restore went far enough to replace data');
  assert.deepEqual(fs.readdirSync(path.dirname(live)).filter((f) => f.includes('.restore-')), [], 'staged files cleaned up');

  // app keeps working normally
  const p = (await ctx.call('products:list')).find((x) => !x.track_stock);
  assert.ok(await ctx.call('sales:create', { items: [{ product_id: p.id, qty: 1 }] }));
  shutdown(ctx);
  const again = await boot({ home });
  await loginAs(again, 'owner', ADMIN_PIN);
  assert.equal((await again.call('sales:list', 10)).length, 1);
  shutdown(again);
});

test('cancelling the restore confirmation changes nothing', async () => {
  const { home, ctx, backupPath } = await adminWithBackup();
  ctx.dialogQueue.open.push({ canceled: false, filePaths: [backupPath] });
  ctx.dialogQueue.message.push({ response: 0 });
  assert.equal(await ctx.call('backup:restore'), false);
  assert.equal(ctx.state.exitCode, null);
  assert.deepEqual(safetyBackups(home), []);
  assert.deepEqual(fs.readdirSync(path.dirname(dbFile(home))).filter((f) => f.includes('.restore-')), []);
  shutdown(ctx);
});
