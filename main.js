const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const win32 = require('./win32');
const input = require('./input');

// Yalnızca bu programların pencereleri yayınlanır ve kontrol edilebilir.
// priority: oyun açıksa launcher yerine oyun penceresi seçilir.
const ALLOWED = [
  { exe: 'runelite.exe', priority: 3 },
  { exe: 'osclient.exe', priority: 3 },
  { exe: 'javaw.exe', title: /runelite/i, priority: 2 },
  { exe: 'java.exe', title: /runelite/i, priority: 2 },
  { exe: 'jagexlauncher.exe', priority: 1 },
];
// Geliştirme testi için: BOOST_ALLOW_EXE=notepad.exe
if (process.env.BOOST_ALLOW_EXE) ALLOWED.push({ exe: process.env.BOOST_ALLOW_EXE.toLowerCase(), priority: 0 });

const PRELOAD = path.join(__dirname, 'preload.js');

// GPU hızlandırma bayrakları (5 adımlık plan, 2. adım). Not: "WebRTC-NVENC" ve
// "WebRTCPeerConnectionWithIsolate" Chromium'da tanımlı özellik adları değil; zararsızdır ama etkisi yoktur.
// ignore-gpu-blocklist, Chromium'un sorunlu bildiği sürücülerde de GPU'yu açar; çökme görülürse kaldırılmalı.
app.commandLine.appendSwitch('enable-features', 'WebRTC-NVENC,WebRTCPeerConnectionWithIsolate');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-gpu-rasterization');

let settings;
let mainWin = null;
let indicatorWin = null;

function digits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(10);
  return s;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8').replace(/^﻿/, ''));
  } catch {}
  const s = {
    serverUrl: 'wss://remote.osrsarmory.com/ws',
    code: digits(9),
    pin: digits(6),
    key: crypto.randomBytes(32).toString('hex'),
    allowAccess: true,
    autoStart: false,
    ...saved,
  };
  saveSettings(s);
  return s;
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

function allowedRule(hwnd, title) {
  const exe = (win32.processName(hwnd) || '').toLowerCase();
  const rule = ALLOWED.find((r) => r.exe === exe && (!r.title || r.title.test(title)));
  return rule ? { rule, exe } : null;
}

/**
 * restoreMinimized: booster bağlıyken oyun küçültülmüşse geri aç. Windows küçültülmüş pencereyi
 * yakalayamıyor; açılan pencere bir sonraki taramada (≈1,5 sn) bulunur.
 */
async function findTarget(restoreMinimized) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  let best = null;
  for (const s of sources) {
    const hwnd = Number(s.id.split(':')[1]);
    if (!hwnd) continue;
    const match = allowedRule(hwnd, s.name);
    if (!match) continue;
    const { rule, exe } = match;
    const cand = { sourceId: s.id, hwnd, title: s.name, exe, priority: rule.priority };
    // Aynı önceliktekiler arasında mevcut hedefte kal, pencereler arasında zıplamasın.
    if (!best || cand.priority > best.priority || (cand.priority === best.priority && hwnd === input.getTarget())) {
      best = cand;
    }
  }
  // Oyun küçültülmüş ama launcher açıksa da oyunu geri aç: oyun launcher'dan önceliklidir.
  if (restoreMinimized) {
    for (const hwnd of win32.minimizedWindows()) {
      const match = allowedRule(hwnd, win32.windowTitle(hwnd));
      if (match && (!best || match.rule.priority > best.priority)) win32.restoreNoActivate(hwnd);
    }
  }
  return best;
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    autoHideMenuBar: true,
    title: 'Blazingboost Remote',
    icon: path.join(__dirname, 'renderer', 'logo.png'),
    backgroundColor: '#0f1115',
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.webContents.on('console-message', (_e, level, message) => {
    if (level >= 1) console.log('[renderer]', message);
  });
  // Uyarılardaki hata nesneleri "[object DOMException]" yerine adı ve mesajıyla yazılsın.
  mainWin.webContents.on('did-finish-load', () => {
    mainWin.webContents.executeJavaScript(
      "{const w=console.warn.bind(console);console.warn=(...a)=>w(...a.map(x=>x instanceof Error||x instanceof DOMException?x.name+': '+x.message:x));} undefined;",
    );
  });
  mainWin.on('closed', () => {
    mainWin = null;
    input.releaseAll();
    app.quit();
  });
}

function showIndicator() {
  if (indicatorWin) return;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 300;
  indicatorWin = new BrowserWindow({
    width,
    height: 40,
    x: Math.round(workArea.x + workArea.width / 2 - width / 2),
    y: workArea.y + 8,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#1b1d23',
    webPreferences: { preload: PRELOAD },
  });
  indicatorWin.setAlwaysOnTop(true, 'screen-saver');
  indicatorWin.loadFile(path.join(__dirname, 'renderer', 'indicator.html'));
  indicatorWin.on('closed', () => {
    indicatorWin = null;
  });
}

