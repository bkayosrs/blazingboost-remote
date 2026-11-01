// Windows API çağrıları. koffi hazır derlenmiş geldiği için native derleme gerekmez.

const path = require('path');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

koffi.struct('POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
});
const INPUT_SIZE = koffi.sizeof(INPUT);

const GetWindowThreadProcessId = user32.func(
  'uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)',
);
const IsWindow = user32.func('int __stdcall IsWindow(intptr_t hWnd)');
const IsIconic = user32.func('int __stdcall IsIconic(intptr_t hWnd)');
const ShowWindow = user32.func('int __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)');
const GetClientRect = user32.func('int __stdcall GetClientRect(intptr_t hWnd, _Out_ RECT *lpRect)');
const GetWindowRect = user32.func('int __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *lpRect)');
const ClientToScreen = user32.func('int __stdcall ClientToScreen(intptr_t hWnd, _Inout_ POINT *lpPoint)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr_t hWnd)');
const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(POINT Point)');
const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hWnd, uint32_t gaFlags)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)');
const OpenProcess = kernel32.func(
  'intptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)',
);
const CloseHandle = kernel32.func('int __stdcall CloseHandle(intptr_t hObject)');
const QueryFullProcessImageNameW = kernel32.func(
  'int __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32_t dwFlags, _Out_ uint8_t *lpExeName, _Inout_ uint32_t *lpdwSize)',
);
const DwmGetWindowAttribute = dwmapi.func(
  'int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ RECT *pvAttribute, uint32_t cbAttribute)',
);

const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint8_t *lpString, int nMaxCount)');
const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
const EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)');

const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *lpPoint)');
const CreateCursor = user32.func(
  'intptr_t __stdcall CreateCursor(intptr_t hInst, int xHotSpot, int yHotSpot, int nWidth, int nHeight, void *pvANDPlane, void *pvXORPlane)',
);
const SetSystemCursor = user32.func('int __stdcall SetSystemCursor(intptr_t hcur, uint32_t id)');
const SystemParametersInfoW = user32.func(
  'int __stdcall SystemParametersInfoW(uint32_t uiAction, uint32_t uiParam, void *pvParam, uint32_t fWinIni)',
);

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SW_SHOWNOACTIVATE = 4;
const SPI_SETCURSORS = 0x0057;
// OCR_NORMAL, IBEAM, WAIT, CROSS, UP, SIZENWSE, SIZENESW, SIZEWE, SIZENS, SIZEALL, NO, HAND, APPSTARTING, HELP
const SYSTEM_CURSORS = [32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651];
const BLANK_AND = Buffer.alloc(128, 0xff);
const BLANK_XOR = Buffer.alloc(128, 0x00);
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const GA_ROOT = 2;
const SW_RESTORE = 9;
const VK_MENU = 0x12;

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

// [down, up] bayrakları; indeks tarayıcıdaki MouseEvent.button ile aynı (0 sol, 1 orta, 2 sağ).
const BUTTON_FLAGS = [
  [0x0002, 0x0004],
  [0x0020, 0x0040],
  [0x0008, 0x0010],
];

function processName(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (!pid[0]) return null;
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(2048);
    const size = [1024];
    if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return null;
    return path.basename(buf.toString('utf16le', 0, size[0] * 2));
  } finally {
    CloseHandle(handle);
  }
}

/** Görünür, küçültülmüş üst düzey pencereler (yakalama API'si bunları listelemiyor). */
function minimizedWindows() {
  const found = [];
  const cb = koffi.register((hwnd) => {
    if (IsWindowVisible(hwnd) && IsIconic(hwnd)) found.push(hwnd);
    return 1;
  }, koffi.pointer(EnumWindowsProc));
  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found;
}

function windowTitle(hwnd) {
  const buf = Buffer.alloc(1024);
  const len = GetWindowTextW(hwnd, buf, 512);
  return buf.toString('utf16le', 0, len * 2);
}

