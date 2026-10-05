// 原型 preload：只暴露存图 + 测量上报两个通道（可丢弃）。
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('holoBridge', {
  savePng: (name, dataUrl) => {
    ipcRenderer.send('holo-save-png', { name, dataUrl })
    return new Promise((resolve) => {
      ipcRenderer.once('holo-save-png-done', (_e, r) => resolve(r))
    })
  },
  measureDone: (payload) => ipcRenderer.send('holo-measure-done', payload),
})
