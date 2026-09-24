const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');

let store;
let mainWindow;
let kitchenWindow;
let currentUser = null;

const appIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'app-icon.png');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'سيستم كاشير',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
    title: 'شاشة المطبخ - سيستم كاشير',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  kitchenWindow.loadFile(path.join(__dirname, '..', 'renderer', 'kitchen.html'));
  kitchenWindow.on('closed', () => {
    kitchenWindow = null;
  });
}

function printReceipt(saleId) {
  return new Promise((resolve, reject) => {
    const receiptWindow = new BrowserWindow({
      width: 380,
      height: 600,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    receiptWindow.loadFile(path.join(__dirname, '..', 'renderer', 'receipt.html'), {
      query: { saleId: String(saleId) },
    });
    receiptWindow.webContents.on('did-finish-load', () => {
      receiptWindow.webContents.print({ silent: false }, (success, reason) => {
        receiptWindow.close();
        if (success) resolve(true);
        else reject(new Error(reason || 'تم إلغاء الطباعة'));
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
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    closeWindow.loadFile(path.join(__dirname, '..', 'renderer', 'day-close.html'), {
      query: { date },
    });
    closeWindow.webContents.on('did-finish-load', () => {
      closeWindow.webContents.print({ silent: false }, (success, reason) => {
        closeWindow.close();
        if (success) resolve(true);
        else reject(new Error(reason || 'تم إلغاء الطباعة'));
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

async function createBackup() {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ نسخة احتياطية',
    defaultPath: `smart-pos-backup-${new Date().toISOString().slice(0, 10)}.db`,
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

  const confirmed = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['إلغاء', 'استعادة'],
    defaultId: 0,
    cancelId: 0,
    title: 'تأكيد الاستعادة',
    message: 'هيتم استبدال كل البيانات الحالية ببيانات النسخة الاحتياطية، وهيقفل البرنامج ويفتح تاني. متأكد؟',
  });
  if (confirmed.response !== 1) return false;

  store.db.close();
  fs.copyFileSync(filePaths[0], store.dbPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = store.dbPath + suffix;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
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
  summarySheet.addRows([
    ['الفترة', `${fromDate} إلى ${toDate}`],
    ['عدد الفواتير', summary.invoiceCount],
    ['إجمالي المبيعات', summary.grossSales],
    ['إجمالي المرتجعات', summary.totalReturns],
    ['صافي المبيعات', summary.netSales],
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

app.whenReady().then(() => {
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

function registerIpcHandlers() {
  ipcMain.handle('auth:login', (_e, username, pin) => {
    const user = store.verifyLogin(username, pin);
    if (user) currentUser = user;
    return user;
  });
  ipcMain.handle('auth:logout', () => {
    currentUser = null;
    if (mainWindow) mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login.html'));
  });
  ipcMain.handle('auth:me', () => currentUser);

  ipcMain.handle('users:list', () => store.getUsers());
  ipcMain.handle('users:save', (_e, user) => store.saveUser(user));
  ipcMain.handle('users:setActive', (_e, id, isActive) => store.setUserActive(id, isActive));

  ipcMain.handle('categories:list', () => store.getCategories());
  ipcMain.handle('categories:save', (_e, name, isKitchen) => store.saveCategory(name, isKitchen));

  ipcMain.handle('products:list', () => store.getProducts());
  ipcMain.handle('products:save', (_e, product) => store.saveProduct(product));
  ipcMain.handle('products:delete', (_e, id) => store.deleteProduct(id));

  ipcMain.handle('sales:create', (_e, payload) => store.createSale({ ...payload, userId: currentUser?.id }));
  ipcMain.handle('sales:list', (_e, limit) => store.getSales(limit));
  ipcMain.handle('sales:items', (_e, saleId) => store.getSaleItems(saleId));
  ipcMain.handle('sales:full', (_e, saleId) => store.getSaleFull(saleId));

  ipcMain.handle('returns:create', (_e, payload) => store.createReturn({ ...payload, userId: currentUser?.id }));
  ipcMain.handle('returns:forSale', (_e, saleId) => store.getReturnsForSale(saleId));

  ipcMain.handle('kitchen:list', () => store.getKitchenOrders());
  ipcMain.handle('kitchen:updateStatus', (_e, saleId, status) => store.updateKitchenStatus(saleId, status));
  ipcMain.handle('kitchen:openWindow', () => createKitchenWindow());

  ipcMain.handle('reports:summary', (_e, fromDate, toDate) => store.getSalesSummary(fromDate, toDate));
  ipcMain.handle('reports:detailRows', (_e, fromDate, toDate) => store.getSalesDetailRows(fromDate, toDate));
  ipcMain.handle('reports:exportPdf', (_e, fromDate, toDate) => exportReportPdf(fromDate, toDate));
  ipcMain.handle('reports:exportExcel', (_e, fromDate, toDate) => exportReportExcel(fromDate, toDate));
  ipcMain.handle('reports:dailyClosing', (_e, date) => store.getDailyClosing(date));

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:save', (_e, key, value) => store.saveSetting(key, value));

  ipcMain.handle('backup:create', () => createBackup());
  ipcMain.handle('backup:restore', () => restoreBackup());
  ipcMain.handle('backup:currentPath', () => store.dbPath);

  ipcMain.handle('print:receipt', (_e, saleId) => printReceipt(saleId));
  ipcMain.handle('print:dayClose', (_e, date) => printDayClose(date));
  ipcMain.handle('print:qr', (_e, text) => QRCode.toDataURL(text, { margin: 0, width: 140 }));

  ipcMain.handle('nav:goToApp', () => {
    if (mainWindow) mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  });
}
