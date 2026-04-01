const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

class Database {
    constructor() {
        // DB path priority (highest → lowest):
        // 1. DB_PATH env variable  — set this on VPS/production for full control
        // 2. Electron userData     — survives client builds on Windows desktop
        // 3. OS home dir fallback  — ~/.zapmax/data.sqlite (safe on Linux/macOS VPS)
        // 4. Dados/ inside server  — legacy fallback (data lost on redeploy!)
        let dbDir;
        if (process.env.DB_PATH) {
            // Explicit override: DB_PATH=/srv/zapmax or DB_PATH=/srv/zapmax/data.sqlite
            const p = process.env.DB_PATH;
            dbDir = p.endsWith('.sqlite') ? path.dirname(p) : p;
        } else if (process.env.APPDATA) {
            // Windows Electron/desktop: %APPDATA%\ZapMax
            dbDir = path.join(process.env.APPDATA, 'ZapMax');
        } else {
            // Linux/macOS VPS: ~/.zapmax
            dbDir = path.join(require('os').homedir(), '.zapmax');
        }
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        const dbFile = (process.env.DB_PATH && process.env.DB_PATH.endsWith('.sqlite'))
            ? process.env.DB_PATH
            : path.join(dbDir, 'data.sqlite');

        // One-time migration: copy from old location if new location is empty
        const legacyPath = path.join(__dirname, 'Dados', 'data.sqlite');
        if (!fs.existsSync(dbFile) && fs.existsSync(legacyPath)) {
            try {
                fs.copyFileSync(legacyPath, dbFile);
                console.log(`[DB] Migrated database from ${legacyPath} → ${dbFile}`);
            } catch (e) {
                console.warn('[DB] Migration copy failed:', e.message);
            }
        }

        console.log('Database path:', dbFile);
        this.db = new sqlite3.Database(dbFile, (err) => {
            if (err) {
                console.error('Error opening database', err);
            } else {
                this.init();
            }
        });
    }

