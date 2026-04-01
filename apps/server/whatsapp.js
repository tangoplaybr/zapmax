const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const db = require('./database');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { resolvePhoneFull } = require('./phoneNormalizer');

// ── Chat ID normalisation ─────────────────────────────────────────────────────
// WhatsApp may report the same contact via @c.us (phone-based) or @lid (linked
// device internal ID). Using different IDs for the same contact creates phantom
// duplicate chats. This helper always resolves to the canonical @c.us form.
// Adapted from Chatwoot's set_conversation pattern (lookup existing first).
function normalizeChatId(msg, field = 'from') {
    const raw = msg[field];
    if (raw && raw.endsWith('@c.us')) return raw;
    // msg._data.id.remote is usually the @c.us form even when msg.from/to is @lid
    const remote = msg._data?.id?.remote;
    if (remote && remote.endsWith('@c.us')) return remote;
    // Fallback: extract numeric part and rebuild @c.us
    const num = (raw || '').replace(/@.*$/, '');
    if (/^\d+$/.test(num)) return num + '@c.us';
    return raw;
}

// ── Avatar disk storage ───────────────────────────────────────────────────────
// Resolves the avatars/ directory next to this file (or Electron userData).
function resolveAvatarsDir() {
    try {
        const { app } = require('electron');
        if (app && app.getPath) return path.join(app.getPath('userData'), 'avatars');
    } catch (_) { }
    return path.join(__dirname, 'avatars');
}

/**
 * Downloads a remote image URL and saves it to disk.
 * Returns the local server-relative URL (/avatars/<safeId>.jpg) or null on failure.
 */
function downloadAvatar(remoteUrl, safeId) {
    return new Promise((resolve) => {
        try {
            const dir = resolveAvatarsDir();
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, `${safeId}.jpg`);
            // Skip download if file already exists (CDN URL may have changed but local copy is fine)
            if (fs.existsSync(filePath)) {
                resolve(`/avatars/${safeId}.jpg`);
                return;
            }
            console.log(`[Avatar DL] Downloading ${safeId} from ${remoteUrl.substring(0, 60)}...`);
            const tmpPath = filePath + '.tmp_' + Date.now();
            const proto = remoteUrl.startsWith('https') ? https : http;
            const file = fs.createWriteStream(tmpPath);
            file.on('error', (err) => {
                console.warn(`[Avatar DL] ${safeId} write error:`, err.message);
                try { fs.unlinkSync(tmpPath); } catch (_) { }
                resolve(null);
            });
            const req = proto.get(remoteUrl, (res) => {
                console.log(`[Avatar DL] ${safeId} statusCode=${res.statusCode}`);
                if (res.statusCode !== 200) {
                    file.close();
                    try { fs.unlinkSync(tmpPath); } catch (_) { }
                    resolve(null);
                    return;
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    try { fs.renameSync(tmpPath, filePath); } catch (_) { }
                    resolve(`/avatars/${safeId}.jpg`);
                });
            });
            req.on('error', (err) => {
                console.warn(`[Avatar DL] ${safeId} network error:`, err.message);
                file.close();
                try { fs.unlinkSync(tmpPath); } catch (_) { }
                resolve(null);
            });
            req.setTimeout(8000, () => { console.warn(`[Avatar DL] ${safeId} timeout`); req.destroy(); resolve(null); });
        } catch (err) { console.warn(`[Avatar DL] ${safeId} exception:`, err.message); resolve(null); }
    });
}

/** Sanitises a WhatsApp ID so it can be used as a filename. */
function safeAvatarId(contactId) {
    return (contactId || '').replace(/[^a-z0-9]/gi, '_');
}

// Resolve a stable session path regardless of run context:
// - Electron packaged: app.getPath('userData') → AppData\Roaming\WhatsApp Server
// - Dev (node directly): directory next to this file (apps/server/wa_session)
function resolveSessionPath() {
    try {
        const { app } = require('electron');
        if (app && app.getPath) {
            const p = path.join(app.getPath('userData'), 'wa_session');
            console.log('[WA] Session path (Electron userData):', p);
            return p;
        }
    } catch (_) { /* not running inside Electron */ }

    const p = path.join(__dirname, 'wa_session');
    console.log('[WA] Session path (dev __dirname):', p);
    return p;
}

class WhatsAppGateway extends EventEmitter {
    constructor() {
        super();
        this.isReady = false;
        this.connectedAt = null;      // Date when connection became ready
        this.connectedNumber = null;  // Phone number/JID of connected account
        this._isReconnecting = false; // Guard to avoid parallel reconnects
        this._intentionalDisconnect = false; // When true, skip auto-reconnect on 'disconnected'
        this._reconnectAttempt = 0;   // Current reconnect attempt (0 = not reconnecting)
        this._reconnectTimer = null;  // setTimeout handle for next reconnect attempt
        this._disconnectTime = null;  // When disconnection happened
        // Backoff delays in ms: 5s, 10s, 20s, 40s, 60s, 60s... (capped)
        this._backoffDelays = [5000, 10000, 20000, 40000, 60000];
        this._maxReconnectAttempts = 8;
        // Track IDs of messages sent by us via sendMessage() so message_create
        // doesn't double-save them. Entries are removed after 30 s.
        this._sentIds = new Set();
        this._recentOutgoing = new Map(); // chatId → timestamp of last send via our API
        // Chatwoot MessageDedupLock equivalent: prevents concurrent processing of the
        // same message ID by multiple async handlers (e.g. text + media arriving together)
        this._processingIds = new Set();
        // Cache: maps normalized @c.us chatId → original @lid raw ID for sending
        // Populated by the 'message' handler when msg.from is @lid
        this._lidMap = new Map();
        this._createClient();
    }

    /** Returns a plain status object for the /api/wa-status endpoint */
    getStatus() {
        return {
            isReady: this.isReady,
            connectedAt: this.connectedAt ? this.connectedAt.toISOString() : null,
            connectedNumber: this.connectedNumber || null,
            reconnectAttempt: this._reconnectAttempt,
            maxReconnectAttempts: this._maxReconnectAttempts,
            disconnectedAt: this._disconnectTime ? this._disconnectTime.toISOString() : null,
        };
    }

    /**
     * Schedule a reconnect with exponential backoff.
     * Each call advances the attempt counter and picks the next delay.
     * After _maxReconnectAttempts, gives up and emits 'reconnect_failed'.
     */
    scheduleReconnect() {
        if (this._intentionalDisconnect) return;
        if (this._reconnectTimer) return; // already scheduled

        this._reconnectAttempt++;

        if (this._reconnectAttempt > this._maxReconnectAttempts) {
            console.error(`[WA] Gave up after ${this._maxReconnectAttempts} reconnect attempts.`);
            this._reconnectAttempt = 0;
            this.emit('reconnect_failed');
            return;
        }

        const delayIdx = Math.min(this._reconnectAttempt - 1, this._backoffDelays.length - 1);
        const delay = this._backoffDelays[delayIdx];
        console.log(`[WA] Reconnect attempt ${this._reconnectAttempt}/${this._maxReconnectAttempts} in ${delay / 1000}s…`);

        this.emit('reconnecting', {
            attempt: this._reconnectAttempt,
            maxAttempts: this._maxReconnectAttempts,
            nextRetryInMs: delay,
        });

        this._reconnectTimer = setTimeout(async () => {
            this._reconnectTimer = null;
            await this.reconnect();
        }, delay);
    }

