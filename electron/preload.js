const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  auth: {
    login: (username, pin) => ipcRenderer.invoke('auth:login', username, pin),
    logout: () => ipcRenderer.invoke('auth:logout'),
    me: () => ipcRenderer.invoke('auth:me'),
    needsSetup: () => ipcRenderer.invoke('auth:needsSetup'),
    setupAdmin: (username, pin, profile) => ipcRenderer.invoke('auth:setupAdmin', username, pin, profile),
    changePin: (currentPin, newPin) => ipcRenderer.invoke('auth:changePin', currentPin, newPin),
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    save: (user) => ipcRenderer.invoke('users:save', user),
    setActive: (id, isActive) => ipcRenderer.invoke('users:setActive', id, isActive),
  },
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
    save: (name, isKitchen) => ipcRenderer.invoke('categories:save', name, isKitchen),
  },
  products: {
    list: () => ipcRenderer.invoke('products:list'),
    save: (product) => ipcRenderer.invoke('products:save', product),
    delete: (id) => ipcRenderer.invoke('products:delete', id),
  },
  sales: {
    create: (payload) => ipcRenderer.invoke('sales:create', payload),
    list: (limit) => ipcRenderer.invoke('sales:list', limit),
    items: (saleId) => ipcRenderer.invoke('sales:items', saleId),
    full: (saleId) => ipcRenderer.invoke('sales:full', saleId),
  },
  returns: {
    create: (payload) => ipcRenderer.invoke('returns:create', payload),
    forSale: (saleId) => ipcRenderer.invoke('returns:forSale', saleId),
  },
  kitchen: {
    list: () => ipcRenderer.invoke('kitchen:list'),
    updateStatus: (saleId, status) => ipcRenderer.invoke('kitchen:updateStatus', saleId, status),
    openWindow: () => ipcRenderer.invoke('kitchen:openWindow'),
  },
  reports: {
    summary: (fromDate, toDate) => ipcRenderer.invoke('reports:summary', fromDate, toDate),
    detailRows: (fromDate, toDate) => ipcRenderer.invoke('reports:detailRows', fromDate, toDate),
    exportPdf: (fromDate, toDate) => ipcRenderer.invoke('reports:exportPdf', fromDate, toDate),
    exportExcel: (fromDate, toDate) => ipcRenderer.invoke('reports:exportExcel', fromDate, toDate),
    dailyClosing: (date) => ipcRenderer.invoke('reports:dailyClosing', date),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (key, value) => ipcRenderer.invoke('settings:save', key, value),
    saveMany: (values) => ipcRenderer.invoke('settings:saveMany', values),
  },
  backup: {
    create: () => ipcRenderer.invoke('backup:create'),
    restore: () => ipcRenderer.invoke('backup:restore'),
    currentPath: () => ipcRenderer.invoke('backup:currentPath'),
  },
  print: {
    receipt: (saleId) => ipcRenderer.invoke('print:receipt', saleId),
    dayClose: (date) => ipcRenderer.invoke('print:dayClose', date),
    qr: (text) => ipcRenderer.invoke('print:qr', text),
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
  nav: {
    goToApp: () => ipcRenderer.invoke('nav:goToApp'),
  },
});
