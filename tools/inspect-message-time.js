#!/usr/bin/env node
/**
 * Evidence helper (plan: sql-evidence): print timestamp columns for one message row.
 * Usage (from repo root): node tools/inspect-message-time.js <messageId>
 * Uses the same DB path rules as apps/server/database.js (DB_PATH, WA_DATA_DIR, APPDATA\\ZapMax, …).
 */
const path = require('path');
const db = require(path.join(__dirname, '../apps/server/database.js'));

const id = process.argv[2];
if (!id) {
    console.error('Usage: node tools/inspect-message-time.js <messageId>');
    process.exit(1);
}

setTimeout(() => {
    const sql = `SELECT id, chat_id, from_me, timestamp, sent_at_utc,
        datetime(sent_at_utc, 'unixepoch') AS sent_at_utc_as_utc_text
        FROM messages WHERE id = ?`;
    db.db.get(sql, [id], (err, row) => {
        if (err) {
            console.error(err.message);
            process.exit(1);
        }
        console.log('DB file:', db.dbFilePath || '(unknown)');
        if (!row) {
            console.log('No row for id:', id);
            process.exit(2);
        }
        console.log(JSON.stringify(row, null, 2));
        if (row.sent_at_utc != null) {
            const d = new Date(row.sent_at_utc * 1000);
            console.log('sent_at_utc as ISO (UTC):', d.toISOString());
        }
        process.exit(0);
    });
}, 400);
