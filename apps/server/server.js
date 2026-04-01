const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');
const whatsapp = require('./whatsapp');
const jwt = require('jsonwebtoken');
const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');

// Resolves the avatars/ directory in both dev and Electron contexts
function resolveAvatarsDir() {
    try {
        const { app: electronApp } = require('electron');
        if (electronApp && electronApp.getPath) return path.join(electronApp.getPath('userData'), 'avatars');
    } catch (_) { }
    return path.join(__dirname, 'avatars');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 50e6 });

const JWT_SECRET = 'your-secret-key';

let COMPANY_NAME = 'Empresa';
db.getConfig('company_name').then(v => { if (v) COMPANY_NAME = v; });

// Multer: store uploads in memory (no disk write), max 50 MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.json({ limit: '51mb' }));
app.use(express.urlencoded({ extended: true, limit: '51mb' }));
app.use(express.static(path.join(__dirname, 'src')));
// Serve saved avatars as static files (permanent, no CDN expiry)
app.use('/avatars', (req, res, next) => {
    express.static(resolveAvatarsDir())(req, res, next);
});

// ── Web client access (browser / mobile) ─────────────────────────────────────
// Serves the Electron client as a web app at http://SERVER:3001/app/
// The Electron desktop app is NOT affected — it loads files via file:// directly.
app.use('/app', express.static(path.join(__dirname, '../client/src')));
app.use('/Icon', express.static(path.join(__dirname, '../../Icon')));
// Convenience redirect: /app → /app/login.html
app.get('/app', (req, res) => res.redirect('/app/login.html'));


// ── Auth ────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.authenticate(username, password);
    if (user) {
        const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET);
        res.json({ success: true, token, user: { id: user.id, name: user.name, role: user.role } });
    } else {
        res.status(401).json({ success: false, message: 'Credenciais inválidas' });
    }
});

// ── Attendants ───────────────────────────────────────────────────────────────
app.post('/api/attendants', async (req, res) => {
    const { username, password, name } = req.body;
    try {
        await db.addAttendant(username, password, name);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: 'Usuário já existe' });
    }
});

app.get('/api/attendants', async (req, res) => {
    const data = await db.getAttendants();
    res.json(data);
});

app.delete('/api/attendants/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await db.deleteAttendant(id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.patch('/api/attendants/:id', async (req, res) => {
    const { id } = req.params;
    const { name, password } = req.body;
    if (!name && !password) return res.status(400).json({ success: false, message: 'Informe name ou password' });
    try {
        await db.updateAttendant(id, { name, password });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── Config ───────────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
    const company = await db.getConfig('company_name');
    res.json({ company_name: company || 'Empresa' });
});

app.post('/api/config', async (req, res) => {
    const { company_name } = req.body;
    if (!company_name) return res.status(400).json({ success: false });
    await db.setConfig('company_name', company_name);
    COMPANY_NAME = company_name;
    res.json({ success: true });
});

// ── Canned Responses ─────────────────────────────────────────────────────────
app.get('/api/canned-responses', async (req, res) => {
    const data = await db.getCannedResponses();
    res.json(data);
});

app.post('/api/canned-responses', async (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, message: 'title e content são obrigatórios' });
    const result = await db.addCannedResponse(title, content);
    res.json({ success: true, id: result.id });
});

app.delete('/api/canned-responses/:id', async (req, res) => {
    await db.deleteCannedResponse(req.params.id);
    res.json({ success: true });
});

// ── File Auto-Reply Rules ─────────────────────────────────────────────────────
app.get('/api/file-rules', async (req, res) => {
    res.json(await db.getFileRules());
});

app.post('/api/file-rules', async (req, res) => {
    const { type, trigger, message } = req.body;
    if (!type || !trigger || !message) return res.status(400).json({ success: false, message: 'type, trigger e message são obrigatórios' });
    if (!['file_extension', 'filename_keyword'].includes(type))
        return res.status(400).json({ success: false, message: 'type inválido' });
    try {
        const result = await db.saveAutoReplyRule(type, trigger.trim().toLowerCase(), message.trim());
        res.json({ success: true, id: result.id });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/file-rules/:id', async (req, res) => {
    await db.deleteAutoReplyRule(req.params.id);
    res.json({ success: true });
});

app.patch('/api/file-rules/:id/toggle', async (req, res) => {
    const { is_active } = req.body;
    await db.toggleAutoReplyRule(req.params.id, is_active);
    res.json({ success: true });
});

// ── Contacts ─────────────────────────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
    const q = req.query.q || '';
    const data = q.length >= 1
        ? await db.searchContacts(q, 40)
        : await db.getContacts(100, 0);
    res.json(data);
});

