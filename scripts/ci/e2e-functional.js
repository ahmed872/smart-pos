// End-to-end functional check of the real app (development Electron binary, real OS, real
// database files), driven through the UI and the renderer's window.api like a user would.
// Used by .github/workflows/windows-verify.yml on a Windows runner.
//
// Usage: node scripts/ci/e2e-functional.js   (PLAYWRIGHT_CORE=<path to playwright-core>)
// WARNING: deletes the SystemDB folder in the current OS user's appData before starting.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.join(__dirname, '..', '..');
// E2E_APP_DIR=<...>/resources/app.asar runs the same checks against the packaged application
// contents (after electron-builder's file filtering), with the development Electron binary.
const APP_DIR = process.env.E2E_APP_DIR || ROOT;
const electronExe = require(path.join(ROOT, 'node_modules', 'electron')); // path to the binary
const extraArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];

function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
const sysDir = path.join(appDataDir(), 'SystemDB');
const dbFile = path.join(sysDir, 'smart-pos.db');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-pos-e2e-'));

const results = [];
const ALL_DIALOGS = []; // every alert/confirm text shown during the whole run (all app launches)
const PAGE_ERRORS = []; // uncaught JavaScript errors in any page during the whole run
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function inspectDb() {
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, 'db-inspect.js'), dbFile]);
  return JSON.parse(out.toString());
}

async function launch() {
  const app = await electron.launch({ executablePath: electronExe, args: [APP_DIR, ...extraArgs] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const dialogs = [];
  win.on('dialog', (d) => { dialogs.push(d.message()); ALL_DIALOGS.push(d.message()); d.accept().catch(() => {}); });
  win.on('pageerror', (err) => PAGE_ERRORS.push(`${win.url().split('/').pop()}: ${err.message}`));
  return { app, win, dialogs };
}

const api = (win, expr) => win.evaluate(async (e) => {
  try {
    return { ok: true, value: await eval(e) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}, expr);

async function uiLogin(win, username, pin) {
  await win.fill('#username', username);
  await win.fill('#pin', pin);
  await win.click('#loginBtn');
}

async function logout(win) {
  await win.click('#logoutBtn');
  await win.waitForURL(/login\.html/);
}

// Replace native dialogs in the main process so backup/restore can be driven headlessly.
async function stubDialogs(app, { save, open, response = 1 }) {
  await app.evaluate(({ dialog, app: electronApp }, opts) => {
    globalThis.__messages = [];
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: opts.save });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [opts.open] });
    dialog.showMessageBox = async (_w, o) => { globalThis.__messages.push(o.message); return { response: opts.response }; };
    dialog.showErrorBox = (_t, m) => { globalThis.__messages.push(m); };
    electronApp.relaunch = () => {};
  }, { save, open, response });
}

