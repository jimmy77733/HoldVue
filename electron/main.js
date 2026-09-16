'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.HOLDVUE_PORT || 18990);

let mainWindow = null;
let tray = null;
let serviceProc = null;
let topMost = true;
let clickThrough = false;
let opacity = 1.0;

function rootDir() {
  // In dev: repo root. In packaged electron-builder: files live inside app.asar next to electron/
  if (!app.isPackaged) return path.resolve(__dirname, '..');
  return app.getAppPath();
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'window.json');
}

function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (typeof j.topMost === 'boolean') topMost = j.topMost;
    if (typeof j.clickThrough === 'boolean') clickThrough = j.clickThrough;
    if (typeof j.opacity === 'number') {
      opacity = j.opacity > 1 ? j.opacity / 100 : j.opacity;
      opacity = Math.min(1, Math.max(0.35, opacity));
    }
    return j;
  } catch {
    return null;
  }
}

function saveSettings() {
  try {
    const next = {
      x: mainWindow ? Math.round(mainWindow.getBounds().x) : 80,
      y: mainWindow ? Math.round(mainWindow.getBounds().y) : 80,
      w: mainWindow ? Math.round(mainWindow.getBounds().width) : 320,
      h: mainWindow ? Math.round(mainWindow.getBounds().height) : 82,
      topMost,
      clickThrough,
      opacity: Math.round(opacity * 100)
    };
    fs.writeFileSync(settingsPath(), JSON.stringify(next), 'utf8');
  } catch {}
}

