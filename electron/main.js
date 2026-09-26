const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const backup = require('./backup.js');
const v = require('./validation.js');

let store;
let mainWindow;
let kitchenWindow;
// Id of the logged-in user. The user row is re-read from the database on every
// request (see authorize), so role changes and deactivation apply immediately.
let sessionUserId = null;

// User-facing product name (Arabic UI); Windows installs it as "Cashier System" (productName).
const PRODUCT_NAME = 'سيستم كاشير';

const rendererDir = path.join(__dirname, '..', 'renderer');
const appIconPath = path.join(rendererDir, 'assets', 'app-icon.png');

// DevTools give full access to window.api, so they only exist in development builds.
function secureWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    devTools: !app.isPackaged,
  };
}

// Switches that would let someone attach a debugger to the app. The matching Node
// options (--inspect, NODE_OPTIONS, ELECTRON_RUN_AS_NODE) are disabled with Electron
// fuses at package time (scripts/after-pack-fuses.js).
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'];

// True only for the app's own bundled pages (file:// URLs inside the renderer folder).
function isAppPageUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  let filePath;
  try {
    filePath = fileURLToPath(url);
  } catch {
    return false;
  }
  const rel = path.relative(rendererDir, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: PRODUCT_NAME,
    icon: appIconPath,
    webPreferences: secureWebPreferences(),
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login.html'));
}

function createKitchenWindow() {
  if (kitchenWindow) {
    kitchenWindow.focus();
    return;
  }
  kitchenWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: `شاشة المطبخ - ${PRODUCT_NAME}`,
    icon: appIconPath,
    webPreferences: secureWebPreferences(),
  });
  kitchenWindow.loadFile(path.join(__dirname, '..', 'renderer', 'kitchen.html'));
  kitchenWindow.on('closed', () => {
    kitchenWindow = null;
  });
}

// Electron reports print failures in English ('cancelled', 'failed', ...).
function printError(reason) {
  if (!reason || reason === 'cancelled') return new Error('تم إلغاء الطباعة');
  console.error('[print] failed:', reason);
  return new Error('تعذرت الطباعة. تأكد من توصيل الطابعة وتشغيلها ثم حاول مرة أخرى.');
}

function printReceipt(saleId) {
  return new Promise((resolve, reject) => {
    const receiptWindow = new BrowserWindow({
      width: 380,
      height: 600,
      show: false,
      webPreferences: secureWebPreferences(),
    });
    receiptWindow.loadFile(path.join(__dirname, '..', 'renderer', 'receipt.html'), {
      query: { saleId: String(saleId) },
    });
    receiptWindow.webContents.on('did-finish-load', () => {
      receiptWindow.webContents.print({ silent: false }, (success, reason) => {
        receiptWindow.close();
        if (success) resolve(true);
        else reject(printError(reason));
      });
    });
  });
}

function printDayClose(date) {
  return new Promise((resolve, reject) => {
    const closeWindow = new BrowserWindow({
      width: 380,
      height: 600,
      show: false,
      webPreferences: secureWebPreferences(),
    });
    closeWindow.loadFile(path.join(__dirname, '..', 'renderer', 'day-close.html'), {
      query: { date },
    });
    closeWindow.webContents.on('did-finish-load', () => {
      closeWindow.webContents.print({ silent: false }, (success, reason) => {
        closeWindow.close();
        if (success) resolve(true);
        else reject(printError(reason));
      });
    });
  });
}

