'use strict';
/* ============================================================
   4399 账号管理器 · 桌面版外壳（Electron）
   - 复用项目原有的 Node 服务端（server.js），不重写业务逻辑
   - 无边框窗口 + 自绘标题栏（前端 ntqq.css 里那套 winbar）
   - 打包后：服务端代码在 resources/app，数据写到 %APPDATA%/4399账号管理器/data
   ============================================================ */

const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PREFERRED_PORT = Number(process.env.PORT) || 8790;

// 打包后：resources/app 放服务端与静态文件；开发时：项目根目录
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const SHOT_PATH = process.env.SHOT_PATH || '';

let mainWindow = null;
let tray = null;
let serverProc = null;
let serverPort = PREFERRED_PORT;
let quitting = false;

/* ---------------- 数据目录（绿色版：跟随 exe） ---------------- */
let cachedDataDir = null;
function resolveDataDir() {
  if (cachedDataDir) return cachedDataDir;
  if (!app.isPackaged) { cachedDataDir = path.join(APP_ROOT, 'data'); return cachedDataDir; }
  const beside = path.join(path.dirname(process.execPath), 'data');
  try {
    fs.mkdirSync(beside, { recursive: true });
    fs.accessSync(beside, fs.constants.W_OK);
    cachedDataDir = beside;
  } catch (e) {
    cachedDataDir = path.join(app.getPath('userData'), 'data');
  }
  return cachedDataDir;
}

/* ---------------- 图标路径（打包后在 resources 下，不在 asar 里） ---------------- */
function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico');
}

/* ---------------- 端口探测 ---------------- */
function probe(url, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.connect({ port, host: HOST });
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
    s.setTimeout(600, () => { s.destroy(); resolve(true); });
  });
}

async function resolveServer() {
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 20; p++) {
    const free = await isPortFree(p);
    if (free) return { port: p, spawn: true };
    // 端口被占：如果是我们自己的服务（比如网页版已经开着），直接复用
    const r = await probe(`http://${HOST}:${p}/api/about`);
    if (r.ok && /4399/.test(r.body)) return { port: p, spawn: false };
  }
  throw new Error('找不到可用端口（8790-8809 全被占用）');
}

/* ---------------- 启动本地服务 ---------------- */
function startServer(port) {
  const entry = path.join(APP_ROOT, 'server.js');
  if (!fs.existsSync(entry)) throw new Error('找不到服务端文件：' + entry);

  const env = Object.assign({}, process.env, {
    PORT: String(port),
    // 用 Electron 自带的 Node 跑服务端，用户不需要另外装 Node.js
    ELECTRON_RUN_AS_NODE: '1',
  });
  // 绿色版：数据默认放在 exe 旁边的 data/（拷走文件夹 = 连账号一起搬走）
  // 目录不可写（比如放在 Program Files）时，退回 %APPDATA%
  env.DATA_DIR = resolveDataDir();

  serverProc = spawn(process.execPath, [entry], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProc.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (!quitting) {
      console.error('[server] 已退出，code=' + code);
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: '本地服务已停止',
          message: '后台服务意外退出（code ' + code + '）',
          detail: '可以关闭本窗口后重新打开程序。若反复出现，请查看 data/errors.log。',
        });
      }
    }
  });
  return serverProc;
}

async function waitReady(port, ms = 20000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const r = await probe(`http://${HOST}:${port}/api/about`, 1200);
    if (r.ok) return true;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  return false;
}

/* ---------------- 窗口状态记忆 ---------------- */
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && Number.isFinite(s.width) && Number.isFinite(s.height)) return s;
  } catch (e) { }
  return { width: 1360, height: 860 };
}
function saveState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: mainWindow.isMaximized() }), 'utf8');
  } catch (e) { }
}

/* ---------------- 主窗口 ---------------- */
function createWindow(port) {
  const st = loadState();
  const icoPath = iconPath();

  mainWindow = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: Number.isFinite(st.x) ? st.x : undefined,
    y: Number.isFinite(st.y) ? st.y : undefined,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,                 // 无边框：标题栏由前端 ntqq.css 自绘
    backgroundColor: '#101317',
    icon: fs.existsSync(icoPath) ? icoPath : undefined,
    title: '4399 账号管理器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  // 验证用：SHOT_PATH 环境变量 -> 截图后自动退出（必须在 loadURL 前注册，否则可能错过事件）
  if (SHOT_PATH) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(SHOT_PATH, img.toPNG());
          console.log('[shot] saved ' + SHOT_PATH);
        } catch (e) { console.error('[shot] fail', e); }
        quitting = true;
        app.quit();
      }, 4000);
    });
  }

  // 截图验证时跳过启动动画，直接看主界面
  mainWindow.loadURL(`http://${HOST}:${port}/${SHOT_PATH ? '?nosplash=1' : ''}`);

  mainWindow.once('ready-to-show', () => {
    if (st.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  const notify = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', notify);
  mainWindow.on('unmaximize', notify);
  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);
  mainWindow.on('close', (e) => {
    saveState();
    if (!quitting && tray) {      // 有托盘时：关窗口 = 收进托盘
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外链走系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

}

/* ---------------- 托盘 ---------------- */
function createTray() {
  const icoPath = iconPath();
  if (!fs.existsSync(icoPath)) return;
  try {
    const img = nativeImage.createFromPath(icoPath);
    if (img.isEmpty()) return;
    tray = new Tray(img);
    tray.setToolTip('4399 账号管理器');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { if (mainWindow) { mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); } });
  } catch (e) { /* 托盘失败不影响主流程 */ }
}

/* ---------------- IPC：自绘标题栏的窗口按钮 ---------------- */
ipcMain.on('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win:toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win:close', () => {
  if (!mainWindow) return;
  if (tray) { mainWindow.hide(); } else { quitting = true; app.quit(); }
});
ipcMain.handle('win:is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
ipcMain.handle('app:open-data-dir', () => {
  const dir = resolveDataDir();
  try { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } catch (e) { }
  return dir;
});

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      const s = await resolveServer();
      serverPort = s.port;
      if (s.spawn) startServer(serverPort);
      const ok = await waitReady(serverPort);
      if (!ok) {
        dialog.showErrorBox('启动失败', '本地服务没有在 20 秒内就绪，请检查是否被杀毒软件拦截。');
      }
      createWindow(serverPort);
      createTray();
    } catch (e) {
      dialog.showErrorBox('启动失败', String((e && e.message) || e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { quitting = true; app.quit(); }
  });

  app.on('before-quit', () => { quitting = true; });

  app.on('quit', () => {
    if (serverProc) { try { serverProc.kill(); } catch (e) { } }
  });
}
