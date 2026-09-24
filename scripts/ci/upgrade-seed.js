// Upgrade test, step 1 (runs against the OLD version's code, E2E_APP_DIR=<old checkout>):
// after the old version's own E2E has created a database, add a discounted sale and a return
// through that version's API, then write a snapshot of the customer data to compare after upgrade.
//   E2E_APP_DIR=../v110 PLAYWRIGHT_CORE=... node scripts/ci/upgrade-seed.js <snapshot.json>
const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

const APP_DIR = process.env.E2E_APP_DIR;
const electronExe = require(path.join(APP_DIR, 'node_modules', 'electron'));
const OWNER = { u: 'owner', p: 'Owner-E2E-771' }; // created by the v1.1.0 E2E

(async () => {
  const app = await electron.launch({ executablePath: electronExe, args: [APP_DIR, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const snap = await win.evaluate(async (owner) => {
    const me = await window.api.auth.login(owner.u, owner.p);
    if (!me) throw new Error('old-version owner login failed');
    const p = (await window.api.products.list()).find((x) => x.name === 'E2E-PRODUCT');
    const sale = await window.api.sales.create({ items: [{ product_id: p.id, qty: 2 }], discount: 5, taxPercent: 14, paymentMethod: 'card' });
    const full = await window.api.sales.full(sale.saleId);
    await window.api.returns.create({ saleId: sale.saleId, saleItemId: full.items[0].id, qty: 1 });
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
  }, OWNER);
  await app.close();
  fs.writeFileSync(process.argv[2], JSON.stringify(snap, null, 2));
  console.log(`snapshot: ${snap.users.length} users, ${snap.products.length} products, ${snap.sales.length} sales, store "${snap.settings.store_name}"`);
})().catch((err) => { console.error(err); process.exit(1); });
