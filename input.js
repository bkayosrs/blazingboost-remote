// Booster'dan gelen girdiyi uygular. Tüm kısıtlamalar burada:
// - Girdi yalnızca seçili oyun penceresine gider.
// - Tıklama yalnızca oyun alanının içinde ve pencerenin üstünde başka pencere yoksa yapılır.
// - Windows kısayolları (Win, Alt+Tab, Alt+F4, Ctrl+Esc…) engellenir.

const win32 = require('./win32');

// KeyboardEvent.code -> set-1 tarama kodu (0xE0xx = genişletilmiş tuş)
const SCAN = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
  KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a,
  Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38,
  Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48,
  Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56,
  F11: 0x57, F12: 0x58,
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, AltRight: 0xe038, Home: 0xe047,
  ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f,
  ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053,
};

const ALT_BLOCKED = new Set(['Tab', 'F4', 'Escape', 'Space']);

let target = 0;
const keysDown = new Set();
const buttonsDown = new Set();
let lastInjected = null; // booster'ın imleci en son koyduğu ekran noktası

function moveTo(p) {
  win32.mouseMove(p.x, p.y);
  lastInjected = p;
}

function getLastInjected() {
  return lastInjected;
}

// Yayın kırpılmışsa (yalnızca oyun alanı) booster'ın 0..1 koordinatı bu alana göredir.
let crop = null; // { x, y, w, h } pencereye göre 0..1

function setTarget(hwnd) {
  hwnd = Number(hwnd) || 0;
  if (hwnd === target) return;
  releaseAll();
  target = hwnd;
  crop = null;
  lastMoveSeq = -1;
  lastEventSeq = -1;
}

function setCrop(c) {
  const ok = c && [c.x, c.y, c.w, c.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1) && c.w > 0 && c.h > 0;
  crop = ok ? c : null;
}

function getTarget() {
  return target;
}

function releaseAll() {
  for (const code of keysDown) win32.keyScan(SCAN[code], false);
  keysDown.clear();
  for (const b of buttonsDown) win32.mouseButton(b, false);
  buttonsDown.clear();
  if (keyGuard) keyGuard.restore();
}

function inRect(p, r) {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
}

/** Booster'ın 0..1 koordinatını ekrandaki noktaya çevirir (yakalanan alan = pencere çerçevesi). */
function toScreen(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || win32.isMinimized(target)) return null;
  const r = win32.windowRect(target);
  if (r.w <= 0 || r.h <= 0) return null;
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  if (crop) {
    x = crop.x + x * crop.w;
    y = crop.y + y * crop.h;
  }
  return { x: r.x + Math.round(x * (r.w - 1)), y: r.y + Math.round(y * (r.h - 1)) };
}

function ensureForeground() {
  if (win32.foreground() === target) return true;
  win32.focus(target);
  return win32.foreground() === target;
}

function isBlockedCombo(code) {
  const alt = keysDown.has('AltLeft') || keysDown.has('AltRight');
  const ctrl = keysDown.has('ControlLeft') || keysDown.has('ControlRight');
  if (alt && ALT_BLOCKED.has(code)) return true;
  if (ctrl && code === 'Escape') return true;
  return false;
}

// Müşterinin kısayol tuşu (F8 = bağlantıyı kes) Windows'ta global kısayol olarak kayıtlı. Global
// kısayol, booster'ın gönderdiği aynı tuşu da yakalardı: booster o tuşa basınca kısayol kısa süre
// bırakılır, tuş oyuna gider, bırakılınca kısayol geri kaydedilir.
let keyGuard = null; // { code, release(), restore() }

function setKeyGuard(g) {
  keyGuard = g;
}

