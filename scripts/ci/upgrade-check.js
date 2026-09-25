// Upgrade test, step 2 (runs against the NEW code on the database written by the old version and
// then opened by the newly installed packaged app): every piece of customer data must be intact,
// and a backup made by the old version must restore in the new one.
//   PLAYWRIGHT_CORE=... node scripts/ci/upgrade-check.js <snapshot.json>
const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const electronExe = require(path.join(ROOT, 'node_modules', 'electron'));
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Settings the new version adds to databases that do not have them yet, and their neutral defaults.
const NEW_SETTING_DEFAULTS = { store_address: '', store_phone: '', tax_number: '', commercial_register: '', receipt_footer: 'شكرًا لتعاملكم معنا' };

async function launch() {
  const app = await electron.launch({ executablePath: electronExe, args: [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

const readData = (win, s) => win.evaluate(async (s) => {
  const needsSetup = await window.api.auth.needsSetup();
  const owner = await window.api.auth.login('owner', 'Owner-E2E-771');
  const cashier = await window.api.auth.login('kasher', 'Cash-E2E-552');
  await window.api.auth.login('owner', 'Owner-E2E-771');
  const settings = await window.api.settings.get();
  const sales = await window.api.sales.list(100);
  const day = sales[0].created_at.slice(0, 10);
  return {
    needsSetup, owner, cashier,
    users: (await window.api.users.list()).map((u) => ({ username: u.username, role: u.role, is_active: u.is_active })),
    products: (await window.api.products.list()).map((x) => ({ name: x.name, price: x.price, stock_qty: x.stock_qty })),
    categories: (await window.api.categories.list()).map((c) => c.name),
    sales: sales.map((x) => ({ sale_number: x.sale_number, total: x.total, discount: x.discount, tax: x.tax })),
    returnsForSale: (await window.api.returns.forSale(s.saleId)).map((x) => ({ qty: x.qty, refunded_amount: x.refunded_amount })),
    settings: { ...settings, logo_data_url: settings.logo_data_url ? `len:${settings.logo_data_url.length}` : '' },
    report: await window.api.reports.summary(day, day),
    closing: await window.api.reports.dailyClosing(day),
    info: await window.api.app.info(),
  };
}, s);

(async () => {
  let { app, win } = await launch();
  const r = await readData(win, snap);

  check('existing installation opens without first-run setup', r.needsSetup === false);
  check('existing PINs still work after upgrade (owner, cashier)', !!r.owner && !!r.cashier);
  check('roles preserved', r.owner && r.owner.role === 'admin' && r.cashier && r.cashier.role === 'cashier');
  check('employees preserved', same(r.users, snap.users), `${r.users.length} users`);
  check('products and stock preserved', same(r.products, snap.products), `${r.products.length} products`);
  check('categories preserved', same(r.categories, snap.categories));
  check('sales preserved', same(r.sales, snap.sales), `${r.sales.length} sales`);
  check('returns preserved', same(r.returnsForSale, snap.returnsForSale));
  for (const k of Object.keys(snap.settings)) {
    check(`setting preserved: ${k}`, r.settings[k] === snap.settings[k], `${JSON.stringify(snap.settings[k])} -> ${JSON.stringify(r.settings[k])}`);
  }
  const added = Object.keys(NEW_SETTING_DEFAULTS).filter((k) => !(k in snap.settings));
  if (added.length) {
    check('new settings added with neutral defaults', added.every((k) => r.settings[k] === NEW_SETTING_DEFAULTS[k]), added.join(', '));
  }
  check('reports work on upgraded data and match the daily closing',
    Math.abs(r.report.netTotal - r.closing.netTotal) < 1e-9 && r.report.invoiceCount === r.closing.invoiceCount,
    `netTotal ${r.report.netTotal} / ${r.closing.netTotal}`);
  check('app reports the new version', r.info.version === require(path.join(ROOT, 'package.json')).version, r.info.version);

  // A backup made by the old version restores in the new version (after data added since then).
  if (snap.backupFile) {
    await win.evaluate(() => window.api.products.save({ name: 'AFTER-UPGRADE', price: 1 }));
    await app.evaluate(({ dialog, app: electronApp }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
      dialog.showErrorBox = () => {};
      electronApp.relaunch = () => {};
    }, snap.backupFile);
    const closed = new Promise((res) => app.once('close', res));
    win.evaluate(() => window.api.backup.restore()).catch(() => {});
    await closed;
    ({ app, win } = await launch());
    const b = await readData(win, snap);
    check('old-version backup restores in the new version', !!b.owner && !!b.cashier && b.needsSetup === false);
    check('restored backup: employees, products, categories, sales, returns',
      same(b.users, snap.users) && same(b.products, snap.products) && same(b.categories, snap.categories)
      && same(b.sales, snap.sales) && same(b.returnsForSale, snap.returnsForSale), `${b.products.length} products`);
    check('restored backup: settings and branding', Object.keys(snap.settings).every((k) => b.settings[k] === snap.settings[k]));
  }
  await app.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} upgrade checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
