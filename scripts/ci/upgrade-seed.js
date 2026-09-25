// Upgrade test, step 1 (runs against the OLD version's code, E2E_APP_DIR=<old checkout>):
// after the old version's own E2E has created a database, add a discounted sale and a return
// through that version's API (and, on versions that have one, a full store profile with a logo),
// back the data up with that version, then write a snapshot of the customer data to compare
// after upgrade. The backup is restored by the new version in upgrade-check.js.
//   E2E_APP_DIR=../v110 PLAYWRIGHT_CORE=... node scripts/ci/upgrade-seed.js <snapshot.json>
const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const APP_DIR = process.env.E2E_APP_DIR;
const electronExe = require(path.join(APP_DIR, 'node_modules', 'electron'));
const OWNER = { u: 'owner', p: 'Owner-E2E-771' }; // created by the old version's E2E
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PROFILE = {
  store_name: 'متجر الترقية', store_address: '5 شارع السوق', store_phone: '+20 100 000 0000',
  tax_number: '100-200-300', commercial_register: 'CR-778', receipt_footer: 'مع تحيات متجر الترقية', logo_data_url: LOGO,
};

(async () => {
  const app = await electron.launch({ executablePath: electronExe, args: [APP_DIR, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const backupFile = path.join(path.dirname(path.resolve(process.argv[2])), 'old-version-backup.db');
  const snap = await win.evaluate(async ({ owner, profile }) => {
    const me = await window.api.auth.login(owner.u, owner.p);
    if (!me) throw new Error('old-version owner login failed');
    const p = (await window.api.products.list()).find((x) => x.name === 'E2E-PRODUCT');
    const sale = await window.api.sales.create({ items: [{ product_id: p.id, qty: 2 }], discount: 5, taxPercent: 14, paymentMethod: 'card' });
    const full = await window.api.sales.full(sale.saleId);
    await window.api.returns.create({ saleId: sale.saleId, saleItemId: full.items[0].id, qty: 1 });
    if (window.api.settings.saveMany) await window.api.settings.saveMany(profile); // store profile: v1.2.0+
    const settings = await window.api.settings.get();
    return {
      users: (await window.api.users.list()).map((u) => ({ username: u.username, role: u.role, is_active: u.is_active })),
      products: (await window.api.products.list()).map((x) => ({ name: x.name, price: x.price, stock_qty: x.stock_qty })),
      categories: (await window.api.categories.list()).map((c) => c.name),
      sales: (await window.api.sales.list(100)).map((s) => ({ sale_number: s.sale_number, total: s.total, discount: s.discount, tax: s.tax })),
      returnsForSale: (await window.api.returns.forSale(sale.saleId)).map((r) => ({ qty: r.qty, refunded_amount: r.refunded_amount })),
      saleId: sale.saleId,
      settings: { ...settings, logo_data_url: settings.logo_data_url ? `len:${settings.logo_data_url.length}` : '' },
    };
  }, { owner: OWNER, profile: PROFILE });
  // Back up with the old version (native save dialog replaced in its main process).
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, backupFile);
  await win.evaluate(() => window.api.backup.create());
  if (!fs.existsSync(backupFile)) throw new Error('old-version backup was not created');
  snap.backupFile = backupFile;
  await app.close();
  fs.writeFileSync(process.argv[2], JSON.stringify(snap, null, 2));
  console.log(`snapshot: ${snap.users.length} users, ${snap.products.length} products, ${snap.sales.length} sales, store "${snap.settings.store_name}"`);
})().catch((err) => { console.error(err); process.exit(1); });
