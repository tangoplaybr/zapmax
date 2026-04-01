const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./database');
const whatsapp = require('./whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Attendant connected:', socket.id);

    // Send initial queue
    db.getQueue().then(queue => {
        socket.emit('queue_update', queue);
    });

    // Handle attendant identification
    socket.on('identify', (attendant) => {
        socket.attendant = attendant;
        console.log(`Attendant identified: ${attendant.name}`);
    });

    // Handle chat claim
    socket.on('claim_chat', async ({ chatId }) => {
        if (socket.attendant) {
            await db.assignChat(chatId, socket.attendant.id, socket.attendant.name);
            const queue = await db.getQueue();
            io.emit('queue_update', queue);

            const history = await db.getChatHistory(chatId);
            socket.emit('chat_history', { chatId, history });
        }
    });

    // Handle message sending from attendant
    socket.on('send_message', async ({ chatId, body, quotedBody, quotedMsgId }) => {
        try {
            await whatsapp.sendMessage(chatId, body);
            const history = await db.getChatHistory(chatId);
            socket.emit('chat_history', { chatId, history });

            // Update queue for everyone
            const queue = await db.getQueue();
            io.emit('queue_update', queue);
        } catch (err) {
            socket.emit('error', 'Failed to send message');
        }
    });

    // Handle edit message — DB first, instant UI, then async WA sync
    socket.on('edit_message', async ({ chatId, msgId, newBody }) => {
        // 1. Update DB immediately
        await db.editMessage(msgId, newBody);

        // 2. Emit incremental event so all clients update instantly
        io.emit('message_updated', { chatId, msgId, newBody });

        // 3. Fire-and-forget: sync with WhatsApp in the background
        (async () => {
            try {
                const waChat = await whatsapp.client.getChatById(chatId);
                const waMessages = await waChat.fetchMessages({ limit: 50 });
                const waMsg = waMessages.find(m => m.id.id === msgId);
                if (waMsg) await waMsg.edit(newBody).catch(() => {});
            } catch (_) { /* WhatsApp sync failed gracefully */ }
        })();
    });

    // Handle delete message — DB first, instant UI, then async WA sync
    socket.on('delete_message', async ({ chatId, msgId }) => {
        // 1. Update DB immediately
        await db.deleteMessage(msgId);

        // 2. Emit incremental event so all clients update instantly
        io.emit('message_deleted', { chatId, msgId });

        // 3. Update queue
        const queue = await db.getQueue();
        io.emit('queue_update', queue);

        // 4. Fire-and-forget: sync with WhatsApp in the background
        (async () => {
            try {
                const waChat = await whatsapp.client.getChatById(chatId);
                const waMessages = await waChat.fetchMessages({ limit: 50 });
                const waMsg = waMessages.find(m => m.id.id === msgId);
                if (waMsg) await waMsg.delete(true).catch(() => {});
            } catch (_) { /* WhatsApp sync failed gracefully */ }
        })();
    });

    socket.on('disconnect', () => {
        console.log('Attendant disconnected');
    });
});

// Forward WhatsApp events to sockets
whatsapp.on('qr', (qr) => {
    io.emit('whatsapp_qr', qr);
});

whatsapp.on('ready', () => {
    io.emit('whatsapp_ready');
});

whatsapp.on('message', async (data) => {
    const queue = await db.getQueue();
    io.emit('queue_update', queue);
    io.emit('new_whatsapp_message', data);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = { io, server };
