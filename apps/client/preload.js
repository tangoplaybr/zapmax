const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Save a base64/data-URI file to Downloads/contactName/filename
    saveFile: (filename, dataUri, contactName) =>
        ipcRenderer.invoke('save-file', { filename, dataUri, contactName }),
    // Persist login credentials to disk (survives builds)
    saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),
    loadCredentials: () => ipcRenderer.invoke('load-credentials'),
    // Persist user preferences (theme, etc.) to disk
    savePreferences: (data) => ipcRenderer.invoke('save-preferences', data),
    loadPreferences: () => ipcRenderer.invoke('load-preferences'),
});