/** Küçültülmüş pencereyi odağı çalmadan geri açar. */
function restoreNoActivate(hwnd) {
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
}

function cursorPos() {
  const p = {};
  GetCursorPos(p);
  return p;
}

/**
 * Sistem imleçlerini saydam yapar. Yakalanan görüntüde müşterinin imleci görünmesin, booster
 * yalnızca kendi (gecikmesiz) imlecini görsün. SetSystemCursor verilen tutamacı tükettiği için
 * her imleç için yenisi oluşturulur.
 */
function hideCursor() {
  for (const id of SYSTEM_CURSORS) {
    const blank = CreateCursor(0, 0, 0, 32, 32, BLANK_AND, BLANK_XOR);
    if (blank) SetSystemCursor(blank, id);
  }
}

/** Kullanıcının imleç şemasını geri yükler. */
function restoreCursor() {
  SystemParametersInfoW(SPI_SETCURSORS, 0, null, 0);
}

function isWindow(hwnd) {
  return !!IsWindow(hwnd);
}

function isMinimized(hwnd) {
  return !!IsIconic(hwnd);
}

/** Pencere yakalamanın kapsadığı alan (görünmez gölge kenarları hariç), ekran koordinatlarında. */
function windowRect(hwnd) {
  const r = {};
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) !== 0) GetWindowRect(hwnd, r);
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

/** Başlık çubuğu hariç oyun alanı, ekran koordinatlarında. */
function clientRect(hwnd) {
  const r = {};
  GetClientRect(hwnd, r);
  const p = { x: 0, y: 0 };
  ClientToScreen(hwnd, p);
  return { x: p.x, y: p.y, w: r.right, h: r.bottom };
}

function rootWindowAt(x, y) {
  return GetAncestor(WindowFromPoint({ x, y }), GA_ROOT);
}

function foreground() {
  return GetForegroundWindow();
}

function send(input) {
  SendInput(1, input, INPUT_SIZE);
}

function mouse(dwFlags, dx = 0, dy = 0, mouseData = 0) {
  send({ type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } } });
}

function keyboard(wVk, wScan, dwFlags) {
  send({ type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } } });
}

function mouseMove(x, y) {
  const vx = GetSystemMetrics(76);
  const vy = GetSystemMetrics(77);
  const vw = GetSystemMetrics(78);
  const vh = GetSystemMetrics(79);
  const dx = Math.round(((x - vx) * 65535) / Math.max(1, vw - 1));
  const dy = Math.round(((y - vy) * 65535) / Math.max(1, vh - 1));
  mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy);
}

function mouseButton(button, down) {
  const flags = BUTTON_FLAGS[button];
  if (flags) mouse(flags[down ? 0 : 1]);
}

function mouseWheel(delta) {
  mouse(MOUSEEVENTF_WHEEL, 0, 0, delta >>> 0);
}

/** sc: set-1 tarama kodu; 0xE0xx biçimindekiler genişletilmiş tuştur. */
function keyScan(sc, down) {
  let flags = KEYEVENTF_SCANCODE;
  if (sc > 0xff) flags |= KEYEVENTF_EXTENDEDKEY;
  if (!down) flags |= KEYEVENTF_KEYUP;
  keyboard(0, sc & 0xff, flags);
}

function focus(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  // Windows, arka plandaki bir sürecin odak çalmasını engelliyor; kısa bir Alt basımı bu kısıtı kaldırır.
  keyboard(VK_MENU, 0, 0);
  SetForegroundWindow(hwnd);
  keyboard(VK_MENU, 0, KEYEVENTF_KEYUP);
}

module.exports = {
  processName,
  cursorPos,
  hideCursor,
  restoreCursor,
  minimizedWindows,
  windowTitle,
  restoreNoActivate,
  isWindow,
  isMinimized,
  windowRect,
  clientRect,
  rootWindowAt,
  foreground,
  focus,
  mouseMove,
  mouseButton,
  mouseWheel,
  keyScan,
  INPUT_SIZE,
};
