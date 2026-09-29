const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lessonAPI', {
  transcribe: (payload) => ipcRenderer.invoke('ai:transcribe', payload),
  assist: (payload) => ipcRenderer.invoke('ai:assist', payload),
  screenshot: () => ipcRenderer.invoke('app:screenshot')
});