async function exportReportPdf(fromDate, toDate) {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ التقرير كـ PDF',
    defaultPath: `تقرير-${fromDate}-الى-${toDate}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;

  const reportWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    webPreferences: secureWebPreferences(),
  });

  await reportWindow.loadFile(path.join(__dirname, '..', 'renderer', 'report-print.html'), {
    query: { from: fromDate, to: toDate },
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const pdfBuffer = await reportWindow.webContents.printToPDF({ printBackground: true });
  fs.writeFileSync(filePath, pdfBuffer);
  reportWindow.close();
  return filePath;
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function createBackup() {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ نسخة احتياطية',
    defaultPath: `cashier-system-backup-${localDate()}.db`,
    filters: [{ name: 'SQLite Database', extensions: ['db'] }],
  });
  if (canceled || !filePath) return null;

  store.flushToDisk();
  fs.copyFileSync(store.dbPath, filePath);
  return filePath;
}

async function restoreBackup() {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'اختيار ملف النسخة الاحتياطية',
    filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return false;

  // Validate a staged copy first; nothing about the live database changes until it passes.
  let stagedPath;
  try {
    stagedPath = backup.stageRestore(filePaths[0], store.dbPath);
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'تعذرت الاستعادة',
      message: 'لم يتم تغيير أي بيانات. ' + (err instanceof backup.BackupValidationError ? err.message : 'تعذر قراءة الملف المختار.'),
    });
    return false;
  }

  const confirmed = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['إلغاء', 'استعادة'],
    defaultId: 0,
    cancelId: 0,
    title: 'تأكيد الاستعادة',
    message: 'سيتم استبدال جميع البيانات الحالية ببيانات النسخة الاحتياطية، ثم يُعاد تشغيل البرنامج. هل تريد المتابعة؟\n\nسيتم حفظ نسخة أمان من البيانات الحالية قبل الاستعادة.',
  });
  if (confirmed.response !== 1) {
    backup.discardStaged(stagedPath);
    return false;
  }

  // Preferred: a validated copy of the current data. If the current database is damaged and
  // cannot be copied, recovery from the (already validated) backup still goes ahead; the
  // damaged files are then quarantined instead of overwritten.
  let safetyPath = null;
  try {
    safetyPath = await backup.createSafetyBackup(store.db, store.dbPath);
  } catch {
    safetyPath = null;
  }

  try {
    store.db.close();
  } catch {
    // A damaged database may fail to close cleanly; its files are handled below either way.
  }

  let quarantineDir = null;
  try {
    if (safetyPath) {
      backup.swapInStaged(stagedPath, store.dbPath);
    } else {
      quarantineDir = backup.quarantineLiveDb(store.dbPath);
      try {
        backup.installStaged(stagedPath, store.dbPath);
      } catch (err) {
        backup.releaseQuarantine(quarantineDir, store.dbPath);
        quarantineDir = null;
        throw err;
      }
    }
  } catch {
    // Every step above is a rename: on failure the original database is back in place.
    backup.discardStaged(stagedPath);
    dialog.showErrorBox('تعذرت الاستعادة', 'لم يتم تغيير البيانات.'
      + (safetyPath ? '\nنسخة الأمان محفوظة في:\n' + safetyPath : '') + '\nسيتم إعادة تشغيل البرنامج.');
    app.relaunch();
    app.exit(0);
    return false;
  }

  if (quarantineDir) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'تمت الاستعادة',
      message: 'تمت الاستعادة بنجاح. قاعدة البيانات السابقة كانت تالفة ولم يمكن أخذ نسخة أمان منها، '
        + 'لذلك تم نقل ملفاتها كما هي إلى:\n' + quarantineDir + '\nسيتم إعادة تشغيل البرنامج.',
    });
  }

  app.relaunch();
  app.exit(0);
  return true;
}

async function exportReportExcel(fromDate, toDate) {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ التقرير كـ Excel',
    defaultPath: `تقرير-${fromDate}-الى-${toDate}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (canceled || !filePath) return null;

  const rows = store.getSalesDetailRows(fromDate, toDate);
  const summary = store.getSalesSummary(fromDate, toDate);

  const workbook = new ExcelJS.Workbook();

  const summarySheet = workbook.addWorksheet('الملخص');
  summarySheet.views = [{ rightToLeft: true }];
  const settings = store.getSettings();
  summarySheet.addRows([
    ['المتجر', settings.store_name || ''],
    ['الفترة', `${fromDate} إلى ${toDate}`],
    ['عدد الفواتير', summary.invoiceCount],
    ['إجمالي المبيعات قبل الخصم', summary.grossSales],
    ['الخصومات', summary.totalDiscount],
    ['المرتجعات (شاملة الضريبة)', summary.totalReturns],
    ['صافي المبيعات (بدون ضريبة)', summary.netSales],
    ['صافي الضريبة', summary.netTax],
    ['الصافي شامل الضريبة', summary.netTotal],
    ['التكلفة', summary.totalCost],
    ['صافي الربح', summary.profit],
  ]);

  const detailSheet = workbook.addWorksheet('تفاصيل المبيعات');
  detailSheet.views = [{ rightToLeft: true }];
  detailSheet.addRow(['التاريخ', 'رقم الفاتورة', 'الكاشير', 'الصنف', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'طريقة الدفع']);
  for (const r of rows) {
    detailSheet.addRow([
      r.created_at, r.sale_number, r.cashier_name || '-', r.product_name,
      r.qty, r.unit_price, r.line_total, r.payment_method === 'cash' ? 'نقدًا' : 'بطاقة',
    ]);
  }
  detailSheet.columns.forEach((col) => { col.width = 18; });

  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

// Renderer windows may only show the app's own pages: no navigation elsewhere and no pop-ups,
// so no foreign content ever runs with the preload's window.api.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isAppPageUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppPageUrl(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  if (app.isPackaged) {
    contents.on('devtools-opened', () => contents.closeDevTools());
  }
});

