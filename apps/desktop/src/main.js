const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, ipcMain, shell, session, desktopCapturer } = require('electron');
const path = require('node:path');
const { fork } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '../../..');
const DEFAULT_PORT = Number(process.env.LIQUID_MESSENGER_DESKTOP_PORT || 18080);
const EMBEDDED_MODE = process.env.LIQUID_MESSENGER_URL ? false : process.env.LIQUID_MESSENGER_EMBED_SERVER !== 'false';
const SERVER_URL = process.env.LIQUID_MESSENGER_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const HEALTH_TIMEOUT_MS = Number(process.env.LIQUID_MESSENGER_DESKTOP_HEALTH_TIMEOUT_MS || 15000);

let mainWindow;
let tray;
let gatewayProcess;
let isQuitting = false;

function desktopIcon() {
  const svgPath = path.join(ROOT_DIR, 'apps/web/public/icon.svg');
  const icon = nativeImage.createFromPath(svgPath);
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function setNativeBadge(count) {
  const value = Math.max(0, Number(count) || 0);
  if (process.platform === 'darwin' || process.platform === 'linux') app.setBadgeCount(value);
  if (tray) tray.setTitle(value ? String(value) : '');
}

function safeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, { cache: 'no-store' });
      if (response.ok) return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  return false;
}

function startEmbeddedGateway() {
  if (!EMBEDDED_MODE || gatewayProcess) return;
  gatewayProcess = fork(path.join(ROOT_DIR, 'backend/gateway/src/server.js'), [], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(DEFAULT_PORT),
      PUBLIC_URL: SERVER_URL,
      CORS_ORIGIN: SERVER_URL,
      LIQUID_DESKTOP_EMBEDDED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gatewayProcess.stdout?.on('data', chunk => console.log(`[gateway] ${chunk.toString().trim()}`));
  gatewayProcess.stderr?.on('data', chunk => console.error(`[gateway] ${chunk.toString().trim()}`));
  gatewayProcess.on('exit', code => {
    gatewayProcess = null;
    if (!isQuitting && mainWindow) mainWindow.webContents.send('desktop:gateway-exit', { code });
  });
}

function installPermissionHandlers() {
  const allowedOrigin = new URL(SERVER_URL).origin;
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = new URL(webContents.getURL() || allowedOrigin).origin;
    const allowed = origin === allowedOrigin && ['media', 'notifications', 'display-capture', 'fullscreen'].includes(permission);
    callback(allowed);
  });

  if (session.defaultSession.setDisplayMediaRequestHandler) {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      callback({ video: sources[0], audio: false });
    });
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: 'Liquid Messenger',
    backgroundColor: '#111827',
    icon: desktopIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (safeExternalUrl(url) && new URL(url).origin !== new URL(SERVER_URL).origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  const ready = EMBEDDED_MODE ? await waitForServer(SERVER_URL, HEALTH_TIMEOUT_MS) : true;
  if (!ready) console.warn('Gateway health check timed out; loading web app so the offline reconnect UI can take over.');
  await mainWindow.loadURL(SERVER_URL);
}

function createTray() {
  tray = new Tray(desktopIcon());
  tray.setToolTip('Liquid Messenger');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Liquid Messenger', click: () => mainWindow.show() },
    { label: 'Перезагрузить интерфейс', click: () => mainWindow.reload() },
    { label: 'Сбросить счётчик', click: () => setNativeBadge(0) },
    { type: 'separator' },
    { label: 'Выйти', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show());
}

ipcMain.handle('desktop:notify', (_event, payload = {}) => {
  const title = String(payload.title || 'Liquid Messenger').slice(0, 120);
  const body = String(payload.body || '').slice(0, 500);
  if (Notification.isSupported()) new Notification({ title, body, icon: desktopIcon() }).show();
});
ipcMain.handle('desktop:set-badge', (_event, count) => setNativeBadge(count));
ipcMain.handle('desktop:info', () => ({ platform: process.platform, embedded: EMBEDDED_MODE, serverUrl: SERVER_URL, version: app.getVersion() }));

app.setAppUserModelId('com.liquid.messenger');
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  installPermissionHandlers();
  startEmbeddedGateway();
  await createWindow();
  createTray();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else mainWindow.show(); });
app.on('before-quit', () => {
  isQuitting = true;
  setNativeBadge(0);
  if (gatewayProcess) gatewayProcess.kill('SIGTERM');
});
