// Loads the real electron/main.js + electron/db.js in plain Node with a fake `electron`
// module, so IPC handlers can be invoked exactly as the renderer would invoke them.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

let fakeElectron = null;
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

function clearAppModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(ROOT, 'electron'))) delete require.cache[key];
  }
}

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smart-pos-test-'));
}

// Boots the app (like a fresh process start) against the given data directory.
async function boot({ home, isPackaged = false, switches = [] } = {}) {
  clearAppModules();
  const handlers = new Map();
  const appListeners = new Map();
  const windows = [];
  const dialogQueue = { open: [], save: [], message: [] };
  const state = { exitCode: null, relaunched: false, errorBoxes: [], messageBoxes: [] };

  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.webContents = {
        on() {},
        print(_o, cb) { cb(true); },
        printToPDF: async () => Buffer.from('%PDF'),
      };
      windows.push(this);
    }
    loadFile(file) { this.loadedFile = file; return Promise.resolve(); }
    focus() {}
    on() {}
    close() {}
    static getAllWindows() { return windows; }
  }

  fakeElectron = {
    app: {
      isPackaged,
      getPath: (name) => path.join(home, name),
      whenReady: () => Promise.resolve(),
      on: (name, fn) => appListeners.set(name, fn),
      relaunch: () => { state.relaunched = true; },
      exit: (code) => { state.exitCode = code; },
      quit: () => {},
      commandLine: { hasSwitch: (name) => switches.includes(name) },
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: {
      showOpenDialog: async () => dialogQueue.open.shift() || { canceled: true, filePaths: [] },
      showSaveDialog: async () => dialogQueue.save.shift() || { canceled: true },
      showMessageBox: async (_w, opts) => {
        state.messageBoxes.push(opts);
        return dialogQueue.message.shift() || { response: 0 };
      },
      showErrorBox: (title, msg) => state.errorBoxes.push({ title, msg }),
    },
  };

  require(path.join(ROOT, 'electron', 'main.js'));
  await new Promise((r) => setImmediate(r));

  const pageEvent = (page = 'index.html') => ({
    senderFrame: { url: pathToFileURL(path.join(RENDERER, page)).href },
    sender: {},
  });

  async function call(channel, ...args) {
    return callFrom(pageEvent(), channel, ...args);
  }
  async function callFrom(event, channel, ...args) {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('no handler for ' + channel);
    return fn(event, ...args);
  }

  const store = handlers.size > 0 ? require(path.join(ROOT, 'electron', 'db.js')) : null;
  return { handlers, appListeners, windows, dialogQueue, state, call, callFrom, pageEvent, store };
}

function shutdown(ctx) {
  try {
    if (ctx.store && ctx.store.db.open) ctx.store.db.close();
  } catch {
    // already closed
  }
}

// The product ships with an empty catalog; tests that need products create this fixture
// (as an admin) instead: kitchen and non-kitchen categories, tracked and untracked stock.
async function addTestCatalog(ctx) {
  const food = await ctx.call('categories:save', 'مأكولات', true);
  const drinks = await ctx.call('categories:save', 'مشروبات', true);
  const general = await ctx.call('categories:save', 'عام', false);
  const items = [
    ['برجر لحم', '1001', food, 85, 45, 0, false],
    ['بيتزا مارجريتا', '1002', food, 120, 60, 0, false],
    ['بطاطس مقلية', '1003', food, 35, 15, 0, false],
    ['عصير برتقال', '2001', drinks, 25, 10, 40, true],
    ['مياه معدنية', '2002', drinks, 10, 4, 100, true],
    ['قهوة تركي', '2003', drinks, 20, 8, 0, false],
    ['منتج عام', '3001', general, 15, 7, 25, true],
  ];
  for (const [name, barcode, category_id, price, cost, stock_qty, track_stock] of items) {
    await ctx.call('products:save', { name, barcode, category_id, price, cost, stock_qty, track_stock });
  }
}

module.exports = { boot, shutdown, makeTempHome, clearAppModules, addTestCatalog, ROOT, setFakeElectron: (e) => { fakeElectron = e; } };