app.whenReady().then(() => {
  if (app.isPackaged && DEBUG_SWITCHES.some((sw) => app.commandLine.hasSwitch(sw))) {
    app.exit(1);
    return;
  }
  store = require('./db.js');
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC access control ----------
// Every handler declares who may call it. The check runs here in the main process,
// so hiding buttons in the UI is no longer the only thing standing in the way.
const Access = {
  PUBLIC: 'public', // login screen
  PENDING: 'pending', // logged in, possibly still required to change the PIN
  USER: 'user', // any logged-in user (cashier or admin)
  ADMIN: 'admin',
  KITCHEN: 'kitchen', // the kitchen window, or any logged-in user
};

class AccessDeniedError extends Error {}

function isTrustedSender(event) {
  return !!event.senderFrame && isAppPageUrl(event.senderFrame.url);
}

function sessionUser() {
  if (sessionUserId == null) return null;
  const user = store.getActiveUser(sessionUserId);
  if (!user) sessionUserId = null;
  return user;
}

function authorize(access, event) {
  if (!isTrustedSender(event)) throw new AccessDeniedError('طلب غير مصرح به');
  if (access === Access.PUBLIC) return sessionUser();
  if (access === Access.KITCHEN && kitchenWindow && event.sender === kitchenWindow.webContents) return sessionUser();

  const user = sessionUser();
  if (!user) throw new AccessDeniedError('يجب تسجيل الدخول أولاً');
  if (access === Access.PENDING) return user;
  if (user.mustChangePin) throw new AccessDeniedError('يجب تغيير الرقم السري أولاً');
  if (access === Access.ADMIN && user.role !== 'admin') throw new AccessDeniedError('هذه العملية متاحة للمدير فقط');
  return user;
}

// ---------- Errors shown to users ----------
// Every IPC failure reaches the renderer as an Arabic message the user can act on. Expected
// errors (validation, permissions, backup checks, or any message already written in Arabic) pass
// through; database constraint errors are translated; anything else is logged here with full
// details for diagnostics and replaced by a generic message.
const ARABIC_RE = /[\u0600-\u06ff]/;
const DATABASE_MESSAGES = [
  [/UNIQUE constraint failed: products\.barcode/, 'الباركود مستخدم لمنتج آخر'],
  [/UNIQUE constraint failed: users\.username/, 'اسم المستخدم مستخدم بالفعل'],
  [/UNIQUE constraint failed: categories\.name/, 'اسم الفئة موجود بالفعل'],
  [/FOREIGN KEY constraint failed/, 'لا يمكن تنفيذ العملية لارتباطها ببيانات أخرى'],
];
const GENERIC_ERROR = 'حدث خطأ غير متوقع. حاول مرة أخرى، وإذا تكرر الخطأ تواصل مع الدعم الفني.';

function toUserError(channel, err) {
  const message = err && err.message ? String(err.message) : String(err);
  for (const [re, text] of DATABASE_MESSAGES) if (re.test(message)) return new Error(text);
  if (err instanceof v.ValidationError || err instanceof AccessDeniedError
    || err instanceof backup.BackupValidationError || ARABIC_RE.test(message)) {
    return new Error(message);
  }
  console.error(`[ipc] ${channel} failed:`, err);
  return new Error(GENERIC_ERROR);
}

function handle(channel, access, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const user = authorize(access, event);
      return await fn(user, ...args);
    } catch (err) {
      throw toUserError(channel, err);
    }
  });
}

