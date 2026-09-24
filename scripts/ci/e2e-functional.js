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
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function inspectDb() {
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, 'db-inspect.js'), dbFile]);
  return JSON.parse(out.toString());
}

async function launch() {
  const app = await electron.launch({ executablePath: electronExe, args: [ROOT, ...extraArgs] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const dialogs = [];
  win.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
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

  // ---- first run
  let { app, win, dialogs } = await launch();
  check('first run: setup screen shown (no default accounts)', await win.isVisible('#setupSection'));
  check('first run: disclosed default admin credentials rejected',
    (await api(win, "window.api.auth.login('admin','00102026')")).value === null);
  await win.fill('#setupUsername', ADMIN.u);
  await win.fill('#setupPin', ADMIN.p);
  await win.fill('#setupPinConfirm', ADMIN.p);
  await win.click('#setupBtn');
  await win.waitForURL(/index\.html/);
  check('first run: admin created, app opened', true);
  check('database file created', fs.existsSync(dbFile), dbFile);

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

  await win.click('.nav-btn[data-view="settings"]');
  await win.fill('#sTax', '14');
  await win.click('#saveSettingsBtn');
  await win.waitForTimeout(500);
  check('admin saves settings via UI (tax 14%)', (await api(win, 'window.api.settings.get()')).value.tax_percent === '14');
  check('negative tax rejected', !(await api(win, "window.api.settings.save('tax_percent','-1')")).ok);

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

  // answer "no" to the "print receipt?" prompt (no printer on CI)
  await win.evaluate(() => { window.confirm = () => false; });
  await win.click(`.product-card:has-text("E2E-PRODUCT")`);
  await win.click('#checkoutBtn');
  await win.waitForTimeout(800);
  let sales = (await api(win, 'window.api.sales.list(10)')).value;
  check('cashier sale via UI', sales.length === 1 && Math.abs(sales[0].total - 28.5) < 1e-9, `total=${sales[0] && sales[0].total}`);

  await win.click('.nav-btn[data-view="sales"]');
  await win.click('[data-view-sale]');
  await win.waitForSelector('[data-return-item]');
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
  check('cashier login uses PIN from the backup', !!(await api(win, `window.api.auth.login('${CASHIER.u}','${CASHIER.p}')`)).value);
  await app.close();

  ({ app, win, dialogs } = await launch());
  check('data persists across a normal restart', !!(await api(win, `window.api.auth.login('${ADMIN.u}','${ADMIN.p}')`)).value);
  await api(win, `window.api.products.save({name:'PERSIST-CHECK',price:2})`);
  await app.close();
  const final = inspectDb();
  check('database integrity ok at the end', final.integrity === 'ok');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