(async () => {
  fs.rmSync(sysDir, { recursive: true, force: true });
  const ADMIN = { u: 'owner', p: 'Owner-E2E-771' };
  const CASHIER = { u: 'kasher', p: 'Cash-E2E-552' };
  const backupFile = path.join(work, 'backup.db');
  const STORE = { name: 'متجر الاختبار', currency: 'ر.س' };
  const PROFILE_FIELDS = {
    '#sStoreAddress': '12 شارع النصر، الرياض',
    '#sStorePhone': '+966 11 234 5678',
    '#sTaxNumber': '300123456700003',
    '#sCommercialRegister': '1010123456',
    '#sReceiptFooter': 'نسعد بخدمتكم دائمًا',
  };
  // 1x1 PNG used as a store logo
  const logoFile = path.join(work, 'logo.png');
  fs.writeFileSync(logoFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  // ---- first run
  let { app, win, dialogs } = await launch();
  check('first run: setup screen shown (no default accounts)', await win.isVisible('#setupSection'));
  check('first run: disclosed default admin credentials rejected',
    (await api(win, "window.api.auth.login('admin','00102026')")).value === null);
  const loginText = await win.evaluate(() => document.body.innerText + document.title);
  check('first run: login screen shows no organization branding', !/المجندين|الإدارة العامة/.test(loginText));
  await win.click('#setupBtn');
  check('first run: store name is required', /اسم المتجر مطلوب/.test(await win.textContent('#errorMsg')));
  await win.fill('#setupStoreName', STORE.name);
  await win.fill('#setupCurrency', STORE.currency);
  await win.fill('#setupUsername', ADMIN.u);
  await win.fill('#setupPin', ADMIN.p);
  await win.fill('#setupPinConfirm', ADMIN.p);
  await win.click('#setupBtn');
  await win.waitForURL(/index\.html/);
  check('first run: admin created, app opened', true);
  check('database file created', fs.existsSync(dbFile), dbFile);
  const firstSettings = (await api(win, 'window.api.settings.get()')).value;
  check('first run: store name and currency saved', firstSettings.store_name === STORE.name && firstSettings.currency === STORE.currency);
  check('first run: no default logo', firstSettings.logo_data_url === '');
  check('first run: no demo products or categories',
    (await api(win, 'window.api.products.list()')).value.length === 0 && (await api(win, 'window.api.categories.list()')).value.length === 0);
  check('sidebar shows the store name', (await win.textContent('#sidebarBrand')).includes(STORE.name));
  check('empty catalog shows a clear message', (await win.textContent('#productGrid')).includes('لا توجد منتجات بعد'));
  check('window title uses the product name', (await win.title()) === 'سيستم كاشير');
  const pkgVersion = require(path.join(ROOT, 'package.json')).version;
  check('about section shows product name and version',
    (await win.textContent('#aboutText')).includes('سيستم كاشير') && (await win.textContent('#aboutText')).includes(pkgVersion));

  // ---- store logo: upload, then remove
  await win.click('.nav-btn[data-view="settings"]');
  await win.setInputFiles('#logoFileInput', logoFile);
  await win.waitForTimeout(300);
  await win.click('#saveLogoBtn');
  await win.waitForTimeout(400);
  check('logo uploaded and shown in the sidebar',
    (await api(win, 'window.api.settings.get()')).value.logo_data_url.startsWith('data:image/png') && await win.isVisible('#sidebarBrand img'));
  await win.evaluate(() => { window.confirm = () => true; });
  await win.click('#removeLogoBtn');
  await win.waitForTimeout(400);
  check('logo removed: sidebar falls back to the store name',
    (await api(win, 'window.api.settings.get()')).value.logo_data_url === '' && !(await win.isVisible('#sidebarBrand img'))
    && (await win.textContent('#sidebarBrand')).includes(STORE.name));

  // ---- admin: users, products, settings, validation
  await win.click('.nav-btn[data-view="users"]');
  await win.fill('#uUsername', CASHIER.u);
  await win.fill('#uPin', CASHIER.p);
  await win.click('#saveUserBtn');
  await win.waitForTimeout(500);
  let users = (await api(win, 'window.api.users.list()')).value;
  check('admin creates cashier via UI', users.some((u) => u.username === CASHIER.u && u.role === 'cashier'));

  await win.click('.nav-btn[data-view="products"]');
  const addProduct = async (name, price) => {
    await win.fill('#pName', name);
    await win.fill('#pPrice', String(price));
    await win.fill('#pCost', '10');
    await win.fill('#pStock', '5');
    await win.check('#pTrackStock');
    await win.click('#saveProductBtn');
    await win.waitForTimeout(500);
  };
  await addProduct('E2E-PRODUCT', 25);
  let products = (await api(win, 'window.api.products.list()')).value;
  const product = products.find((p) => p.name === 'E2E-PRODUCT');
  check('admin creates product via UI', product && product.price === 25 && product.stock_qty === 5);

  const before = products.length;
  await addProduct('NEGATIVE', -5);
  products = (await api(win, 'window.api.products.list()')).value;
  check('negative price rejected via UI', products.length === before && dialogs.some((m) => /سالبة/.test(m)));
  const dup1 = await api(win, "window.api.products.save({name:'DUP-1',price:1,barcode:'999001'})");
  const dup2 = await api(win, "window.api.products.save({name:'DUP-2',price:1,barcode:'999001'})");
  check('duplicate barcode gives a clear Arabic message', dup1.ok && !dup2.ok && /الباركود مستخدم لمنتج آخر/.test(dup2.error));
  await api(win, `window.api.products.delete(${dup1.value})`);

  // a large photo (1600x1200) is resized before it is stored
  const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
  const photo = new PNG({ width: 1600, height: 1200 });
  for (let i = 0; i < photo.data.length; i += 4) {
    photo.data[i] = (i * 7) % 251; photo.data[i + 1] = (i * 13) % 241; photo.data[i + 2] = (i * 3) % 239; photo.data[i + 3] = 255;
  }
  const photoFile = path.join(work, 'photo.png');
  fs.writeFileSync(photoFile, PNG.sync.write(photo));
  await win.fill('#pName', 'PHOTO-PRODUCT');
  await win.fill('#pPrice', '3');
  await win.setInputFiles('#pImageInput', photoFile);
  await win.waitForTimeout(800);
  await win.click('#saveProductBtn');
  await win.waitForTimeout(500);
  const stored = ((await api(win, 'window.api.products.list()')).value.find((p) => p.name === 'PHOTO-PRODUCT') || {}).image_data_url || '';
  const dims = stored ? await win.evaluate((src) => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = src; }), stored) : [0, 0];
  check('product photo resized before saving (JPEG, at most 256 px)',
    stored.startsWith('data:image/jpeg') && Math.max(...dims) === 256 && stored.length < 100000,
    `${fs.statSync(photoFile).size} bytes -> ${stored.length} chars, ${dims.join('x')}`);

  // an empty price is not saved as a free product
  const countBeforeEmptyPrice = (await api(win, 'window.api.products.list()')).value.length;
  await win.fill('#pName', 'NO-PRICE');
  await win.fill('#pPrice', '');
  await win.click('#saveProductBtn');
  await win.waitForTimeout(400);
  check('empty price is refused with a message',
    (await api(win, 'window.api.products.list()')).value.length === countBeforeEmptyPrice && dialogs.some((m) => m === 'السعر مطلوب'));
  await win.fill('#pName', '');

  // deleting asks for confirmation first
  await addProduct('DELETE-ME', 1);
  const delId = (await api(win, 'window.api.products.list()')).value.find((p) => p.name === 'DELETE-ME').id;
  await win.evaluate(() => { window.confirm = () => false; });
  await win.fill('#productsTableSearch', 'DELETE-ME');
  await win.waitForTimeout(200);
  const visibleRows = await win.$$eval('#productsTableBody tr', (rows) => rows.length);
  await win.click(`[data-delete="${delId}"]`);
  await win.waitForTimeout(300);
  const keptAfterCancel = (await api(win, 'window.api.products.list()')).value.some((p) => p.id === delId);
  await win.evaluate(() => { window.confirm = () => true; });
  await win.click(`[data-delete="${delId}"]`);
  await win.waitForTimeout(400);
  check('product search filters the products table', visibleRows === 1);
  check('product delete asks for confirmation (cancel keeps it, confirm deletes it)',
    keptAfterCancel && !(await api(win, 'window.api.products.list()')).value.some((p) => p.id === delId));
  await win.fill('#productsTableSearch', '');

  await win.click('.nav-btn[data-view="settings"]');
  await win.fill('#sTax', '14');
  for (const [id, value] of Object.entries(PROFILE_FIELDS)) await win.fill(id, value);
  await win.click('#saveSettingsBtn');
  await win.waitForTimeout(500);
  check('admin saves settings via UI (tax 14%)', (await api(win, 'window.api.settings.get()')).value.tax_percent === '14');
  check('negative tax rejected', !(await api(win, "window.api.settings.save('tax_percent','-1')")).ok);
  const savedProfile = (await api(win, 'window.api.settings.get()')).value;
  check('store profile saved via settings screen', savedProfile.store_address === PROFILE_FIELDS['#sStoreAddress']
    && savedProfile.store_phone === PROFILE_FIELDS['#sStorePhone'] && savedProfile.tax_number === PROFILE_FIELDS['#sTaxNumber']
    && savedProfile.commercial_register === PROFILE_FIELDS['#sCommercialRegister'] && savedProfile.receipt_footer === PROFILE_FIELDS['#sReceiptFooter']);

  await stubDialogs(app, { save: backupFile, open: backupFile });
  const created = await api(win, 'window.api.backup.create()');
  check('admin creates backup', created.ok && fs.existsSync(backupFile), backupFile);

  // ---- cashier
  await logout(win);
  await uiLogin(win, CASHIER.u, CASHIER.p);
  await win.waitForURL(/index\.html/);
  const hidden = await win.evaluate(() => [...document.querySelectorAll('.admin-only')].every((e) => getComputedStyle(e).display === 'none'));
  check('cashier: admin-only navigation hidden', hidden);
  for (const [label, expr] of [
    ['create admin', "window.api.users.save({username:'evil',pin:'evil-pin-9',role:'admin'})"],
    ['edit product', `window.api.products.save({id:${product.id},name:'x',price:0.01})`],
    ['delete product', `window.api.products.delete(${product.id})`],
    ['edit settings', "window.api.settings.save('tax_percent','0')"],
    ['restore backup', 'window.api.backup.restore()'],
    ['create backup', 'window.api.backup.create()'],
    ['read reports', "window.api.reports.summary('2020-01-01','2030-12-31')"],
  ]) {
    const r = await api(win, expr);
    check(`cashier blocked: ${label}`, !r.ok && /للمدير فقط/.test(r.error));
  }
  check('cashier: negative discount rejected',
    !(await api(win, `window.api.sales.create({items:[{product_id:${product.id},qty:1}],discount:-10})`)).ok);

  check('POS: barcode field has the focus when the app opens', await win.evaluate(() => document.activeElement.id === 'barcodeInput'));
  await win.fill('#productSearch', 'zzz-no-such');
  check('POS: search with no match says so', (await win.textContent('#productGrid')).includes('لا توجد منتجات مطابقة'));
  await win.fill('#productSearch', 'E2E-PROD');
  check('POS: search shows only matching products', (await win.$$eval('.product-card', (cards) => cards.map((c) => c.textContent)))
    .every((t) => t.includes('E2E-PRODUCT')));
  // answer "no" to the "print receipt?" prompt (no printer on CI)
  await win.evaluate(() => { window.confirm = () => false; });
  await win.click(`.product-card:has-text("E2E-PRODUCT")`);
  await win.fill('#productSearch', '');
  // an impatient double click on "complete sale" must not create two invoices
  await win.dblclick('#checkoutBtn');
  await win.waitForTimeout(1000);
  let sales = (await api(win, 'window.api.sales.list(10)')).value;
  check('cashier sale via UI (double click creates exactly one invoice)', sales.length === 1 && Math.abs(sales[0].total - 28.5) < 1e-9,
    `invoices=${sales.length} total=${sales[0] && sales[0].total}`);
  check('POS: barcode field gets the focus back after a sale', await win.evaluate(() => document.activeElement.id === 'barcodeInput'));

  await win.click('.nav-btn[data-view="sales"]');
  await win.fill('#saleSearch', 'NO-SUCH-INVOICE');
  await win.press('#saleSearch', 'Enter');
  await win.waitForTimeout(300);
  check('sales history: search with no match says so', (await win.textContent('#salesTableBody')).includes('لا توجد فواتير مطابقة'));
  await win.fill('#saleSearch', sales[0].sale_number.slice(-6));
  await win.press('#saleSearch', 'Enter');
  await win.waitForTimeout(300);
  check('sales history: invoice found by its number', (await win.$$eval('[data-view-sale]', (b) => b.length)) === 1
    && (await win.textContent('#salesTableBody')).includes(sales[0].sale_number));
  await win.click('[data-view-sale]');
  await win.waitForSelector('[data-return-item]');
  await win.evaluate(() => { window.confirm = () => true; }); // confirm the return
  await win.click('[data-return-item]');
  await win.waitForTimeout(500);
  const full = (await api(win, `window.api.sales.full(${sales[0].id})`)).value;
  check('cashier return via UI', full.items[0].returned_qty === 1);

  // ---- admin changes cashier PIN (PIN only) — role must be preserved
  await logout(win);
  await uiLogin(win, ADMIN.u, ADMIN.p);
  await win.waitForURL(/index\.html/);
  await win.click('.nav-btn[data-view="users"]');
  await win.waitForTimeout(300);
  await win.fill('#uUsername', CASHIER.u);
  await win.fill('#uPin', 'Cash-E2E-NEW-9');
  await win.click('#saveUserBtn');
  await win.waitForTimeout(500);
  users = (await api(win, 'window.api.users.list()')).value;
  check('PIN change keeps role', users.find((u) => u.username === CASHIER.u).role === 'cashier');
  check('old PIN no longer works', (await api(win, `window.api.auth.login('${CASHIER.u}','${CASHIER.p}')`)).value === null);
  check('new PIN works', !!(await api(win, `window.api.auth.login('${CASHIER.u}','Cash-E2E-NEW-9')`)).value);
  await api(win, `window.api.auth.login('${ADMIN.u}','${ADMIN.p}')`);

  const inspected = inspectDb();
  check('PINs stored hashed (scrypt), never plaintext', inspected.users.length === 2 && inspected.users.every((u) => u.hashed));

  // ---- printed documents use the same store identity (rendered pages, as printed)
  const page = (f) => {
    const [file, query] = f.split('?');
    return require('node:url').pathToFileURL(path.join(APP_DIR, 'renderer', file)).href + (query ? `?${query}` : '');
  };
  const day = sales[0].created_at.slice(0, 10);
  await win.goto(page(`receipt.html?saleId=${sales[0].id}`));
  await win.waitForTimeout(800);
  const receipt = await win.innerText('#receipt');
  check('receipt: store name, address, phone, tax number, commercial register',
    [STORE.name, ...Object.values(PROFILE_FIELDS).slice(0, 4)].every((v) => receipt.includes(v)), receipt.split('\n').slice(0, 6).join(' | '));
  check('receipt: invoice number, date, payment method, tax rate, totals, footer',
    receipt.includes(sales[0].sale_number) && /\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/.test(receipt) && receipt.includes('طريقة الدفع: نقدًا')
    && receipt.includes('الضريبة (14%)') && receipt.includes('28.50 ' + STORE.currency) && receipt.includes(PROFILE_FIELDS['#sReceiptFooter']));
  check('receipt: returns shown after a return', receipt.includes('المرتجعات') && receipt.includes('الصافي بعد المرتجعات'));
  check('receipt: QR code rendered', await win.isVisible('.qr-box img'));
  await win.goto(page(`day-close.html?date=${day}`));
  await win.waitForTimeout(800);
  check('daily closing print: store name', (await win.innerText('#report')).includes(STORE.name));
  await win.goto(page(`report-print.html?from=${day}&to=${day}`));
  await win.waitForTimeout(800);
  const reportText = await win.innerText('#report');
  check('sales report print: store name and consistent labels', reportText.includes(STORE.name) && reportText.includes('الصافي شامل الضريبة'));
  await win.goto(page('index.html'));
  await win.waitForLoadState('domcontentloaded');
  const pdfFile = path.join(work, 'report.pdf');
  const xlsxFile = path.join(work, 'report.xlsx');
  await stubDialogs(app, { save: pdfFile, open: backupFile });
  check('PDF export', (await api(win, `window.api.reports.exportPdf('${day}','${day}')`)).ok
    && fs.existsSync(pdfFile) && fs.readFileSync(pdfFile).subarray(0, 4).toString() === '%PDF');
  await stubDialogs(app, { save: xlsxFile, open: backupFile });
  check('Excel export', (await api(win, `window.api.reports.exportExcel('${day}','${day}')`)).ok
    && fs.existsSync(xlsxFile) && fs.readFileSync(xlsxFile).subarray(0, 2).toString() === 'PK' && fs.statSync(xlsxFile).size > 1000);

  // ---- restore a corrupted file: rejected, app keeps running
  const junk = path.join(work, 'junk.db');
  fs.writeFileSync(junk, crypto.randomBytes(16384));
  await stubDialogs(app, { save: backupFile, open: junk });
  const bad = await api(win, 'window.api.backup.restore()');
  const msgs = await app.evaluate(() => globalThis.__messages);
  check('corrupted backup rejected', bad.ok && bad.value === false && msgs.some((m) => /لم يتم تغيير أي بيانات/.test(m)));
  check('app still working after rejected restore', (await api(win, 'window.api.products.list()')).ok);

  // ---- restore the valid backup
  await api(win, "window.api.products.save({name:'AFTER-BACKUP',price:1})");
  await stubDialogs(app, { save: backupFile, open: backupFile });
  const closed = new Promise((r) => app.once('close', r));
  win.evaluate(() => window.api.backup.restore()).catch(() => {});
  await closed;
  const safety = path.join(sysDir, 'safety-backups');
  check('safety backup created before restore', fs.existsSync(safety) && fs.readdirSync(safety).length === 1);

  // ---- restart: restored data, persistence
  ({ app, win, dialogs } = await launch());
  check('app restarts after restore', (await api(win, `window.api.auth.login('${ADMIN.u}','${ADMIN.p}')`)).value?.role === 'admin');
  products = (await api(win, 'window.api.products.list()')).value.map((p) => p.name);
  check('restored data is the backup data', products.includes('E2E-PRODUCT') && !products.includes('AFTER-BACKUP'));
  const restoredProfile = (await api(win, 'window.api.settings.get()')).value;
  check('store identity restored with the backup', restoredProfile.store_name === STORE.name && restoredProfile.tax_number === PROFILE_FIELDS['#sTaxNumber']);
  check('cashier login uses PIN from the backup', !!(await api(win, `window.api.auth.login('${CASHIER.u}','${CASHIER.p}')`)).value);
  await app.close();

  ({ app, win, dialogs } = await launch());
  check('data persists across a normal restart', !!(await api(win, `window.api.auth.login('${ADMIN.u}','${ADMIN.p}')`)).value);
  const persisted = (await api(win, 'window.api.settings.get()')).value;
  check('store identity persists across restart (name, currency, removed logo)',
    persisted.store_name === STORE.name && persisted.currency === STORE.currency && persisted.logo_data_url === '');
  await api(win, `window.api.products.save({name:'PERSIST-CHECK',price:2})`);
  await app.close();
  const final = inspectDb();
  check('database integrity ok at the end', final.integrity === 'ok');

  check('no technical/English error text was ever shown to the user',
    ALL_DIALOGS.length > 0 && ALL_DIALOGS.every((m) => !/Error invoking|remote method|SqliteError|constraint/i.test(m)),
    `${ALL_DIALOGS.length} dialogs checked`);
  check('no uncaught JavaScript error in any page', PAGE_ERRORS.length === 0, PAGE_ERRORS.slice(0, 3).join(' || '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
