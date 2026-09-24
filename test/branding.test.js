// Commercial identity: a fresh install ships no store identity, logo, currency or demo catalog;
// migrations never rewrite a customer's own branding; logo can be removed; backup/restore carries
// the store identity; no organization branding exists in shipped source.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { boot, shutdown, makeTempHome, ROOT } = require('./harness.js');

const PIN = 'Owner-PIN-1';
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ORG_NAME = 'الإدارة العامة لشئون المجندين';

function dbFile(home) {
  return path.join(home, 'appData', 'SystemDB', 'smart-pos.db');
}

async function restart(home) {
  const ctx = await boot({ home });
  await ctx.call('auth:login', 'owner', PIN);
  return ctx;
}

test('fresh install: no store identity, logo, currency or demo catalog', async () => {
  const home = makeTempHome();
  const ctx = await boot({ home });
  assert.equal(await ctx.call('auth:needsSetup'), true);
  await ctx.call('auth:setupAdmin', 'owner', PIN);
  const s = await ctx.call('settings:get');
  assert.deepEqual(s, {
    store_name: '', currency: '', tax_percent: '0', receipt_width_mm: '58',
    invoice_reset_period: 'monthly', low_stock_threshold: '5', logo_data_url: '',
  });
  assert.deepEqual(await ctx.call('products:list'), []);
  assert.deepEqual(await ctx.call('categories:list'), []);
  shutdown(ctx);
  const raw = new Database(dbFile(home), { readonly: true });
  const all = JSON.stringify([raw.prepare('SELECT * FROM settings').all(), raw.prepare('SELECT * FROM products').all()]);
  raw.close();
  assert.ok(!all.includes('المجندين') && !all.includes('ج.م'), 'no organization or market-specific defaults stored');
});

test('first-run setup stores the store name and currency with the admin (atomically)', async () => {
  const home = makeTempHome();
  const ctx = await boot({ home });
  await assert.rejects(ctx.call('auth:setupAdmin', 'owner', PIN, { storeName: 'x'.repeat(201) }), /طويل/);
  assert.equal(await ctx.call('auth:needsSetup'), true, 'invalid profile creates no admin');
  await ctx.call('auth:setupAdmin', 'owner', PIN, { storeName: '  متجر النور  ', currency: 'ر.س' });
  const s = await ctx.call('settings:get');
  assert.equal(s.store_name, 'متجر النور');
  assert.equal(s.currency, 'ر.س');
  shutdown(ctx);
});

test('regression: a store named "متجري" keeps its name across restarts', async () => {
  const home = makeTempHome();
  let ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', PIN, { storeName: 'متجري' });
  shutdown(ctx);
  for (let i = 0; i < 3; i++) {
    ctx = await restart(home);
    assert.equal((await ctx.call('settings:get')).store_name, 'متجري');
    shutdown(ctx);
  }
});

test('upgrade keeps an existing installation\'s branding, currency and catalog untouched', async () => {
  const home = makeTempHome();
  let ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', PIN);
  shutdown(ctx);
  // what a v1.0.0/v1.1.0 install looks like: organization defaults and the demo catalog
  const raw = new Database(dbFile(home));
  const set = raw.prepare('UPDATE settings SET value = ? WHERE key = ?');
  set.run(ORG_NAME, 'store_name');
  set.run(LOGO, 'logo_data_url');
  set.run('ج.م', 'currency');
  const cat = raw.prepare("INSERT INTO categories (name, is_kitchen) VALUES ('مأكولات', 1)").run().lastInsertRowid;
  raw.prepare("INSERT INTO products (name, barcode, category_id, price, cost) VALUES ('برجر لحم', '1001', ?, 85, 45)").run(cat);
  raw.close();
  for (let i = 0; i < 2; i++) {
    ctx = await restart(home);
    const s = await ctx.call('settings:get');
    assert.equal(s.store_name, ORG_NAME);
    assert.equal(s.logo_data_url, LOGO);
    assert.equal(s.currency, 'ج.م');
    assert.deepEqual((await ctx.call('products:list')).map((p) => p.name), ['برجر لحم']);
    shutdown(ctx);
  }
});

test('databases missing settings rows get neutral defaults, never an organization logo', async () => {
  const home = makeTempHome();
  let ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', PIN);
  shutdown(ctx);
  const raw = new Database(dbFile(home));
  raw.exec("DELETE FROM settings WHERE key IN ('logo_data_url', 'store_name', 'currency', 'receipt_width_mm')");
  raw.close();
  ctx = await restart(home);
  const s = await ctx.call('settings:get');
  assert.equal(s.logo_data_url, '');
  assert.equal(s.store_name, '');
  assert.equal(s.currency, '');
  assert.equal(s.receipt_width_mm, '58');
  shutdown(ctx);
});

test('logo: upload, remove, and the removal survives a restart', async () => {
  const home = makeTempHome();
  let ctx = await boot({ home });
  await ctx.call('auth:setupAdmin', 'owner', PIN, { storeName: 'متجر أ' });
  await ctx.call('settings:save', 'logo_data_url', LOGO);
  assert.equal((await ctx.call('settings:get')).logo_data_url, LOGO);
  shutdown(ctx);
  ctx = await restart(home);
  assert.equal((await ctx.call('settings:get')).logo_data_url, LOGO);
  await ctx.call('settings:save', 'logo_data_url', '');
  shutdown(ctx);
  ctx = await restart(home);
  assert.equal((await ctx.call('settings:get')).logo_data_url, '');
  shutdown(ctx);
});

test('backup/restore carries the store identity; another store does not see it', async () => {
  const homeA = makeTempHome();
  let a = await boot({ home: homeA });
  await a.call('auth:setupAdmin', 'owner', PIN, { storeName: 'Store A', currency: 'A$' });
  await a.call('settings:save', 'logo_data_url', LOGO);
  const backupFile = path.join(homeA, 'a.db');
  a.dialogQueue.save.push({ canceled: false, filePath: backupFile });
  await a.call('backup:create');
  shutdown(a);

  const homeB = makeTempHome();
  let b = await boot({ home: homeB });
  await b.call('auth:setupAdmin', 'owner', PIN, { storeName: 'Store B', currency: 'B$' });
  const sB = await b.call('settings:get');
  assert.equal(sB.store_name, 'Store B');
  assert.equal(sB.logo_data_url, '', 'store B sees nothing of store A');
  assert.equal(sB.currency, 'B$');
  b.dialogQueue.open.push({ canceled: false, filePaths: [backupFile] });
  b.dialogQueue.message.push({ response: 1 });
  assert.equal(await b.call('backup:restore'), true);
  b = await restart(homeB);
  const restored = await b.call('settings:get');
  assert.equal(restored.store_name, 'Store A');
  assert.equal(restored.logo_data_url, LOGO);
  assert.equal(restored.currency, 'A$');
  shutdown(b);
});

test('shipped source and assets contain no organization branding', () => {
  const shipped = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else shipped.push(f);
    }
  };
  walk(path.join(ROOT, 'electron'));
  walk(path.join(ROOT, 'renderer'));
  shipped.push(path.join(ROOT, 'package.json'), path.join(ROOT, 'build', 'installer.nsh'));
  for (const f of shipped) {
    const text = fs.readFileSync(f).toString('utf8');
    for (const banned of ['المجندين', 'الإدارة العامة', 'login-emblem', 'default-logo']) {
      assert.ok(!text.includes(banned), `${path.relative(ROOT, f)} contains "${banned}"`);
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'renderer', 'assets')), ['app-icon.png']);
  assert.equal(fs.existsSync(path.join(ROOT, 'electron', 'default-logo.js')), false);
});
