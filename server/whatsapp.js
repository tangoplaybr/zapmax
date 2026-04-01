const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const db = require('./database');
const { EventEmitter } = require('events');

class WhatsAppGateway extends EventEmitter {
    constructor() {
        super();
        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                args: ['--no-sandbox'],
            }
        });

        this.init();
    }

    init() {
        this.client.on('qr', (qr) => {
            console.log('QR RECEIVED', qr);
            qrcode.generate(qr, { small: true });
            this.emit('qr', qr);
        });

        this.client.on('ready', () => {
            console.log('Client is ready!');
            this.emit('ready');
        });

        this.client.on('message', async (msg) => {
            console.log('MESSAGE RECEIVED', msg.body);

            const contact = await msg.getContact();
            const name = contact.name || contact.pushname || msg.from;

            // Save to database
            await db.updateChat(msg.from, name, msg.body);
            await db.saveMessage(msg.id.id, msg.from, msg.body, false);

            this.emit('message', {
                chatId: msg.from,
                name: name,
                body: msg.body,
                timestamp: new Date()
            });
        });

        this.client.initialize();
    }

    async sendMessage(chatId, body) {
        try {
            const msg = await this.client.sendMessage(chatId, body);
            await db.saveMessage(msg.id.id, chatId, body, true);
            return msg;
        } catch (err) {
            console.error('Error sending message', err);
            throw err;
        }
    }
}

module.exports = new WhatsAppGateway();