    /** Tear down current client and spin up a fresh one. */
    async reconnect() {
        // Force-clear stale guard so manual reconnects are never silently blocked
        if (this._isReconnecting) {
            console.warn('[WA] reconnect() called while _isReconnecting=true — force-clearing.');
        }
        this._isReconnecting = true;
        console.log('[WA] Reconnecting — destroying old client…');
        this.isReady = false;
        this.connectedAt = null;
        this.connectedNumber = null;
        // Cancel any pending timers that could create a competing client
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._reconnectAttempt = 0;
        this._cleanupChrome();
        try {
            await this.client.destroy();
        } catch (err) {
            console.warn('[WA] destroy() error (ignored):', err.message);
        }
        // Small delay so Puppeteer releases resources before a new instance starts
        setTimeout(() => {
            this._isReconnecting = false;
            this._createClient();
        }, 3000);
    }

    /** Logout from WhatsApp (clears session — will need full QR re-scan) */
    async disconnect() {
        console.log('[WA] Manual disconnect requested — clearing session…');
        this._intentionalDisconnect = true; // prevent auto-reconnect in 'disconnected' handler
        this._isReconnecting = false;        // clear guard so _createClient() can run
        this.isReady = false;
        this.connectedAt = null;
        this.connectedNumber = null;
        // Cancel any pending reconnect/watchdog timers so they don't interfere
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._initWatchdog) { clearTimeout(this._initWatchdog); this._initWatchdog = null; }
        try {
            await this.client.logout();   // clears LocalAuth session files
        } catch (_) { /* may throw if already gone, that is fine */ }
        try {
            await this.client.destroy();
        } catch (_) { }
        // After a short delay let the dust settle, then reset flags and spin up fresh client → new QR
        // Use a guaranteed callback — even if the above threw unexpected errors, QR must appear.
        const doCreate = () => {
            this._intentionalDisconnect = false;
            this._isReconnecting = false;
            this._reconnectAttempt = 0;
            this._createClient();
            console.log('[WA] Session cleared — fresh client created, waiting for QR…');
        };
        setTimeout(doCreate, 4000);
    }

    /**
     * Nuclear reset: destroy client + wipe wa_session folder from ALL known paths.
     * ⚠️  NEVER deletes the SQLite database. Only removes the wa_session directory.
     * Use when the server is stuck at "initializing" after a bad disconnect.
     */
    async resetSession() {
        console.log('[WA] resetSession() called — destroying client and wiping session data…');
        this._intentionalDisconnect = true;
        this.isReady = false;
        this.connectedAt = null;
        this.connectedNumber = null;

        // 1) Cancel ALL pending timers so nothing interferes during rebuild
        if (this._healthCheckTimer) { clearInterval(this._healthCheckTimer); this._healthCheckTimer = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._initWatchdog) { clearTimeout(this._initWatchdog); this._initWatchdog = null; }

        // 2) Kill orphaned Chrome processes before destroying Puppeteer
        this._cleanupChrome();

        // 3) Try to destroy the current Puppeteer instance gracefully
        try { await this.client.destroy(); } catch (_) { /* ignored */ }

        // 4) Collect ALL possible wa_session paths (dev + every Electron userData variant)
        const sessionFolderName = 'wa_session';
        const candidatePaths = [
            // Dev mode (node directly — next to this file)
            path.join(__dirname, sessionFolderName),
        ];

        // Electron packaged paths — cover all known app name variants in AppData\Roaming
        const appDataRoaming = process.env.APPDATA;
        if (appDataRoaming) {
            const appNames = [
                'sistema-whatsapp-multi',
                'whatsapp-server',
                'ZapMax',
                'WhatsApp Server',
            ];
            appNames.forEach(name => {
                candidatePaths.push(path.join(appDataRoaming, name, sessionFolderName));
            });
        }

        // Also try electron.app.getPath if running inside Electron
        try {
            const { app } = require('electron');
            if (app && app.getPath) {
                candidatePaths.push(path.join(app.getPath('userData'), sessionFolderName));
            }
        } catch (_) { /* not in Electron */ }

        // 5) Delete every wa_session directory found — NEVER touch the .db file
        let deleted = 0;
        for (const p of candidatePaths) {
            // Safety guard: path must end with wa_session (never delete parent dir or db)
            if (!p.endsWith(sessionFolderName) && !p.endsWith(sessionFolderName + path.sep)) continue;
            try {
                if (fs.existsSync(p)) {
                    fs.rmSync(p, { recursive: true, force: true });
                    console.log('[WA] resetSession: removed', p);
                    deleted++;
                }
            } catch (rmErr) {
                console.warn('[WA] resetSession: could not remove', p, '→', rmErr.message);
            }
        }
        console.log(`[WA] resetSession: removed ${deleted} session folder(s). Starting fresh client…`);

        // 6) Small wait so OS releases any file handles
        await new Promise(r => setTimeout(r, 2000));

        // 7) Spin up a clean client → will emit 'qr' shortly
        this._intentionalDisconnect = false;
        this._isReconnecting = false;
        this._reconnectAttempt = 0;
        this._createClient();
        this.emit('session_reset');
    }

    /** Centralised helper: mark gateway as disconnected and notify listeners */
    _setDisconnected(reason) {
        if (!this.isReady && !this.connectedAt) return; // already disconnected
        this.isReady = false;
        this.connectedAt = null;
        this.connectedNumber = null;
        this.emit('disconnected', reason);
        console.log('[WA] _setDisconnected called, reason:', reason);
    }

    /** Find the system Chrome on Windows (whitelisted in Firewall). */
    _findSystemChrome() {
        const candidates = [
            process.env.LOCALAPPDATA
                ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
                : null,
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ].filter(Boolean);
        for (const p of candidates) {
            try { if (fs.existsSync(p)) { console.log('[WA] System Chrome:', p); return p; } } catch (_) { }
        }
        return null;
    }

    /** Synchronous cleanup: kill known Chrome and remove lock files. */
    _cleanupChrome() {
        const isWin = process.platform === 'win32';
        if (this._chromePid) {
            try {
                if (isWin) {
                    require('child_process').execSync(`taskkill /F /PID ${this._chromePid}`, { stdio: 'ignore' });
                } else {
                    process.kill(this._chromePid, 'SIGKILL');
                }
            } catch (_) { }
            this._chromePid = null;
        }
        try {
            const proc = this.client?.pupBrowser?.process?.();
            if (proc && !proc.killed) {
                if (isWin && proc.pid) {
                    try { require('child_process').execSync(`taskkill /F /PID ${proc.pid}`, { stdio: 'ignore' }); } catch (_) { }
                } else {
                    proc.kill('SIGKILL');
                }
            }
        } catch (_) { }
        // Remove singleton lock files
        const sp = resolveSessionPath();
        for (const sub of ['session-default', 'session']) {
            for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
                try { const lp = path.join(sp, sub, lock); if (fs.existsSync(lp)) fs.unlinkSync(lp); } catch (_) { }
            }
        }
    }

    /** 
     * Create a new Client and set up all event handlers. 
     * SYNCHRONOUS — safe to call from constructor and reconnect().
     */
    _createClient() {
        this._cleanupChrome();

        let chromePath = this._findSystemChrome();
        
        // If system Chrome is not found, fallback to the Puppeteer bundled Chromium
        if (!chromePath) {
            try {
                const puppeteer = require('puppeteer');
                chromePath = puppeteer.executablePath();
                console.log('[WA] Using bundled Puppeteer Chromium:', chromePath);
            } catch (err) {
                console.warn('[WA] Puppeteer bundled Chromium not found either. WhatsApp Web may fail to start.');
            }
        }

        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: resolveSessionPath() }),
            puppeteer: {
                ...(chromePath ? { executablePath: chromePath } : {}),
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                headless: true,
            }
        });

        this._qrReceived = false;
        const currentClient = this.client;
        const isCurrent = () => this.client === currentClient;

        // ── QR ────────────────────────────────────────────────────────────────
        this.client.on('qr', (qr) => {
            if (!isCurrent()) return;
            console.log('[WA] QR code received');
            qrcode.generate(qr, { small: true });
            this._qrReceived = true;
            this.isReady = false;
            this.emit('qr', qr);
        });

        // ── Auth Failure ──────────────────────────────────────────────────────
        this.client.on('auth_failure', (msg) => {
            if (!isCurrent()) return;
            console.error('[WA] auth_failure:', msg);
            this.isReady = false;
            this.emit('auth_failure', msg);
            this.emit('init_error', 'auth_failure: ' + msg);
        });

        // ── Authenticated ────────────────────────────────────────────────────
        this.client.on('authenticated', () => {
            if (!isCurrent()) return;
            console.log('[WA] authenticated');
            try {
                const pid = this.client?.pupBrowser?.process?.()?.pid;
                if (pid) { this._chromePid = pid; console.log('[WA] Chrome PID:', pid); }
            } catch (_) { }
            this.emit('authenticated');
        });

        // ── Ready ────────────────────────────────────────────────────────────
        this.client.on('ready', () => {
            if (!isCurrent()) return;
            console.log('[WA] WhatsApp Client is ready!');
            this.isReady = true;
            this.connectedAt = new Date();
            this._reconnectAttempt = 0;
            this._disconnectTime = null;
            if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
            try {
                this.connectedNumber = this.client.info?.wid?.user
                    ? `${this.client.info.wid.user}@${this.client.info.wid.server}`
                    : (this.client.info?.pushname || null);
            } catch (_) { this.connectedNumber = null; }
            this.emit('ready', { connectedAt: this.connectedAt, connectedNumber: this.connectedNumber });

            // Patch: prevent "No LID for user" crash
            this.client.pupPage.evaluate(() => {
                if (window.Store && window.Store.Lid1X1MigrationUtils) {
                    const orig = window.Store.Lid1X1MigrationUtils.isLidMigrated;
                    if (orig) {
                        window.Store.Lid1X1MigrationUtils.isLidMigrated = function (...args) {
                            try { return orig.apply(this, args); }
                            catch (e) { return false; }
                        };
                    }
                }
            }).then(() => console.log('[WA] LID patch applied.'))
                .catch(e => console.warn('[WA] LID patch skipped:', e.message));

            setTimeout(() => {
                Promise.all([
                    this.refreshAllContactInfo(),
                    this.syncAllContacts()
                ]).catch(err => console.error('[WA] Init sync error:', err));

                if (this._avatarRefreshTimer) clearInterval(this._avatarRefreshTimer);
                this._avatarRefreshTimer = setInterval(() => {
                    if (!this.isReady) return;
                    this.refreshAllContactInfo().catch(e => console.warn('[WA] Refresh error:', e.message));
                }, 4 * 60 * 60 * 1000);
            }, 3000);

            setTimeout(() => {
                if (this.isReady) {
                    this.refreshMissingAvatars().catch(e => console.warn('[WA] Avatar refresh error:', e.message));
                }
            }, 30000);
        });

        // ── Disconnected ─────────────────────────────────────────────────────
        this.client.on('disconnected', (reason) => {
            if (!isCurrent()) return;
            console.warn('[WA] disconnected:', reason);
            this._disconnectTime = new Date();
            this._setDisconnected(reason);
            if (this._intentionalDisconnect) return;
            this.scheduleReconnect();
        });

        // ── State changes ────────────────────────────────────────────────────
        this.client.on('change_state', (state) => {
            if (!isCurrent()) return;
            const BAD = ['CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'TIMEOUT'];
            if (BAD.includes(state) && this.isReady) {
                this._setDisconnected(state);
                if (!this._intentionalDisconnect) this.scheduleReconnect();
            }
        });

        // ── Health check ─────────────────────────────────────────────────────
        if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
        this._healthCheckFailCount = 0;
        this._healthCheckTimer = setInterval(async () => {
            if (!isCurrent() || !this.isReady) { this._healthCheckFailCount = 0; return; }
            try {
                const state = await this.client.getState();
                if (state !== 'CONNECTED') {
                    this._healthCheckFailCount++;
                    if (this._healthCheckFailCount >= 2) {
                        this._setDisconnected(state || 'health_check_failed');
                        this._healthCheckFailCount = 0;
                        if (!this._intentionalDisconnect) setTimeout(() => this.reconnect(), 3000);
                    }
                } else { this._healthCheckFailCount = 0; }
            } catch (_) {
                this._healthCheckFailCount++;
                if (this._healthCheckFailCount >= 2) {
                    this._setDisconnected('health_check_error');
                    this._healthCheckFailCount = 0;
                    if (!this._intentionalDisconnect) setTimeout(() => this.reconnect(), 3000);
                }
            }
        }, 30000);

        // ── Initialize ───────────────────────────────────────────────────────
        this.client.initialize().catch(err => {
            if (!isCurrent()) return;
            const msg = err.message || String(err);
            if (this._qrReceived) {
                console.warn('[WA] Post-QR init error (expected):', msg.slice(0, 80));
                return;
            }
            console.error('[WA] initialize() failed:', msg);
            this.emit('init_error', msg);
            // Auto-retry: schedule a reconnect with exponential backoff so the
            // server doesn't stay stuck in the "initializing" state forever.
            if (!this._intentionalDisconnect) {
                this.scheduleReconnect();
            }
        });

        // ── Incoming messages (from clients) ──────────────────────
        this.client.on('message', async (msg) => {
            // Ignore group messages, status updates and broadcast lists
            if (msg.from === 'status@broadcast') return;
            if (msg.from.endsWith('@g.us')) return;
            if (msg.to && msg.to.endsWith('@g.us')) return;
            if (!isCurrent()) return;

            const rawFrom = msg.from;

            // ── Resolve chatId: @lid → real phone @c.us ──────────────
            let chatId, name, number, avatarUrl;
            const _debugLog = (m) => { try { fs.appendFileSync(path.join(process.env.APPDATA || '.', 'ZapMax', 'send_debug.log'), `[${new Date().toISOString()}] ${m}\n`); } catch (_) { } };

            // Dedup lock first (before any async work)
            const msgUniqueId = msg.id?._serialized || msg.id?.id;
            if (this._processingIds.has(msgUniqueId)) return;
            this._processingIds.add(msgUniqueId);
            setTimeout(() => this._processingIds.delete(msgUniqueId), 15000);
            if (this._sentIds.has(msgUniqueId)) return;

            if (rawFrom.endsWith('@lid')) {
                // @lid contact: resolve real phone number via WA Contact store
                let waId = rawFrom; // the native WA identifier for sending
                try {
                    const info = await this.getContactInfo(rawFrom);
                    name = info.name || msg._data?.notifyName || '';
                    avatarUrl = info.avatarUrl || null;
                    // Filter corrupted phone: if number matches the @lid user part, discard it
                    const lidUser = rawFrom.replace('@lid', '');
                    number = (info.number && info.number !== lidUser) ? info.number : null;
                } catch (_) {
                    name = msg._data?.notifyName || '';
                    number = null;
                    avatarUrl = null;
                }

                // Build candidate chatId from real phone when available
                if (number && /^\d{8,15}$/.test(number)) {
                    chatId = number + '@c.us';
                } else {
                    chatId = rawFrom; // fallback: use @lid directly
                }

                // ── RESOLVE to existing chat BEFORE creating/updating ──────
                // Priority: 1) wa_id lookup  2) resolveActiveChatId (phone + wa_id)
                const existingByWaId = await db.findChatByWaId(rawFrom);
                if (existingByWaId) {
                    chatId = existingByWaId;
                } else {
                    chatId = await db.resolveActiveChatId(chatId, number, rawFrom);
                }

                // Cache for sendMessage
                this._lidMap.set(chatId, waId);
                _debugLog(`[MSG_IN] @lid=${rawFrom} phone=${number} → chatId=${chatId}`);

                // NOW persist with wa_id — chatId is guaranteed correct
                await db.updateChat(chatId, name, msg.body, avatarUrl, 'waiting', number, true, waId);
                // Separate transition: finished → waiting
                await new Promise(r => db.db.run(
                    `UPDATE chats SET status = 'waiting', has_unread = 1 WHERE id = ? AND status = 'finished'`,
                    [chatId], () => r()
                ));
            } else {
                // Normal @c.us contact
                chatId = normalizeChatId(msg);
                if (!chatId || !chatId.endsWith('@c.us')) return;
                number = chatId.replace('@c.us', '');
                try {
                    const info = await this.getContactInfo(rawFrom);
                    name = info.name || msg._data?.notifyName || '';
                    avatarUrl = info.avatarUrl || null;
                    if (info.number) number = info.number;
                } catch (_) {
                    name = msg._data?.notifyName || '';
                    avatarUrl = null;
                }
                // ── RESOLVE to existing chat to prevent phone-based duplicates ──
                chatId = await db.resolveActiveChatId(chatId, number);
                await db.updateChat(chatId, name, msg.body, avatarUrl, 'waiting', number, true);
                // Separate transition: finished → waiting
                await new Promise(r => db.db.run(
                    `UPDATE chats SET status = 'waiting', has_unread = 1 WHERE id = ? AND status = 'finished'`,
                    [chatId], () => r()
                ));
            }

            try { // top-level try/catch to capture any error

                db.upsertContact(chatId, name, number, avatarUrl).catch(() => { });
                db.updateContactInfo(chatId, name, avatarUrl, number).catch(() => { });


                if (!avatarUrl) {
                    setTimeout(async () => {
                        try {
                            const retry = await this.getContactInfo(msg.from);
                            if (retry.avatarUrl) {
                                await db.updateChat(chatId, name, null, retry.avatarUrl, undefined, number, true);
                                db.upsertContact(chatId, name, number, retry.avatarUrl).catch(() => { });
                                db.updateContactInfo(chatId, name, retry.avatarUrl, number).catch(() => { });
                                this.emit('avatar_updated', { chatId, avatarUrl: retry.avatarUrl });
                            }
                        } catch (_) { }
                    }, 5000);
                }

                // ── Download media & emit message to server.js ──────────────
                let mediaData = null;
                let mediaType = null;
                let mediaFilename = msg._data?.filename || null;
                let mediaPages = msg._data?.pageCount || null;
                let mediaSize = null;
                let quotedStatusMedia = null;
                let quotedBody = null;
                let quotedMsgId = null;

                if (msg.hasMedia) {
                    const typeMap = { document: 'application/pdf', image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', sticker: 'image/webp', ptt: 'audio/ogg' };
                    try {
                        const media = await msg.downloadMedia();
                        if (media && media.data) {
                            mediaData = `data:${media.mimetype};base64,${media.data}`;
                            mediaType = media.mimetype;
                            mediaSize = Math.round(Buffer.byteLength(media.data, 'base64') / 1024);
                            if (!mediaFilename && media.filename) mediaFilename = media.filename;
                        } else {
                            // Retry after 2s — forwarded/shared media can take time to become available
                            console.warn('[WA] downloadMedia returned empty for', msg.type, '— retrying in 2s');
                            await new Promise(r => setTimeout(r, 2000));
                            try {
                                const retry = await msg.downloadMedia();
                                if (retry && retry.data) {
                                    mediaData = `data:${retry.mimetype};base64,${retry.data}`;
                                    mediaType = retry.mimetype;
                                    mediaSize = Math.round(Buffer.byteLength(retry.data, 'base64') / 1024);
                                    if (!mediaFilename && retry.filename) mediaFilename = retry.filename;
                                } else {
                                    mediaType = msg._data?.mimetype || typeMap[msg.type] || null;
                                }
                            } catch (_retryErr) {
                                mediaType = msg._data?.mimetype || typeMap[msg.type] || null;
                            }
                        }
                    } catch (e) {
                        mediaType = msg._data?.mimetype || typeMap[msg.type] || null;
                        console.warn('[WA] Failed to download media:', e.message);
                    }
                }

                // Extract quoted message body + ID (for reply context display)
                // and check for quoted status media (stories forwarded as messages)
                if (msg.hasQuotedMsg) {
                    try {
                        const quoted = await Promise.race([
                            msg.getQuotedMessage(),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                        ]);
                        if (quoted) {
                            quotedBody = (quoted.body || '').slice(0, 300) || null;
                            if (!quotedBody && quoted.hasMedia) quotedBody = `[${quoted.type || 'mídia'}]`;
                            quotedMsgId = quoted.id?.id || null;
                            if (quoted.isStatus && quoted.hasMedia) {
                                const qMedia = await quoted.downloadMedia();
                                if (qMedia) quotedStatusMedia = `data:${qMedia.mimetype};base64,${qMedia.data}`;
                            }
                        }
                    } catch (_) { }
                }

                // Save message to DB
                const msgId = msg.id?.id || msg.id?._serialized || `in_${Date.now()}`;
                const msgSerialized = msg.id?._serialized || null;
                const bodyText = msg.body || (mediaFilename ? `[${msg.type || 'arquivo'}]` : (msg.hasMedia ? `[${msg.type || 'mídia'}]` : ''));
                await db.saveMessage(msgId, chatId, bodyText, 0, quotedBody, null, mediaData, mediaType, mediaFilename, mediaPages, mediaSize, 1, quotedStatusMedia, null, quotedMsgId, msgSerialized).catch(() => { });

                // Emit to server.js → frontend
                this.emit('message', {
                    chatId, name, avatarUrl,
                    body: bodyText,
                    msgId, msgSerialized,
                    mediaData, mediaType, mediaFilename, mediaPages, mediaSize,
                    quotedStatusMedia, quotedBody, quotedMsgId,
                    timestamp: msg.timestamp
                });
                _debugLog(`[MSG_IN] EMIT OK chatId=${chatId}`);

            } catch (handlerErr) {
                _debugLog(`[MSG_IN] HANDLER ERROR: ${handlerErr.message}\n${handlerErr.stack}`);
            }

            // Feature E — auto-reply rules (throttle: 1 auto-reply per chat per 60s)
            (async () => {
                try {
                    const now = Date.now();
                    if (!this._lastAutoReply) this._lastAutoReply = {};
                    const lastReply = this._lastAutoReply[chatId] || 0;
                    if (now - lastReply < 60000) return; // throttle

                    // ⚑  Claim the slot immediately (before any await) to prevent
                    //    race conditions when the client sends multiple files at once.
                    this._lastAutoReply[chatId] = now;

                    const rules = await db.getAutoReplyRules();
                    const activeRules = rules.filter(r => r.is_active);

                    // Lunch break: ONLY fires when the chat's assigned attendant is on lunch.
                    // Waiting (unassigned) chats are intentionally NOT affected.
                    if (this.lunchBreakSet && this.lunchBreakSet.size > 0) {
                        let onLunch = false;
                        try {
                            const allChats = await db.getQueue();
                            const chat = allChats.find(c => c.id === chatId);
                            const attendantId = chat?.attendant_id;
                            if (chat?.status === 'attending' && attendantId && this.lunchBreakSet.has(String(attendantId))) {
                                onLunch = true;
                            }
                        } catch (_) { /* fail safe */ }

                        if (onLunch) {
                            const lunchRule = activeRules.find(r => r.type === 'lunch_break');
                            const lunchMsg = lunchRule?.message || '🍽️ Olá! No momento estou em horário de almoço. Retornarei em breve, obrigado pela compreensão!';
                            await this.sendMessage(chatId, lunchMsg);
                            const autoId = `auto_lunch_${Date.now()}`;
                            await db.saveMessage(autoId, chatId, lunchMsg, 1, null, 'AutoReply');
                            this._lastAutoReply[chatId] = now;
                            this.emit('queue_refresh');
                            return;
                        }
                    }

                    // File-based rules (only if message has media and filename)
                    if (mediaFilename) {
                        const fn = (mediaFilename || '').toLowerCase();
                        const ext = fn.split('.').pop();
                        for (const rule of activeRules) {
                            if (rule.type === 'lunch_break') continue; // handled above
                            let matched = false;
                            if (rule.type === 'file_extension' && ext === rule.trigger.replace('.', '').toLowerCase()) matched = true;
                            if (rule.type === 'filename_keyword' && fn.includes(rule.trigger.toLowerCase())) matched = true;
                            if (matched) {
                                await this.sendMessage(chatId, rule.message); // uses _sentIds
                                const autoId = `auto_rule_${Date.now()}`;
                                await db.saveMessage(autoId, chatId, rule.message, 1, null, 'AutoReply');
                                this._lastAutoReply[chatId] = now;
                                this.emit('queue_refresh');
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[AutoReply] Error:', e.message);
                }
            })();
        });

        // ── Outgoing messages sent from phone / WhatsApp Web ──────
        // NOTE: messages sent via sendMessage() are already saved by server.js.
        // We use this._sentIds to skip those and only process truly external sends
        // (phone / WhatsApp Web) so we don't double-save.
        // Additional guard: _recentOutgoing tracks chatIds with recent sends to handle
        // race conditions where message_create fires before sendMessage() returns.
        this.client.on('message_create', async (msg) => {
            if (!msg.fromMe) return;
            if (msg.to.endsWith('@g.us')) return;
            if (msg.to === 'status@broadcast') return;
            if (msg.isStatus) return;
            if (msg.to.endsWith('@broadcast')) return;
            // ── Chatwoot MessageDedupLock: in-memory fast path ──────────────
            const outMsgId = msg.id.id;
            if (this._processingIds.has(outMsgId)) return;

            // Race condition fix: message_create fires BEFORE sendMessage() returns,
            // so _sentIds may not be populated yet. Wait 300ms and re-check.
            if (this._sentIds.has(outMsgId)) {
                console.log('OUTGOING (skipped dedup by id)', outMsgId);
                this._sentIds.delete(outMsgId);
                return;
            }
            // Delay to let sendMessage() complete and populate _sentIds
            await new Promise(r => setTimeout(r, 300));
            if (this._sentIds.has(outMsgId)) {
                console.log('OUTGOING (skipped dedup by id after delay)', outMsgId);
                this._sentIds.delete(outMsgId);
                return;
            }

            // Fallback dedup: if this phone number had a send via our API within the last 10s, skip.
            // Uses PHONE NUMBER (not chatId) to handle @lid vs @c.us mismatch.
            const normTo = normalizeChatId(msg, 'to');
            const numericTo = (msg.to || '').replace(/@.*$/, '');
            const recentSend = this._recentOutgoing?.get(numericTo) || this._recentOutgoing?.get(msg.to) || this._recentOutgoing?.get(normTo);
            if (recentSend && (Date.now() - recentSend) < 10000) {
                console.log('OUTGOING (skipped dedup by timing)', msg.id.id, msg.to);
                return;
            }

            console.log('OUTGOING (external)', msg.to, msg.body, msg.hasMedia ? '[MEDIA]' : '');

            // Acquire lock
            this._processingIds.add(outMsgId);
            setTimeout(() => this._processingIds.delete(outMsgId), 30000);

            // Normalise chatId and resolve to existing active chat (Chatwoot pattern)
            let chatId = normTo;
            // Use ORIGINAL msg.to for WA client queries (it knows @lid, not normalised @c.us)
            const { name, avatarUrl, number } = await this.getContactInfo(msg.to);
            const safePhone = number || (chatId.endsWith('@c.us') ? chatId.replace(/@.*$/, '') : null);
            chatId = await db.resolveActiveChatId(chatId, safePhone);

            // Download media if present
            let mediaData = null;
            let mediaType = null;
            let mediaFilename = null;
            let mediaPages = null;
            let mediaSize = null;
            if (msg.hasMedia) {
                mediaFilename = msg._data?.filename || null;
                mediaPages = msg._data?.pageCount || null;
                const typeMap = { document: 'application/pdf', image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg', sticker: 'image/webp' };
                try {
                    const media = await msg.downloadMedia();
                    if (media) {
                        mediaData = `data:${media.mimetype};base64,${media.data}`;
                        mediaType = media.mimetype;
                        mediaSize = Math.round(Buffer.byteLength(media.data, 'base64') / 1024);
                        if (!mediaFilename && media.filename) mediaFilename = media.filename;
                    }
                } catch (e) {
                    mediaType = msg._data?.mimetype || typeMap[msg.type] || null;
                    console.warn('[WA] Failed to download media (outgoing):', e.message);
                }
            }

            // Capture quoted body for outgoing replies sent from phone/WhatsApp Web
            let quotedBody = null;
            if (msg.hasQuotedMsg) {
                try {
                    const quoted = await Promise.race([
                        msg.getQuotedMessage(),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                    ]);
                    if (quoted) {
                        quotedBody = (quoted.body || '').slice(0, 300) || null;
                        if (!quotedBody && quoted.hasMedia) quotedBody = `[${quoted.type || 'mídia'}]`;
                    }
                } catch (_) { /* quoted not available */ }
            }

            const bodyText = msg.body || (mediaFilename || (mediaType ? `[${(mediaType || '').split('/')[0]}]` : ''));
            // ── Chatwoot find_message_by_source_id dedup guard ──────
            if (await db.messageExists(outMsgId)) { console.log('OUTGOING (skipped dedup by DB)', outMsgId); return; }
            await db.updateChat(chatId, name, bodyText, avatarUrl, undefined, number, true);
            await db.saveMessage(outMsgId, chatId, bodyText, true, quotedBody, null, mediaData, mediaType, mediaFilename, mediaPages, mediaSize);

            this.emit('outgoing_message', { chatId, name, avatarUrl, body: bodyText, mediaData, mediaType, mediaFilename, mediaPages, mediaSize, timestamp: new Date() });
        });

        // ── Feature F: message_ack (delivery/read status) ─────────
        this.client.on('message_ack', async (msg, ack) => {
            try {
                await db.updateMessageAck(msg.id.id, ack);
                this.emit('ack_update', { msgId: msg.id.id, ack });
            } catch (e) { console.warn('[ACK]', e.message); }
        });

        // ── Emoji reactions from WhatsApp ─────────────────────────
        this.client.on('message_reaction', async (reaction) => {
            try {
                const msgId = reaction.msgId?._serialized || reaction.msgId?.id || String(reaction.msgId);
                const emoji = reaction.reaction;
                const senderIsMe = reaction.senderId === this.client.info?.wid?._serialized;

                console.log('REACTION', msgId, emoji, senderIsMe ? 'mine' : 'theirs');

                // Determine chatId from the reaction sender
                const chatId = reaction.senderId?.includes('@c.us')
                    ? (senderIsMe ? reaction.msgId?.remote || reaction.orphan : reaction.senderId)
                    : reaction.senderId;

                if (!emoji || emoji === '') {
                    // Empty emoji = reaction removed, skip storing
                    this.emit('reaction_removed', { msgId, senderIsMe });
                    return;
                }

                this.emit('message_reaction', {
                    msgId,
                    chatId: chatId || reaction.senderId,
                    emoji,
                    senderIsMe,
                    senderName: senderIsMe ? 'Você' : null
                });
            } catch (err) {
                console.error('Error processing reaction:', err);
            }
        });

        // ── Client message deleted (for everyone) ─────────────────
        // `revokedMsg` is the revoked message object (may have null body).
        // `msg`        is the replacement/tombstone message from WA.
        // The real original ID is on `revokedMsg`, fallback to `msg`.
        this.client.on('message_revoke_for_everyone', async (msg, revokedMsg) => {
            try {
                const msgId = revokedMsg?.id?.id || revokedMsg?.id?._serialized || msg?.id?.id;
                const chatId = revokedMsg?.from || msg?.from;
                if (!msgId || !chatId) return;
                if (chatId.endsWith('@g.us') || chatId === 'status@broadcast') return;

                console.log('[WA] Client revoked msg', msgId, 'in', chatId);
                await db.deleteMessage(msgId, chatId);
                this.emit('message_revoked', { msgId, chatId });
            } catch (e) { console.warn('[Revoke]', e.message); }
        });

        // ── Client message edited ─────────────────────────────────
        this.client.on('message_edit', async (msg, newBody /* , prevBody */) => {
            try {
                const msgId = msg?.id?.id;
                const chatId = msg?.from;
                if (!msgId || !chatId) return;
                if (chatId.endsWith('@g.us') || chatId === 'status@broadcast') return;

                console.log('[WA] Client edited msg', msgId, 'in', chatId, '→', newBody?.slice(0, 60));
                await db.editMessage(msgId, newBody || '', chatId);
                this.emit('message_edited', { msgId, chatId, newBody: newBody || '' });
            } catch (e) { console.warn('[Edit]', e.message); }
        });
    } // end _createClient()

    async sendMessage(chatId, body, options = {}) {
        if (!this.isReady) throw new Error('WhatsApp not connected');

        // Diagnostic file log (user can check %APPDATA%/ZapMax/send_debug.log)
        const _log = (msg) => {
            try {
                const logPath = path.join(process.env.APPDATA || '.', 'ZapMax', 'send_debug.log');
                const ts = new Date().toISOString();
                require('fs').appendFileSync(logPath, `[${ts}] ${msg}\n`);
            } catch (_) { }
            console.log(msg);
        };
        _log(`[sendMessage] chatId=${chatId}, bodyLen=${body?.length || 0}`);

        const numericId = chatId.replace(/@.*$/, '');
        this._recentOutgoing.set(chatId, Date.now());
        this._recentOutgoing.set(numericId, Date.now());
        setTimeout(() => { this._recentOutgoing.delete(chatId); this._recentOutgoing.delete(numericId); }, 15000);
        let msg;
        try {
            msg = await Promise.race([
                this.client.sendMessage(chatId, body, options),
                new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout: WhatsApp não respondeu em 30s.')), 30000))
            ]);
            console.log(`[sendMessage] result for ${chatId}:`, msg ? 'OK' : 'null');
            _log(`[sendMessage] result: ${msg ? 'OK id=' + msg?.id?.id : 'NULL'}`);
        } catch (sendErr) {
            _log(`[sendMessage] ERROR: ${sendErr.message}`);
            // On "No LID" error, try @s.whatsapp.net then fall through to fallback strategies
            if (sendErr.message?.includes('No LID') && chatId.endsWith('@c.us')) {
                const altId = chatId.replace('@c.us', '@s.whatsapp.net');
                console.warn(`[sendMessage] No LID for ${chatId}, retrying with ${altId}`);
                try {
                    msg = await Promise.race([
                        this.client.sendMessage(altId, body, options),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout no retry')), 30000))
                    ]);
                } catch (retryErr) {
                    _log(`[sendMessage] @s.whatsapp.net retry also failed: ${retryErr.message}`);
                    msg = null; // fall through to fallback strategies below
                }
            } else if (!sendErr.message?.includes('No LID')) {
                throw sendErr;
            }
        }
        // If msg is null and chatId is @c.us, resolve to @lid for sending
        if (!msg && chatId.endsWith('@c.us')) {
            const digits = chatId.replace('@c.us', '');
            _log(`[sendMessage] NULL for @c.us — resolving ${digits} to @lid`);

            // Strategy 1: wa_id from DB (persistent, most reliable)
            const dbWaId = await db.getWaId(chatId);
            if (dbWaId) {
                _log(`[sendMessage] DB wa_id: ${dbWaId}`);
                try {
                    msg = await this.client.sendMessage(dbWaId, body, options);
                    if (msg) _log(`[sendMessage] DB wa_id send OK: ${msg.id?.id}`);
                } catch (e) { _log(`[sendMessage] DB wa_id failed: ${e.message}`); }
            }

            // Strategy 2: _lidMap cache (from recent incoming messages)
            if (!msg && this._lidMap.has(chatId)) {
                const cached = this._lidMap.get(chatId);
                _log(`[sendMessage] _lidMap cache: ${cached}`);
                try {
                    msg = await this.client.sendMessage(cached, body, options);
                    if (msg) _log(`[sendMessage] Cache send OK: ${msg.id?.id}`);
                } catch (e) { _log(`[sendMessage] Cache send failed: ${e.message}`); }
            }

            // Strategy 3: digits might already be a LID number (old DB entries)
            if (!msg) {
                const tryLid = digits + '@lid';
                _log(`[sendMessage] Trying direct @lid: ${tryLid}`);
                try {
                    msg = await this.client.sendMessage(tryLid, body, options);
                    if (msg) _log(`[sendMessage] Direct @lid send OK: ${msg.id?.id}`);
                } catch (e) { _log(`[sendMessage] Direct @lid failed: ${e.message}`); }
            }

            if (!msg) _log(`[sendMessage] All strategies failed for ${digits}`);
        }


        if (!msg) throw new Error('Não foi possível enviar — contato não encontrado no WhatsApp.');

        this._sentIds.add(msg.id.id);
        setTimeout(() => this._sentIds.delete(msg.id.id), 60000); // extended from 30s to 60s
        const { name, avatarUrl, number } = await this.getContactInfo(chatId);
        // Non-blocking: updateChat updates last_message on the sidebar card.
        // Must not throw — if DB is busy (BEGIN IMMEDIATE from incoming tx), the
        // message is already sent. The server.js handler saves the message separately.
        db.updateChat(chatId, name, body, avatarUrl, undefined, number, true).catch(e =>
            console.warn('[sendMessage] updateChat failed (non-critical):', e.message));
        return msg;
    }

    /**
     * Send a media file (image, PDF, audio, video, etc.) to a WhatsApp chat.
     * @param {string} chatId - WhatsApp chat ID
     * @param {string} base64Data - raw base64 string (no data URI prefix)
     * @param {string} mimetype  - MIME type e.g. 'image/jpeg', 'application/pdf'
     * @param {string} filename  - Original filename shown to recipient
     * @param {string} caption   - Optional caption text
     */
    async sendMedia(chatId, base64Data, mimetype, filename, caption = '') {
        if (!this.isReady) throw new Error('WhatsApp not connected');
        const media = new MessageMedia(mimetype, base64Data, filename);
        const options = {};
        // Images/videos use caption; documents always send as document
        if (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/')) {
            if (caption) options.caption = caption;
        } else {
            // Force document mode for PDFs and other binary files
            options.sendMediaAsDocument = true;
            if (caption) options.caption = caption;
        }
        // Dedup: mark chatId BEFORE sending so message_create can detect it
        const numericMId = chatId.replace(/@.*$/, '');
        this._recentOutgoing.set(chatId, Date.now());
        this._recentOutgoing.set(numericMId, Date.now());
        setTimeout(() => { this._recentOutgoing.delete(chatId); this._recentOutgoing.delete(numericMId); }, 15000);

        let msg;
        try {
            msg = await this.client.sendMessage(chatId, media, options);
        } catch (sendErr) {
            // On "No LID" error, try @s.whatsapp.net then fall through to fallback strategies
            if (sendErr.message?.includes('No LID') && chatId.endsWith('@c.us')) {
                const altId = chatId.replace('@c.us', '@s.whatsapp.net');
                console.warn(`[sendMedia] No LID for ${chatId}, retrying with ${altId}`);
                try {
                    msg = await this.client.sendMessage(altId, media, options);
                } catch (retryErr) {
                    console.warn(`[sendMedia] @s.whatsapp.net retry also failed: ${retryErr.message}`);
                    msg = null; // fall through to fallback strategies below
                }
            } else if (!sendErr.message?.includes('No LID')) {
                throw sendErr;
            }
        }

        // LID resolution: same 3-strategy pattern as sendMessage
        if (!msg && chatId.endsWith('@c.us')) {
            const digits = chatId.replace('@c.us', '');
            console.log(`[sendMedia] NULL for @c.us — resolving ${digits} to @lid`);

            // Strategy 1: wa_id from DB
            const dbWaId = await db.getWaId(chatId);
            if (dbWaId) {
                try { msg = await this.client.sendMessage(dbWaId, media, options); }
                catch (_) { }
            }
            // Strategy 2: _lidMap cache
            if (!msg && this._lidMap.has(chatId)) {
                try { msg = await this.client.sendMessage(this._lidMap.get(chatId), media, options); }
                catch (_) { }
            }
            // Strategy 3: direct @lid
            if (!msg) {
                try { msg = await this.client.sendMessage(digits + '@lid', media, options); }
                catch (_) { }
            }
            if (!msg) console.error(`[sendMedia] All strategies failed for ${digits}`);
        }

        if (!msg) throw new Error('Não foi possível enviar mídia — contato não encontrado no WhatsApp.');

        this._sentIds.add(msg.id.id);
        setTimeout(() => this._sentIds.delete(msg.id.id), 60000);
        const { name, avatarUrl, number } = await this.getContactInfo(chatId);
        // Non-blocking: same rationale as sendMessage — must not block media send
        db.updateChat(chatId, name, caption || filename, avatarUrl, undefined, number, true).catch(e =>
            console.warn('[sendMedia] updateChat failed (non-critical):', e.message));
        return msg;
    }

    /**
     * Publish a text status/story with background color and font style.
     * @param {string} text - Status text
     * @param {number} backgroundColor - ARGB color (e.g. 0xff7acca5)
     * @param {number} fontStyle - Font style 0-7
     */
    async sendStatusText(text, backgroundColor = 0xff7acca5, fontStyle = 0) {
        if (!this.isReady) throw new Error('WhatsApp not connected');
        const msg = await this.client.sendMessage('status@broadcast', text, {
            extraOptions: { backgroundColor, fontStyle }
        });
        console.log('[Status] Text status published:', text.substring(0, 50));
        return msg;
    }

    /**
     * Publish a media status/story (image or video) with optional caption.
     * @param {string} base64Data - raw base64 string
     * @param {string} mimetype - MIME type
     * @param {string} filename - file name
     * @param {string} caption - optional caption
     */
    async sendStatusMedia(base64Data, mimetype, filename, caption = '') {
        if (!this.isReady) throw new Error('WhatsApp not connected');
        const media = new MessageMedia(mimetype, base64Data, filename);
        const options = {};
        if (caption) options.caption = caption;
        const msg = await this.client.sendMessage('status@broadcast', media, options);
        console.log('[Status] Media status published:', mimetype, filename);
        return msg;
    }

    // Fetch contact name, phone number, and profile picture URL safely.
    // Avatar is downloaded to disk; returns local /avatars/... path.
    // Uses pupPage.evaluate (bypass broken getProfilePicUrl in whatsapp-web.js@1.23)
    async getContactInfo(contactId) {
        let name = contactId.replace(/@.*$/, '');
        let avatarUrl = null;
        let number = null;
        let contact = null;
        try {
            contact = await this.client.getContactById(contactId);
            name = contact.name || contact.pushname || contact.number || name;
            number = resolvePhoneFull(contactId, contact.number || contact.id?.user || null);
        } catch (_) { }

        // Build list of IDs to try for profile pic
        const idsToTry = [contactId];
        if (number && !number.includes('@')) {
            idsToTry.push(number + '@c.us', number + '@s.whatsapp.net');
        }
        if (contact?.number && contact.number + '@c.us' !== contactId) {
            idsToTry.push(contact.number + '@c.us');
        }

        let cdnUrl = null;

        // Primary method: pupPage.evaluate (bypass broken lib)
        try {
            const page = this.client.pupPage;
            if (page) {
                cdnUrl = await page.evaluate(async (ids) => {
                    for (const id of ids) {
                        try {
                            if (window.Store && window.Store.ProfilePicThumb) {
                                const thumb = await window.Store.ProfilePicThumb.find(id);
                                if (thumb && thumb.imgFull) return thumb.imgFull;
                                if (thumb && thumb.img) return thumb.img;
                            }
                        } catch (_) { }
                    }
                    return null;
                }, idsToTry);
            }
        } catch (_) { }

        // Fallback: try getProfilePicUrl (in case future lib version fixes it)
        if (!cdnUrl) {
            for (const id of idsToTry) {
                try { cdnUrl = await this.client.getProfilePicUrl(id); } catch (_) { }
                if (cdnUrl) break;
            }
        }

        if (cdnUrl) {
            try {
                const local = await downloadAvatar(cdnUrl, safeAvatarId(number || contactId));
                avatarUrl = local || null;
            } catch (_) { }
        }
        return { name, avatarUrl, number };
    }

    // When WhatsApp is ready, refresh all existing chats with correct names + photos.
    // Now reuses getContactInfo() which has @lid→@c.us avatar fallback.
    async refreshAllContactInfo() {
        try {
            const chats = await db.getQueue();
            console.log(`[WA] Refreshing contact info for ${chats.length} chats...`);
            for (const chat of chats) {
                if (!chat.id || chat.id === 'admin') continue;
                try {
                    const { name, avatarUrl } = await this.getContactInfo(chat.id);
                    await db.updateContactInfo(chat.id, name, avatarUrl);
                } catch (_) { }
            }
            console.log('[WA] Contact info refresh complete.');
            this.emit('contacts_refreshed');
        } catch (err) {
            console.error('[WA] Error refreshing contacts:', err.message);
        }
    }

    // Focused refresh: only chats WITHOUT avatar (faster — skips existing)
    async refreshMissingAvatars() {
        try {
            const chats = await db.getQueue();
            const noAvatar = chats.filter(c => !c.avatar_url && c.id && c.id !== 'admin');
            if (!noAvatar.length) { console.log('[AvatarRefresh] All chats have avatars.'); return; }
            console.log(`[AvatarRefresh] ${noAvatar.length} chats without avatar, refreshing...`);
            let found = 0;
            for (const chat of noAvatar) {
                try {
                    const { avatarUrl } = await this.getContactInfo(chat.id);
                    if (avatarUrl) {
                        await db.updateChat(chat.id, chat.name, chat.last_message, avatarUrl, chat.status, chat.phone, true);
                        found++;
                        console.log(`[AvatarRefresh] ✓ ${chat.name || chat.id}: ${avatarUrl}`);
                    }
                } catch (_) { }
                await new Promise(r => setTimeout(r, 500)); // rate limit
            }
            console.log(`[AvatarRefresh] Done. Found ${found}/${noAvatar.length} avatars.`);
            if (found > 0) this.emit('contacts_refreshed');
        } catch (err) {
            console.error('[AvatarRefresh] Error:', err.message);
        }
    }

    // Sync ALL contacts from the phone book into DB
    async syncAllContacts() {
        try {
            console.log('[WA] Syncing phone contacts...');
            const allContacts = await this.client.getContacts();

            // Filter: only real user contacts (@c.us), skip groups, broadcast, status
            const filtered = allContacts.filter(c =>
                c.id?.server === 'c.us' &&
                !c.isGroup &&
                !c.isBroadcast &&
                c.isContact
            );

            console.log(`[WA] Found ${filtered.length} contacts to sync.`);

            // Build records — fetch and save photos to disk in small batches to avoid WA rate limits
            const dir = resolveAvatarsDir();
            const BATCH = 10;
            const records = [];
            for (let i = 0; i < filtered.length; i += BATCH) {
                const batch = filtered.slice(i, i + BATCH);
                await Promise.all(batch.map(async c => {
                    const cid = c.id._serialized;
                    const sid = safeAvatarId(cid);
                    const localPath = path.join(dir, `${sid}.jpg`);
                    let avatarUrl = fs.existsSync(localPath) ? `/avatars/${sid}.jpg` : null;
                    if (!avatarUrl) {
                        try {
                            const cdnUrl = await this.client.getProfilePicUrl(cid);
                            if (cdnUrl) avatarUrl = await downloadAvatar(cdnUrl, sid);
                        } catch (_) { }
                    }
                    records.push({
                        id: cid,
                        name: c.name || c.pushname || c.number || '',
                        number: c.number || c.id.user || '',
                        avatar_url: avatarUrl,
                        is_business: c.isBusiness || false
                    });
                }));
            }

            if (records.length > 0) {
                await db.syncContacts(records);
                console.log(`[WA] Synced ${records.length} contacts to DB.`);
            }

            this.emit('contacts_synced', { count: records.length });
        } catch (err) {
            console.error('[WA] Error syncing contacts:', err.message);
        }
    }

    async retryDownloadMedia(serializedId) {
        if (!this.isReady || !this.client) throw new Error('WhatsApp não conectado');
        const waMsg = await this.client.getMessageById(serializedId);
        if (!waMsg) throw new Error('Mensagem não encontrada no WhatsApp');
        if (!waMsg.hasMedia) throw new Error('Mensagem não contém mídia');
        const media = await waMsg.downloadMedia();
        if (!media || !media.data) throw new Error('Download falhou novamente');
        return {
            mediaData: `data:${media.mimetype};base64,${media.data}`,
            mediaType: media.mimetype,
            mediaFilename: media.filename || null,
            mediaSize: Math.round(Buffer.byteLength(media.data, 'base64') / 1024)
        };
    }
}

module.exports = new WhatsAppGateway();