function portOpen() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/quotes', timeout: 400 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureService() {
  if (await portOpen()) return;
  const script = path.join(rootDir(), 'services', 'core.js');
  const env = {
    ...process.env,
    HOLDVUE_PORT: String(PORT),
    HOLDVUE_DATA_DIR: path.join(app.getPath('userData'), 'data'),
    ELECTRON_RUN_AS_NODE: '1'
  };
  serviceProc = spawn(process.execPath, [script], {
    cwd: rootDir(),
    stdio: 'ignore',
    windowsHide: true,
    env
  });
  serviceProc.on('exit', () => { serviceProc = null; });
  for (let i = 0; i < 50; i++) {
    if (await portOpen()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function iconPath() {
  const base = rootDir();
  const p = path.join(base, 'assets', process.platform === 'win32' ? 'holdvue.ico' : 'holdvue.png');
  return p;
}

/** Windows 極簡：略過工作列，僅系統匣；macOS 維持 Dock 顯示 */
function applyMiniTaskbar(mini) {
  if (process.platform !== 'win32' || !mainWindow) return;
  mainWindow.setSkipTaskbar(!!mini);
}

function applyClickThrough(on) {
  clickThrough = !!on;
  if (!mainWindow) return;
  try {
    mainWindow.setIgnoreMouseEvents(clickThrough);
  } catch {}
  saveSettings();
  refreshTrayMenu();
}

function createWindow() {
  const saved = loadSettings();
  mainWindow = new BrowserWindow({
    width: saved?.w || 320,
    height: saved?.h || 82,
    x: saved?.x,
    y: saved?.y,
    minWidth: 220,
    minHeight: 60,
    frame: false,
    skipTaskbar: process.platform === 'win32',
    alwaysOnTop: topMost,
    // 關閉系統邊框縮放；改由左下／右下角自訂把手調整
    resizable: false,
    show: false,
    backgroundColor: '#1c1c1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: iconPath()
  });

  mainWindow.setOpacity(opacity);
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/?widget=1`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (clickThrough) applyClickThrough(true);
  });
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      saveSettings();
      mainWindow.hide();
    }
  });
  mainWindow.on('moved', () => saveSettings());
  mainWindow.on('resized', () => saveSettings());
}

function buildMenu(locked) {
  const opacityItems = [100, 90, 80, 70, 60, 50, 40].map((pct) => ({
    label: `${pct}%`,
    type: 'radio',
    checked: Math.round(opacity * 100) === pct,
    click: () => {
      opacity = pct / 100;
      if (mainWindow) mainWindow.setOpacity(opacity);
      saveSettings();
    }
  }));

  const items = [
    { label: locked ? '系統監控' : '極簡浮動視窗', enabled: false },
    { type: 'separator' }
  ];

  if (!locked) {
    items.push({ label: '切換顯示', click: () => mainWindow?.webContents.executeJavaScript("holdvueMenu('toggle')") });
  }

  items.push(
    { label: '切換深淺色', click: () => mainWindow?.webContents.executeJavaScript("holdvueMenu('theme')") },
    {
      label: '永遠置頂',
      type: 'checkbox',
      checked: topMost,
      click: (item) => {
        topMost = item.checked;
        mainWindow?.setAlwaysOnTop(topMost);
        saveSettings();
      }
    },
    {
      label: '左鍵穿透',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => applyClickThrough(item.checked)
    },
    {
      label: '低對比',
      type: 'checkbox',
      checked: false,
      click: () => mainWindow?.webContents.executeJavaScript("holdvueMenu('lowcontrast')")
    },
    { label: '透明度', submenu: opacityItems },
    { type: 'separator' },
    { label: '尺寸：系統列', click: () => { mainWindow?.setSize(320, 82); saveSettings(); } }
  );

  if (!locked) {
    items.push(
      { label: '尺寸：股票列', click: () => mainWindow?.webContents.executeJavaScript("holdvueMenu('size-stock')") },
      { label: '完整介面 / 設定', click: () => mainWindow?.webContents.executeJavaScript("holdvueMenu('full')") },
      { type: 'separator' }
    );
  }

  items.push(
    { label: '重新整理', click: () => mainWindow?.webContents.executeJavaScript("holdvueMenu('reload')") },
    { type: 'separator' },
    { label: '隱藏到系統匣', click: () => { saveSettings(); mainWindow?.hide(); } },
    {
      label: '結束 HoldVue',
      click: () => {
        app.isQuitting = true;
        saveSettings();
        if (serviceProc) try { serviceProc.kill(); } catch {}
        app.quit();
      }
    }
  );

  return Menu.buildFromTemplate(items);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '顯示小視窗', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    {
      label: '左鍵穿透',
      type: 'checkbox',
      checked: clickThrough,
      click: (item) => applyClickThrough(item.checked)
    },
    { label: '結束', click: () => { app.isQuitting = true; if (serviceProc) try { serviceProc.kill(); } catch {} app.quit(); } }
  ]));
}

function createTray() {
  let img = nativeImage.createFromPath(iconPath());
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(process.platform === 'darwin' ? img : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('HoldVue');
  refreshTrayMenu();
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

let dragState = null; // { win, ox, oy, w, h }
let resizeState = null; // { win, edge, startX, startY, x, y, w, h }

ipcMain.on('holdvue-menu', (_e, locked) => buildMenu(!!locked).popup({ window: mainWindow }));
ipcMain.on('holdvue-drag', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  if (!win) return;
  const point = screen.getCursorScreenPoint();
  const b = win.getBounds();
  // 鎖定寬高，拖移只改位置
  dragState = { win, ox: point.x - b.x, oy: point.y - b.y, w: b.width, h: b.height };
  resizeState = null;
});
ipcMain.on('holdvue-drag-move', () => {
  if (!dragState || !dragState.win || dragState.win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  dragState.win.setBounds({
    x: Math.round(point.x - dragState.ox),
    y: Math.round(point.y - dragState.oy),
    width: dragState.w,
    height: dragState.h
  });
});
ipcMain.on('holdvue-drag-end', () => {
  dragState = null;
  saveSettings();
});
ipcMain.on('holdvue-resize-start', (e, edge) => {
  const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  if (!win || (edge !== 'se' && edge !== 'sw')) return;
  const point = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragState = null;
  resizeState = {
    win,
    edge,
    startX: point.x,
    startY: point.y,
    x: b.x,
    y: b.y,
    w: b.width,
    h: b.height
  };
});
ipcMain.on('holdvue-resize-move', () => {
  if (!resizeState || !resizeState.win || resizeState.win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const dx = point.x - resizeState.startX;
  const dy = point.y - resizeState.startY;
  let { x, y, w, h } = resizeState;
  if (resizeState.edge === 'se') {
    w = Math.max(220, resizeState.w + dx);
    h = Math.max(60, resizeState.h + dy);
  } else {
    w = Math.max(220, resizeState.w - dx);
    h = Math.max(60, resizeState.h + dy);
    x = resizeState.x + (resizeState.w - w);
  }
  resizeState.win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
});
ipcMain.on('holdvue-resize-end', () => {
  resizeState = null;
  saveSettings();
});
ipcMain.on('holdvue-resize', (_e, w, h, chrome) => {
  if (!mainWindow) return;
  mainWindow.setSize(Math.max(220, w | 0), Math.max(60, h | 0));
  if (chrome) applyMiniTaskbar(false);
  saveSettings();
});
ipcMain.on('holdvue-chrome', (_e, fullMode) => {
  applyMiniTaskbar(!fullMode);
  if (fullMode && clickThrough) applyClickThrough(false);
});
ipcMain.on('holdvue-hide', () => { saveSettings(); mainWindow?.hide(); });
ipcMain.on('holdvue-clickthrough', () => applyClickThrough(!clickThrough));

app.whenReady().then(async () => {
  await ensureService();
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  saveSettings();
  if (serviceProc) try { serviceProc.kill(); } catch {}
});
