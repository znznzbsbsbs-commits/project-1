const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LiquidDesktop', {
  isDesktop: true,
  platform: process.platform,
  notify(title, body) { return ipcRenderer.invoke('desktop:notify', { title, body }); },
  setBadge(count) { return ipcRenderer.invoke('desktop:set-badge', count); },
  clearBadge() { return ipcRenderer.invoke('desktop:set-badge', 0); },
  info() { return ipcRenderer.invoke('desktop:info'); },
  onGatewayExit(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:gateway-exit', listener);
    return () => ipcRenderer.removeListener('desktop:gateway-exit', listener);
  },
});