// ── Labels (Feature 5) ───────────────────────────────────────────────────────
app.get('/api/labels', async (req, res) => {
    res.json(await db.getLabels());
});
app.post('/api/labels', async (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name obrigatório' });
    try { res.json(await db.createLabel(name.trim(), color || '#6366f1')); }
    catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.delete('/api/labels/:id', async (req, res) => {
    await db.deleteLabel(req.params.id);
    res.json({ success: true });
});
// Attach/detach label on chat
app.post('/api/chats/:chatId/labels', async (req, res) => {
    const chatId = decodeURIComponent(req.params.chatId);
    const { labelId } = req.body;
    if (!labelId) return res.status(400).json({ success: false });
    await db.addLabelToChat(chatId, labelId);
    await broadcastQueue();
    res.json({ success: true });
});
app.delete('/api/chats/:chatId/labels/:labelId', async (req, res) => {
    const chatId = decodeURIComponent(req.params.chatId);
    await db.removeLabelFromChat(chatId, req.params.labelId);
    await broadcastQueue();
    res.json({ success: true });
});

// ── Snooze (Feature 6) ──────────────────────────────────────────────────────
app.post('/api/chats/:chatId/snooze', async (req, res) => {
    const chatId = decodeURIComponent(req.params.chatId);
    const { until } = req.body; // ISO datetime string
    if (!until) return res.status(400).json({ success: false, message: 'until obrigatório' });
    await db.snoozeChat(chatId, until);
    await broadcastQueue();
    res.json({ success: true });
});
app.delete('/api/chats/:chatId/snooze', async (req, res) => {
    const chatId = decodeURIComponent(req.params.chatId);
    await db.unsnoozeChat(chatId);
    await broadcastQueue();
    res.json({ success: true });
});

// ── Snooze Watcher: every 60s, wake expired snoozed chats ──────────────────
setInterval(async () => {
    try {
        const due = await db.getSnoozedDueChats();
        if (due.length === 0) return;
        for (const { id } of due) await db.unsnoozeChat(id);
        console.log(`[Snooze] Unsnoozing ${due.length} chat(s):`, due.map(d => d.id));
        await broadcastQueue();
        io.emit('chats_unsnoozed', due.map(d => d.id));
    } catch (e) { console.warn('[Snooze] Watcher error:', e.message); }
}, 60_000);

// Paginated chat history for contact drawer (lazy load)
app.get('/api/history/:chatId', async (req, res) => {
    const chatId = decodeURIComponent(req.params.chatId);
    const page = Math.max(0, parseInt(req.query.page || '0', 10));
    const limit = Math.min(100, parseInt(req.query.limit || '30', 10));
    try {
        const msgs = await db.getPagedHistory(chatId, page, limit);
        res.json({ messages: msgs, page, limit, hasMore: msgs.length === limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rename a contact
app.patch('/api/contacts/:id/name', async (req, res) => {
    const id = decodeURIComponent(req.params.id);
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'name é obrigatório' });
    try {
        await db.updateContactName(id, name.trim());
        // Also update the chat display name so it reflects immediately
        await db.updateContactInfo(id, name.trim(), null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Internal Notes (Mural de Avisos) ─────────────────────────────────────────
app.get('/api/notes', authMiddleware, async (req, res) => {
    try { res.json(await db.getNotes(req.user.id, req.user.role)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notes', authMiddleware, async (req, res) => {
    const { title, body, assignedTo, assignedToName, deadline, isRecurring, recurrenceDays, recurrenceTime, checklist } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Título obrigatório' });
    try {
        const id = await db.createNote({
            title: title.trim(), body: body?.trim() || null,
            createdBy: req.user.id, createdByName: req.user.name,
            assignedTo: assignedTo || null, assignedToName: assignedToName || null,
            deadline: deadline || null, isRecurring: !!isRecurring,
            recurrenceDays: recurrenceDays || null,
            recurrenceTime: recurrenceTime || null,
            checklist: checklist || null
        });
        const notes = await db.getNotes(req.user.id, req.user.role);
        const note = notes.find(n => n.id === id);
        io.emit('new_note', note); // broadcast to all online attendants
        res.json({ success: true, id });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/notes/:id/read', authMiddleware, async (req, res) => {
    const noteId = parseInt(req.params.id);
    try {
        await db.markNoteRead(noteId, req.user.id, req.user.name);
        io.emit('note_read', { noteId, attendantId: req.user.id, attendantName: req.user.name, readAt: new Date().toISOString() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.patch('/api/notes/:id/done', authMiddleware, async (req, res) => {
    const noteId = parseInt(req.params.id);
    try {
        await db.markNoteDone(noteId);
        io.emit('note_done', { noteId, doneBy: req.user.name, doneAt: new Date().toISOString() });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/notes/:id', authMiddleware, async (req, res) => {
    const noteId = parseInt(req.params.id);
    try {
        await db.deleteNote(noteId);
        io.emit('note_deleted', { noteId });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Toggle a checklist item on a note
app.patch('/api/notes/:noteId/checklist/:itemId/toggle', authMiddleware, async (req, res) => {
    const itemId = parseInt(req.params.itemId);
    try {
        const result = await db.toggleChecklistItem(itemId, req.user.id, req.user.name);
        io.emit('checklist_toggled', { noteId: parseInt(req.params.noteId), item: result });
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── Groq API Key config ───────────────────────────────────────────────────────
app.get('/api/config/groq-key', requireAdmin, async (req, res) => {
    const key = await db.getConfig('groq_api_key') || '';
    // Mask all but first 8 chars for display
    const masked = key.length > 8 ? key.slice(0, 8) + '*'.repeat(Math.min(key.length - 8, 24)) : key;
    res.json({ configured: key.length > 0, masked });
});

app.post('/api/config/groq-key', requireAdmin, async (req, res) => {
    const { key } = req.body;
    if (!key || typeof key !== 'string' || !key.trim())
        return res.status(400).json({ success: false, message: 'Chave inválida' });
    await db.setConfig('groq_api_key', key.trim());
    res.json({ success: true });
});

// POST /api/transcribe — transcribe a base64 audio message using Groq Whisper
// Body: { audioData: "data:audio/ogg;base64,...", msgId: "...", language: "pt" }
app.post('/api/transcribe', authMiddleware, async (req, res) => {
    try {
        const groqKey = await db.getConfig('groq_api_key');
        if (!groqKey) return res.status(503).json({ success: false, message: 'Chave Groq não configurada. Configure em Painel Admin → Integração IA.' });

        const { audioData } = req.body;
        if (!audioData) return res.status(400).json({ success: false, message: 'audioData obrigatório' });

        // Strip data URI prefix — handles any number of params (e.g. codecs=opus)
        // data:audio/ogg;codecs=opus;base64,AAAA... → everything before and including the comma is removed
        const base64 = audioData.replace(/^data:[^,]+,/, '');
        if (!base64 || base64.length < 100) {
            return res.status(400).json({ success: false, message: 'Dados de áudio inválidos ou vazios.' });
        }
        const audioBuffer = Buffer.from(base64, 'base64');

        // Extract MIME from data URI — first segment between "data:" and ";"
        // data:audio/ogg;codecs=opus;base64,... → "audio/ogg"
        const mimeMatch = audioData.match(/^data:([^;,]+)/);
        const mime = mimeMatch ? mimeMatch[1].trim() : 'audio/ogg';
        const extMap = { webm: 'webm', mp4: 'mp4', wav: 'wav', mpeg: 'mp3', mp3: 'mp3', m4a: 'm4a', opus: 'ogg', flac: 'flac', ogg: 'ogg' };
        const extKey = Object.keys(extMap).find(k => mime.includes(k));
        const ext = extKey ? extMap[extKey] : 'ogg';
        const filename = `audio.${ext}`;

        const groq = new Groq({ apiKey: groqKey });

        // Diagnostic log — helps trace audio format issues
        console.log(`[Transcribe] mime=${mime}, ext=${ext}, bufferSize=${audioBuffer.length}, first4bytes=${audioBuffer.slice(0, 4).toString('hex')}`);

        // Write to temp file — most reliable cross-platform approach
        const tmpPath = path.join(require('os').tmpdir(), `zap_${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, audioBuffer);
        let transcription;
        try {
            const audioFile = await toFile(fs.createReadStream(tmpPath), filename, { type: `audio/${ext}` });
            transcription = await groq.audio.transcriptions.create({
                file: audioFile,
                model: 'whisper-large-v3-turbo',
                response_format: 'json',
                language: 'pt',
            });
        } finally {
            try { fs.unlinkSync(tmpPath); } catch (_) { }
        }

        res.json({ success: true, text: transcription.text });
    } catch (err) {
        console.error('[Transcribe] Error:', err?.error || err?.message || err);
        res.status(500).json({ success: false, message: err.message || String(err) });
    }
});


// ── DB Maintenance (admin only) ───────────────────────────────────────────────
const ADMIN_BYPASS = 'admin-bypass-or-login';
const ADMIN_BYPASS_USER = { id: 'admin', name: 'System Admin', role: 'admin' };

function requireAdmin(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'Token ausente' });
    // Server panel uses a fixed bypass token instead of JWT
    if (token === ADMIN_BYPASS) { req.user = ADMIN_BYPASS_USER; return next(); }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') return res.status(403).json({ success: false, message: 'Acesso negado' });
        req.user = decoded;
        next();
    } catch (_) { res.status(401).json({ success: false, message: 'Token inválido' }); }
}

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'Token ausente' });
    if (token === ADMIN_BYPASS) { req.user = ADMIN_BYPASS_USER; return next(); }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (_) { res.status(401).json({ success: false, message: 'Token inválido' }); }
}

// GET /api/db-stats — show current DB usage
app.get('/api/db-stats', requireAdmin, async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30', 10);
        const stats = await db.getDbStats(days);

        // Also get the actual DB file size
        let fileSizeMb = null;
        try {
            const dbPath = db.db.filename;
            const { size } = require('fs').statSync(dbPath);
            fileSizeMb = (size / 1048576).toFixed(2);
        } catch (_) { }

        res.json({ success: true, ...stats, file_size_mb: fileSizeMb });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/db-purge-media — nullify media_data blobs older than N days
app.post('/api/db-purge-media', requireAdmin, async (req, res) => {
    const days = Math.max(1, parseInt(req.body.days || '7', 10));
    try {
        const result = await db.purgeMediaData(days);
        console.log(`[DB Maintenance] purgeMediaData(${days}d) → ${result.affected} rows cleared`);
        res.json({ success: true, ...result, days });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/db-purge-chats — delete finished chats + all their messages older than N days
app.post('/api/db-purge-chats', requireAdmin, async (req, res) => {
    const days = Math.max(7, parseInt(req.body.days || '30', 10));
    try {
        const result = await db.purgeOldFinishedChats(days);
        console.log(`[DB Maintenance] purgeOldFinishedChats(${days}d) → ${result.affected} chats removed`);
        res.json({ success: true, ...result, days });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/db-vacuum — VACUUM SQLite (reclaim freed space on disk)
app.post('/api/db-vacuum', requireAdmin, async (req, res) => {
    try {
        const startTime = Date.now();
        await db.vacuumDb();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[DB Maintenance] VACUUM completed in ${elapsed}s`);
        res.json({ success: true, elapsed_sec: elapsed });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/db-purge-avatars — delete all avatar files from disk + clear avatar_url in DB
app.post('/api/db-purge-avatars', requireAdmin, async (req, res) => {
    try {
        const dir = resolveAvatarsDir();
        let deleted = 0;
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                try { fs.unlinkSync(path.join(dir, f)); deleted++; } catch (_) { }
            }
        }
        // Also clear avatar_url references in DB so the UI shows initials instead of broken paths
        await db.clearAllAvatarUrls();
        console.log(`[DB Maintenance] purgeAvatars → ${deleted} file(s) deleted`);
        res.json({ success: true, deleted });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/db-maintenance-config — read auto-purge configuration
app.get('/api/db-maintenance-config', requireAdmin, async (req, res) => {
    try {
        const [enabled, hour, mediaDays, chatsDays] = await Promise.all([
            db.getConfig('auto_purge_enabled'),
            db.getConfig('auto_purge_hour'),
            db.getConfig('auto_purge_media_days'),
            db.getConfig('auto_purge_chats_days'),
        ]);
        res.json({
            success: true,
            enabled: enabled === '1' || enabled === 'true',
            hour: parseInt(hour || '3', 10),
            mediaDays: parseInt(mediaDays || '15', 10),
            chatsDays: parseInt(chatsDays || '60', 10),
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/db-maintenance-config — save auto-purge configuration
app.post('/api/db-maintenance-config', requireAdmin, async (req, res) => {
    try {
        const { enabled, hour, mediaDays, chatsDays } = req.body;
        await Promise.all([
            db.setConfig('auto_purge_enabled', enabled ? '1' : '0'),
            db.setConfig('auto_purge_hour', String(Math.max(0, Math.min(23, parseInt(hour || '3', 10))))),
            db.setConfig('auto_purge_media_days', String(Math.max(1, parseInt(mediaDays || '15', 10)))),
            db.setConfig('auto_purge_chats_days', String(Math.max(7, parseInt(chatsDays || '60', 10)))),
        ]);
        console.log(`[DB Maintenance] Config updated — enabled=${enabled}, hour=${hour}, mediaDays=${mediaDays}, chatsDays=${chatsDays}`);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/test-avatar — test different avatar fetch methods for waiting chats
app.post('/api/test-avatar', requireAdmin, async (req, res) => {
    try {
        const { method } = req.body; // 'A', 'B', or 'C'
        const chats = await db.getQueue();
        const waiting = chats.filter(c => c.status === 'waiting' && c.id && c.id !== 'admin');
        const results = [];
        let found = 0;

        for (const chat of waiting.slice(0, 10)) { // max 10 to avoid timeout
            const result = { name: chat.name || chat.id, id: chat.id, ok: false, url: null, error: null };
            try {
                let cdnUrl = null;

                if (method === 'A') {
                    // Method A: direct getProfilePicUrl with chat.id
                    try { cdnUrl = await whatsapp.client.getProfilePicUrl(chat.id); } catch (e) { result.error = `throw: ${e.message.substring(0, 120)}`; }

                } else if (method === 'B') {
                    // Method B: use phone from DB + @c.us
                    const phone = chat.phone || chat.id.replace(/@.*$/, '');
                    const cUsId = phone + '@c.us';
                    try { cdnUrl = await whatsapp.client.getProfilePicUrl(cUsId); } catch (e) { result.error = `throw: ${e.message.substring(0, 120)}`; }

                } else if (method === 'C') {
                    // Method C: find contact in WA contacts list, then use their ID
                    const phone = chat.phone || chat.id.replace(/@.*$/, '');
                    try {
                        const contact = await whatsapp.client.getContactById(chat.id);
                        const realNumber = contact?.number || contact?.id?.user || phone;
                        try { cdnUrl = await whatsapp.client.getProfilePicUrl(realNumber + '@c.us'); } catch (_) { }
                        if (!cdnUrl && contact?.id?._serialized) {
                            try { cdnUrl = await whatsapp.client.getProfilePicUrl(contact.id._serialized); } catch (_) { }
                        }
                        if (!cdnUrl) result.error = `contact found (${realNumber}) but no pic`;
                    } catch (e) { result.error = `getContact throw: ${e.message.substring(0, 120)}`; }

                } else if (method === 'D') {
                    // Method D: bypass whatsapp-web.js entirely — use pupPage.evaluate
                    const phone = chat.phone || chat.id.replace(/@.*$/, '');
                    const jid = chat.id; // original chatId
                    try {
                        const page = whatsapp.client.pupPage;
                        if (!page) { result.error = 'pupPage not available'; }
                        else {
                            // Try multiple IDs via WA internal Store API
                            cdnUrl = await page.evaluate(async (ids) => {
                                for (const id of ids) {
                                    try {
                                        // Method 1: Store.ProfilePicThumb
                                        if (window.Store && window.Store.ProfilePicThumb) {
                                            const thumb = await window.Store.ProfilePicThumb.find(id);
                                            if (thumb && thumb.imgFull) return thumb.imgFull;
                                            if (thumb && thumb.img) return thumb.img;
                                        }
                                    } catch (_) { }
                                    try {
                                        // Method 2: Store.Contact.profilePicThumb
                                        if (window.Store && window.Store.Contact) {
                                            const contact = window.Store.Contact.get(id);
                                            if (contact) {
                                                const pic = await contact.getProfilePicThumb();
                                                if (pic && pic.imgFull) return pic.imgFull;
                                                if (pic && pic.img) return pic.img;
                                            }
                                        }
                                    } catch (_) { }
                                }
                                return null;
                            }, [jid, phone + '@c.us', phone + '@s.whatsapp.net']);

                            if (!cdnUrl) result.error = `pupPage: Store returned null for ${jid} / ${phone}`;
                        }
                    } catch (e) { result.error = `pupPage error: ${e.message.substring(0, 120)}`; }
                }

                if (cdnUrl) {
                    const safeId = (chat.phone || chat.id || '').replace(/[^a-z0-9]/gi, '_');
                    // Inline download (downloadAvatar is in whatsapp.js, not exported)
                    const dir = resolveAvatarsDir();
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const filePath = path.join(dir, `${safeId}.jpg`);
                    const local = await new Promise(resolve => {
                        const proto = cdnUrl.startsWith('https') ? require('https') : require('http');
                        const file = fs.createWriteStream(filePath);
                        proto.get(cdnUrl, r => {
                            if (r.statusCode !== 200) { file.close(); try { fs.unlinkSync(filePath); } catch (_) { } resolve(null); return; }
                            r.pipe(file);
                            file.on('finish', () => { file.close(); resolve(`/avatars/${safeId}.jpg`); });
                        }).on('error', () => { file.close(); try { fs.unlinkSync(filePath); } catch (_) { } resolve(null); });
                    });
                    if (local) {
                        result.ok = true;
                        result.url = local;
                        found++;
                        await db.updateChat(chat.id, chat.name, chat.last_message, local, chat.status, chat.phone, true);
                    } else {
                        result.error = 'download failed (status != 200)';
                    }
                } else if (!result.error) {
                    result.error = 'cdnUrl is null';
                }
            } catch (e) { result.error = e.message; }
            results.push(result);
        }

        // Refresh sidebar if any avatars were found
        if (found > 0) await broadcastQueue();
        res.json({ success: true, method, total: waiting.length, found, results });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ── WhatsApp Status/Stories ─────────────────────────────────────────────

// POST /api/status/text — publish a text status with background color + font style
app.post('/api/status/text', authMiddleware, async (req, res) => {
    try {
        if (!whatsapp.isReady) return res.status(503).json({ success: false, message: 'WhatsApp não conectado' });
        const { text, backgroundColor, fontStyle } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ success: false, message: 'Texto é obrigatório' });

        // Convert CSS hex color (#RRGGBB) to ARGB integer (0xffRRGGBB)
        let bgColor = 0xff7acca5; // default green
        if (backgroundColor && backgroundColor.startsWith('#')) {
            bgColor = parseInt('0xff' + backgroundColor.slice(1), 16);
        }

        await whatsapp.sendStatusText(text.trim(), bgColor, fontStyle || 0);
        await db.saveStatusPost({
            type: 'text', content: text.trim(), caption: null,
            backgroundColor: backgroundColor || '#7acca5', fontStyle: fontStyle || 0,
            postedBy: req.user.id.toString(), postedByName: req.user.name
        });
        res.json({ success: true, message: 'Status publicado!' });
    } catch (err) {
        console.error('[Status] Text error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/status/media — publish image/video status with caption (JSON body with base64)
app.post('/api/status/media', authMiddleware, async (req, res) => {
    try {
        if (!whatsapp.isReady) return res.status(503).json({ success: false, message: 'WhatsApp não conectado' });
        const { base64, mimetype, filename, caption } = req.body;
        if (!base64 || !mimetype) return res.status(400).json({ success: false, message: 'base64 e mimetype são obrigatórios' });

        // Strip data URI prefix if present
        const rawBase64 = base64.includes(',') ? base64.split(',')[1] : base64;

        await whatsapp.sendStatusMedia(rawBase64, mimetype, filename || 'status', caption || '');
        await db.saveStatusPost({
            type: mimetype.startsWith('video/') ? 'video' : 'image',
            content: filename || 'status', caption: caption || null,
            backgroundColor: null, fontStyle: 0,
            postedBy: req.user.id.toString(), postedByName: req.user.name
        });
        res.json({ success: true, message: 'Status de mídia publicado!' });
    } catch (err) {
        console.error('[Status] Media error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/status/history — list recent status posts
app.get('/api/status/history', authMiddleware, async (req, res) => {
    try {
        const posts = await db.getStatusHistory(30);
        res.json({ success: true, posts });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Toggle urgent flag — persiste no DB e broadcast fila atualizada
app.patch('/api/chats/:chatId/urgent', authMiddleware, async (req, res) => {
    const { chatId } = req.params;
    try {
        const result = await db.toggleUrgent(decodeURIComponent(chatId));
        await broadcastQueue();
        res.json({ success: true, is_urgent: result.is_urgent });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Toggle special client flag — fila separada para clientes especiais
app.patch('/api/chats/:chatId/special', authMiddleware, async (req, res) => {
    const { chatId } = req.params;
    try {
        const result = await db.toggleSpecial(decodeURIComponent(chatId));
        await broadcastQueue();
        res.json({ success: true, is_special: result.is_special });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Start a new chat by sending a first message to a contact
app.post('/api/start-chat', async (req, res) => {
    const { contactId, message, attendantName, attendantId } = req.body;
    if (!contactId || !message) return res.status(400).json({ success: false, message: 'contactId e message são obrigatórios' });
    if (!whatsapp.isReady) return res.status(503).json({ success: false, message: 'WhatsApp não conectado' });
    try {
        const company = await db.getConfig('company_name') || 'Empresa';
        const prefixed = `*${attendantName || 'Atendente'} | ${company}:* ${message}`;
        const msg = await whatsapp.sendMessage(contactId, prefixed); // uses _sentIds to prevent message_create duplicate
        const msgId = (msg && msg.id && msg.id.id) ? msg.id.id : `start_${Date.now()}`;
        // fromMe=true: esta é uma mensagem de saída — não deve resetar o status do chat
        await db.updateChat(contactId, null, message, null, 'waiting', null, true);
        await db.saveMessage(msgId, contactId, message, 1, null, attendantName || 'Atendente');
        // Atribuir o atendente imediatamente para evitar que o chat apareça na fila de 'waiting'
        if (attendantId) {
            const { serviceCode } = await db.assignChat(contactId, attendantId, attendantName || 'Atendente');
            const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            await db.saveChatEvent(contactId, 'open', `Atendimento iniciado por ${attendantName || 'Atendente'} em ${ts} — Cód. ${serviceCode}`);
        }
        // Broadcast updated queue so new chat appears in all attendants' sidebar immediately
        await broadcastQueue();
        res.json({ success: true, chatId: contactId });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Media Upload (REST, multipart) ──────────────────────────────────────────
// Accepts: multipart/form-data with fields: file, chatId, caption, token
app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.body.token;
    if (!token) return res.status(401).json({ success: false, message: 'Token ausente' });
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); }
    catch (_) { return res.status(401).json({ success: false, message: 'Token inválido' }); }

    if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
    const { chatId, caption } = req.body;
    if (!chatId) return res.status(400).json({ success: false, message: 'chatId obrigatório' });

    // If WA reports not ready, wait up to 3s for it to reconnect before giving up
    if (!whatsapp.isReady) {
        await new Promise(r => setTimeout(r, 3000));
        if (!whatsapp.isReady) {
            return res.status(503).json({ success: false, message: 'WhatsApp não está conectado. Aguarde a reconexão e tente novamente.' });
        }
    }

    try {
        const base64 = req.file.buffer.toString('base64');
        const mimetype = req.file.mimetype || 'application/octet-stream';
        const filename = req.file.originalname || 'file';
        const captionText = caption || '';
        const waMsg = await whatsapp.sendMedia(chatId, base64, mimetype, filename, captionText);
        const msgId = (waMsg && waMsg.id && waMsg.id.id) ? waMsg.id.id : `media_${Date.now()}`;
        const displayBody = captionText || filename;
        await db.saveMessage(msgId, chatId, displayBody, 1, null, decoded.name,
            `data:${mimetype};base64,${base64}`, mimetype, filename, null,
            Math.round(req.file.size / 1024));

        // Broadcast updated queue & history to all viewing attendants
        await broadcastQueue();
        // Push fresh history to everyone viewing this chat (including sender)
        const history = await db.getChatHistory(chatId);
        io.emit('media_sent', { chatId, msgId, history });
        res.json({ success: true, msgId });
    } catch (err) {
        console.error('[Media] Send error:', err.message);
        const isWaError = /session|not ready|disconnected|browser/i.test(err.message);
        const userMessage = isWaError
            ? 'WhatsApp não está pronto. Verifique a conexão no painel do servidor.'
            : err.message;
        res.status(500).json({ success: false, message: userMessage });
    }
});


// ── Socket Auth ──────────────────────────────────────────────────────────────
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token === 'admin-bypass-or-login') {
        socket.user = { id: 'admin', name: 'System Admin', role: 'admin' };
        return next();
    }
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) return next(new Error('Authentication error'));
            socket.user = decoded;
            next();
        });
    } else {
        next(new Error('Authentication error'));
    }
});

// Track online attendants and which chat each is viewing
const onlineAttendants = new Map();    // userId → socket
const viewingChat = new Map();         // userId → chatId
// Guest attendants: userId → Set of chatIds they were invited to
const guestChats = new Map();
// Dedup: track chatIds that recently had live_message emitted (prevents
// new_outgoing_message from showing a duplicate when message_create fires)
const _recentLiveMsgChats = new Map();
// Feature E — per-attendant lunch break (in-memory Set)
const lunchBreakSet = new Set();
whatsapp.lunchBreakSet = lunchBreakSet;

// Re-hydrate lunchBreakSet from DB on startup (survives server restart)
(async () => {
    try {
        const activeIds = await db.getActiveLunchBreaks();
        activeIds.forEach(id => lunchBreakSet.add(id));
        if (activeIds.length) console.log(`[LunchBreak] Restored ${activeIds.length} attendant(s) from DB:`, activeIds);
    } catch (e) {
        console.warn('[LunchBreak] Failed to restore from DB:', e.message);
    }
})();

// Re-hydrate guestChats from DB on startup (survives server restart + client reload)
(async () => {
    try {
        const rows = await db.loadAllGuestInvites();
        rows.forEach(({ attendant_id, chat_id }) => {
            if (!guestChats.has(attendant_id)) guestChats.set(attendant_id, new Set());
            guestChats.get(attendant_id).add(chat_id);
        });
        if (rows.length) console.log(`[GuestChats] Restored ${rows.length} invite(s) from DB.`);
    } catch (e) {
        console.warn('[GuestChats] Failed to restore from DB:', e.message);
    }
})();

/**
 * Permission-aware broadcast: each socket receives only its own filtered queue.
 * Mirrors Chatwoot's PermissionFilterService pattern.
 *   - admin  → all chats
 *   - others → waiting (unassigned) + their own attending/finished
 */
async function broadcastQueue() {
    for (const [userId, sock] of onlineAttendants) {
        try {
            const role = sock.user.role || 'attendant';
            const queue = await db.getQueueForUser(userId, role);
            // Merge in any guest-invited chats that aren't already in the queue
            const guestIds = guestChats.get(String(userId));
            if (guestIds && guestIds.size > 0) {
                for (const gChatId of guestIds) {
                    const existing = queue.find(c => c.id === gChatId);
                    if (existing) {
                        // Already in queue — just flag it
                        existing.is_guest = true;
                    } else {
                        const allChats = await db.getQueue();
                        const gChat = allChats.find(c => c.id === gChatId);
                        if (gChat) queue.push({ ...gChat, is_guest: true });
                    }
                }
            }
            // Include finished count for badge without loading all finished chats
            const finishedCount = await db.countFinishedChats(userId, role);
            sock.emit('queue_update', queue, finishedCount);
        } catch (err) {
            console.error('[broadcastQueue] error for user', userId, err.message);
        }
    }
}

// Debounced version — collapses rapid bursts (e.g. multiple images) into one DB query
let _broadcastDebounceTimer = null;
function debouncedBroadcastQueue() {
    clearTimeout(_broadcastDebounceTimer);
    _broadcastDebounceTimer = setTimeout(() => broadcastQueue(), 300);
}


io.on('connection', (socket) => {
    console.log('User connected:', socket.user.name);
    onlineAttendants.set(socket.user.id, socket);

    io.emit('online_attendants', Array.from(onlineAttendants.values())
        .map(s => ({ id: s.user.id, name: s.user.name })));

    if (isWhatsAppReady) {
        socket.emit('whatsapp_ready', { connectedAt: waConnectedAt, connectedNumber: waConnectedNumber });
    } else if (lastQR) {
        socket.emit('whatsapp_qr', lastQR);
    } else {
        // WA is still initializing (Puppeteer loading, no QR yet) — tell client to show loading state
        socket.emit('whatsapp_initializing');
    }

    // Send queue immediately to THIS socket only — targeted so guest chats arrive instantly on reconnect
    (async () => {
        try {
            const role = socket.user.role || 'attendant';
            const queue = await db.getQueueForUser(socket.user.id, role);
            const guestIds = guestChats.get(String(socket.user.id));
            if (guestIds && guestIds.size > 0) {
                const allChats = await db.getQueue();
                for (const gChatId of guestIds) {
                    const existing = queue.find(c => c.id === gChatId);
                    if (existing) {
                        existing.is_guest = true;
                    } else {
                        const gChat = allChats.find(c => c.id === gChatId);
                        if (gChat) queue.push({ ...gChat, is_guest: true });
                    }
                }
            }
            const finishedCount = await db.countFinishedChats(socket.user.id, role);
            socket.emit('queue_update', queue, finishedCount);
        } catch (e) {
            console.warn('[Connect] Failed to send queue:', e.message);
        }
    })();

    // ── Viewing chat (used for typing scope) ─────────────────────
    socket.on('set_viewing_chat', ({ chatId }) => {
        viewingChat.set(socket.user.id, chatId);
    });

    // ── Finished chats (on-demand, not in broadcast) ──────────
    socket.on('get_recent_finished', async () => {
        try {
            const role = socket.user.role || 'attendant';
            const chats = await db.getRecentFinished(10, socket.user.id, role);
            socket.emit('finished_results', chats);
        } catch (e) { console.warn('[Finished] recent error:', e.message); }
    });

    socket.on('search_finished', async ({ search }) => {
        try {
            const role = socket.user.role || 'attendant';
            const chats = await db.searchFinishedChats(search, 50, socket.user.id, role);
            socket.emit('finished_results', chats);
        } catch (e) { console.warn('[Finished] search error:', e.message); }
    });

    // ── View history (initial load — lazy) ───────────────────────
    socket.on('get_history', async ({ chatId }) => {
        viewingChat.set(socket.user.id, chatId);
        try {
            const { messages, hasMore } = await db.getPagedHistory(chatId, null, 25);
            console.log(`[History] ${chatId} initial → ${messages.length} msgs, hasMore=${hasMore}`);
            socket.emit('history_page', { chatId, messages, hasMore, isInitial: true });
        } catch (err) {
            console.error('[History] get_history error:', err.message);
        }
    });

    // ── Load older messages (lazy scroll up) ─────────────────────
    socket.on('get_history_page', async ({ chatId, beforeTimestamp }) => {
        try {
            const { messages, hasMore } = await db.getPagedHistory(chatId, beforeTimestamp, 25);
            console.log(`[History] ${chatId} before=${beforeTimestamp} → ${messages.length} msgs, hasMore=${hasMore}`);
            socket.emit('history_page', { chatId, messages, hasMore, isInitial: false });
        } catch (err) {
            console.error('[History] get_history_page error:', err.message);
        }
    });

    // ── Mark chat read (persist unread state to DB) ───────────────
    socket.on('mark_read', async ({ chatId }) => {
        try {
            await db.markChatRead(chatId);
        } catch (e) { console.warn('[mark_read]', e.message); }
    });

    // ── Claim chat ────────────────────────────────────────────────
    socket.on('claim_chat', async ({ chatId }) => {
        const result = await db.assignChat(chatId, socket.user.id, socket.user.name);
        const serviceCode = result?.serviceCode || '';
        // G — save event
        const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        await db.saveChatEvent(chatId, 'open', `Atendimento iniciado por ${socket.user.name} em ${ts} — Cód. ${serviceCode}`);
        await broadcastQueue();
        const history = await db.getChatHistory(chatId);
        socket.emit('chat_history', { chatId, history });
        // Notify the claiming socket of the generated service code
        if (serviceCode) socket.emit('service_code_assigned', { chatId, serviceCode });
    });

    // ── Finish chat (waiting OR attending) ───────────────────────────────────
    socket.on('finish_chat', async ({ chatId }) => {
        const allChats = await db.getQueue();
        const chat = allChats.find(c => c.id === chatId);
        // Only check ownership for attending chats; waiting chats anyone can close
        if (chat && chat.status === 'attending' && chat.attendant_id
            && String(chat.attendant_id) !== String(socket.user.id)
            && socket.user.role !== 'admin') {
            socket.emit('message_error', { chatId, error: 'Apenas o dono do atendimento pode encerrá-lo.' });
            return;
        }
        await db.finishChat(chatId);
        const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        await db.saveChatEvent(chatId, 'close', `Encerrado por ${socket.user.name} em ${ts}`);
        // Notify all attendants viewing this chat so their UI closes properly
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId || s.id === socket.id) {
                s.emit('chat_closed', { chatId });
            }
        });
        // Clean guest invitations for this chat (they are closed, no need to keep)
        for (const [uid, chats] of guestChats) {
            chats.delete(chatId);
            if (chats.size === 0) guestChats.delete(uid);
        }
        // Remove from DB persistence
        db.removeGuestInvitesByChat(chatId).catch(() => { });
        await broadcastQueue();
    });

    // ── Leave invited chat (guest only) ─────────────────────────
    socket.on('leave_invite', async ({ chatId }) => {
        viewingChat.delete(socket.user.id);
        const uid = String(socket.user.id);
        if (guestChats.has(uid)) {
            guestChats.get(uid).delete(chatId);
            if (guestChats.get(uid).size === 0) guestChats.delete(uid);
        }
        // Remove from DB persistence
        db.removeGuestInvite(uid, chatId).catch(() => { });
        const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        await db.saveChatEvent(chatId, 'transfer', `${socket.user.name} saiu da conversa (convidado) em ${ts}`);
        // Push updated history to remaining viewers
        const history = await db.getChatHistory(chatId);
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId)
                s.emit('chat_history', { chatId, history });
        });
        socket.emit('left_invite', { chatId });
        // Update the leaving guest's own queue (remove the invited chat)
        await broadcastQueue();
    });

    // ── Transfer chat to another attendant ────────────────────────
    socket.on('transfer_chat', async ({ chatId, targetId, chatName }) => {
        const targetSocket = onlineAttendants.get(targetId);
        if (!targetSocket) {
            socket.emit('message_error', { chatId, error: 'Atendente não está online' });
            return;
        }
        await db.assignChat(chatId, targetId, targetSocket.user.name);
        // G — save event
        const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        await db.saveChatEvent(chatId, 'transfer', `Transferido de ${socket.user.name} para ${targetSocket.user.name} em ${ts}`);
        await broadcastQueue();
        // Enrich payload with real contact data so the receiving attendant sees full info immediately
        const allChatsForTransfer = await db.getQueue();
        const transferredChat = allChatsForTransfer.find(c => c.id === chatId);
        targetSocket.emit('chat_transferred_to_you', {
            chatId,
            chatName: transferredChat?.name || chatName || chatId,
            chatAvatar: transferredChat?.avatar_url || null,
            lastMessage: transferredChat?.last_message || '',
            fromName: socket.user.name
        });
    });

    // ── Send message (to WhatsApp) ────────────────────────────────
    socket.on('send_message', async ({ chatId, body, quotedBody, quotedMsgId }) => {
        console.log('[SEND_DEBUG] Received send_message:', chatId, body?.slice(0, 50));
        const prefixedBody = `*${socket.user.name} | ${COMPANY_NAME}:* ${body}`;
        let waMsg = null;
        try {
            // Auto-claim: se o chat estiver 'waiting' quando o atendente responde,
            // atribuí-lo imediatamente para evitar duplicatas na fila.
            const allChats = await db.getQueue();
            console.log('[SEND_DEBUG] getQueue OK, chats:', allChats.length);
            const currentChat = allChats.find(c => c.id === chatId);
            if (currentChat && currentChat.status === 'waiting') {
                const { serviceCode } = await db.assignChat(chatId, socket.user.id, socket.user.name);
                const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                await db.saveChatEvent(chatId, 'open', `Atendimento iniciado por ${socket.user.name} em ${ts} — Cód. ${serviceCode}`);
                if (serviceCode) socket.emit('service_code_assigned', { chatId, serviceCode });
            }
            let sendOptions = {};
            // Try to quote the real WA message if quotedMsgId is provided
            if (quotedMsgId) {
                try {
                    const chat = await whatsapp.client.getChatById(chatId);
                    const msgs = await chat.fetchMessages({ limit: 50 });
                    const targetMsg = msgs.find(m => m.id.id === quotedMsgId || m.id._serialized === quotedMsgId);
                    if (targetMsg) sendOptions.quotedMessageId = targetMsg.id._serialized;
                } catch (_) { /* quote failed silently, send without it */ }
            }
            console.log('[SEND_DEBUG] Calling whatsapp.sendMessage, isReady:', whatsapp.isReady);
            waMsg = await whatsapp.sendMessage(chatId, prefixedBody, sendOptions);
            console.log('[SEND_DEBUG] sendMessage OK, msgId:', waMsg?.id?.id);
        } catch (err) {
            console.error('[SEND_DEBUG] ERROR in send_message try block:', err.message, err.stack);
            socket.emit('message_error', { chatId, error: err.message });
            return;
        }
        const msgId = (waMsg && waMsg.id && waMsg.id.id) ? waMsg.id.id : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // Save to DB with retry — protects against transient SQLITE_BUSY from concurrent transactions
        try {
            await db.saveMessage(msgId, chatId, body, 1, quotedBody || null, socket.user.name, null, null, null, null, null, 1, null, null, quotedMsgId || null);
        } catch (saveErr) {
            console.warn('[send_message] saveMessage failed, retrying in 500ms:', saveErr.message);
            try {
                await new Promise(r => setTimeout(r, 500));
                await db.saveMessage(msgId, chatId, body, 1, quotedBody || null, socket.user.name, null, null, null, null, null, 1, null, null, quotedMsgId || null);
            } catch (retryErr) {
                console.error('[send_message] saveMessage retry failed:', retryErr.message);
            }
        }

        // ALWAYS emit live_message — the WA message was already sent successfully
        const liveMsg = {
            id: msgId, chat_id: chatId, body, from_me: 1,
            sender_name: socket.user.name, timestamp: new Date().toISOString(),
            quoted_body: quotedBody || null, quoted_msg_id: quotedMsgId || null,
            record_type: 'message', reactions: {}
        };
        // Emit live_message to OTHER attendants viewing this chat
        // (sender already has optimistic render — sending back causes duplicate)
        Array.from(onlineAttendants.values()).forEach(s => {
            if (s.user.id !== socket.user.id && viewingChat.get(s.user.id) === chatId) {
                s.emit('live_message', { chatId, message: liveMsg });
            }
        });
        // Emit confirmation back to SENDER only — updates optimistic msg with real ID + ack
        socket.emit('message_sent_ack', { chatId, realId: msgId, ack: waMsg.ack || 1 });
        // Mark this chatId as having a recent live_message — prevents new_outgoing_message duplicate
        _recentLiveMsgChats.set(chatId, Date.now());
        setTimeout(() => _recentLiveMsgChats.delete(chatId), 15000);
        await broadcastQueue();
    });

    // ── Delete message — DB first, instant UI, then async WA sync ───────────
    socket.on('delete_message', async ({ chatId, msgId }) => {
        // 1. Update DB immediately
        await db.deleteMessage(msgId, chatId);

        // 2. Push targeted delete event — guarantee sender always gets feedback
        const emittedDelete = new Set();
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId) {
                s.emit('message_deleted', { chatId, msgId });
                emittedDelete.add(s.user.id);
            }
        });
        if (!emittedDelete.has(socket.user.id)) {
            socket.emit('message_deleted', { chatId, msgId });
        }

        // 3. Fire-and-forget: sync with WhatsApp in the background
        (async () => {
            try {
                const waChat = await whatsapp.client.getChatById(chatId);
                const waMessages = await waChat.fetchMessages({ limit: 50 });
                const waMsg = waMessages.find(m => m.id.id === msgId || m.id._serialized === msgId);
                if (waMsg) await waMsg.delete(true).catch(() => { });
            } catch (_) { /* best-effort */ }
        })();
    });

    // ── Edit message — DB first, instant UI, then async WA sync ────────────
    socket.on('edit_message', async ({ chatId, msgId, newBody }) => {
        // 1. Update DB immediately
        await db.editMessage(msgId, newBody, chatId);

        // 2. Push targeted edit event — no full history needed
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId) s.emit('message_updated', { chatId, msgId, newBody });
        });

        // 3. Fire-and-forget: sync with WhatsApp in the background
        (async () => {
            try {
                const waChat = await whatsapp.client.getChatById(chatId);
                const waMessages = await waChat.fetchMessages({ limit: 50 });
                const waMsg = waMessages.find(m => m.id.id === msgId || m.id._serialized === msgId);
                if (waMsg) await waMsg.edit(newBody).catch(() => { });
            } catch (_) { /* best-effort */ }
        })();
    });

    // ── Retry media download ───────────────────────────────────────────
    socket.on('retry_media', async ({ chatId, msgId, serializedId }) => {
        try {
            if (!serializedId) {
                socket.emit('media_retry_failed', { msgId, error: 'ID serializado não disponível' });
                return;
            }
            const result = await whatsapp.retryDownloadMedia(serializedId);
            await db.updateMessageMedia(msgId, result.mediaData, result.mediaType, result.mediaFilename, result.mediaSize);
            // Push to all viewers of this chat
            Array.from(onlineAttendants.values()).forEach(s => {
                if (viewingChat.get(s.user.id) === chatId) {
                    s.emit('media_retry_result', { chatId, msgId, ...result });
                }
            });
        } catch (e) {
            console.warn('[RetryMedia]', e.message);
            socket.emit('media_retry_failed', { msgId, error: e.message });
        }
    });

    // ── Send internal note (NOT sent via WhatsApp) ────────────────
    socket.on('send_note', async ({ chatId, body }) => {
        const noteId = `note_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await db.saveMessage(noteId, chatId, body, 2, null, socket.user.name);
        // Push only the new note — avoids full history reload
        const liveNote = {
            id: noteId, chat_id: chatId, body, from_me: 2,
            sender_name: socket.user.name, timestamp: new Date().toISOString(),
            record_type: 'message', reactions: {}
        };
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId) s.emit('live_message', { chatId, message: liveNote });
        });
    });

    // ── Typing indicators ─────────────────────────────────────────
    socket.on('typing_start', ({ chatId }) => {
        // Broadcast to others viewing the same chat
        Array.from(onlineAttendants.values()).forEach(s => {
            if (s.id !== socket.id && viewingChat.get(s.user.id) === chatId) {
                s.emit('typing_start', { chatId, name: socket.user.name });
            }
        });
    });

    socket.on('typing_stop', ({ chatId }) => {
        Array.from(onlineAttendants.values()).forEach(s => {
            if (s.id !== socket.id && viewingChat.get(s.user.id) === chatId) {
                s.emit('typing_stop', { chatId, name: socket.user.name });
            }
        });
    });

    // ── React to message (attendant) ──────────────────────────────
    socket.on('react_message', async ({ chatId, messageId, emoji }) => {
        await db.saveReaction(messageId, chatId, emoji, 'attendant', socket.user.name);
        // Push targeted reaction event — no full history needed
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId)
                s.emit('reaction_updated', { chatId, messageId });
        });
    });

    // ── Get online attendants ─────────────────────────────────────
    socket.on('get_online_attendants', () => {
        const list = Array.from(onlineAttendants.values())
            .map(s => ({ id: s.user.id, name: s.user.name }));
        socket.emit('online_attendants', list);
    });

    // ── Invite attendant ───────────────────────────────────────
    socket.on('invite_attendant', async ({ chatId, targetId, chatName }) => {
        const targetSocket = onlineAttendants.get(targetId);
        if (targetSocket) {
            // Log event in chat history
            const ts = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            await db.saveChatEvent(chatId, 'transfer', `${socket.user.name} convidou ${targetSocket.user.name} para a conversa em ${ts}`);
            // Register the guest so their queue_update includes this chat
            const targetUid = String(targetId);
            if (!guestChats.has(targetUid)) guestChats.set(targetUid, new Set());
            guestChats.get(targetUid).add(chatId);
            // Persist so it survives client reload and server restart
            db.addGuestInvite(targetUid, chatId).catch(() => { });
            // Notify the invited attendant
            targetSocket.emit('attendant_invited', {
                chatId,
                chatName: chatName || chatId,
                invitedBy: socket.user.name
            });
            // Push updated history to current viewers
            const history = await db.getChatHistory(chatId);
            Array.from(onlineAttendants.values()).forEach(s => {
                if (viewingChat.get(s.user.id) === chatId)
                    s.emit('chat_history', { chatId, history });
            });
            // Send updated queue to the invited attendant so the chat appears immediately
            await broadcastQueue();
        } else {
            socket.emit('message_error', { chatId, error: 'Atendente convidado não está online' });
        }
    });

    socket.on('disconnect', () => {
        onlineAttendants.delete(socket.user.id);
        viewingChat.delete(socket.user.id);
        // NOTE: guestChats intentionally NOT cleared — survives reload/reconnect.
        // NOTE: lunchBreakSet intentionally NOT cleared — lunch break must persist
        //       when attendant closes the app. Only cleared on explicit toggle-off.
        io.emit('online_attendants', Array.from(onlineAttendants.values())
            .map(s => ({ id: s.user.id, name: s.user.name })));
    });
});


// ── Contact Rename endpoint ──────────────────────────────────────────────────
app.patch('/api/contacts/:id/name', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Nome inválido' });
        await db.updateContactName(req.params.id, name.trim());
        // Broadcast updated queue so all attendants see the new name immediately
        broadcastQueue().catch(() => { });
        res.json({ success: true });
    } catch (err) {
        console.error('[Rename]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Auto-Reply REST endpoints (Feature E) ────────────────────────────────────

// ── Client Notes REST endpoints ──────────────────────────────────────────────
app.get('/api/client-notes/:contactId', authMiddleware, async (req, res) => {
    const notes = await db.getClientNotes(req.params.contactId);
    res.json(notes);
});
app.post('/api/client-notes', authMiddleware, async (req, res) => {
    const { contactId, body } = req.body;
    if (!contactId || !body) return res.status(400).json({ success: false });
    const result = await db.saveClientNote(contactId, body, req.user.id, req.user.name);
    res.json({ success: true, id: result.id });
});
app.delete('/api/client-notes/:id', authMiddleware, async (req, res) => {
    await db.deleteClientNote(req.params.id);
    res.json({ success: true });
});

app.get('/api/auto-replies', authMiddleware, async (req, res) => {
    const rules = await db.getAutoReplyRules();
    res.json(rules);
});
app.post('/api/auto-replies', authMiddleware, async (req, res) => {
    const { type, trigger, message } = req.body;
    if (!type || !trigger || !message) return res.status(400).json({ success: false, message: 'Campos obrigatórios' });
    const result = await db.saveAutoReplyRule(type, trigger, message);
    res.json({ success: true, id: result.id });
});
app.delete('/api/auto-replies/:id', authMiddleware, async (req, res) => {
    await db.deleteAutoReplyRule(req.params.id);
    res.json({ success: true });
});
app.put('/api/auto-replies/:id', authMiddleware, async (req, res) => {
    const { is_active } = req.body;
    await db.toggleAutoReplyRule(req.params.id, is_active);
    res.json({ success: true });
});

// Lunch break toggle — persists to DB so it survives app restarts
app.post('/api/lunch-break', authMiddleware, async (req, res) => {
    const id = String(req.user.id);
    const wasActive = lunchBreakSet.has(id);
    const nowActive = !wasActive;
    if (nowActive) lunchBreakSet.add(id); else lunchBreakSet.delete(id);
    // Persist to DB so state survives server restart
    await db.setConfig(`lunch_break_${id}`, nowActive ? '1' : '0');
    res.json({ success: true, active: nowActive });
});
app.get('/api/lunch-break', authMiddleware, async (req, res) => {
    const id = String(req.user.id);
    // Serve from in-memory first; on first load it may not be set yet
    if (lunchBreakSet.has(id)) return res.json({ active: true });
    // Fall back to DB (after restart)
    const stored = await db.getConfig(`lunch_break_${id}`);
    const active = stored === '1';
    if (active) lunchBreakSet.add(id); // re-hydrate set
    res.json({ active });
});

// ── WhatsApp Status API ──────────────────────────────────────────────────────
app.get('/api/wa-status', (req, res) => {
    res.json({ ...whatsapp.getStatus(), lastQR: lastQR || null });
});

// Force reconnect (useful when auto-reconnect stalls)
app.post('/api/wa-reconnect', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Acesso negado' });
    try {
        await whatsapp.reconnect();
        res.json({ success: true, message: 'Reconexão iniciada. Aguarde o novo QR.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Disconnect WhatsApp (logout + clear session — requires new QR scan)
app.post('/api/wa-disconnect', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Acesso negado' });
    try {
        // Notify clients before disconnecting so UI transitions immediately
        io.emit('whatsapp_disconnected', { reason: 'manual', reconnecting: false });
        await whatsapp.disconnect();
        res.json({ success: true, message: 'Desconectado. Aguarde o novo QR.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Reset WA Session (wipe wa_session folder, never touches DB) ──────────────
// Use when server is stuck at "initializing" after a bad disconnect.
app.post('/api/wa-reset-session', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Acesso negado' });
    try {
        // Tell every connected client that a reset is happening
        io.emit('whatsapp_disconnected', { reason: 'session_reset', reconnecting: true });
        // resetSession() is async — it destroys client, wipes folders, then creates fresh client
        whatsapp.resetSession().catch(err => console.error('[WA] resetSession error:', err.message));
        res.json({ success: true, message: 'Reset de sessão iniciado. O QR Code aparecerá em alguns segundos.' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── WhatsApp Events ──────────────────────────────────────────────────────────
let lastQR = null;
let isWhatsAppReady = false;
let waConnectedAt = null;
let waConnectedNumber = null;

whatsapp.on('qr', (qr) => {
    lastQR = qr;
    isWhatsAppReady = false;
    waConnectedAt = null;
    waConnectedNumber = null;
    io.emit('whatsapp_qr', qr);
});

whatsapp.on('authenticated', () => {
    console.log('[SERVER] whatsapp authenticated event received');
    io.emit('whatsapp_authenticated');
    io.emit('wa_debug', '[SERVER] authenticated event fired');
});

whatsapp.on('ready', ({ connectedAt, connectedNumber } = {}) => {
    console.log('[SERVER] whatsapp ready event received');
    io.emit('wa_debug', '[SERVER] ready event fired');
    const wasReconnecting = !isWhatsAppReady;
    isWhatsAppReady = true;
    lastQR = null;
    waConnectedAt = connectedAt || new Date();
    waConnectedNumber = connectedNumber || null;
    io.emit('whatsapp_ready', { connectedAt: waConnectedAt, connectedNumber: waConnectedNumber });

    if (wasReconnecting) {
        // Chatwoot pattern: force-sync queue so all attendants see fresh chat list/counts
        broadcastQueue().catch(err => console.warn('[Reconnect] broadcastQueue failed:', err.message));
        io.emit('wa_reconnected');

        // Re-push history for every chat currently being viewed — catches messages received while offline
        const viewingMap = new Map(); // chatId → [sockets]
        for (const [userId, sock] of onlineAttendants) {
            const chatId = viewingChat.get(userId);
            if (!chatId) continue;
            if (!viewingMap.has(chatId)) viewingMap.set(chatId, []);
            viewingMap.get(chatId).push(sock);
        }
        for (const [chatId, sockets] of viewingMap) {
            db.getChatHistory(chatId).then(history => {
                sockets.forEach(s => s.emit('chat_history', { chatId, history }));
            }).catch(err => console.warn('[Reconnect] history re-fetch failed:', chatId, err.message));
        }
        if (viewingMap.size) console.log(`[Reconnect] Re-fetched history for ${viewingMap.size} active chat(s).`);
    }
});


whatsapp.on('disconnected', (reason) => {
    isWhatsAppReady = false;
    lastQR = null;
    waConnectedAt = null;
    waConnectedNumber = null;
    io.emit('whatsapp_disconnected', { reason, reconnecting: true });
});

// ── Exponential backoff reconnect events ─────────────────────────────────────
whatsapp.on('reconnecting', ({ attempt, maxAttempts, nextRetryInMs }) => {
    console.log(`[Server] WA reconnecting: attempt ${attempt}/${maxAttempts}, next in ${nextRetryInMs / 1000}s`);
    io.emit('wa_reconnecting', { attempt, maxAttempts, nextRetryInMs });
});

whatsapp.on('reconnect_failed', () => {
    console.error('[Server] WA reconnect_failed — all attempts exhausted.');
    io.emit('wa_reconnect_failed');
});

whatsapp.on('init_error', (errMsg) => {
    console.error('[Server] WA init_error:', errMsg);
    isWhatsAppReady = false;
    lastQR = null;
    // Tell the frontend Puppeteer failed — auto-retry is now triggered by whatsapp.js
    io.emit('wa_init_error', {
        message: errMsg,
        attempt: whatsapp._reconnectAttempt,
        maxAttempts: whatsapp._maxReconnectAttempts,
    });
});



whatsapp.on('session_reset', () => {
    isWhatsAppReady = false;
    lastQR = null;
    waConnectedAt = null;
    waConnectedNumber = null;
    console.log('[Server] session_reset received — awaiting new QR from fresh client.');
    io.emit('whatsapp_disconnected', { reason: 'session_reset', reconnecting: true });
});

whatsapp.on('ack_update', ({ msgId, ack }) => {
    io.emit('message_ack_update', { msgId, ack });
});

whatsapp.on('queue_refresh', async () => {
    debouncedBroadcastQueue();
});

whatsapp.on('message', async (data) => {
    debouncedBroadcastQueue();
    io.emit('new_whatsapp_message', { chatId: data.chatId, name: data.name, avatarUrl: data.avatarUrl, body: data.body, msgId: data.msgId || null, msgSerialized: data.msgSerialized || null, mediaData: data.mediaData || null, mediaType: data.mediaType || null, mediaFilename: data.mediaFilename || null, mediaPages: data.mediaPages || null, mediaSize: data.mediaSize || null, quotedStatusMedia: data.quotedStatusMedia || null, quoted_body: data.quotedBody || null, quoted_msg_id: data.quotedMsgId || null, timestamp: data.timestamp });
    // Notify clients to refresh contacts panel when a new message arrives (new contact may have been upserted)
    io.emit('new_contact', { chatId: data.chatId, name: data.name, avatarUrl: data.avatarUrl });
    // NOTE: We intentionally do NOT push chat_history here.
    // When the client receives new_whatsapp_message it appends immediately and schedules
    // a debounced get_history (300ms) to sync from DB after the burst settles.
    // This prevents the race condition where parallel file downloads cause N partial
    // history pushes that wipe the DOM before all files are saved.

    // ── Auto-reply rules ───────────────────────────────────────────────────────
    try {
        const rules = await db.getAutoReplyRules();
        const activeRules = rules.filter(r => r.is_active);
        if (activeRules.length > 0 && whatsapp.isReady) {
            const bodyLower = (data.body || '').toLowerCase();
            const filename = (data.mediaFilename || '').toLowerCase();
            for (const rule of activeRules) {
                const trig = (rule.trigger || '').toLowerCase();
                let matched = false;
                if (rule.type === 'keyword') {
                    matched = bodyLower.includes(trig);
                } else if (rule.type === 'file_extension') {
                    matched = filename.endsWith(trig.startsWith('.') ? trig : '.' + trig);
                } else if (rule.type === 'filename_keyword') {
                    matched = filename.includes(trig);
                }
                if (matched) {
                    await whatsapp.sendMessage(data.chatId, rule.message);
                    console.log(`[AutoReply] Regra "${rule.type}:${rule.trigger}" disparou para chat ${data.chatId}`);
                    break; // Only fire first matching rule to avoid spam
                }
            }
        }
    } catch (arErr) {
        console.warn('[AutoReply] Erro ao processar regras:', arErr.message);
    }
});



whatsapp.on('outgoing_message', async (data) => {
    debouncedBroadcastQueue();
    // Skip if this chat already received a live_message from send_message handler
    // (prevents visual duplicate when message_create fires after API send)
    // Check both exact chatId AND numeric suffix match (handles @lid → @c.us mismatch)
    const recentTs = _recentLiveMsgChats.get(data.chatId);
    if (recentTs && (Date.now() - recentTs) < 10000) {
        console.log('[outgoing_message] Skipped (exact match)', data.chatId);
        return;
    }
    // Fallback: check if any recent live_message chatId shares the same numeric suffix
    const dataDigits = (data.chatId || '').replace(/@.*$/, '');
    for (const [key, ts] of _recentLiveMsgChats) {
        if ((Date.now() - ts) < 10000 && key.replace(/@.*$/, '') === dataDigits) {
            console.log('[outgoing_message] Skipped (numeric match)', data.chatId, key);
            return;
        }
    }
    io.emit('new_outgoing_message', { chatId: data.chatId, name: data.name, avatarUrl: data.avatarUrl, body: data.body, mediaData: data.mediaData || null, mediaType: data.mediaType || null, mediaFilename: data.mediaFilename || null, mediaPages: data.mediaPages || null, mediaSize: data.mediaSize || null, timestamp: data.timestamp });
});

// ACK updates (delivered, read) — push tick updates to viewing clients
whatsapp.on('ack_update', async ({ msgId, ack }) => {
    try {
        const msg = await new Promise((resolve) => {
            db.db.get(`SELECT chat_id FROM messages WHERE id = ?`, [msgId], (err, row) => resolve(row));
        });
        if (!msg) return;
        const chatId = msg.chat_id;
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId) {
                s.emit('message_ack_update', { chatId, msgId, ack });
            }
        });
    } catch (e) { console.warn('[ACK_UPDATE]', e.message); }
});

// After ready: contact names/photos refreshed — push updated queue to all clients
whatsapp.on('contacts_refreshed', async () => {
    await broadcastQueue();
    console.log('[Server] Pushed refreshed contact info to all clients.');
});

// Avatar found on delayed retry — refresh sidebar
whatsapp.on('avatar_updated', async ({ chatId, avatarUrl }) => {
    console.log(`[Avatar] Delayed retry found avatar for ${chatId}: ${avatarUrl}`);
    await broadcastQueue();
});

// WhatsApp client-side reactions
whatsapp.on('message_reaction', async ({ msgId, chatId, emoji, senderIsMe, senderName }) => {
    try {
        const senderType = senderIsMe ? 'attendant' : 'client';
        const name = senderIsMe ? 'Você (celular)' : (senderName || 'Cliente');
        await db.saveReaction(msgId, chatId, emoji, senderType, name);
        // Push targeted reaction event — avoids full history re-render
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId)
                s.emit('reaction_updated', { chatId, messageId: msgId });
        });
        io.emit('reaction_update', { chatId, messageId: msgId, emoji, senderType });
    } catch (err) {
        console.error('Error saving WhatsApp reaction:', err);
    }
});

// ── Client deleted a message (revoked for everyone) ───────────────────────────
whatsapp.on('message_revoked', async ({ msgId, chatId }) => {
    try {
        // Push targeted delete event — avoids full history re-render
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId)
                s.emit('message_deleted', { chatId, msgId });
        });
        console.log(`[Server] Pushed revoked msg ${msgId} to viewers of ${chatId}`);
    } catch (err) { console.warn('[Revoke propagation]', err.message); }
});

// ── Client edited a message ───────────────────────────────────────────────────
whatsapp.on('message_edited', async ({ msgId, chatId, newBody }) => {
    try {
        // Push targeted edit event — avoids full history re-render
        Array.from(onlineAttendants.values()).forEach(s => {
            if (viewingChat.get(s.user.id) === chatId)
                s.emit('message_updated', { chatId, msgId, newBody });
        });
        console.log(`[Server] Pushed edited msg ${msgId} to viewers of ${chatId}`);
    } catch (err) { console.warn('[Edit propagation]', err.message); }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Gateway running on http://localhost:${PORT}`));

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
    }
});

// ── Delay Alert Config endpoints ─────────────────────────────────────────────
app.get('/api/delay-alert-config', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    const [enabled, minutes, cooldown, groupId, monWaiting, monAttending, hourStart, hourEnd] = await Promise.all([
        db.getConfig('delay_alert_enabled'),
        db.getConfig('delay_alert_minutes'),
        db.getConfig('delay_alert_cooldown'),
        db.getConfig('delay_alert_group'),
        db.getConfig('delay_alert_monitor_waiting'),
        db.getConfig('delay_alert_monitor_attending'),
        db.getConfig('delay_alert_hour_start'),
        db.getConfig('delay_alert_hour_end'),
    ]);
    res.json({
        enabled: enabled === '1',
        minutes: parseInt(minutes || '10', 10),
        cooldown: parseInt(cooldown || '30', 10),
        groupId: groupId || '',
        monitorWaiting: monWaiting !== '0',
        monitorAttending: monAttending === '1',
        hourStart: parseInt(hourStart || '8', 10),
        hourEnd: parseInt(hourEnd || '18', 10)
    });
});

app.post('/api/delay-alert-config', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    const { enabled, minutes, cooldown, groupId, monitorWaiting, monitorAttending, hourStart, hourEnd } = req.body;
    await Promise.all([
        db.setConfig('delay_alert_enabled', enabled ? '1' : '0'),
        db.setConfig('delay_alert_minutes', String(parseInt(minutes, 10) || 10)),
        db.setConfig('delay_alert_cooldown', String(parseInt(cooldown, 10) || 30)),
        db.setConfig('delay_alert_group', (groupId || '').trim()),
        db.setConfig('delay_alert_monitor_waiting', monitorWaiting === false ? '0' : '1'),
        db.setConfig('delay_alert_monitor_attending', monitorAttending ? '1' : '0'),
        db.setConfig('delay_alert_hour_start', String(parseInt(hourStart, 10) || 8)),
        db.setConfig('delay_alert_hour_end', String(parseInt(hourEnd, 10) || 18)),
    ]);
    res.json({ success: true });
});

// ── List WhatsApp groups (for group picker in admin panel) ───────────────────
app.get('/api/wa-groups', authMiddleware, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ success: false });
    if (!whatsapp.isReady) return res.status(503).json({ success: false, message: 'WhatsApp não conectado' });
    try {
        const chats = await whatsapp.client.getChats();
        const groups = chats
            .filter(c => c.isGroup)
            .map(c => ({ id: c.id._serialized, name: c.name || c.id._serialized }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json(groups);
    } catch (err) {
        console.error('[WA-Groups]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Delay Alert Watchdog ──────────────────────────────────────────────────────
let _delayWatchdogTimer = null;

async function runDelayAlertWatchdog() {
    try {
        const enabled = await db.getConfig('delay_alert_enabled');
        if (enabled !== '1') return;

        const groupId = (await db.getConfig('delay_alert_group') || '').trim();
        if (!groupId) return;

        const alertMinutes = parseInt(await db.getConfig('delay_alert_minutes') || '10', 10);
        const cooldownMinutes = parseInt(await db.getConfig('delay_alert_cooldown') || '30', 10);
        const monWaiting = (await db.getConfig('delay_alert_monitor_waiting')) !== '0';
        const monAttending = (await db.getConfig('delay_alert_monitor_attending')) === '1';
        const hourStart = parseInt(await db.getConfig('delay_alert_hour_start') || '8', 10);
        const hourEnd = parseInt(await db.getConfig('delay_alert_hour_end') || '18', 10);

        // Business hours check — use local server time (Brasília = UTC-3)
        const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
        const currentHour = nowLocal.getHours();
        if (currentHour < hourStart || currentHour >= hourEnd) {
            console.log(`[DelayAlert] Fora do horário comercial (${currentHour}h, janela: ${hourStart}h-${hourEnd}h). Pulando.`);
            return;
        }

        if (!whatsapp.isReady) return;

        const allChats = await db.getQueue();
        const activeChats = allChats.filter(c => {
            if (c.status === 'waiting') return monWaiting;
            if (c.status === 'attending') return monAttending;
            return false;
        });
        const now = Date.now();

        for (const chat of activeChats) {
            try {
                // Skip if attendant is on lunch break
                if (chat.status === 'attending' && chat.attendant_id && lunchBreakSet.has(String(chat.attendant_id))) {
                    console.log(`[DelayAlert] ⏭ ${chat.id} — atendente em almoço`);
                    continue;
                }

                // Last client message
                const lastClientMsg = await db.getLastClientMessageTime(chat.id);
                if (!lastClientMsg) {
                    console.log(`[DelayAlert] ⏭ ${chat.id} — sem mensagem do cliente`);
                    continue;
                }

                const minutesSinceClient = (now - lastClientMsg.getTime()) / 60000;
                console.log(`[DelayAlert] 🔍 ${chat.id} (${chat.status}) — ${minutesSinceClient.toFixed(1)} min sem resposta (threshold: ${alertMinutes} min)`);
                if (minutesSinceClient < alertMinutes) {
                    console.log(`[DelayAlert] ⏭ ${chat.id} — abaixo do threshold`);
                    continue;
                }

                // Last attendant message
                const lastAttendantMsg = await db.getLastAttendantMessageTime(chat.id);
                if (lastAttendantMsg && lastAttendantMsg.getTime() > lastClientMsg.getTime()) {
                    console.log(`[DelayAlert] ⏭ ${chat.id} — atendente já respondeu`);
                    continue;
                }

                // Cooldown: check when we last notified this chat
                const lastNotifiedStr = await db.getConfig(`delay_alert_notified_${chat.id}`);
                if (lastNotifiedStr) {
                    const lastNotified = new Date(lastNotifiedStr).getTime();
                    const minutesSinceNotif = (now - lastNotified) / 60000;
                    if (minutesSinceNotif < cooldownMinutes) {
                        console.log(`[DelayAlert] ⏭ ${chat.id} — cooldown ativo (${minutesSinceNotif.toFixed(1)} / ${cooldownMinutes} min)`);
                        continue;
                    }
                }

                // Build alert message
                const clientName = chat.name && chat.name !== chat.id ? chat.name : chat.id.replace(/@.*$/, '');
                const minutesWaiting = Math.round(minutesSinceClient);
                const lastMsgTime = lastClientMsg.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

                let statusLine;
                let attendantLine = '';
                if (chat.status === 'waiting') {
                    statusLine = '📋 Status: Aguardando atendente';
                } else {
                    statusLine = '📋 Status: Em atendimento';
                    if (chat.attendant_name) {
                        attendantLine = `\n🧑‍💼 Atendente: ${chat.attendant_name}`;
                    }
                }

                const alertMsg = `⚠️ *Sem resposta há ${minutesWaiting} min*\n👤 Cliente: ${clientName}\n${statusLine}${attendantLine}\n🕐 Última mensagem: ${lastMsgTime}`;

                await whatsapp.sendMessage(groupId, alertMsg);
                await db.setConfig(`delay_alert_notified_${chat.id}`, new Date().toISOString());
                console.log(`[DelayAlert] ✅ Notificou grupo sobre chat ${chat.id} (${minutesWaiting} min sem resposta)`);
            } catch (chatErr) {
                console.warn(`[DelayAlert] Erro ao processar chat ${chat.id}:`, chatErr.message);
            }
        }
    } catch (err) {
        console.warn('[DelayAlert] Watchdog error:', err.message);
    }
}

function startDelayAlertWatchdog() {
    if (_delayWatchdogTimer) return; // already running
    console.log('[DelayAlert] Watchdog iniciado (intervalo: 60s)');
    _delayWatchdogTimer = setInterval(runDelayAlertWatchdog, 60000);
    // Run immediately once on start
    runDelayAlertWatchdog();
}

// Start watchdog when WhatsApp connects
whatsapp.on('ready', () => startDelayAlertWatchdog());
// Also try to start immediately in case WA is already ready when this code loads
if (whatsapp.isReady) startDelayAlertWatchdog();

// ══════════════════════════════════════════════════════════════════════════════
// Auto-Purge Scheduler — runs daily at a configurable hour
// ══════════════════════════════════════════════════════════════════════════════
let _lastAutoPurgeDate = null;
let _autoPurgeRunning = false;

async function runAutoPurge() {
    if (_autoPurgeRunning) return;
    _autoPurgeRunning = true;
    const started = Date.now();
    try {
        const mediaDays = parseInt(await db.getConfig('auto_purge_media_days') || '15', 10);
        const chatsDays = parseInt(await db.getConfig('auto_purge_chats_days') || '60', 10);

        console.log(`[AutoPurge] Starting — media>${mediaDays}d, chats>${chatsDays}d`);

        // 1) Purge old media blobs
        const mediaResult = await db.purgeMediaData(mediaDays);
        console.log(`[AutoPurge] purgeMediaData(${mediaDays}d) → ${mediaResult.affected} rows`);

        // 2) Purge old finished chats
        const chatsResult = await db.purgeOldFinishedChats(chatsDays);
        console.log(`[AutoPurge] purgeOldFinishedChats(${chatsDays}d) → ${chatsResult.affected} chats`);

        // 3) VACUUM to reclaim disk space
        await db.vacuumDb();
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`[AutoPurge] VACUUM done — total ${elapsed}s`);
    } catch (err) {
        console.error('[AutoPurge] Error:', err.message);
    } finally {
        _autoPurgeRunning = false;
    }
}

// Check every 60s if it's time to run auto-purge
setInterval(async () => {
    try {
        const enabled = await db.getConfig('auto_purge_enabled');
        if (enabled !== '1' && enabled !== 'true') return;

        const hour = parseInt(await db.getConfig('auto_purge_hour') || '3', 10);
        const now = new Date();
        // Use local date parts (consistent with getHours() which is also local)
        const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

        if (now.getHours() === hour && _lastAutoPurgeDate !== todayStr) {
            _lastAutoPurgeDate = todayStr;
            console.log(`[AutoPurge] Triggered at ${now.toLocaleTimeString('pt-BR')} (local time)`);
            runAutoPurge();
        }
    } catch (_) { }
}, 60000);

console.log('[AutoPurge] Scheduler registered (checks every 60s)');

// ── Recurring Note Scheduler ─────────────────────────────────────────────────
// Every 60s: check if any recurring note's scheduled time just arrived → emit toast
let _lastNoteActivateMinute = '';
setInterval(async () => {
    try {
        const now = new Date();
        const currentMinute = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
        if (currentMinute === _lastNoteActivateMinute) return; // already checked this minute
        _lastNoteActivateMinute = currentMinute;
        const today = now.getDay();

        // Fetch ALL recurring notes (admin view) to check times
        const allNotes = await db.getNotes('__scheduler__', 'admin');
        const activated = allNotes.filter(n =>
            n.is_recurring &&
            n.recurrence_time === currentMinute &&
            (!n.recurrence_days || !n.recurrence_days.length || n.recurrence_days.includes(today))
        );
        if (!activated.length) return;

        // Emit toast to all online attendants
        for (const note of activated) {
            for (const [, sock] of onlineAttendants) {
                sock.emit('note_activated', {
                    id: note.id,
                    title: note.title,
                    body: note.body,
                    created_by_name: note.created_by_name
                });
            }
        }
        console.log(`[NoteScheduler] Activated ${activated.length} note(s) at ${currentMinute}`);
    } catch (e) {
        console.warn('[NoteScheduler] Error:', e.message);
    }
}, 60000);
console.log('[NoteScheduler] Registered (checks every 60s)');