function key(code, down) {
  const sc = SCAN[code];
  if (sc === undefined) return; // Win, Menü ve bilinmeyen tuşlar burada elenir.
  const guarded = keyGuard && code === keyGuard.code;
  if (!down) {
    if (keysDown.delete(code)) {
      win32.keyScan(sc, false);
      if (guarded) keyGuard.restore();
    }
    return;
  }
  if (isBlockedCombo(code) || win32.foreground() !== target) return;
  if (guarded) keyGuard.release();
  win32.keyScan(sc, true);
  keysDown.add(code);
}

// Girdi kayıplı ve sırasız kanaldan gelir. Her mesajda sıra numarası (q) var: geç kalmış eski bir
// mesaj (ör. "bırak"tan sonra gelen "bas") uygulanmaz. Hareket ve tıklama/tuş ayrı sayaçlıdır ki
// bir fare hareketi tıklamayı "eski" saydırmasın.
let lastMoveSeq = -1;
let lastEventSeq = -1;
let lastNonce = null;

function isStale(m) {
  if (typeof m.q !== 'number') return false; // sıra numarasız (eski panel): olduğu gibi uygula
  // Her booster sayfası rastgele bir kimlik (n) taşır; sayfa yenilenince ya da başka booster
  // bağlanınca sayaçlar sıfırdan başlar, eski sayaçlarla karşılaştırılmamalı.
  if (m.n !== lastNonce) {
    lastNonce = m.n;
    lastMoveSeq = -1;
    lastEventSeq = -1;
  }
  if (m.t === 'm') {
    if (m.q <= lastMoveSeq) return true;
    lastMoveSeq = m.q;
    return false;
  }
  if (m.q < lastEventSeq || (m.q === lastEventSeq && m.t !== 's')) return true;
  lastEventSeq = m.q;
  return false;
}

/**
 * Booster'ın basılı tuş/düğme özeti (200 ms'de bir). Kaybolan mesajları telafi eder: özette olmayan
 * basılı tuşlar bırakılır, özette olup kaçırılan tuş basmaları uygulanır. Fare düğmeleri yalnızca
 * bırakılır (konumu bilinmeyen bir tıklama üretmemek için).
 */
function reconcile(m) {
  const keys = new Set(Array.isArray(m.keys) ? m.keys.filter((c) => typeof c === 'string') : []);
  const buttons = new Set(Array.isArray(m.buttons) ? m.buttons : []);
  for (const code of [...keysDown]) if (!keys.has(code)) key(code, false);
  for (const code of keys) if (!keysDown.has(code)) key(code, true);
  for (const b of [...buttonsDown]) {
    if (!buttons.has(b)) {
      buttonsDown.delete(b);
      win32.mouseButton(b, false);
    }
  }
}

function handle(m) {
  if (!m || !target || !win32.isWindow(target)) return;
  if (isStale(m)) return;
  switch (m.t) {
    case 's':
      reconcile(m);
      break;
    case 'm': {
      const p = toScreen(m.x, m.y);
      if (p) moveTo(p);
      break;
    }
    case 'b': {
      const button = m.b;
      if (button !== 0 && button !== 1 && button !== 2) return;
      const p = toScreen(m.x, m.y);
      if (!m.d) {
        if (!buttonsDown.delete(button)) return;
        if (p) moveTo(p);
        win32.mouseButton(button, false);
        return;
      }
      if (!p || !inRect(p, win32.clientRect(target))) return; // başlık çubuğu / kenarlar yasak
      if (!ensureForeground()) return;
      if (win32.rootWindowAt(p.x, p.y) !== target) return; // üstte başka pencere var
      moveTo(p);
      win32.mouseButton(button, true);
      buttonsDown.add(button);
      break;
    }
    case 'w':
      if ((m.dy === 1 || m.dy === -1) && win32.foreground() === target) win32.mouseWheel(-m.dy * 120);
      break;
    case 'k':
      if (typeof m.c === 'string') key(m.c, !!m.d);
      break;
    case 'reset':
      releaseAll();
      break;
  }
}

module.exports = { setTarget, setCrop, getTarget, handle, releaseAll, getLastInjected, setKeyGuard };
