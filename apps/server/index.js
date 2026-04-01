const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Inject persistent data dir BEFORE requiring server (database.js reads it on module load)
// app.getPath('userData') = AppData/Roaming/<appName> — survives builds
process.env.WA_DATA_DIR = app.getPath('userData');

// Ensure the directory exists
fs.mkdirSync(process.env.WA_DATA_DIR, { recursive: true });

require('./server'); // Starts the background Express + Socket.io server

const PORT = process.env.PORT || 3001;
let win;

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 900,
        title: "WhatsApp Gateway & Admin",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Wait for Express server to be ready before loading URL
    setTimeout(() => {
        win.loadURL(`http://localhost:${PORT}`);
    }, 1500);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
