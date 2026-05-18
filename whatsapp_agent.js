const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Express App Configuration
const app = express();
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));
const PORT = 4000;
const FLASK_URL = process.env.FLASK_URL || 'https://spliteasy-crazf5arbyh3ftfj.eastasia-01.azurewebsites.net';

let currentQR = null;
let isReady = false;

// Ensure static directory exists
if (!fs.existsSync(path.join(__dirname, 'static'))) {
    fs.mkdirSync(path.join(__dirname, 'static'));
}

// ---------------------------------------------------------------
// Helper: Notify Flask about Bot Status
// ---------------------------------------------------------------
async function updateFlaskStatus(status, phone = null) {
    try {
        const payload = { status };
        if (phone) payload.phone = phone;

        const res = await fetch(`${FLASK_URL}/api/internal/update_whatsapp_status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            console.log(`[Status Sync] Synchronized status "${status}" with Flask backend.`);
        } else {
            console.error(`[Status Sync] Failed to sync status with Flask: ${res.status}`);
        }
    } catch (err) {
        console.error(`[Status Sync] Error calling Flask status API: ${err.message}`);
    }
}

// ---------------------------------------------------------------
// WhatsApp Client Setup
// ---------------------------------------------------------------
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
    webVersion: '2.24.12.54',
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.24.12.54.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-zygote'
        ]
    }
});

// ---------------------------------------------------------------
// QR Code — save to static dir + notify Flask
// ---------------------------------------------------------------
client.on('qr', async (qr) => {
    currentQR = qr;
    console.log('[WhatsApp Agent] New QR Code received, saving to static directory...');

    const qrPath = path.join(__dirname, 'static', 'whatsapp_qr.png');
    try {
        await QRCode.toFile(qrPath, qr, {
            color: { dark: '#000000', light: '#ffffff' },
            width: 300
        });
        console.log(`[WhatsApp Agent] Auth QR generated successfully at: ${qrPath}`);
        await updateFlaskStatus('qr_ready');
    } catch (err) {
        console.error('[WhatsApp Agent] Failed to save QR code image file:', err.message);
    }
});

// ---------------------------------------------------------------
// Browser QR page (same as your working reference code)
// ---------------------------------------------------------------
app.get('/qr', async (req, res) => {
    if (!currentQR) {
        return res.send(`
            <h2 style="font-family:sans-serif;text-align:center;margin-top:60px;">
                No QR code right now (loading or already connected).
            </h2>
            <script>setTimeout(() => location.reload(), 2000)</script>
        `);
    }
    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <div style="font-family:sans-serif;text-align:center;margin-top:50px;">
                <h2>Scan with WhatsApp to connect SplitEasy Bot</h2>
                <img src="${qrImage}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:8px;" />
                <p>Open WhatsApp → Linked Devices → Link a Device</p>
                <script>setTimeout(() => location.reload(), 5000)</script>
            </div>
        `);
    } catch (e) {
        res.send('<p>Error generating QR image.</p>');
    }
});

// ---------------------------------------------------------------
// Authenticated
// ---------------------------------------------------------------
client.on('authenticated', () => {
    console.log('[WhatsApp Agent] Session authenticated successfully.');
});

client.on('auth_failure', async (msg) => {
    console.error('[WhatsApp Agent] Authentication failure:', msg);
    await updateFlaskStatus('offline');
});

// ---------------------------------------------------------------
// Ready — connection is open
// ---------------------------------------------------------------
client.on('ready', async () => {
    isReady = true;
    currentQR = null;

    // Clean up QR image
    const qrPath = path.join(__dirname, 'static', 'whatsapp_qr.png');
    if (fs.existsSync(qrPath)) {
        try {
            fs.unlinkSync(qrPath);
            console.log('[WhatsApp Agent] Cleaned up authentication QR code image.');
        } catch (e) {
            console.error('[WhatsApp Agent] Failed to delete QR file:', e.message);
        }
    }

    const phone = client.info.wid.user; // real phone number, e.g. "923427411527"
    console.log(`[WhatsApp Agent] Connection established successfully!`);
    console.log(`[WhatsApp Agent] Bot is online using phone number: +${phone}`);
    await updateFlaskStatus('online', phone);
});