// ---------- Login throttling ----------
// After 5 wrong PINs in a row for a username, that username cannot log in for 30 seconds, so a
// PIN cannot be found by trying values quickly at the login screen.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 30 * 1000;
const loginFailures = new Map(); // normalized username -> { count, lockedUntil }

function loginKey(username) {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function assertLoginAllowed(username) {
  const entry = loginFailures.get(loginKey(username));
  if (entry && entry.lockedUntil > Date.now()) {
    const seconds = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    throw new AccessDeniedError(`تم إيقاف تسجيل الدخول لهذا المستخدم مؤقتًا بسبب تكرار الرقم السري الخاطئ. حاول مرة أخرى بعد ${seconds} ثانية.`);
  }
}

function recordLoginResult(username, success) {
  const key = loginKey(username);
  if (success) {
    loginFailures.delete(key);
    return;
  }
  const entry = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) {
    entry.count = 0;
    entry.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
  loginFailures.set(key, entry);
}

// ---------- Management data ----------
// Cost prices and profit are for the store's management: cashiers and the kitchen screen get the
// same data without them.
function isAdmin(user) {
  return !!user && user.role === 'admin';
}

function withoutCost(rows, field) {
  return rows.map(({ [field]: _hidden, ...rest }) => rest);
}

function registerIpcHandlers() {
  handle('auth:login', Access.PUBLIC, (_user, username, pin) => {
    assertLoginAllowed(username);
    const user = store.verifyLogin(username, pin);
    recordLoginResult(username, !!user);
    sessionUserId = user ? user.id : null;
    return user;
  });
  handle('auth:logout', Access.PUBLIC, () => {
    sessionUserId = null;
    if (mainWindow) mainWindow.loadFile(path.join(rendererDir, 'login.html'));
  });
  handle('auth:me', Access.PUBLIC, (user) => user);
  handle('auth:needsSetup', Access.PUBLIC, () => !store.hasAnyUser());
  handle('auth:setupAdmin', Access.PUBLIC, (_user, username, pin, profile) => {
    const user = store.createInitialAdmin(username, pin, profile);
    sessionUserId = user.id;
    return user;
  });
  handle('auth:changePin', Access.PENDING, (user, currentPin, newPin) => store.changeOwnPin(user.id, currentPin, newPin));

  handle('users:list', Access.ADMIN, () => store.getUsers());
  handle('users:save', Access.ADMIN, (_user, user) => store.saveUser(user));
  handle('users:setActive', Access.ADMIN, (_user, id, isActive) => store.setUserActive(id, isActive));

  handle('categories:list', Access.USER, () => store.getCategories());
  handle('categories:save', Access.ADMIN, (_user, name, isKitchen) => store.saveCategory(name, isKitchen));

  handle('products:list', Access.USER, (user) => (isAdmin(user) ? store.getProducts() : withoutCost(store.getProducts(), 'cost')));
  handle('products:save', Access.ADMIN, (_user, product) => store.saveProduct(product));
  handle('products:delete', Access.ADMIN, (_user, id) => store.deleteProduct(id));

  handle('sales:create', Access.USER, (user, payload) => store.createSale({ ...payload, userId: user.id }));
  handle('sales:list', Access.USER, (_user, limit) => store.getSales(limit));
  handle('sales:find', Access.USER, (_user, query) => store.findSales(query));
  handle('sales:items', Access.USER, (user, saleId) => {
    const items = store.getSaleItems(v.positiveId(saleId, 'الفاتورة'));
    return isAdmin(user) ? items : withoutCost(items, 'unit_cost');
  });
  handle('sales:full', Access.USER, (user, saleId) => {
    const full = store.getSaleFull(v.positiveId(saleId, 'الفاتورة'));
    return full && !isAdmin(user) ? { ...full, items: withoutCost(full.items, 'unit_cost') } : full;
  });

  handle('returns:create', Access.USER, (user, payload) => store.createReturn({ ...payload, userId: user.id }));
  handle('returns:forSale', Access.USER, (_user, saleId) => store.getReturnsForSale(v.positiveId(saleId, 'الفاتورة')));

  handle('kitchen:list', Access.KITCHEN, () =>
    store.getKitchenOrders().map((order) => ({ ...order, items: withoutCost(order.items, 'unit_cost') })));
  handle('kitchen:updateStatus', Access.KITCHEN, (_user, saleId, status) => store.updateKitchenStatus(saleId, status));
  handle('kitchen:openWindow', Access.USER, () => createKitchenWindow());

  handle('reports:summary', Access.ADMIN, (_user, fromDate, toDate) =>
    store.getSalesSummary(v.dateString(fromDate), v.dateString(toDate)));
  handle('reports:detailRows', Access.ADMIN, (_user, fromDate, toDate) =>
    store.getSalesDetailRows(v.dateString(fromDate), v.dateString(toDate)));
  handle('reports:exportPdf', Access.ADMIN, (_user, fromDate, toDate) =>
    exportReportPdf(v.dateString(fromDate), v.dateString(toDate)));
  handle('reports:exportExcel', Access.ADMIN, (_user, fromDate, toDate) =>
    exportReportExcel(v.dateString(fromDate), v.dateString(toDate)));
  handle('reports:dailyClosing', Access.USER, (user, date) => {
    const closing = store.getDailyClosing(v.dateString(date));
    if (isAdmin(user)) return closing;
    const { totalCost: _cost, profit: _profit, ...forCashier } = closing;
    return forCashier;
  });

  handle('settings:get', Access.USER, () => store.getSettings());
  handle('settings:save', Access.ADMIN, (_user, key, value) => store.saveSetting(key, value));
  handle('settings:saveMany', Access.ADMIN, (_user, values) => store.saveSettings(values));

  handle('backup:create', Access.ADMIN, () => createBackup());
  handle('backup:restore', Access.ADMIN, () => restoreBackup());
  handle('backup:currentPath', Access.ADMIN, () => store.dbPath);

  handle('print:receipt', Access.USER, (_user, saleId) => printReceipt(v.positiveId(saleId, 'الفاتورة')));
  handle('print:dayClose', Access.USER, (_user, date) => printDayClose(v.dateString(date)));
  handle('print:qr', Access.USER, (_user, text) =>
    QRCode.toDataURL(v.multilineText(text, 'النص', 500), { margin: 0, width: 140 }));

  handle('app:info', Access.USER, () => ({ name: PRODUCT_NAME, version: app.getVersion() }));

  handle('nav:goToApp', Access.USER, () => {
    if (mainWindow) mainWindow.loadFile(path.join(rendererDir, 'index.html'));
  });
}
