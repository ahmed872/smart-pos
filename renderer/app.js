const { escapeHtml } = window.StoreIdentity;
const { userMessage } = window.UiMessages;

let categories = [];
let products = [];
let cart = []; // { product_id, name, qty, unit_price, is_kitchen_item }
let settings = {};
let currentUser = null;
let editingProductId = null;
let pendingProductImage = null;

async function init() {
  currentUser = await window.api.auth.me();
  if (!currentUser || currentUser.mustChangePin) {
    window.location.href = 'login.html';
    return;
  }

  categories = await window.api.categories.list();
  products = await window.api.products.list();
  settings = await window.api.settings.get();

  applyRoleVisibility();
  renderSidebarBrand();
  renderProductGrid();
  renderCategorySelect();
  renderCart();
  populateSettingsForm();
  updateLowStockBadge();
  await refreshSalesTable();
  await refreshProductsTable();

  setupNav();
  setupPosHandlers();
  setupProductHandlers();
  setupSettingsHandlers();
  setupReportsHandlers();
  setupUsersHandlers();
  if (currentUser.role === 'admin') setupBackupHandlers();
  setupLogoHandlers();
  setupDayCloseHandlers();
  showAbout();

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('reportFrom').value = today;
  document.getElementById('reportTo').value = today;
  document.getElementById('dayCloseDate').value = today;
}

function isLowStock(product) {
  const threshold = Number(settings.low_stock_threshold) || 5;
  return product.track_stock && product.stock_qty <= threshold;
}

function updateLowStockBadge() {
  const lowStockItems = products.filter(isLowStock);
  const badge = document.getElementById('lowStockBadge');
  if (lowStockItems.length === 0) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = 'block';
  badge.textContent = `⚠ ${lowStockItems.length} صنف مخزونه منخفض`;
}

function applyRoleVisibility() {
  document.getElementById('userBadge').textContent =
    `${currentUser.username} (${currentUser.role === 'admin' ? 'مدير' : 'كاشير'})`;

  if (currentUser.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach((el) => (el.style.display = 'none'));
  }
}

// The store's own identity: its logo if it has one, otherwise its name (product name as last resort).
function renderSidebarBrand() {
  const box = document.getElementById('sidebarBrand');
  box.innerHTML = settings.logo_data_url
    ? `<img src="${settings.logo_data_url}" style="max-width:100%;height:auto;" alt="${escapeHtml(settings.store_name || '')}" />`
    : `<span style="color:var(--accent);font-size:20px;font-weight:bold;">${escapeHtml(settings.store_name || 'سيستم كاشير')}</span>`;
}

function renderLogoPreview() {
  document.getElementById('logoPreviewBox').innerHTML = settings.logo_data_url
    ? `<img src="${settings.logo_data_url}" style="max-height:70px;" />`
    : '<span style="color:var(--text-dim);font-size:13px;">لا يوجد شعار مرفوع حاليًا</span>';
  document.getElementById('removeLogoBtn').style.display = settings.logo_data_url ? '' : 'none';
}

function setupNav() {
  document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('view-' + btn.dataset.view).classList.add('active');
      if (btn.dataset.view === 'users') await refreshUsersTable();
    });
  });
  document.getElementById('openKitchenBtn').addEventListener('click', () => {
    window.api.kitchen.openWindow();
  });
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await window.api.auth.logout();
  });
}

function renderProductGrid() {
  const grid = document.getElementById('productGrid');
  grid.innerHTML = '';
  if (products.length === 0) {
    grid.innerHTML = `<p style="color:var(--text-dim);padding:12px;">${currentUser.role === 'admin'
      ? 'لا توجد منتجات بعد. أضف المنتجات من شاشة "المنتجات".'
      : 'لا توجد منتجات بعد. يمكن للمدير إضافة المنتجات.'}</p>`;
    return;
  }

  const byCategory = new Map();
  for (const p of products) {
    const key = p.category_id || 'none';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(p);
  }

  const orderedKeys = categories.map((c) => c.id);
  if (byCategory.has('none')) orderedKeys.push('none');

  for (const key of orderedKeys) {
    const items = byCategory.get(key);
    if (!items || items.length === 0) continue;
    const categoryName = key === 'none' ? 'بدون فئة' : (categories.find((c) => c.id === key)?.name || '');

    const heading = document.createElement('div');
    heading.className = 'category-heading';
    heading.textContent = categoryName;
    grid.appendChild(heading);

    for (const p of items) {
      const card = document.createElement('div');
      card.className = 'product-card' + (isLowStock(p) ? ' low-stock' : '');
      const stockLabel = p.track_stock ? `${p.stock_qty} بالمخزون` : 'غير محدود';
      const thumb = p.image_data_url
        ? `<img src="${p.image_data_url}" style="width:100%;height:70px;object-fit:cover;border-radius:6px;margin-bottom:6px;" />`
        : '';
      card.innerHTML = `
        ${thumb}
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="price">${p.price.toFixed(2)} ${settings.currency || ''}</div>
        <div class="stock">${isLowStock(p) ? '⚠ ' : ''}${stockLabel}</div>
      `;
      card.addEventListener('click', () => addToCart(p));
      grid.appendChild(card);
    }
  }
}