    init() {
        this.db.serialize(() => {
            // ── Performance PRAGMAs ──────────────────────────────────────────
            // Must run BEFORE any table creation / queries
            this.db.run(`PRAGMA busy_timeout = 5000`);
            this.db.run(`PRAGMA journal_mode = WAL`, (err, row) => {
                if (!err) console.log('[DB] Journal mode:', row?.journal_mode || 'WAL');
            });
            this.db.run(`PRAGMA synchronous = NORMAL`);   // safe tradeoff for WAL
            this.db.run(`PRAGMA cache_size = -8000`);      // 8 MB page cache
            this.db.run(`PRAGMA temp_store = MEMORY`);     // temp tables in RAM
            this.db.run(`PRAGMA mmap_size = 67108864`);    // 64 MB memory-mapped I/O

            // Attendants
            this.db.run(`CREATE TABLE IF NOT EXISTS attendants (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE,
                password TEXT,
                name TEXT,
                role TEXT DEFAULT 'attendant',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Chats
            this.db.run(`CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                name TEXT,
                avatar_url TEXT,
                last_message TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'waiting',
                attendant_id TEXT,
                attendant_name TEXT
            )`);

            // Migrate existing chats table
            this.db.run(`ALTER TABLE chats ADD COLUMN avatar_url TEXT`, () => { });
            this.db.run(`ALTER TABLE chats ADD COLUMN service_code TEXT`, () => { });
            this.db.run(`ALTER TABLE chats ADD COLUMN phone TEXT`, () => { });  // real phone for @c.us IDs
            this.db.run(`ALTER TABLE chats ADD COLUMN wa_id TEXT`, () => { });   // native WA @lid for sending

            // Migrate messages: add edit/delete tracking
            this.db.run(`ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN msg_serialized TEXT`, () => { });
            // Clean invalid phone values (WA internal IDs > 15 digits stored as phone)
            this.db.run(`UPDATE chats SET phone = NULL WHERE phone IS NOT NULL AND length(phone) > 15`, () => { });
            this.db.run(`UPDATE contacts SET number = NULL WHERE number IS NOT NULL AND length(number) > 15`, () => { });
            // Fix chats created with invalid status (timestamp passed as status due to arg order bug)
            this.db.run(`UPDATE chats SET status = 'waiting' WHERE status NOT IN ('waiting', 'attending', 'finished')`, (err) => {
                if (!err) console.log('[DB] Fixed chats with invalid status');
            });

            // Guest invitations — persisted so they survive client reload and server restart
            this.db.run(`CREATE TABLE IF NOT EXISTS guest_invites (
                attendant_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (attendant_id, chat_id)
            )`);

            // Messages — from_me: 0=client, 1=attendant, 2=internal_note
            this.db.run(`CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT,
                body TEXT,
                from_me INTEGER,
                quoted_body TEXT,
                sender_name TEXT,
                media_data TEXT,
                media_type TEXT,
                media_filename TEXT,
                media_pages INTEGER,
                media_size INTEGER,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(chat_id) REFERENCES chats(id)
            )`);

            // Reactions
            this.db.run(`CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                emoji TEXT NOT NULL,
                sender_type TEXT DEFAULT 'client',
                sender_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Canned responses
            this.db.run(`CREATE TABLE IF NOT EXISTS canned_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Contacts (synced from WhatsApp phone book)
            this.db.run(`CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                name TEXT,
                number TEXT,
                avatar_url TEXT,
                is_business INTEGER DEFAULT 0,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Config
            this.db.run(`CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            )`);

            // Auto-reply rules
            this.db.run(`CREATE TABLE IF NOT EXISTS auto_reply_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                trigger TEXT NOT NULL,
                message TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Chat events (open/close/transfer)
            this.db.run(`CREATE TABLE IF NOT EXISTS chat_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL,
                type TEXT NOT NULL,
                description TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Client notes (per contact, visible to all attendants)
            this.db.run(`CREATE TABLE IF NOT EXISTS client_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id TEXT NOT NULL,
                body TEXT NOT NULL,
                author_id TEXT,
                author_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Feature 5: Labels — coloridas, atribuíveis a conversas
            this.db.run(`CREATE TABLE IF NOT EXISTS labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                color TEXT DEFAULT '#6366f1',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            this.db.run(`CREATE TABLE IF NOT EXISTS chat_labels (
                chat_id TEXT NOT NULL,
                label_id INTEGER NOT NULL,
                PRIMARY KEY (chat_id, label_id),
                FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE
            )`);

            // Feature 6: Snooze — adiar conversa até data/hora
            this.db.run(`ALTER TABLE chats ADD COLUMN snoozed_until DATETIME`, () => { });

            // Migrations
            this.db.run(`ALTER TABLE messages ADD COLUMN quoted_body TEXT`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN sender_name TEXT`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN media_data TEXT`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN media_type TEXT`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN media_filename TEXT`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN media_pages INTEGER`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN media_size INTEGER`, () => { });
            // Feature F — message ACK (0=pending,1=sent,2=delivered,3=read)
            this.db.run(`ALTER TABLE messages ADD COLUMN ack INTEGER DEFAULT 1`, () => { });
            // Feature D — quoted status media
            this.db.run(`ALTER TABLE messages ADD COLUMN quoted_status_media TEXT`, () => { });
            this.db.run(`ALTER TABLE messages ADD COLUMN quoted_status_type TEXT`, () => { });
            // Scroll-to-quoted: ID da mensagem original citada (para navegação precisa pelo ID)
            this.db.run(`ALTER TABLE messages ADD COLUMN quoted_msg_id TEXT`, () => { });
            // Urgente: flag persistente por conversa
            this.db.run(`ALTER TABLE chats ADD COLUMN is_urgent INTEGER DEFAULT 0`, () => { });
            this.db.run(`ALTER TABLE chats ADD COLUMN has_unread INTEGER DEFAULT 0`, () => { });
            // Cliente especial: fila separada
            this.db.run(`ALTER TABLE chats ADD COLUMN is_special INTEGER DEFAULT 0`, () => { });
            // Protect user-renamed contacts from being overwritten by WA sync
            this.db.run(`ALTER TABLE contacts ADD COLUMN renamed_manually INTEGER DEFAULT 0`, () => { });
            // Recurring notes: stay visible, sorted by deadline proximity
            this.db.run(`ALTER TABLE internal_notes ADD COLUMN is_recurring INTEGER DEFAULT 0`, () => { });
            // Day-of-week recurrence: JSON array e.g. "[0,1,3,5]" (0=Sun, 6=Sat)
            this.db.run(`ALTER TABLE internal_notes ADD COLUMN recurrence_days TEXT`, () => { });
            // Scheduled time for recurring notes: "HH:MM" format
            this.db.run(`ALTER TABLE internal_notes ADD COLUMN recurrence_time TEXT`, () => { });

            // Internal notes (mural de avisos entre atendentes)
            this.db.run(`CREATE TABLE IF NOT EXISTS internal_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT,
                created_by TEXT NOT NULL,
                created_by_name TEXT NOT NULL,
                assigned_to TEXT,
                assigned_to_name TEXT,
                deadline DATETIME,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            this.db.run(`CREATE TABLE IF NOT EXISTS note_reads (
                note_id INTEGER NOT NULL,
                attendant_id TEXT NOT NULL,
                attendant_name TEXT,
                read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (note_id, attendant_id)
            )`);

            // Note checklist items (unlimited sub-tasks per note)
            this.db.run(`CREATE TABLE IF NOT EXISTS note_checklist_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                is_checked INTEGER DEFAULT 0,
                checked_by TEXT,
                checked_by_name TEXT,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY(note_id) REFERENCES internal_notes(id) ON DELETE CASCADE
            )`);

            // WhatsApp Status/Stories posts history
            this.db.run(`CREATE TABLE IF NOT EXISTS status_posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                content TEXT,
                caption TEXT,
                background_color TEXT,
                font_style INTEGER DEFAULT 0,
                posted_by TEXT NOT NULL,
                posted_by_name TEXT NOT NULL,
                posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // ── Performance Indexes ──────────────────────────────────────────
            // Eliminates full table scans on all hot query paths.
            // IF NOT EXISTS ensures safe re-runs on existing databases.

            // messages: getPagedHistory, getLastClientMessageTime, getLastAttendantMessageTime
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp DESC)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_chat_fromme ON messages(chat_id, from_me, is_deleted)`);

            // reactions: LEFT JOIN in getPagedHistory / getChatHistory
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id)`);

            // chats: getQueueForUser, resolveActiveChatId, countFinishedChats
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status, timestamp DESC)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chats_phone ON chats(phone)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chats_wa_id ON chats(wa_id)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chats_attendant ON chats(attendant_id, status)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chats_snoozed ON chats(snoozed_until)`);

            // chat_events: event merge in getPagedHistory
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chat_events_chat_ts ON chat_events(chat_id, timestamp)`);

            // contacts: searchContacts LIKE queries
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name)`);
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_contacts_number ON contacts(number)`);

            // chat_labels: label sub-query in getQueueForUser
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_chat_labels_chat ON chat_labels(chat_id)`);

            // client_notes: contact drawer
            this.db.run(`CREATE INDEX IF NOT EXISTS idx_client_notes_contact ON client_notes(contact_id)`);

            console.log('[DB] Performance indexes ensured.');

            this.createAdmin();
            // Cleanup: merge duplicate chats on startup
            this.mergeDuplicateChats();
        });
    }

    async createAdmin() {
        const hash = await bcrypt.hash('admin123', 10);
        this.db.run(`INSERT OR IGNORE INTO attendants (id, username, password, name, role)
                     VALUES ('admin', 'admin', ?, 'Super Admin', 'admin')`, [hash]);
    }

    // ── Startup cleanup: merge duplicate chats for the same phone or wa_id ─────
    // Detects chats sharing the same phone number OR the same wa_id, keeps the
    // one with highest priority (attending > waiting > finished, most recent on
    // tie), moves all messages and events to it, and deletes the orphaned dupes.
    mergeDuplicateChats() {
        const mergeRows = (rows, keyName) => {
            if (!rows || rows.length === 0) return;
            console.log(`[MergeDuplicates] Found ${rows.length} ${keyName}(s) with duplicate chats. Merging...`);
            let totalMerged = 0;
            rows.forEach(({ key, ids }) => {
                const chatIds = ids.split(',');
                this.db.all(
                    `SELECT id, status, timestamp, wa_id FROM chats WHERE id IN (${chatIds.map(() => '?').join(',')})
                     ORDER BY
                       CASE status WHEN 'attending' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
                       timestamp DESC`,
                    chatIds,
                    (err2, chats) => {
                        if (err2 || !chats || chats.length < 2) return;
                        const mainChat = chats[0];
                        const duplicates = chats.slice(1);
                        duplicates.forEach(dup => {
                            this.db.run(`UPDATE messages SET chat_id = ? WHERE chat_id = ?`, [mainChat.id, dup.id]);
                            this.db.run(`UPDATE chat_events SET chat_id = ? WHERE chat_id = ?`, [mainChat.id, dup.id]);
                            this.db.run(`UPDATE OR IGNORE chat_labels SET chat_id = ? WHERE chat_id = ?`, [mainChat.id, dup.id]);
                            // Preserve wa_id on the winner if it doesn't have one
                            if (!mainChat.wa_id && dup.wa_id) {
                                this.db.run(`UPDATE chats SET wa_id = ? WHERE id = ? AND wa_id IS NULL`, [dup.wa_id, mainChat.id]);
                            }
                            this.db.run(`DELETE FROM chats WHERE id = ?`, [dup.id]);
                            totalMerged++;
                            console.log(`[MergeDuplicates] Merged ${dup.id} (${dup.status}) → ${mainChat.id} (${mainChat.status}) [${keyName}: ${key}]`);
                        });
                    }
                );
            });
            setTimeout(() => console.log(`[MergeDuplicates] Done (${keyName}). Merged ${totalMerged} duplicate chat(s).`), 2000);
        };

        // Pass 1: group by phone
        this.db.all(
            `SELECT phone AS key, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
             FROM chats WHERE phone IS NOT NULL AND phone != ''
             GROUP BY phone HAVING cnt > 1`,
            [],
            (err, rows) => {
                if (!err) mergeRows(rows, 'phone');
                else console.warn('[MergeDuplicates] phone query error:', err.message);
            }
        );

        // Pass 2: group by wa_id (catches @lid duplicates phone-merge missed)
        this.db.all(
            `SELECT wa_id AS key, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
             FROM chats WHERE wa_id IS NOT NULL AND wa_id != ''
             GROUP BY wa_id HAVING cnt > 1`,
            [],
            (err, rows) => {
                if (!err) mergeRows(rows, 'wa_id');
                else console.warn('[MergeDuplicates] wa_id query error:', err.message);
            }
        );
    }

    // ── Internal Notes ───────────────────────────────────────────────────────
    createNote({ title, body, createdBy, createdByName, assignedTo, assignedToName, deadline, isRecurring, recurrenceDays, recurrenceTime, checklist }) {
        const sqlDb = this.db; // capture before callback changes `this`
        return new Promise((resolve, reject) => {
            const recDays = Array.isArray(recurrenceDays) && recurrenceDays.length ? JSON.stringify(recurrenceDays) : null;
            const recurring = recDays ? 1 : (isRecurring ? 1 : 0);
            const recTime = (recurring && recurrenceTime) ? recurrenceTime : null;
            sqlDb.run(
                `INSERT INTO internal_notes (title, body, created_by, created_by_name, assigned_to, assigned_to_name, deadline, is_recurring, recurrence_days, recurrence_time)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [title, body || null, createdBy, createdByName, assignedTo || null, assignedToName || null, deadline || null, recurring, recDays, recTime],
                function (err) {
                    if (err) return reject(err);
                    const noteId = this.lastID;
                    // Insert checklist items if provided
                    if (Array.isArray(checklist) && checklist.length) {
                        const stmt = sqlDb.prepare(`INSERT INTO note_checklist_items (note_id, text, sort_order) VALUES (?, ?, ?)`);
                        checklist.forEach((item, i) => {
                            if (item && typeof item === 'object' && item.text?.trim()) {
                                stmt.run(noteId, item.text.trim(), i);
                            } else if (typeof item === 'string' && item.trim()) {
                                stmt.run(noteId, item.trim(), i);
                            }
                        });
                        stmt.finalize();
                    }
                    resolve(noteId);
                }
            );
        });
    }

    getNotes(userId, role) {
        return new Promise((resolve, reject) => {
            // Visibility: admin sees all, attendant sees unassigned + own (creator or assignee)
            const whereClause = role === 'admin'
                ? ''
                : `WHERE (n.assigned_to IS NULL OR n.assigned_to = ? OR n.created_by = ?)`;
            const params = role === 'admin' ? [] : [String(userId), String(userId)];
            this.db.all(
                `SELECT n.*, 
                    (SELECT json_group_array(json_object('attendant_id', r.attendant_id, 'attendant_name', r.attendant_name, 'read_at', r.read_at))
                     FROM note_reads r WHERE r.note_id = n.id) as reads_json,
                    (SELECT json_group_array(json_object('id', ci.id, 'text', ci.text, 'is_checked', ci.is_checked, 'checked_by', ci.checked_by, 'checked_by_name', ci.checked_by_name, 'sort_order', ci.sort_order))
                     FROM note_checklist_items ci WHERE ci.note_id = n.id ORDER BY ci.sort_order) as checklist_json
                 FROM internal_notes n ${whereClause}
                 ORDER BY
                   CASE WHEN n.is_recurring = 1 AND n.deadline IS NOT NULL
                        THEN ABS(julianday(n.deadline) - julianday('now'))
                        ELSE 999999 END ASC,
                   n.created_at DESC`,
                params,
                (err, rows) => {
                    if (err) return reject(err);
                    const now = new Date();
                    const today = now.getDay(); // 0=Sun, 6=Sat
                    const nowHHMM = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
                    const result = rows
                        .map(r => ({
                            ...r,
                            reads: JSON.parse(r.reads_json || '[]'),
                            checklist: JSON.parse(r.checklist_json || '[]').filter(ci => ci && ci.id),
                            recurrence_days: r.recurrence_days ? JSON.parse(r.recurrence_days) : null
                        }))
                        // Filter recurring notes by day-of-week
                        .filter(r => {
                            if (!r.is_recurring || !r.recurrence_days || !r.recurrence_days.length) return true;
                            return r.recurrence_days.includes(today);
                        })
                        // Time-based visibility: before scheduled time, only creator sees it
                        .filter(r => {
                            if (!r.is_recurring || !r.recurrence_time) return true;
                            if (nowHHMM >= r.recurrence_time) return true; // time has passed — visible to all
                            return String(r.created_by) === String(userId); // before time — creator only
                        });
                    resolve(result);
                }
            );
        });
    }

    markNoteRead(noteId, attendantId, attendantName) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO note_reads (note_id, attendant_id, attendant_name) VALUES (?, ?, ?)`,
                [noteId, attendantId, attendantName],
                err => err ? reject(err) : resolve()
            );
        });
    }

    markNoteDone(noteId) {
        return new Promise((resolve, reject) => {
            // Recurring notes cannot be marked as done
            this.db.get(`SELECT is_recurring FROM internal_notes WHERE id = ?`, [noteId], (err, row) => {
                if (err) return reject(err);
                if (row && row.is_recurring) return reject(new Error('Notas recorrentes não podem ser concluídas'));
                this.db.run(
                    `UPDATE internal_notes SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [noteId],
                    err2 => err2 ? reject(err2) : resolve()
                );
            });
        });
    }

    deleteNote(noteId) {
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM note_checklist_items WHERE note_id = ?`, [noteId], () => {
                this.db.run(`DELETE FROM note_reads WHERE note_id = ?`, [noteId], () => {
                    this.db.run(`DELETE FROM internal_notes WHERE id = ?`, [noteId],
                        err => err ? reject(err) : resolve());
                });
            });
        });
    }

    toggleChecklistItem(itemId, userId, userName) {
        return new Promise((resolve, reject) => {
            this.db.get(`SELECT id, is_checked FROM note_checklist_items WHERE id = ?`, [itemId], (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error('Item não encontrado'));
                const newVal = row.is_checked ? 0 : 1;
                const checkedBy = newVal ? userId : null;
                const checkedByName = newVal ? userName : null;
                this.db.run(
                    `UPDATE note_checklist_items SET is_checked = ?, checked_by = ?, checked_by_name = ? WHERE id = ?`,
                    [newVal, checkedBy, checkedByName, itemId],
                    err2 => err2 ? reject(err2) : resolve({ id: itemId, is_checked: newVal, checked_by: checkedBy, checked_by_name: checkedByName })
                );
            });
        });
    }

    // ── WhatsApp Status/Stories ──────────────────────────────────────────────
    saveStatusPost({ type, content, caption, backgroundColor, fontStyle, postedBy, postedByName }) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO status_posts (type, content, caption, background_color, font_style, posted_by, posted_by_name) VALUES (?,?,?,?,?,?,?)`,
                [type, content || null, caption || null, backgroundColor || null, fontStyle || 0, postedBy, postedByName],
                function (err) { err ? reject(err) : resolve({ id: this.lastID }); }
            );
        });
    }

    getStatusHistory(limit = 20) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM status_posts ORDER BY posted_at DESC LIMIT ?`, [limit],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });
    }

    markChatRead(chatId) {
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE chats SET has_unread = 0 WHERE id = ?`, [chatId],
                err => err ? reject(err) : resolve());
        });
    }

    // Auth
    authenticate(username, password) {
        return new Promise((resolve, reject) => {
            this.db.get(`SELECT * FROM attendants WHERE username = ?`, [username], async (err, user) => {
                if (err) return reject(err);
                if (!user) return resolve(null);
                const match = await bcrypt.compare(password, user.password);
                if (match) resolve(user);
                else resolve(null);
            });
        });
    }

    // Attendant Management
    addAttendant(username, password, name) {
        return new Promise(async (resolve, reject) => {
            const hash = await bcrypt.hash(password, 10);
            const id = 'att_' + Date.now();
            this.db.run(`INSERT INTO attendants (id, username, password, name) VALUES (?, ?, ?, ?)`,
                [id, username, hash, name], function (err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
        });
    }

    getAttendants() {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT id, username, name, role, created_at FROM attendants ORDER BY created_at ASC`, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    deleteAttendant(id) {
        return new Promise((resolve, reject) => {
            // Prevent deleting the built-in admin account
            if (id === 'admin') return reject(new Error('Cannot delete the main admin account'));
            this.db.run(`DELETE FROM attendants WHERE id = ?`, [id], function (err) {
                if (err) reject(err); else resolve({ deleted: this.changes });
            });
        });
    }

    updateAttendant(id, { name, password } = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                if (password) {
                    const hash = await bcrypt.hash(password, 10);
                    this.db.run(
                        `UPDATE attendants SET name = COALESCE(?, name), password = ? WHERE id = ?`,
                        [name || null, hash, id],
                        function (err) { if (err) reject(err); else resolve({ updated: this.changes }); }
                    );
                } else {
                    this.db.run(
                        `UPDATE attendants SET name = ? WHERE id = ?`,
                        [name, id],
                        function (err) { if (err) reject(err); else resolve({ updated: this.changes }); }
                    );
                }
            } catch (e) { reject(e); }
        });
    }

    getActiveLunchBreaks() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT key, value FROM config WHERE key LIKE 'lunch_break_%' AND value = '1'`,
                [],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows.map(r => r.key.replace('lunch_break_', '')));
                }
            );
        });
    }

    // ── Guest invite persistence ─────────────────────────────────────────────
    addGuestInvite(attendantId, chatId) {
        return new Promise((resolve) => {
            this.db.run(
                `INSERT OR IGNORE INTO guest_invites (attendant_id, chat_id) VALUES (?, ?)`,
                [String(attendantId), chatId],
                () => resolve()
            );
        });
    }

    removeGuestInvite(attendantId, chatId) {
        return new Promise((resolve) => {
            this.db.run(
                `DELETE FROM guest_invites WHERE attendant_id = ? AND chat_id = ?`,
                [String(attendantId), chatId],
                () => resolve()
            );
        });
    }

    removeGuestInvitesByChat(chatId) {
        return new Promise((resolve) => {
            this.db.run(
                `DELETE FROM guest_invites WHERE chat_id = ?`,
                [chatId],
                () => resolve()
            );
        });
    }

    loadAllGuestInvites() {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT attendant_id, chat_id FROM guest_invites`, [], (err, rows) => {
                if (err) return reject(err);
                resolve(rows);
            });
        });
    }


    // ── Chatwoot set_conversation pattern ──────────────────────────────────────
    // Prevents duplicate chats when WhatsApp uses a different ID format (@lid) for
    // the same phone number. If the chatId already exists, returns it. If not,
    // looks up an active or recently-finished chat with the same phone/wa_id and
    // returns that ID instead — avoiding a phantom duplicate in the queue.
    resolveActiveChatId(chatId, phone, waId = null) {
        const digits = chatId.replace(/@.*$/, '');
        const searchPhone = phone || (digits.length <= 15 ? digits : null);
        return new Promise((resolve) => {
            // 1️⃣ Exact ID match — fastest path
            this.db.get(`SELECT id FROM chats WHERE id = ?`, [chatId], (err, row) => {
                if (row) { resolve(chatId); return; }

                // 2️⃣ wa_id match — resolves @lid ↔ @c.us duplicates reliably
                if (waId) {
                    this.db.get(`SELECT id FROM chats WHERE wa_id = ? LIMIT 1`, [waId], (err1, waRow) => {
                        if (waRow) {
                            console.log(`[ResolveChat] Reusing existing chat ${waRow.id} by wa_id=${waId} (incoming chatId was ${chatId})`);
                            resolve(waRow.id);
                            return;
                        }
                        // Fall through to phone search
                        this._resolveByPhone(chatId, searchPhone, resolve);
                    });
                    return;
                }

                // 3️⃣ Phone-based search
                this._resolveByPhone(chatId, searchPhone, resolve);
            });
        });
    }

    /** @private Phone-based fallback for resolveActiveChatId */
    _resolveByPhone(chatId, searchPhone, resolve) {
        if (!searchPhone) { resolve(chatId); return; }
        this.db.get(
            `SELECT id FROM chats
             WHERE (phone = ? OR id LIKE ?)
             AND (status IN ('waiting','attending')
                  OR (status = 'finished' AND timestamp > datetime('now', '-24 hours')))
             ORDER BY
               CASE status WHEN 'attending' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
               timestamp DESC
             LIMIT 1`,
            [searchPhone, '%' + searchPhone + '%'],
            (err2, existing) => {
                if (existing) {
                    console.log(`[ResolveChat] Reusing existing chat ${existing.id} for phone ${searchPhone} (incoming chatId was ${chatId})`);
                }
                resolve(existing ? existing.id : chatId);
            }
        );
    }

    /**
     * Fast wa_id → chatId lookup. Returns the chat ID if found, null otherwise.
     * Used as a fast-path before resolveActiveChatId for @lid contacts.
     */
    findChatByWaId(waId) {
        return new Promise((resolve) => {
            if (!waId) { resolve(null); return; }
            this.db.get(`SELECT id FROM chats WHERE wa_id = ? LIMIT 1`, [waId], (_, row) => {
                resolve(row ? row.id : null);
            });
        });
    }

    // Chat management — also accepts phone and wa_id so they are stored durably.
    // fromMe: true  → message sent by attendant; NEVER change chat status (prevents 'finished'→'waiting' on outgoing)
    // fromMe: false → inbound client message; restore 'finished' chats to 'waiting' (normal reactivation flow)
    updateChat(chatId, name, lastMessage, avatarUrl = null, status = 'waiting', phone = null, fromMe = false, waId = null) {
        return new Promise((resolve, reject) => {
            // Safety: reject phone values that are WA internal IDs (> 15 digits)
            if (phone && phone.length > 15) phone = null;
            const rawId = chatId.replace(/@.*$/, '');
            const nameIsJustId = name && (name === rawId || /^\d+$/.test(name) || name.includes('@'));
            // Protect manually renamed contacts: if contacts.renamed_manually = 1, keep existing chats.name
            const safeNameExpr = nameIsJustId
                ? 'chats.name'
                : `CASE WHEN EXISTS (SELECT 1 FROM contacts WHERE contacts.id = excluded.id AND contacts.renamed_manually = 1) THEN chats.name
                        WHEN excluded.name IS NOT NULL AND excluded.name != '' AND excluded.name != excluded.id THEN excluded.name ELSE chats.name END`;
            const statusExpr = fromMe
                ? 'chats.status'
                : `CASE WHEN chats.status = 'finished' THEN 'waiting' ELSE chats.status END`;
            const sql = `INSERT INTO chats (id, name, avatar_url, last_message, timestamp, status, phone, wa_id)
                         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                     name = ${safeNameExpr},
                     avatar_url = COALESCE(excluded.avatar_url, chats.avatar_url),
                     last_message = excluded.last_message,
                     timestamp = CURRENT_TIMESTAMP,
                     phone = COALESCE(excluded.phone, chats.phone),
                     wa_id = COALESCE(excluded.wa_id, chats.wa_id),
                     status = ${statusExpr},
                     has_unread = ${fromMe ? 'chats.has_unread' : '1'}`;
            this.db.run(sql, [chatId, name, avatarUrl, lastMessage, status || 'waiting', phone, waId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // Get the native WhatsApp @lid for a chat (used by sendMessage)
    getWaId(chatId) {
        return new Promise((resolve) => {
            this.db.get('SELECT wa_id FROM chats WHERE id = ?', [chatId], (_, row) => {
                resolve(row?.wa_id || null);
            });
        });
    }

    // Upsert into contacts table — called on every inbound message to keep contacts always in sync
    upsertContact(chatId, name, phone, avatarUrl) {
        return new Promise((resolve, reject) => {
            // For @lid IDs (no real phone), we skip unless we have a stored name
            if (!name && !phone) return resolve();
            const sql = `INSERT INTO contacts (id, name, number, avatar_url, last_seen)
                         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                         ON CONFLICT(id) DO UPDATE SET
                         name = CASE WHEN contacts.renamed_manually = 1 THEN contacts.name
                                     WHEN excluded.name IS NOT NULL AND excluded.name != '' AND excluded.name != contacts.id
                                     THEN excluded.name ELSE contacts.name END,
                         number = COALESCE(excluded.number, contacts.number),
                         avatar_url = CASE WHEN excluded.avatar_url IS NOT NULL THEN excluded.avatar_url ELSE contacts.avatar_url END,
                         last_seen = CURRENT_TIMESTAMP`;
            this.db.run(sql, [chatId, name || null, phone || null, avatarUrl || null], (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    /** Returns a Map<id, avatarUrl> for all contacts+chats that already have a stored avatar.
     *  Used to skip getProfilePicUrl() calls for IDs we already have a photo for. */
    getExistingAvatars() {
        return new Promise((resolve, reject) => {
            const map = new Map();
            const done = (rows) => rows.forEach(r => { if (r.id && r.avatar_url) map.set(r.id, r.avatar_url); });
            this.db.all(`SELECT id, avatar_url FROM contacts WHERE avatar_url IS NOT NULL`, [], (err, rows) => {
                if (err) return reject(err);
                done(rows || []);
                this.db.all(`SELECT id, avatar_url FROM chats WHERE avatar_url IS NOT NULL`, [], (err2, rows2) => {
                    if (err2) return reject(err2);
                    done(rows2 || []);
                    resolve(map);
                });
            });
        });
    }

    // Update only name, avatar and optionally phone without touching status/messages
    updateContactInfo(chatId, name, avatarUrl, phone = null) {
        return new Promise((resolve, reject) => {
            // Reject null, empty, or raw-number-only names (WA API sometimes returns
            // the phone digits or the @c.us ID fragment before contacts finish loading)
            const isValidName = name && name !== '' && !/^\d+$/.test(name) && !name.includes('@');
            // Protect manually renamed contacts: skip name overwrite if renamed_manually = 1
            const sql = `UPDATE chats SET
            name = CASE WHEN ? = 1 AND NOT EXISTS (SELECT 1 FROM contacts WHERE contacts.id = chats.id AND contacts.renamed_manually = 1) THEN ? ELSE name END,
            avatar_url = CASE WHEN ? IS NOT NULL THEN ? ELSE avatar_url END,
            phone = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE phone END
            WHERE id = ?`;
            this.db.run(sql, [isValidName ? 1 : 0, name, avatarUrl, avatarUrl, phone, phone, phone, chatId], (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }
    assignChat(chatId, attendantId, attendantName) {
        return new Promise((resolve, reject) => {
            // Generate a unique service code: #YYMMDD-NNNN
            const today = new Date();
            const dateStr = String(today.getFullYear()).slice(2)
                + String(today.getMonth() + 1).padStart(2, '0')
                + String(today.getDate()).padStart(2, '0');
            // Count today's attendances to create a sequential number
            this.db.get(
                `SELECT COUNT(*) as cnt FROM chats WHERE service_code LIKE ?`,
                [`%${dateStr}-%`],
                (err, row) => {
                    const seq = String((row?.cnt || 0) + 1).padStart(4, '0');
                    const serviceCode = `#${dateStr}-${seq}`;
                    this.db.run(
                        `UPDATE chats SET status = 'attending', attendant_id = ?, attendant_name = ?, service_code = ?, timestamp = CURRENT_TIMESTAMP WHERE id = ?`,
                        [attendantId, attendantName, serviceCode, chatId],
                        (err2) => {
                            if (err2) reject(err2);
                            else resolve({ serviceCode });
                        }
                    );
                }
            );
        });
    }

    /**
     * Cursor-based paginated history for lazy loading.
     * @param {string} chatId
     * @param {string|null} beforeTimestamp - ISO/SQLite timestamp; load messages BEFORE this. null = most recent.
     * @param {number} limit - page size (default 25)
     * @returns {Promise<{ messages: Array, hasMore: boolean }>}
     */
    getPagedHistory(chatId, beforeTimestamp = null, limit = 25) {
        return new Promise((resolve, reject) => {
            // Fetch messages with reactions, newest first, with optional cursor
            const cursorClause = beforeTimestamp ? `AND m.timestamp < ?` : '';
            const msgParams = beforeTimestamp
                ? [chatId, beforeTimestamp, limit + 1]  // +1 to probe hasMore
                : [chatId, limit + 1];

            this.db.all(
                `SELECT m.id, m.chat_id, m.body, m.from_me, m.sender_name,
                        m.media_type, m.media_filename, m.media_data, m.media_pages,
                        m.media_size, m.timestamp, m.ack, m.is_deleted, m.is_edited,
                        m.quoted_body, m.quoted_status_media, m.quoted_status_type,
                        m.quoted_msg_id, m.msg_serialized,
                        'message' AS record_type,
                        GROUP_CONCAT(r.emoji || ':' || r.sender_type || ':' || COALESCE(r.sender_name,''), '|') AS reactions_raw
                 FROM messages m
                 LEFT JOIN reactions r ON r.message_id = m.id
                 WHERE m.chat_id = ? ${cursorClause}
                 GROUP BY m.id
                 ORDER BY m.timestamp DESC
                 LIMIT ?`,
                msgParams,
                (err, msgRows) => {
                    if (err) return reject(err);

                    const hasMore = msgRows.length > limit;
                    if (hasMore) msgRows.pop(); // remove the probe row

                    // Determine timestamp window for fetching matching chat_events
                    const oldest = msgRows.length ? msgRows[msgRows.length - 1].timestamp : null;
                    const newest = msgRows.length ? msgRows[0].timestamp : null;

                    // Build event query for the same time window
                    let evtSql, evtParams;
                    if (oldest && newest) {
                        const beforeClause = beforeTimestamp ? `AND timestamp < ?` : '';
                        evtSql = `SELECT id, chat_id, type, description, timestamp, 'event' AS record_type
                                  FROM chat_events
                                  WHERE chat_id = ? ${beforeClause} AND timestamp >= ?
                                  ORDER BY timestamp ASC`;
                        evtParams = beforeTimestamp
                            ? [chatId, beforeTimestamp, oldest]
                            : [chatId, oldest];
                    } else {
                        evtSql = `SELECT id, chat_id, type, description, timestamp, 'event' AS record_type
                                  FROM chat_events WHERE chat_id = ? ORDER BY timestamp ASC LIMIT 0`;
                        evtParams = [chatId];
                    }

                    this.db.all(evtSql, evtParams, (err2, evtRows) => {
                        if (err2) return reject(err2);

                        // Parse reactions
                        const messages = msgRows.map(row => {
                            const reactions = {};
                            if (row.reactions_raw) {
                                row.reactions_raw.split('|').forEach(part => {
                                    const [emoji, senderType, senderName] = part.split(':');
                                    if (!emoji) return;
                                    if (!reactions[emoji]) reactions[emoji] = { count: 0, senderType, senders: [] };
                                    reactions[emoji].count++;
                                    if (senderName) reactions[emoji].senders.push(senderName);
                                });
                            }
                            return { ...row, reactions };
                        });

                        const events = evtRows.map(e => ({ ...e, from_me: -1 }));

                        // Merge and return in chronological order (oldest → newest)
                        const combined = [...messages, ...events]
                            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                        resolve({ messages: combined, hasMore });
                    });
                }
            );
        });
    }

    finishChat(chatId) {
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE chats SET status = 'finished' WHERE id = ?`, [chatId], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // Messages — from_me: 0=client, 1=attendant, 2=internal_note
    deleteMessage(messageId, chatId) {
        return new Promise((resolve, reject) => {
            // Guard: only delete within the correct chat to prevent cross-chat bleed
            const sql = chatId
                ? `UPDATE messages SET is_deleted = 1, body = '' WHERE id = ? AND chat_id = ?`
                : `UPDATE messages SET is_deleted = 1, body = '' WHERE id = ?`;
            const params = chatId ? [messageId, chatId] : [messageId];
            this.db.run(sql, params, (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    editMessage(messageId, newBody, chatId) {
        return new Promise((resolve, reject) => {
            const sql = chatId
                ? `UPDATE messages SET body = ?, is_edited = 1 WHERE id = ? AND chat_id = ?`
                : `UPDATE messages SET body = ?, is_edited = 1 WHERE id = ?`;
            const params = chatId ? [newBody, messageId, chatId] : [newBody, messageId];
            this.db.run(sql, params, (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    updateMessageMedia(messageId, mediaData, mediaType, mediaFilename, mediaSize) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE messages SET media_data = ?, media_type = ?, media_filename = COALESCE(?, media_filename), media_size = COALESCE(?, media_size) WHERE id = ?`,
                [mediaData, mediaType, mediaFilename, mediaSize, messageId],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    saveMessage(messageId, chatId, body, fromMe, quotedBody = null, senderName = null, mediaData = null, mediaType = null, mediaFilename = null, mediaPages = null, mediaSize = null, ack = 1, quotedStatusMedia = null, quotedStatusType = null, quotedMsgId = null, msgSerialized = null) {
        return new Promise((resolve, reject) => {
            const fromMeVal = (fromMe === true || fromMe === 1) ? 1 : fromMe === 2 ? 2 : 0;
            this.db.run(
                `INSERT OR IGNORE INTO messages (id, chat_id, body, from_me, quoted_body, sender_name, media_data, media_type, media_filename, media_pages, media_size, ack, quoted_status_media, quoted_status_type, quoted_msg_id, msg_serialized)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [messageId, chatId, body, fromMeVal, quotedBody, senderName, mediaData, mediaType, mediaFilename, mediaPages, mediaSize, ack, quotedStatusMedia, quotedStatusType, quotedMsgId, msgSerialized],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    // ── Chatwoot ActiveRecord::Base.transaction pattern ──────────────────────
    // Atomic: updateChat + messageExists-guard + saveMessage in a single SQLite
    // transaction. If the message already exists, rolls back and returns {skipped:true}.
    // This prevents inconsistent state where chat is updated but message save fails.
    updateChatAndSaveMessage(chatOpts, msgOpts) {
        const { chatId, name, lastMessage, avatarUrl, status, phone, fromMe } = chatOpts;
        const { messageId, body, fromMe: msgFromMe, quotedBody, senderName, mediaData, mediaType,
            mediaFilename, mediaPages, mediaSize, ack, quotedStatusMedia, quotedStatusType, quotedMsgId } = msgOpts;
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN IMMEDIATE', (beginErr) => {
                    if (beginErr) { reject(beginErr); return; }

                    // 1) Check if message already exists (Chatwoot find_message_by_source_id)
                    this.db.get('SELECT 1 FROM messages WHERE id = ?', [messageId], (selErr, row) => {
                        if (row) {
                            // Message exists — rollback and signal skip
                            this.db.run('ROLLBACK', () => resolve({ skipped: true }));
                            return;
                        }

                        // 2) updateChat
                        const safePh = (phone && phone.length > 15) ? null : phone;
                        const rawId = chatId.replace(/@.*$/, '');
                        const nameIsJustId = name && (name === rawId || /^\d+$/.test(name) || name.includes('@'));
                        const safeNameExpr = nameIsJustId
                            ? 'chats.name'
                            : `CASE WHEN EXISTS (SELECT 1 FROM contacts WHERE contacts.id = excluded.id AND contacts.renamed_manually = 1) THEN chats.name
                                    WHEN excluded.name IS NOT NULL AND excluded.name != '' AND excluded.name != excluded.id THEN excluded.name ELSE chats.name END`;
                        const statusExpr = fromMe
                            ? 'chats.status'
                            : `CASE WHEN chats.status = 'finished' THEN 'waiting' ELSE chats.status END`;
                        const chatSql = `INSERT INTO chats (id, name, avatar_url, last_message, timestamp, status, phone)
                                         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
                                         ON CONFLICT(id) DO UPDATE SET
                                         name = ${safeNameExpr},
                                         avatar_url = COALESCE(excluded.avatar_url, chats.avatar_url),
                                         last_message = excluded.last_message,
                                         timestamp = CURRENT_TIMESTAMP,
                                         phone = COALESCE(excluded.phone, chats.phone),
                                         status = ${statusExpr}`;
                        this.db.run(chatSql, [chatId, name, avatarUrl, lastMessage, status || 'waiting', safePh], (chatErr) => {
                            if (chatErr) {
                                this.db.run('ROLLBACK', () => reject(chatErr));
                                return;
                            }

                            // 3) saveMessage
                            const fromMeVal = (msgFromMe === true || msgFromMe === 1) ? 1 : msgFromMe === 2 ? 2 : 0;
                            this.db.run(
                                `INSERT OR IGNORE INTO messages (id, chat_id, body, from_me, quoted_body, sender_name, media_data, media_type, media_filename, media_pages, media_size, ack, quoted_status_media, quoted_status_type, quoted_msg_id, msg_serialized)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                [messageId, chatId, body || lastMessage, fromMeVal, quotedBody, senderName, mediaData, mediaType, mediaFilename, mediaPages, mediaSize, ack ?? 1, quotedStatusMedia, quotedStatusType, quotedMsgId, msgOpts.msgSerialized || null],
                                (msgErr) => {
                                    if (msgErr) {
                                        this.db.run('ROLLBACK', () => reject(msgErr));
                                        return;
                                    }
                                    this.db.run('COMMIT', (commitErr) => {
                                        if (commitErr) reject(commitErr);
                                        else resolve({ skipped: false });
                                    });
                                }
                            );
                        });
                    });
                });
            });
        });
    }

    // ── Chatwoot find_message_by_source_id pattern ─────────────────────────────
    // Checks if a message with this ID already exists in the DB.
    // Used as the primary dedup guard: if it exists, skip all processing.
    messageExists(messageId) {
        return new Promise((resolve) => {
            this.db.get(`SELECT 1 FROM messages WHERE id = ?`, [messageId], (err, row) => {
                resolve(!!row);
            });
        });
    }

    // Feature F — update ACK status in real time
    updateMessageAck(messageId, ack) {
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE messages SET ack = ? WHERE id = ?`, [ack, messageId],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    getChatHistory(chatId) {
        return new Promise((resolve, reject) => {
            // Fetch messages with reactions
            this.db.all(
                `SELECT m.*, 'message' as record_type,
                        GROUP_CONCAT(r.emoji || ':' || r.sender_type || ':' || COALESCE(r.sender_name,''), '|') as reactions_raw
                 FROM messages m
                 LEFT JOIN reactions r ON r.message_id = m.id
                 WHERE m.chat_id = ?
                 GROUP BY m.id
                 ORDER BY m.timestamp ASC`,
                [chatId],
                (err, msgRows) => {
                    if (err) return reject(err);
                    // Fetch chat events
                    this.db.all(
                        `SELECT id, chat_id, type, description, timestamp, 'event' as record_type FROM chat_events WHERE chat_id = ? ORDER BY timestamp ASC`,
                        [chatId],
                        (err2, evtRows) => {
                            if (err2) return reject(err2);
                            // Merge and sort by timestamp
                            const messages = msgRows.map(row => {
                                const reactions = {};
                                if (row.reactions_raw) {
                                    row.reactions_raw.split('|').forEach(part => {
                                        const [emoji, senderType, senderName] = part.split(':');
                                        if (!emoji) return;
                                        if (!reactions[emoji]) reactions[emoji] = { count: 0, senderType, senders: [] };
                                        reactions[emoji].count++;
                                        if (senderName) reactions[emoji].senders.push(senderName);
                                    });
                                }
                                return { ...row, reactions };
                            });
                            const events = evtRows.map(e => ({ ...e, from_me: -1 }));
                            const combined = [...messages, ...events]
                                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                            resolve(combined);
                        }
                    );
                }
            );
        });
    }

    // Feature G — save chat lifecycle events
    saveChatEvent(chatId, type, description) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO chat_events (chat_id, type, description) VALUES (?, ?, ?)`,
                [chatId, type, description],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    // Feature E — Auto-reply rule management
    getAutoReplyRules() {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM auto_reply_rules ORDER BY id ASC`, [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
    }

    saveAutoReplyRule(type, trigger, message) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO auto_reply_rules (type, trigger, message) VALUES (?, ?, ?)`,
                [type, trigger, message],
                function (err) { if (err) reject(err); else resolve({ id: this.lastID }); }
            );
        });
    }

    deleteAutoReplyRule(id) {
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM auto_reply_rules WHERE id = ?`, [id],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    toggleAutoReplyRule(id, isActive) {
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE auto_reply_rules SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, id],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    /** Returns only file-detection rules (file_extension / filename_keyword) */
    getFileRules() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM auto_reply_rules WHERE type IN ('file_extension','filename_keyword') ORDER BY created_at ASC`,
                [],
                (err, rows) => { if (err) reject(err); else resolve(rows); }
            );
        });
    }

    // Returns ALL chats (for internal server logic — not exposed to clients)
    getQueue() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT c.*,
                        COALESCE(ct.avatar_url, c.avatar_url) AS avatar_url,
                        CASE
                          WHEN c.name IS NULL OR c.name = '' OR c.name = REPLACE(c.id, '@c.us','') OR c.name = REPLACE(c.id,'@lid','')
                          THEN COALESCE(ct.name, c.name)
                          ELSE c.name
                        END AS name
                 FROM chats c
                 LEFT JOIN contacts ct ON ct.id = c.id
                 ORDER BY COALESCE(c.is_urgent, 0) DESC, c.timestamp DESC`,
                [],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    // Toggle o flag de urgente em um chat (persiste no SQLite)
    toggleUrgent(chatId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE chats SET is_urgent = CASE WHEN COALESCE(is_urgent,0) = 1 THEN 0 ELSE 1 END WHERE id = ?`,
                [chatId],
                (err) => {
                    if (err) return reject(err);
                    this.db.get(`SELECT is_urgent FROM chats WHERE id = ?`, [chatId],
                        (e, row) => e ? reject(e) : resolve({ is_urgent: row?.is_urgent || 0 })
                    );
                }
            );
        });
    }

    // Toggle o flag de cliente especial (fila separada)
    toggleSpecial(chatId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE chats SET is_special = CASE WHEN COALESCE(is_special,0) = 1 THEN 0 ELSE 1 END WHERE id = ?`,
                [chatId],
                (err) => {
                    if (err) return reject(err);
                    this.db.get(`SELECT is_special FROM chats WHERE id = ?`, [chatId],
                        (e, row) => e ? reject(e) : resolve({ is_special: row?.is_special || 0 })
                    );
                }
            );
        });
    }

    /**
     * Permission-filtered queue — mirrors Chatwoot's PermissionFilterService:
     *   - Admin/super-admin → all chats
     *   - Attendant        → waiting (unassigned) + own attending + own finished
     */
    getQueueForUser(userId, role) {
        return new Promise((resolve, reject) => {
            const nameExpr = `CASE
                WHEN c.name IS NULL OR c.name = '' OR c.name = REPLACE(c.id, '@c.us','') OR c.name = REPLACE(c.id,'@lid','')
                THEN COALESCE(ct.name, c.name)
                ELSE c.name
            END`;
            const avatarExpr = `COALESCE(ct.avatar_url, c.avatar_url)`;
            // Sub-query fetches labels as JSON array for each chat
            const labelsSub = `(SELECT '[' || GROUP_CONCAT(json_object('id', l.id, 'name', l.name, 'color', l.color)) || ']'
                FROM chat_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.chat_id = c.id) AS labels_json`;
            if (role === 'admin') {
                this.db.all(
                    `SELECT c.*, ${nameExpr} AS name, ${avatarExpr} AS avatar_url, ${labelsSub}
                     FROM chats c
                     LEFT JOIN contacts ct ON ct.id = c.id
                     WHERE (c.snoozed_until IS NULL OR c.snoozed_until <= datetime('now'))
                       AND c.status != 'finished'
                     ORDER BY c.timestamp DESC`,
                    [],
                    (err, rows) => { if (err) reject(err); else resolve(rows.map(r => ({ ...r, labels: r.labels_json ? JSON.parse(r.labels_json) : [] }))); }
                );
            } else {
                this.db.all(
                    `SELECT c.*, ${nameExpr} AS name, ${avatarExpr} AS avatar_url, ${labelsSub}
                     FROM chats c
                     LEFT JOIN contacts ct ON ct.id = c.id
                     WHERE (c.snoozed_until IS NULL OR c.snoozed_until <= datetime('now'))
                       AND (c.status = 'waiting'
                         OR (c.status = 'attending' AND c.attendant_id = ?))
                     ORDER BY c.timestamp DESC`,
                    [String(userId)],
                    (err, rows) => { if (err) reject(err); else resolve(rows.map(r => ({ ...r, labels: r.labels_json ? JSON.parse(r.labels_json) : [] }))); }
                );
            }
        });
    }

    // ── Finished Chats (on-demand) ────────────────────────────────────────────

    countFinishedChats(userId, role) {
        return new Promise((resolve, reject) => {
            const where = role === 'admin'
                ? `WHERE status = 'finished'`
                : `WHERE status = 'finished' AND attendant_id = '${String(userId)}'`;
            this.db.get(`SELECT COUNT(*) AS cnt FROM chats ${where}`, [], (err, row) => {
                if (err) reject(err); else resolve(row?.cnt || 0);
            });
        });
    }

    getRecentFinished(limit = 10, userId, role) {
        return new Promise((resolve, reject) => {
            const nameExpr = `CASE
                WHEN c.name IS NULL OR c.name = '' OR c.name = REPLACE(c.id, '@c.us','') OR c.name = REPLACE(c.id,'@lid','')
                THEN COALESCE(ct.name, c.name) ELSE c.name END`;
            const avatarExpr = `COALESCE(ct.avatar_url, c.avatar_url)`;
            const labelsSub = `(SELECT '[' || GROUP_CONCAT(json_object('id', l.id, 'name', l.name, 'color', l.color)) || ']'
                FROM chat_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.chat_id = c.id) AS labels_json`;
            const filter = role === 'admin' ? '' : `AND c.attendant_id = ?`;
            const params = role === 'admin' ? [limit] : [String(userId), limit];
            this.db.all(
                `SELECT c.*, ${nameExpr} AS name, ${avatarExpr} AS avatar_url, ${labelsSub}
                 FROM chats c LEFT JOIN contacts ct ON ct.id = c.id
                 WHERE c.status = 'finished' ${filter}
                 ORDER BY c.timestamp DESC LIMIT ?`,
                params,
                (err, rows) => { if (err) reject(err); else resolve(rows.map(r => ({ ...r, labels: r.labels_json ? JSON.parse(r.labels_json) : [] }))); }
            );
        });
    }

    searchFinishedChats(search, limit = 50, userId, role) {
        return new Promise((resolve, reject) => {
            const nameExpr = `CASE
                WHEN c.name IS NULL OR c.name = '' OR c.name = REPLACE(c.id, '@c.us','') OR c.name = REPLACE(c.id,'@lid','')
                THEN COALESCE(ct.name, c.name) ELSE c.name END`;
            const avatarExpr = `COALESCE(ct.avatar_url, c.avatar_url)`;
            const labelsSub = `(SELECT '[' || GROUP_CONCAT(json_object('id', l.id, 'name', l.name, 'color', l.color)) || ']'
                FROM chat_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.chat_id = c.id) AS labels_json`;
            const q = `%${search}%`;
            const filter = role === 'admin' ? '' : `AND c.attendant_id = ?`;
            const params = role === 'admin' ? [q, q, limit] : [q, q, String(userId), limit];
            this.db.all(
                `SELECT c.*, ${nameExpr} AS name, ${avatarExpr} AS avatar_url, ${labelsSub}
                 FROM chats c LEFT JOIN contacts ct ON ct.id = c.id
                 WHERE c.status = 'finished'
                   AND (COALESCE(ct.name, c.name) LIKE ? OR COALESCE(ct.number, c.phone, c.id) LIKE ?)
                   ${filter}
                 ORDER BY c.timestamp DESC LIMIT ?`,
                params,
                (err, rows) => { if (err) reject(err); else resolve(rows.map(r => ({ ...r, labels: r.labels_json ? JSON.parse(r.labels_json) : [] }))); }
            );
        });
    }

    // ── Labels ────────────────────────────────────────────────────────────────
    getLabels() {
        return new Promise((resolve, reject) =>
            this.db.all(`SELECT * FROM labels ORDER BY name`, [], (err, rows) => err ? reject(err) : resolve(rows))
        );
    }
    createLabel(name, color = '#6366f1') {
        return new Promise((resolve, reject) =>
            this.db.run(`INSERT INTO labels (name, color) VALUES (?, ?)`, [name, color],
                function (err) { if (err) reject(err); else resolve({ id: this.lastID, name, color }); })
        );
    }
    deleteLabel(id) {
        return new Promise((resolve, reject) =>
            this.db.run(`DELETE FROM labels WHERE id = ?`, [id], err => err ? reject(err) : resolve())
        );
    }
    getChatLabels(chatId) {
        return new Promise((resolve, reject) =>
            this.db.all(`SELECT l.* FROM labels l JOIN chat_labels cl ON cl.label_id = l.id WHERE cl.chat_id = ?`, [chatId],
                (err, rows) => err ? reject(err) : resolve(rows))
        );
    }
    addLabelToChat(chatId, labelId) {
        return new Promise((resolve, reject) =>
            this.db.run(`INSERT OR IGNORE INTO chat_labels (chat_id, label_id) VALUES (?, ?)`, [chatId, labelId],
                err => err ? reject(err) : resolve())
        );
    }
    removeLabelFromChat(chatId, labelId) {
        return new Promise((resolve, reject) =>
            this.db.run(`DELETE FROM chat_labels WHERE chat_id = ? AND label_id = ?`, [chatId, labelId],
                err => err ? reject(err) : resolve())
        );
    }

    // ── Snooze ────────────────────────────────────────────────────────────────
    snoozeChat(chatId, until) {
        // until: ISO datetime string
        return new Promise((resolve, reject) =>
            this.db.run(`UPDATE chats SET snoozed_until = ? WHERE id = ?`, [until, chatId],
                err => err ? reject(err) : resolve())
        );
    }
    unsnoozeChat(chatId) {
        return new Promise((resolve, reject) =>
            this.db.run(`UPDATE chats SET snoozed_until = NULL WHERE id = ?`, [chatId],
                err => err ? reject(err) : resolve())
        );
    }
    // Returns chats whose snooze has expired (used by the server job)
    getSnoozedDueChats() {
        return new Promise((resolve, reject) =>
            this.db.all(`SELECT id FROM chats WHERE snoozed_until IS NOT NULL AND snoozed_until <= datetime('now')`,
                [], (err, rows) => err ? reject(err) : resolve(rows))
        );
    }

    // Reactions
    saveReaction(messageId, chatId, emoji, senderType, senderName) {
        return new Promise((resolve, reject) => {
            // Remove existing reaction from same sender for same message (toggle)
            this.db.run(
                `DELETE FROM reactions WHERE message_id = ? AND sender_type = ? AND sender_name = ? AND emoji != ?`,
                [messageId, senderType, senderName, emoji],
                () => {
                    // Check if same reaction exists (to toggle off)
                    this.db.get(
                        `SELECT id FROM reactions WHERE message_id = ? AND sender_type = ? AND sender_name = ? AND emoji = ?`,
                        [messageId, senderType, senderName, emoji],
                        (err, row) => {
                            if (row) {
                                // Toggle off
                                this.db.run(`DELETE FROM reactions WHERE id = ?`, [row.id], (err) => {
                                    if (err) reject(err); else resolve({ toggled: 'off' });
                                });
                            } else {
                                // Add reaction
                                this.db.run(
                                    `INSERT INTO reactions (message_id, chat_id, emoji, sender_type, sender_name) VALUES (?, ?, ?, ?, ?)`,
                                    [messageId, chatId, emoji, senderType, senderName],
                                    (err) => { if (err) reject(err); else resolve({ toggled: 'on' }); }
                                );
                            }
                        }
                    );
                }
            );
        });
    }

    getReactionsByChatId(chatId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM reactions WHERE chat_id = ?`,
                [chatId],
                (err, rows) => { if (err) reject(err); else resolve(rows); }
            );
        });
    }

    // Canned Responses
    getCannedResponses() {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM canned_responses ORDER BY title ASC`, [], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
    }

    addCannedResponse(title, content) {
        return new Promise((resolve, reject) => {
            this.db.run(`INSERT INTO canned_responses (title, content) VALUES (?, ?)`,
                [title, content], function (err) {
                    if (err) reject(err); else resolve({ id: this.lastID });
                });
        });
    }

    deleteCannedResponse(id) {
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM canned_responses WHERE id = ?`, [id], (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    // Config
    getConfig(key) {
        return new Promise((resolve, reject) => {
            this.db.get(`SELECT value FROM config WHERE key = ?`, [key], (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.value : null);
            });
        });
    }

    setConfig(key, value) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                [key, value], (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    // ── Contacts ──────────────────────────────────────────────────────────────

    // Upsert a single contact
    upsertContact(id, name, number, avatarUrl, isBusiness = false) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO contacts (id, name, number, avatar_url, is_business, last_seen)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                   name = CASE WHEN contacts.renamed_manually = 1 THEN contacts.name
                               ELSE COALESCE(NULLIF(excluded.name, ''), contacts.name) END,
                   number = COALESCE(excluded.number, contacts.number),
                   avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
                   is_business = excluded.is_business,
                   last_seen = CURRENT_TIMESTAMP`,
                [id, name, number, avatarUrl, isBusiness ? 1 : 0],
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    // Sync an array of contacts in a transaction for speed
    syncContacts(contacts) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                const stmt = this.db.prepare(
                    `INSERT INTO contacts (id, name, number, avatar_url, is_business, last_seen)
                     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET
                       name = CASE WHEN contacts.renamed_manually = 1 THEN contacts.name
                                   ELSE COALESCE(NULLIF(excluded.name, ''), contacts.name) END,
                       number = COALESCE(excluded.number, contacts.number),
                       avatar_url = COALESCE(excluded.avatar_url, contacts.avatar_url),
                       is_business = excluded.is_business,
                       last_seen = CURRENT_TIMESTAMP`
                );
                this.db.run('BEGIN');
                contacts.forEach(c => {
                    stmt.run([c.id, c.name, c.number, c.avatar_url, c.is_business ? 1 : 0]);
                });
                this.db.run('COMMIT', (err) => {
                    stmt.finalize();
                    if (err) reject(err); else resolve();
                });
            });
        });
    }

    // Search contacts by name or number — merges chats + contacts tables
    // Returns chat status, attendant, last_message and timestamp for unified card display
    searchContacts(query, limit = 30) {
        return new Promise((resolve, reject) => {
            const q = `%${query}%`;
            this.db.all(
                `SELECT c.id,
                        COALESCE(ct.name, c.name) AS name,
                        COALESCE(ct.number, c.phone) AS number,
                        COALESCE(ct.avatar_url, c.avatar_url) AS avatar_url,
                        c.status, c.attendant_name, c.last_message, c.timestamp
                 FROM chats c
                 LEFT JOIN contacts ct ON ct.id = c.id
                 WHERE (COALESCE(ct.name, c.name) LIKE ? OR COALESCE(ct.number, c.phone) LIKE ?)
                 UNION
                 SELECT id, name, number, avatar_url,
                        NULL AS status, NULL AS attendant_name, NULL AS last_message, NULL AS timestamp
                 FROM contacts
                 WHERE (name LIKE ? OR number LIKE ?)
                   AND id NOT IN (SELECT id FROM chats)
                 ORDER BY name ASC
                 LIMIT ?`,
                [q, q, q, q, limit],
                (err, rows) => { if (err) reject(err); else resolve(rows); }
            );
        });
    }

    // Get all contacts (paginated) — merges chats + contacts tables so every
    // customer who ever sent a message appears, even if never synced to contacts.
    getContacts(limit = 100, offset = 0) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT c.id,
                        COALESCE(ct.name, c.name) AS name,
                        COALESCE(ct.number, c.phone) AS number,
                        COALESCE(ct.avatar_url, c.avatar_url) AS avatar_url
                 FROM chats c
                 LEFT JOIN contacts ct ON ct.id = c.id
                 UNION
                 SELECT id, name, number, avatar_url FROM contacts
                 WHERE id NOT IN (SELECT id FROM chats)
                 ORDER BY name ASC
                 LIMIT ? OFFSET ?`,
                [limit, offset],
                (err, rows) => { if (err) reject(err); else resolve(rows); }
            );
        });
    }

    // Rename a contact — writes to both `contacts` AND `chats` so name is always consistent
    // Sets renamed_manually = 1 so WA sync won't overwrite the user's custom name
    updateContactName(id, newName) {
        return new Promise((resolve, reject) => {
            // 1) Update (or insert) in contacts table + set renamed_manually flag
            this.db.run(
                `INSERT INTO contacts (id, name, number, last_seen, renamed_manually)
                 VALUES (?, ?, '', CURRENT_TIMESTAMP, 1)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, renamed_manually = 1`,
                [id, newName],
                (err) => {
                    if (err) return reject(err);
                    // 2) Also update chats.name so the conversation card reflects the rename immediately
                    this.db.run(
                        `UPDATE chats SET name = ? WHERE id = ?`,
                        [newName, id],
                        function (err2) { if (err2) reject(err2); else resolve({ changed: this.changes }); }
                    );
                }
            );
        });
    }

    // Client notes
    getClientNotes(contactId) {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM client_notes WHERE contact_id = ? ORDER BY created_at DESC`, [contactId], (err, rows) => {
                if (err) reject(err); else resolve(rows);
            });
        });
    }

    saveClientNote(contactId, body, authorId, authorName) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO client_notes (contact_id, body, author_id, author_name) VALUES (?, ?, ?, ?)`,
                [contactId, body, authorId, authorName],
                function (err) { if (err) reject(err); else resolve({ id: this.lastID }); }
            );
        });
    }

    deleteClientNote(id) {
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM client_notes WHERE id = ?`, [id], (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    // ── Delay Alert helpers ───────────────────────────────────────────────────

    /** Returns the timestamp (as Date) of the last client message (from_me=0) in a chat, or null */
    getLastClientMessageTime(chatId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT timestamp FROM messages WHERE chat_id = ? AND from_me = 0 AND is_deleted = 0 ORDER BY timestamp DESC LIMIT 1`,
                [chatId],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    // SQLite CURRENT_TIMESTAMP stores UTC without 'Z' — force UTC parse
                    const ts = row.timestamp.includes('+') || row.timestamp.endsWith('Z')
                        ? row.timestamp
                        : row.timestamp.replace(' ', 'T') + '+00:00';
                    resolve(new Date(ts));
                }
            );
        });
    }

    /** Returns the timestamp (as Date) of the last attendant message (from_me=1) in a chat, or null */
    getLastAttendantMessageTime(chatId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT timestamp FROM messages WHERE chat_id = ? AND from_me = 1 AND is_deleted = 0 ORDER BY timestamp DESC LIMIT 1`,
                [chatId],
                (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    // SQLite CURRENT_TIMESTAMP stores UTC without 'Z' — force UTC parse
                    const ts = row.timestamp.includes('+') || row.timestamp.endsWith('Z')
                        ? row.timestamp
                        : row.timestamp.replace(' ', 'T') + '+00:00';
                    resolve(new Date(ts));
                }
            );
        });
    }

    // ── Auto-Reply Rules CRUD ─────────────────────────────────────────────────

    getAutoReplyRules() {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM auto_reply_rules ORDER BY created_at ASC`, [], (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });
    }

    saveAutoReplyRule(type, trigger, message) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO auto_reply_rules (type, trigger, message) VALUES (?, ?, ?)`,
                [type, trigger.trim().toLowerCase(), message.trim()],
                function (err) { if (err) reject(err); else resolve({ id: this.lastID }); }
            );
        });
    }

    deleteAutoReplyRule(id) {
        return new Promise((resolve, reject) => {
            this.db.run(`DELETE FROM auto_reply_rules WHERE id = ?`, [id], (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    toggleAutoReplyRule(id, isActive) {
        return new Promise((resolve, reject) => {
            this.db.run(`UPDATE auto_reply_rules SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, id], (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    // ── DB Maintenance ───────────────────────────────────────────────────────

    /**
     * Returns storage statistics:
     *   - Total message count
     *   - Messages that still have media_data (base64 blobs)
     *   - Approximate size of all media_data in MB
     *   - Number of finished chats older than N days
     */
    getDbStats(finishedOlderThanDays = 30) {
        return new Promise((resolve, reject) => {
            // Count total messages and those with media
            this.db.get(
                `SELECT
                    COUNT(*) AS total_messages,
                    SUM(CASE WHEN media_data IS NOT NULL THEN 1 ELSE 0 END) AS messages_with_media,
                    ROUND(SUM(CASE WHEN media_data IS NOT NULL THEN length(media_data) ELSE 0 END) / 1048576.0, 2) AS media_mb
                 FROM messages`,
                [],
                (err, stats) => {
                    if (err) return reject(err);
                    // Count finished chats old enough to purge
                    this.db.get(
                        `SELECT COUNT(*) AS purgeable_chats
                         FROM chats
                         WHERE status = 'finished'
                           AND timestamp < datetime('now', '-' || ? || ' days')`,
                        [finishedOlderThanDays],
                        (err2, chatStats) => {
                            if (err2) return reject(err2);
                            resolve({ ...stats, ...chatStats });
                        }
                    );
                }
            );
        });
    }

    /**
     * Nullifies media_data blobs for messages older than `olderThanDays`.
     * Keeps text body, media_type, media_filename, media_size — only removes the base64 binary.
     * Returns the number of rows affected.
     */
    purgeMediaData(olderThanDays = 7) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE messages
                 SET media_data = NULL
                 WHERE media_data IS NOT NULL
                   AND timestamp < datetime('now', '-' || ? || ' days')`,
                [olderThanDays],
                function (err) {
                    if (err) reject(err); else resolve({ affected: this.changes });
                }
            );
        });
    }

    /**
     * Deletes finished chats (and all their messages, events, reactions, guest invites)
     * older than `olderThanDays` days.
     * CRITICAL: never deletes waiting or attending chats.
     */
    purgeOldFinishedChats(olderThanDays = 30) {
        return new Promise((resolve, reject) => {
            // Collect IDs first
            this.db.all(
                `SELECT id FROM chats WHERE status = 'finished' AND timestamp < datetime('now', '-' || ? || ' days')`,
                [olderThanDays],
                (err, rows) => {
                    if (err) return reject(err);
                    if (!rows || rows.length === 0) return resolve({ affected: 0 });

                    const ids = rows.map(r => r.id);
                    const placeholders = ids.map(() => '?').join(',');

                    // Cascade-delete in order: reactions → messages → events → guest_invites → chats
                    this.db.serialize(() => {
                        this.db.run(`DELETE FROM reactions WHERE chat_id IN (${placeholders})`, ids);
                        this.db.run(`DELETE FROM messages  WHERE chat_id IN (${placeholders})`, ids);
                        this.db.run(`DELETE FROM chat_events WHERE chat_id IN (${placeholders})`, ids);
                        this.db.run(`DELETE FROM guest_invites WHERE chat_id IN (${placeholders})`, ids);
                        this.db.run(`DELETE FROM chats WHERE id IN (${placeholders})`, ids, function (err2) {
                            if (err2) reject(err2);
                            else resolve({ affected: ids.length });
                        });
                    });
                }
            );
        });
    }

    /**
     * Runs VACUUM to reclaim freed pages back to the OS.
     * Must be called AFTER purge operations to actually shrink the file on disk.
     */
    /** Clears all stored avatar_url values from both contacts and chats tables.
     *  Called after the avatar files on disk have been purged, so the UI gracefully
     *  falls back to initials instead of showing broken image paths.  */
    clearAllAvatarUrls() {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(`UPDATE contacts SET avatar_url = NULL WHERE avatar_url IS NOT NULL`);
                this.db.run(`UPDATE chats SET avatar_url = NULL WHERE avatar_url IS NOT NULL`, (err) => {
                    if (err) reject(err); else resolve();
                });
            });
        });
    }

    vacuumDb() {
        return new Promise((resolve, reject) => {
            this.db.run('VACUUM', (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }
}


module.exports = new Database();