function hideIndicator() {
  if (indicatorWin) indicatorWin.destroy();
  indicatorWin = null;
}

// ---- Müşterinin imleci ----
// Oturum boyunca müşterinin imleci gizlenir; booster yalnızca kendi imlecini görür (tek imleç, gecikmesiz).
// Müşteri fareyi kendisi oynatırsa (imleç booster'ın koyduğu yerde değilse) imleç hemen geri gelir,
// böylece "Bağlantıyı Kes"e tıklayabilir; 3 sn hareketsizlikten sonra tekrar gizlenir.
const CURSOR_REVEAL_MS = 3000;
let cursorTimer = null;
let cursorHidden = false;
let lastPhysicalMove = 0;

function setCursorHidden(hidden) {
  if (hidden === cursorHidden) return;
  cursorHidden = hidden;
  if (hidden) win32.hideCursor();
  else win32.restoreCursor();
}

function cursorTick() {
  const p = win32.cursorPos();
  const injected = input.getLastInjected();
  const physical = !injected || Math.abs(p.x - injected.x) > 3 || Math.abs(p.y - injected.y) > 3;
  if (physical) lastPhysicalMove = Date.now();
  setCursorHidden(Date.now() - lastPhysicalMove > CURSOR_REVEAL_MS);
}

function startCursorControl() {
  if (cursorTimer) return;
  lastPhysicalMove = Date.now();
  cursorTimer = setInterval(cursorTick, 100);
}

function stopCursorControl() {
  clearInterval(cursorTimer);
  cursorTimer = null;
  setCursorHidden(false);
}

// ---- F8: müşteri bağlantıyı tek tuşla keser ----
// Yalnızca oturum sürerken kayıtlı. Booster F8'e basarsa input.js kısayolu o an bırakır (oyuna gider).
const KICK_KEY = 'F8';
let kickKeyActive = false;

function registerKickKey() {
  if (!kickKeyActive || globalShortcut.isRegistered(KICK_KEY)) return;
  try {
    globalShortcut.register(KICK_KEY, () => {
      if (mainWin) mainWin.webContents.send('kick-request');
    });
  } catch {}
}

function setKickKey(active) {
  kickKeyActive = active;
  if (active) registerKickKey();
  else globalShortcut.unregister(KICK_KEY);
}

input.setKeyGuard({
  code: KICK_KEY,
  release: () => globalShortcut.unregister(KICK_KEY),
  restore: registerKickKey,
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  });

  app.whenReady().then(() => {
    // Önceki çalıştırma çöktüyse imleç gizli kalmış olabilir.
    win32.restoreCursor();
    settings = loadSettings();
    createMainWindow();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    win32.restoreCursor();
  });
  process.on('exit', () => win32.restoreCursor());
}

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', (_e, patch) => {
  for (const k of ['serverUrl', 'allowAccess', 'autoStart']) if (k in patch) settings[k] = patch[k];
  if ('autoStart' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.autoStart });
  saveSettings(settings);
  return settings;
});

ipcMain.handle('settings:new-pin', () => {
  settings.pin = digits(6);
  saveSettings(settings);
  return settings;
});

ipcMain.handle('target:find', (_e, restoreMinimized) => findTarget(!!restoreMinimized));
ipcMain.on('target:set', (_e, hwnd) => input.setTarget(hwnd));
ipcMain.on('target:crop', (_e, crop) => input.setCrop(crop));

// Oyun alanının (başlık çubuğu hariç) yakalanan pencere içindeki yeri, 0..1 oranlarıyla.
ipcMain.handle('target:client-area', (_e, hwnd) => {
  hwnd = Number(hwnd);
  if (!hwnd || !win32.isWindow(hwnd) || win32.isMinimized(hwnd)) return null;
  const w = win32.windowRect(hwnd);
  const c = win32.clientRect(hwnd);
  if (w.w <= 0 || w.h <= 0) return null;
  return { x: (c.x - w.x) / w.w, y: (c.y - w.y) / w.h, w: c.w / w.w, h: c.h / w.h };
});
ipcMain.on('input', (_e, msg) => input.handle(msg));
ipcMain.on('input:release', () => input.releaseAll());
ipcMain.on('session:state', (_e, connected) => {
  if (connected) {
    showIndicator();
    startCursorControl();
  } else {
    hideIndicator();
    stopCursorControl();
  }
  setKickKey(!!connected);
});
ipcMain.on('session:kick', () => {
  if (mainWin) mainWin.webContents.send('kick-request');
});