// ---------------------------------------------------------------
// Disconnected
// ---------------------------------------------------------------
client.on('disconnected', async (reason) => {
    isReady = false;
    console.log(`[WhatsApp Agent] Disconnected: ${reason}`);
    await updateFlaskStatus('offline');

    // Reinitialize after short delay
    console.log('[WhatsApp Agent] Reinitializing in 5 seconds...');
    setTimeout(() => {
        client.initialize();
    }, 5000);
});

// ---------------------------------------------------------------
// Incoming Messages
// ---------------------------------------------------------------
client.on('message', async (msg) => {
    // Ignore status broadcasts and empty messages
    if (msg.isStatus || !msg.body) return;

    // Extract real phone number — always clean with whatsapp-web.js
    // msg.author is set for group messages, msg.from for direct
    const rawSender = msg.author || msg.from;
    const phone = rawSender.split('@')[0]; // e.g. "923350806140"

    const textContent = msg.body.trim();
    if (!textContent) return;

    console.log(`[WhatsApp Incoming] Message from +${phone}: "${textContent}"`);

    // Mark as read
    try {
        await msg.getChat().then(chat => chat.sendSeen());
    } catch (e) {
        console.warn('[WhatsApp Agent] Failed to mark message as read:', e.message);
    }

    // Forward to Flask Conversational Brain webhook
    try {
        const webhookUrl = `${FLASK_URL}/api/whatsapp/webhook`;
        const payload = { from_phone: phone, message_text: textContent };

        console.log(`[WhatsApp Webhook] Dispatching to webhook: ${webhookUrl}`);
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            const responseData = await response.json();
            const replyText = responseData.reply;

            if (replyText) {
                console.log(`[WhatsApp Outgoing] Replying to +${phone}: "${replyText}"`);
                await msg.reply(replyText);
            }
        } else {
            console.error(`[WhatsApp Webhook] Webhook returned status: ${response.status}`);
            await msg.reply("⚠️ Sorry, I am experiencing temporary difficulties communicating with the SplitEasy engine. Please try again in a few moments.");
        }
    } catch (err) {
        console.error('[WhatsApp Webhook] Webhook post failure:', err.message);
        await msg.reply("⚠️ Network connectivity issues: I couldn't reach the SplitEasy servers. Please notify the administrator.");
    }
});

// ---------------------------------------------------------------
// Express API: POST /send — Flask broadcast dispatcher
// ---------------------------------------------------------------
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Missing phone or message fields.' });
    }

    if (!isReady) {
        return res.status(503).json({ error: 'WhatsApp bot daemon is currently offline or unauthenticated.' });
    }

    try {
        // Normalize to WhatsApp chat ID format
        const chatId = `${phone.replace(/[^0-9]/g, '')}@c.us`;
        console.log(`[Broadcast Dispatcher] Sending message to +${phone}...`);
        await client.sendMessage(chatId, message);
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Broadcast Dispatcher] Failed to send broadcast message:', err.message);
        return res.status(500).json({ error: `Failed to transmit message: ${err.message}` });
    }
});

// ---------------------------------------------------------------
// Express API: GET /status — health check
// ---------------------------------------------------------------
app.get('/status', (req, res) => {
    res.json({
        status: isReady ? 'online' : 'offline',
        qr_active: !!currentQR,
        info: client.info || null
    });
});

// ---------------------------------------------------------------
// Start Express server & WhatsApp client
// ---------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Admin Dispatcher Server] Running on http://0.0.0.0:${PORT}`);
    console.log(`[Admin Dispatcher Server] QR page available at http://0.0.0.0:${PORT}/qr`);
    client.initialize();
});
