'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('holdvueDesktop', {
  menu: (locked) => ipcRenderer.send('holdvue-menu', !!locked),
  drag: () => ipcRenderer.send('holdvue-drag'),
  dragMove: () => ipcRenderer.send('holdvue-drag-move'),
  dragEnd: () => ipcRenderer.send('holdvue-drag-end'),
  resizeStart: (edge) => ipcRenderer.send('holdvue-resize-start', edge),
  resizeMove: () => ipcRenderer.send('holdvue-resize-move'),
  resizeEnd: () => ipcRenderer.send('holdvue-resize-end'),
  resize: (w, h, chrome) => ipcRenderer.send('holdvue-resize', w, h, !!chrome),
  chrome: (on) => ipcRenderer.send('holdvue-chrome', !!on),
  hide: () => ipcRenderer.send('holdvue-hide'),
  clickThrough: (on) => ipcRenderer.send('holdvue-clickthrough', on),
  topmost: (on) => ipcRenderer.send('holdvue-topmost', on),
  opacity: (pct) => ipcRenderer.send('holdvue-opacity', pct),
  getPrefs: () => ipcRenderer.invoke('holdvue-get-prefs'),
  isElectron: true
});
