// Polyfill global crypto for Node 18.x and older (required by Baileys Web Crypto)
if (typeof global.crypto === 'undefined') {
    global.crypto = require('crypto');
}

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const express = require('express');
const fetch = require('node-fetch');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Express App Configuration
const app = express();
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));
const PORT = 4000;
const FLASK_URL = process.env.FLASK_URL || 'https://spliteasy-crazf5arbyh3ftfj.eastasia-01.azurewebsites.net';

let sock = null;

// Helper to notify Flask about Bot Status
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

// Start Baileys Socket Session
async function startSock() {
    console.log('[WhatsApp Agent] Initializing Baileys Socket...');
    
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_auth_info');
    
    let version = [2, 3000, 1017531287]; // Default fallback "last known good" version
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        version = latestVersion;
        console.log(`[WhatsApp Agent] Dynamically loaded WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);
    } catch (err) {
        console.warn(`[WhatsApp Agent] Failed to fetch latest version, falling back to v${version.join('.')}: ${err.message}`);
    }
    
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[WhatsApp Agent] New QR Code received, saving to static directory...');
            const qrPath = path.join(__dirname, 'static', 'whatsapp_qr.png');
            
            // Ensure static directory exists
            if (!fs.existsSync(path.join(__dirname, 'static'))) {
                fs.mkdirSync(path.join(__dirname, 'static'));
            }
            
            try {
                await qrcode.toFile(qrPath, qr, {
                    color: {
                        dark: '#000000',
                        light: '#ffffff'
                    },
                    width: 300
                });
                console.log(`[WhatsApp Agent] Auth QR generated successfully at: ${qrPath}`);
                await updateFlaskStatus('qr_ready');
            } catch (err) {
                console.error('[WhatsApp Agent] Failed to save QR code image file:', err.message);
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[WhatsApp Agent] Connection closed due to: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`);
            
            await updateFlaskStatus('offline');
            
            if (shouldReconnect) {
                setTimeout(startSock, 5000); // Reconnect in 5 seconds
            } else {
                console.log('[WhatsApp Agent] Logged out from WhatsApp. Purging old session credentials...');
                try {
                    fs.rmSync('whatsapp_auth_info', { recursive: true, force: true });
                } catch (e) {
                    console.error('[WhatsApp Agent] Failed to clean auth directory:', e.message);
                }
                setTimeout(startSock, 5000);
            }
        } else if (connection === 'open') {
            console.log('[WhatsApp Agent] Connection established successfully!');
            
            // Delete the QR file if it exists to avoid showing stale code
            const qrPath = path.join(__dirname, 'static', 'whatsapp_qr.png');
            if (fs.existsSync(qrPath)) {
                try {
                    fs.unlinkSync(qrPath);
                    console.log('[WhatsApp Agent] Cleaned up authentication QR code image.');
                } catch (e) {
                    console.error('[WhatsApp Agent] Failed to delete QR file:', e.message);
                }
            }
            
            const rawPhone = sock.user.id.split(':')[0];
            console.log(`[WhatsApp Agent] Bot is online using phone number: +${rawPhone}`);
            await updateFlaskStatus('online', rawPhone);
        }
    });
    
    // Listen for Incoming Messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const fromMe = msg.key.fromMe;
        
        // Only process direct chats and ignore messages sent by the bot itself
        if (isGroup || fromMe) return;
        
        // Extract raw phone number of sender
        const phone = from.split('@')[0];
        
        // Get text content of the message
        let textContent = '';
        if (msg.message.conversation) {
            textContent = msg.message.conversation;
        } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) {
            textContent = msg.message.extendedTextMessage.text;
        } else if (msg.message.imageMessage && msg.message.imageMessage.caption) {
            textContent = msg.message.imageMessage.caption;
        }
        
        textContent = textContent.trim();
        if (!textContent) return;
        
        console.log(`[WhatsApp Incoming] Message from +${phone}: "${textContent}"`);
        
        // Mark message as read
        try {
            await sock.readMessages([msg.key]);
        } catch (e) {
            console.warn('[WhatsApp Agent] Failed to mark message as read:', e.message);
        }
        
        // Forward to Flask Conversational Brain webhook
        try {
            const webhookUrl = `${FLASK_URL}/api/whatsapp/webhook`;
            const payload = { sender: phone, message: textContent };
            
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
                    await sock.sendMessage(from, { text: replyText });
                }
            } else {
                console.error(`[WhatsApp Webhook] Webhook returned status: ${response.status}`);
                await sock.sendMessage(from, { 
                    text: "⚠️ Sorry, I am experiencing temporary difficulties communicating with the SplitEasy engine. Please try again in a few moments." 
                });
            }
        } catch (err) {
            console.error('[WhatsApp Webhook] Webhook post failure:', err.message);
            await sock.sendMessage(from, { 
                text: "⚠️ Network connectivity issues: I couldn't reach the SplitEasy servers. Please notify the administrator." 
            });
        }
    });
}

// --- Express API Endpoints for Flask ---

// POST /send - Admin broadcast dispatching endpoint
app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Missing phone or message fields.' });
    }
    
    if (!sock || sock.ws.readyState !== 1) { // 1 = OPEN
        return res.status(503).json({ error: 'WhatsApp bot daemon is currently offline or unauthenticated.' });
    }
    
    try {
        const jid = `${phone}@s.whatsapp.net`;
        console.log(`[Broadcast Dispatcher] Sending message to +${phone}...`);
        await sock.sendMessage(jid, { text: message });
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Broadcast Dispatcher] Failed to send broadcast message:', err.message);
        return res.status(500).json({ error: `Failed to transmit message: ${err.message}` });
    }
});

// Start Express server & socket connection
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Admin Dispatcher Server] Running on http://0.0.0.0:${PORT}`);
    startSock();
});
