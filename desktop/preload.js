'use strict';
/* 预加载脚本：只把「窗口控制」这几个能力暴露给页面，其余 Node 能力一律不给 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  onMaximizedChange: (cb) => {
    const handler = (_e, v) => { try { cb(!!v); } catch (e) { } };
    ipcRenderer.on('win:maximized', handler);
    return () => ipcRenderer.removeListener('win:maximized', handler);
  },
});
