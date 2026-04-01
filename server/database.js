const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class Database {
    constructor() {
        const dbPath = path.join(__dirname, '../data.sqlite');
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database', err);
            } else {
                console.log('Connected to SQLite database');
                this.init();
            }
        });
    }

    init() {
        this.db.serialize(() => {
            // Table for storing chats (contacts) and their status in the queue
            this.db.run(`CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                name TEXT,
                last_message TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'waiting', -- waiting, attending, finished
                attendant_id TEXT,
                attendant_name TEXT
            )`);

            // Table for message history
            this.db.run(`CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT,
                body TEXT,
                from_me INTEGER, -- 1 if sent by system, 0 if received
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                is_edited INTEGER DEFAULT 0,
                FOREIGN KEY(chat_id) REFERENCES chats(id)
            )`);

            // Migrate: add columns if missing
            this.db.run(`ALTER TABLE messages ADD COLUMN is_deleted INTEGER DEFAULT 0`, () => {});
            this.db.run(`ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0`, () => {});
            this.db.run(`ALTER TABLE messages ADD COLUMN quoted_body TEXT`, () => {});
            this.db.run(`ALTER TABLE messages ADD COLUMN quoted_msg_id TEXT`, () => {});

            // Table for attendants (stations)
            this.db.run(`CREATE TABLE IF NOT EXISTS attendants (
                id TEXT PRIMARY KEY,
                name TEXT,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
        });
    }

    // Chat operations
    updateChat(chatId, name, lastMessage, status = 'waiting') {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO chats (id, name, last_message, timestamp, status) 
                         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
                         ON CONFLICT(id) DO UPDATE SET 
                         name = excluded.name, 
                         last_message = excluded.last_message, 
                         timestamp = CURRENT_TIMESTAMP,
                         status = CASE WHEN chats.status = 'finished' THEN 'waiting' ELSE chats.status END`;
            this.db.run(sql, [chatId, name, lastMessage, status], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    assignChat(chatId, attendantId, attendantName) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE chats SET status = 'attending', attendant_id = ?, attendant_name = ? WHERE id = ?`;
            this.db.run(sql, [attendantId, attendantName, chatId], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    // Message operations
    saveMessage(messageId, chatId, body, fromMe, { quotedBody, quotedMsgId } = {}) {
        return new Promise((resolve, reject) => {
            const sql = `INSERT INTO messages (id, chat_id, body, from_me, quoted_body, quoted_msg_id) VALUES (?, ?, ?, ?, ?, ?)`;
            this.db.run(sql, [messageId, chatId, body, fromMe ? 1 : 0, quotedBody || null, quotedMsgId || null], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    editMessage(msgId, newBody) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE messages SET body = ?, is_edited = 1 WHERE id = ?`;
            this.db.run(sql, [newBody, msgId], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    deleteMessage(msgId) {
        return new Promise((resolve, reject) => {
            const sql = `UPDATE messages SET is_deleted = 1 WHERE id = ?`;
            this.db.run(sql, [msgId], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    getChatHistory(chatId) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC`;
            this.db.all(sql, [chatId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    getQueue() {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM chats ORDER BY timestamp DESC`;
            this.db.all(sql, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }
}

module.exports = new Database();
