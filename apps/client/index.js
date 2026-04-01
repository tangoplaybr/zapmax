const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Enable standard Edit menu so Ctrl+C / Ctrl+V / Ctrl+A work inside the app
const menuTemplate = [
    {
        label: 'Edit',
        submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
        ]
    }
];
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

let win;

function createWindow() {
    // In packaged builds the ico is placed in resources/ via extraResources.
    // In dev mode it lives at the project root Icon/ folder.
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'logo.png')
        : path.join(__dirname, '../../Icon/logo.png');

    win = new BrowserWindow({
        width: 1100,
        height: 800,
        title: 'ZapMax',
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.loadFile(path.join(__dirname, 'src/login.html'));
}

// ── Save file to Downloads/<contactName>/<filename> ──────────────────────────
ipcMain.handle('save-file', async (_event, { filename, dataUri, contactName }) => {
    try {
        // Sanitize folder/file names
        const safeContact = (contactName || 'Sem_Nome')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'Cliente';
        const safeFile = (filename || 'arquivo')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();

        const targetDir = path.join(os.homedir(), 'Downloads', safeContact);
        fs.mkdirSync(targetDir, { recursive: true });

        // Handle data URIs (data:mime;base64,xxx) and plain base64
        let buffer;
        if (dataUri.startsWith('data:')) {
            const base64 = dataUri.split(',')[1];
            buffer = Buffer.from(base64, 'base64');
        } else {
            buffer = Buffer.from(dataUri, 'base64');
        }

        // Avoid overwriting — append counter if file exists
        let finalPath = path.join(targetDir, safeFile);
        if (fs.existsSync(finalPath)) {
            const ext = path.extname(safeFile);
            const base = path.basename(safeFile, ext);
            let n = 1;
            while (fs.existsSync(finalPath)) {
                finalPath = path.join(targetDir, `${base}_${n}${ext}`);
                n++;
            }
        }

        fs.writeFileSync(finalPath, buffer);
        shell.showItemInFolder(finalPath); // opens Explorer and selects the file
        return { ok: true, path: finalPath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ── Credentials persistence (survives builds/updates) ─────────────────────
// Stored in %APPDATA%/ZapMax/credentials.json — outside the app folder
function credentialsPath() {
    return path.join(app.getPath('userData'), 'credentials.json');
}

ipcMain.handle('save-credentials', (_event, data) => {
    try {
        fs.writeFileSync(credentialsPath(), JSON.stringify(data || {}), 'utf8');
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-credentials', () => {
    try {
        const raw = fs.readFileSync(credentialsPath(), 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
});

// ── Preferences persistence (theme, etc.) ─────────────────────────────────
function prefsPath() {
    return path.join(app.getPath('userData'), 'preferences.json');
}

ipcMain.handle('save-preferences', (_event, data) => {
    try {
        // Merge with existing prefs so individual keys can be updated
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { }
        const merged = { ...existing, ...data };
        fs.writeFileSync(prefsPath(), JSON.stringify(merged), 'utf8');
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-preferences', () => {
    try {
        const raw = fs.readFileSync(prefsPath(), 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