function renderCategorySelect() {
  const select = document.getElementById('pCategory');
  select.innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function addToCart(product) {
  const existing = cart.find((it) => it.product_id === product.id);
  const qtyInCart = existing ? existing.qty : 0;

  if (product.track_stock && qtyInCart + 1 > product.stock_qty) {
    alert(`الكمية المتاحة من "${product.name}" في المخزون: ${product.stock_qty} فقط`);
    return;
  }

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({
      product_id: product.id,
      name: product.name,
      qty: 1,
      unit_price: product.price,
      is_kitchen_item: product.category_is_kitchen ? 1 : 0,
    });
  }
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cartItems');
  container.innerHTML = '';
  for (const [index, it] of cart.entries()) {
    const row = document.createElement('div');
    row.className = 'cart-row';
    row.innerHTML = `
      <span>${escapeHtml(it.name)}</span>
      <div class="qty-controls" style="display:flex;align-items:center;gap:6px;">
        <button data-action="dec" data-index="${index}">-</button>
        <span>${it.qty}</span>
        <button data-action="inc" data-index="${index}">+</button>
        <button data-action="remove" data-index="${index}">×</button>
      </div>
      <span>${(it.qty * it.unit_price).toFixed(2)}</span>
    `;
    container.appendChild(row);
  }
  container.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index);
      if (btn.dataset.action === 'inc') {
        const product = products.find((p) => p.id === cart[index].product_id);
        if (product && product.track_stock && cart[index].qty + 1 > product.stock_qty) {
          alert(`الكمية المتاحة من "${product.name}" في المخزون: ${product.stock_qty} فقط`);
          return;
        }
        cart[index].qty += 1;
      }
      if (btn.dataset.action === 'dec') cart[index].qty = Math.max(1, cart[index].qty - 1);
      if (btn.dataset.action === 'remove') cart.splice(index, 1);
      renderCart();
    });
  });
  updateTotals();
}

function updateTotals() {
  const subtotal = cart.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
  const discount = Number(document.getElementById('discountInput').value) || 0;
  const taxPercent = Number(settings.tax_percent) || 0;
  const taxable = Math.max(subtotal - discount, 0);
  const tax = taxable * (taxPercent / 100);
  const total = taxable + tax;

  document.getElementById('subtotalText').textContent = subtotal.toFixed(2);
  document.getElementById('taxText').textContent = tax.toFixed(2);
  document.getElementById('totalText').textContent = total.toFixed(2);
}

function setupPosHandlers() {
  document.getElementById('discountInput').addEventListener('input', updateTotals);

  const barcodeInput = document.getElementById('barcodeInput');
  barcodeInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const code = barcodeInput.value.trim();
    barcodeInput.value = '';
    if (!code) return;
    const product = products.find((p) => p.barcode === code);
    if (!product) {
      alert('لا يوجد منتج بهذا الباركود: ' + code);
      return;
    }
    addToCart(product);
  });

  document.getElementById('clearCartBtn').addEventListener('click', () => {
    cart = [];
    renderCart();
  });

  document.getElementById('checkoutBtn').addEventListener('click', async () => {
    if (cart.length === 0) {
      alert('الفاتورة فارغة');
      return;
    }
    const discount = Number(document.getElementById('discountInput').value) || 0;
    const taxPercent = Number(settings.tax_percent) || 0;
    const paymentMethod = document.getElementById('paymentMethod').value;

    let result;
    try {
      result = await window.api.sales.create({
        items: cart,
        discount,
        taxPercent,
        paymentMethod,
      });
    } catch (err) {
      alert(userMessage(err));
      return;
    }

    cart = [];
    document.getElementById('discountInput').value = 0;
    renderCart();
    products = await window.api.products.list();
    renderProductGrid();
    updateLowStockBadge();
    await refreshSalesTable();

    const wantsPrint = confirm(`تم إتمام البيع - فاتورة رقم ${result.saleNumber} بإجمالي ${result.total.toFixed(2)}\n\nهل تريد طباعة الفاتورة؟`);
    if (wantsPrint) {
      try {
        await window.api.print.receipt(result.saleId);
      } catch (err) {
        alert(userMessage(err));
      }
    }
  });
}

async function refreshSalesTable() {
  const sales = await window.api.sales.list(100);
  const body = document.getElementById('salesTableBody');
  if (sales.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim);">لا توجد فواتير بعد.</td></tr>';
    return;
  }
  body.innerHTML = sales.map((s) => `
    <tr>
      <td><bdi dir="ltr">${escapeHtml(s.sale_number)}</bdi></td>
      <td>${window.StoreIdentity.formatDateTime(s.created_at)}</td>
      <td>${window.StoreIdentity.money(s.total, settings.currency)}</td>
      <td>${window.StoreIdentity.paymentLabel(s.payment_method)}</td>
      <td>
        <button class="secondary" data-view-sale="${s.id}">تفاصيل</button>
        <button class="secondary" data-print-sale="${s.id}">طباعة</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-view-sale]').forEach((btn) => {
    btn.addEventListener('click', () => showSaleDetail(Number(btn.dataset.viewSale)));
  });
  body.querySelectorAll('[data-print-sale]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await window.api.print.receipt(Number(btn.dataset.printSale));
      } catch (err) {
        alert(userMessage(err));
      }
    });
  });
}

async function showSaleDetail(saleId) {
  const data = await window.api.sales.full(saleId);
  const box = document.getElementById('saleDetailBox');
  box.style.display = 'block';

  box.innerHTML = `
    <h3>تفاصيل فاتورة ${escapeHtml(data.sale.sale_number)}</h3>
    <table>
      <thead><tr><th>الصنف</th><th>الكمية</th><th>تم إرجاعه</th><th>السعر</th><th>إرجاع</th></tr></thead>
      <tbody>
        ${data.items.map((it) => {
          const remaining = it.qty - it.returned_qty;
          return `
            <tr>
              <td>${escapeHtml(it.name)}</td>
              <td>${it.qty}</td>
              <td>${it.returned_qty}</td>
              <td>${it.unit_price.toFixed(2)}</td>
              <td>
                ${remaining > 0 ? `
                  <input type="number" min="1" max="${remaining}" value="1" style="width:50px;" id="retQty-${it.id}" />
                  <input type="text" placeholder="السبب (اختياري)" style="width:120px;" id="retReason-${it.id}" />
                  <button class="secondary" data-return-item="${it.id}" data-sale="${saleId}">إرجاع</button>
                ` : 'مكتمل'}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  box.querySelectorAll('[data-return-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const saleItemId = Number(btn.dataset.returnItem);
      const saleIdVal = Number(btn.dataset.sale);
      const qty = Number(document.getElementById(`retQty-${saleItemId}`).value);
      const reason = document.getElementById(`retReason-${saleItemId}`).value.trim();
      try {
        const result = await window.api.returns.create({ saleId: saleIdVal, saleItemId, qty, reason });
        alert(`تم تسجيل الإرجاع. المبلغ المسترد: ${result.refundedAmount.toFixed(2)} ${settings.currency || ''}`);
        showSaleDetail(saleIdVal);
        products = await window.api.products.list();
        renderProductGrid();
        updateLowStockBadge();
      } catch (err) {
        alert(userMessage(err));
      }
    });
  });
}

async function refreshProductsTable() {
  const body = document.getElementById('productsTableBody');
  body.innerHTML = products.map((p) => `
    <tr${isLowStock(p) ? ' style="background:#fef3c7;"' : ''}>
      <td>${p.image_data_url ? `<img src="${p.image_data_url}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;" />` : '—'}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.category_name || '-')}</td>
      <td>${p.price.toFixed(2)}</td>
      <td>${isLowStock(p) ? '⚠ ' : ''}${p.track_stock ? p.stock_qty : '—'}</td>
      <td>
        <button class="secondary" data-edit="${p.id}">تعديل</button>
        <button class="secondary" data-delete="${p.id}">حذف</button>
      </td>
    </tr>
  `).join('');
  body.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await window.api.products.delete(Number(btn.dataset.delete));
      } catch (err) {
        alert(userMessage(err));
        return;
      }
      products = await window.api.products.list();
      renderProductGrid();
      updateLowStockBadge();
      await refreshProductsTable();
    });
  });
  body.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = products.find((p) => p.id === Number(btn.dataset.edit));
      if (product) loadProductIntoForm(product);
    });
  });
}

function renderProductImagePreview() {
  const box = document.getElementById('pImagePreview');
  box.innerHTML = pendingProductImage
    ? `<img src="${pendingProductImage}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;" />`
    : '<span style="color:var(--text-dim);font-size:13px;">لا توجد صورة</span>';
}

function loadProductIntoForm(product) {
  editingProductId = product.id;
  document.getElementById('productFormTitle').textContent = 'تعديل: ' + product.name;
  document.getElementById('pName').value = product.name;
  document.getElementById('pBarcode').value = product.barcode || '';
  document.getElementById('pCategory').value = product.category_id || '';
  document.getElementById('pPrice').value = product.price;
  document.getElementById('pCost').value = product.cost;
  document.getElementById('pStock').value = product.stock_qty;
  document.getElementById('pTrackStock').checked = !!product.track_stock;
  document.getElementById('cancelEditBtn').style.display = 'block';
  pendingProductImage = product.image_data_url || null;
  document.getElementById('pImageInput').value = '';
  renderProductImagePreview();
  document.getElementById('view-products').scrollIntoView({ behavior: 'smooth' });
}

function resetProductForm() {
  editingProductId = null;
  document.getElementById('productFormTitle').textContent = 'إضافة منتج جديد';
  document.getElementById('pName').value = '';
  document.getElementById('pBarcode').value = '';
  document.getElementById('pCategory').value = '';
  document.getElementById('pPrice').value = '';
  document.getElementById('pCost').value = '';
  document.getElementById('pStock').value = '';
  document.getElementById('pTrackStock').checked = false;
  document.getElementById('cancelEditBtn').style.display = 'none';
  pendingProductImage = null;
  document.getElementById('pImageInput').value = '';
  renderProductImagePreview();
}

function setupProductHandlers() {
  renderProductImagePreview();

  document.getElementById('pImageInput').addEventListener('change', () => {
    const file = document.getElementById('pImageInput').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingProductImage = reader.result;
      renderProductImagePreview();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('saveProductBtn').addEventListener('click', async () => {
    const name = document.getElementById('pName').value.trim();
    if (!name) { alert('اسم المنتج مطلوب'); return; }
    try {
      await window.api.products.save({
        id: editingProductId,
        name,
        barcode: document.getElementById('pBarcode').value.trim(),
        category_id: Number(document.getElementById('pCategory').value) || null,
        price: Number(document.getElementById('pPrice').value) || 0,
        cost: Number(document.getElementById('pCost').value) || 0,
        stock_qty: Number(document.getElementById('pStock').value) || 0,
        track_stock: document.getElementById('pTrackStock').checked,
        image_data_url: pendingProductImage,
      });
    } catch (err) {
      alert(userMessage(err));
      return;
    }
    resetProductForm();
    products = await window.api.products.list();
    renderProductGrid();
    updateLowStockBadge();
    await refreshProductsTable();
  });

  document.getElementById('cancelEditBtn').addEventListener('click', resetProductForm);
}

// Settings key -> form field of the settings screen.
const SETTINGS_FORM_FIELDS = [
  ['store_name', 'sStoreName'],
  ['store_address', 'sStoreAddress'],
  ['store_phone', 'sStorePhone'],
  ['tax_number', 'sTaxNumber'],
  ['commercial_register', 'sCommercialRegister'],
  ['receipt_footer', 'sReceiptFooter'],
  ['currency', 'sCurrency'],
  ['tax_percent', 'sTax'],
  ['receipt_width_mm', 'sReceiptWidth'],
  ['invoice_reset_period', 'sInvoiceReset'],
  ['low_stock_threshold', 'sLowStock'],
];

// Every key always exists (the backend inserts defaults), so no defaults are repeated here.
function populateSettingsForm() {
  for (const [key, id] of SETTINGS_FORM_FIELDS) document.getElementById(id).value = settings[key] ?? '';
  renderLogoPreview();
}

function setupSettingsHandlers() {
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const values = {};
    for (const [key, id] of SETTINGS_FORM_FIELDS) values[key] = document.getElementById(id).value;
    try {
      // validated and saved together: either every value is stored or none is
      await window.api.settings.saveMany(values);
    } catch (err) {
      alert(userMessage(err));
      return;
    } finally {
      settings = await window.api.settings.get();
    }
    renderProductGrid();
    renderSidebarBrand();
    updateLowStockBadge();
    alert('تم حفظ الإعدادات');
  });

  document.getElementById('addCategoryBtn').addEventListener('click', async () => {
    const name = document.getElementById('catName').value.trim();
    if (!name) return;
    try {
      await window.api.categories.save(name, document.getElementById('catIsKitchen').checked);
    } catch (err) {
      alert(userMessage(err));
      return;
    }
    categories = await window.api.categories.list();
    renderCategorySelect();
    document.getElementById('catName').value = '';
    alert('تمت إضافة الفئة');
  });
}

// Same rows, in the same order, as the PDF report and the Excel export.
function summaryRows(summary) {
  const currency = settings.currency || '';
  const money = (n) => `${n.toFixed(2)} ${currency}`;
  return [
    ['عدد الفواتير', summary.invoiceCount],
    ['إجمالي المبيعات قبل الخصم', money(summary.grossSales)],
    ['الخصومات', money(summary.totalDiscount)],
    ['المرتجعات (شاملة الضريبة)', money(summary.totalReturns)],
    ['صافي المبيعات (بدون ضريبة)', money(summary.netSales)],
    ['صافي الضريبة', money(summary.netTax)],
    ['الصافي شامل الضريبة', money(summary.netTotal)],
    ['التكلفة', money(summary.totalCost)],
    ['صافي الربح', money(summary.profit), true],
  ];
}

function setupReportsHandlers() {
  document.getElementById('loadReportBtn').addEventListener('click', async () => {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    const summary = await window.api.reports.summary(from, to);
    const currency = settings.currency || '';
    const box = document.getElementById('reportResults');

    box.innerHTML = `
      <div class="card-box" style="max-width:700px;">
        ${summaryRows(summary).map(([label, value, strong]) => `
          <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;${strong ? 'font-weight:bold;color:var(--accent);' : ''}"><span>${label}</span><span>${value}</span></div>
        `).join('')}
      </div>
      <h3>الأكثر مبيعًا</h3>
      <table>
        <thead><tr><th>المنتج</th><th>الكمية المباعة</th><th>الإيراد</th></tr></thead>
        <tbody>
          ${summary.topProducts.map((p) => `
            <tr><td>${escapeHtml(p.name)}</td><td>${p.qty_sold}</td><td>${p.revenue.toFixed(2)}</td></tr>
          `).join('')}
        </tbody>
      </table>
    `;
  });

  document.getElementById('exportPdfBtn').addEventListener('click', async () => {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    if (!from || !to) { alert('اختر الفترة أولاً'); return; }
    const filePath = await window.api.reports.exportPdf(from, to);
    if (filePath) alert('تم حفظ التقرير: ' + filePath);
  });

  document.getElementById('exportExcelBtn').addEventListener('click', async () => {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    if (!from || !to) { alert('اختر الفترة أولاً'); return; }
    const filePath = await window.api.reports.exportExcel(from, to);
    if (filePath) alert('تم حفظ التقرير: ' + filePath);
  });
}

let usersList = [];

async function refreshUsersTable() {
  const users = await window.api.users.list();
  usersList = users;
  const body = document.getElementById('usersTableBody');
  body.innerHTML = users.map((u) => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'admin' ? 'مدير' : 'كاشير'}</td>
      <td>${u.is_active ? 'مفعل' : 'موقوف'}</td>
      <td>
        <button class="secondary" data-toggle-user="${u.id}" data-active="${u.is_active}">
          ${u.is_active ? 'إيقاف' : 'تفعيل'}
        </button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-toggle-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.toggleUser);
      const isActive = btn.dataset.active === '1';
      try {
        await window.api.users.setActive(id, !isActive);
      } catch (err) {
        alert(userMessage(err));
      }
      await refreshUsersTable();
    });
  });
}

function setupUsersHandlers() {
  // The role dropdown defaults to "cashier", so for an existing user its value only counts
  // as a new role when the admin actually changed it.
  let roleChangedByUser = false;
  document.getElementById('uRole').addEventListener('change', () => { roleChangedByUser = true; });

  document.getElementById('saveUserBtn').addEventListener('click', async () => {
    const username = document.getElementById('uUsername').value.trim();
    const pin = document.getElementById('uPin').value.trim();
    const role = document.getElementById('uRole').value;
    if (!username || !pin) { alert('اسم المستخدم والرقم السري مطلوبان'); return; }
    // Saving an existing username updates that user's PIN, and their role only if it was changed.
    const existing = usersList.find((u) => u.username === username);
    const payload = existing
      ? { id: existing.id, username, pin, ...(roleChangedByUser ? { role } : {}) }
      : { username, pin, role };
    try {
      await window.api.users.save(payload);
    } catch (err) {
      alert(userMessage(err));
      return;
    }
    roleChangedByUser = false;
    document.getElementById('uUsername').value = '';
    document.getElementById('uPin').value = '';
    await refreshUsersTable();
    alert('تم حفظ المستخدم');
  });
}

async function setupBackupHandlers() {
  const dbPath = await window.api.backup.currentPath();
  document.getElementById('dbPathText').textContent = 'مكان قاعدة البيانات الحالية: ' + dbPath;

  document.getElementById('createBackupBtn').addEventListener('click', async () => {
    const filePath = await window.api.backup.create();
    if (filePath) alert('تم حفظ النسخة الاحتياطية في:\n' + filePath);
  });

  document.getElementById('restoreBackupBtn').addEventListener('click', async () => {
    await window.api.backup.restore();
  });
}

function setupLogoHandlers() {
  const fileInput = document.getElementById('logoFileInput');
  const previewBox = document.getElementById('logoPreviewBox');
  let pendingDataUrl = null;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingDataUrl = reader.result;
      previewBox.innerHTML = `<img src="${pendingDataUrl}" style="max-height:70px;" />`;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('saveLogoBtn').addEventListener('click', async () => {
    if (!pendingDataUrl) { alert('اختر صورة الشعار أولاً'); return; }
    try {
      await window.api.settings.save('logo_data_url', pendingDataUrl);
    } catch (err) {
      alert(userMessage(err));
      return;
    }
    pendingDataUrl = null;
    fileInput.value = '';
    settings = await window.api.settings.get();
    renderSidebarBrand();
    renderLogoPreview();
    alert('تم حفظ الشعار');
  });

  document.getElementById('removeLogoBtn').addEventListener('click', async () => {
    if (!confirm('هل تريد إزالة الشعار؟ سيظهر اسم المتجر بدلًا منه.')) return;
    try {
      await window.api.settings.save('logo_data_url', '');
    } catch (err) {
      alert(userMessage(err));
      return;
    }
    pendingDataUrl = null;
    fileInput.value = '';
    settings = await window.api.settings.get();
    renderSidebarBrand();
    renderLogoPreview();
    alert('تمت إزالة الشعار');
  });
}

async function showAbout() {
  const info = await window.api.app.info();
  document.getElementById('aboutText').innerHTML =
    `${escapeHtml(info.name)} — الإصدار <bdi dir="ltr">${escapeHtml(info.version)}</bdi>`;
}

function setupDayCloseHandlers() {
  document.getElementById('loadDayCloseBtn').addEventListener('click', async () => {
    const date = document.getElementById('dayCloseDate').value;
    if (!date) { alert('اختر التاريخ أولاً'); return; }
    const closing = await window.api.reports.dailyClosing(date);
    const currency = settings.currency || '';
    document.getElementById('dayCloseResults').innerHTML = `
      <div class="card-box" style="max-width:500px;">
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;"><span>عدد الفواتير</span><span>${closing.invoiceCount}</span></div>
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;"><span>مبيعات نقدًا</span><span>${closing.cash.toFixed(2)} ${currency}</span></div>
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;"><span>مبيعات بطاقة</span><span>${closing.card.toFixed(2)} ${currency}</span></div>
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;"><span>الخصومات</span><span>${closing.discount.toFixed(2)} ${currency}</span></div>
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;"><span>الضريبة</span><span>${closing.tax.toFixed(2)} ${currency}</span></div>
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;"><span>المرتجعات</span><span>${closing.returns.toFixed(2)} ${currency}</span></div>
        <div class="row" style="display:flex;justify-content:space-between;margin:6px 0;font-weight:bold;color:var(--accent);"><span>الصافي</span><span>${closing.netTotal.toFixed(2)} ${currency}</span></div>
      </div>
    `;
  });

  document.getElementById('printDayCloseBtn').addEventListener('click', async () => {
    const date = document.getElementById('dayCloseDate').value;
    if (!date) { alert('اختر التاريخ أولاً'); return; }
    try {
      await window.api.print.dayClose(date);
    } catch (err) {
      alert(userMessage(err));
    }
  });
}


init();
