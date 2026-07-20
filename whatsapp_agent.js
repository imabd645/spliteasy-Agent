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

// The pairing QR is a live credential: whoever scans it links their own
// WhatsApp Web session to this number. It sat under a public static mount, so
// on a public hostname it was readable by anyone who guessed the path. This
// guarded route is registered *before* the static middleware so it wins.
app.get('/static/whatsapp_qr.png', (req, res) => {
    if (!secretsMatch(req.get('x-api-key'), WHATSAPP_API_KEY)) {
        console.warn(`[QR] Rejected an unauthorized QR fetch from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const qrPath = path.join(__dirname, 'static', 'whatsapp_qr.png');
    if (!fs.existsSync(qrPath)) {
        return res.status(404).json({ error: 'No pairing QR is currently available.' });
    }
    return res.sendFile(qrPath);
});

app.use('/static', express.static(path.join(__dirname, 'static')));

// Liveness probe for the host. Deliberately unauthenticated and free of any
// detail worth leaking.
app.get('/health', (req, res) => {
    const connected = Boolean(sock && sock.ws && sock.ws.readyState === 1);
    return res.status(200).json({ ok: true, whatsapp_connected: connected });
});

// Hosting platforms assign the port; 4000 is only the local default. This was
// hardcoded, so the agent bound to the wrong port on any managed host.
const PORT = process.env.PORT || 4000;

// Flask Backend Configuration
const FLASK_URL = process.env.FLASK_URL || 'https://splitkar.site';

// Shared secret presented to Flask on /api/internal/* and the message webhook.
// Must equal INTERNAL_API_KEY on the Flask side, or those calls are rejected.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';

// Shared secret Flask presents to *this* agent on /send. Must equal Flask's
// WHATSAPP_API_KEY. Without it, anyone who can reach this host can send
// WhatsApp messages from the linked number.
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || '';

if (!INTERNAL_API_KEY) {
    console.error('[Config] INTERNAL_API_KEY is not set. Flask will reject every ' +
                  'status update and every forwarded message with 401.');
}
if (!WHATSAPP_API_KEY) {
    console.error('[Config] WHATSAPP_API_KEY is not set. /send is UNPROTECTED — ' +
                  'anyone who can reach this host can send messages as you.');
}

// Constant-time comparison, so a caller cannot recover the key by timing how
// long a wrong guess takes to be rejected.
function secretsMatch(presented, expected) {
    if (!expected) return false;
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return require('crypto').timingSafeEqual(a, b);
}

// Headers for every call out to Flask.
function flaskHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Internal-Key': INTERNAL_API_KEY
    };
}

let sock = null;

// Helper to notify Flask about Bot Status
async function updateFlaskStatus(status, phone = null) {
    try {
        const payload = { status };
        if (phone) payload.phone = phone;

        const res = await fetch(`${FLASK_URL}/api/internal/update_whatsapp_status`, {
            method: 'POST',
            headers: flaskHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            console.log(`[Status Sync] Synchronized status "${status}" with Flask backend.`);
        } else if (res.status === 401) {
            console.error('[Status Sync] Flask rejected the internal key (401). ' +
                          'INTERNAL_API_KEY here must match the Flask environment.');
        } else if (res.status === 503) {
            console.error('[Status Sync] Flask has no INTERNAL_API_KEY configured (503).');
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
        
        // Ignore messages sent by the bot itself
        if (fromMe) return;
        
        // Extract raw phone number of sender correctly (handles direct, groups, or status participants)
        const sender = msg.key.participant || msg.key.remoteJid;
        if (!sender) return;
        const phone = sender.split('@')[0];
        
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
            const payload = { from_phone: phone, message_text: textContent };
            
            console.log(`[WhatsApp Webhook] Dispatching to webhook: ${webhookUrl}`);
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: flaskHeaders(),
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
                if (response.status === 401) {
                    console.error('[WhatsApp Webhook] Flask rejected the internal key (401). ' +
                                  'INTERNAL_API_KEY must match on both sides.');
                } else if (response.status === 404) {
                    console.error('[WhatsApp Webhook] Webhook is disabled on Flask ' +
                                  '(WHATSAPP_WEBHOOK_ENABLED=false).');
                }
                console.error(`[WhatsApp Webhook] Webhook returned status: ${response.status}`);
                await sock.sendMessage(from, { 
                    text: "⚠️ Sorry, I am experiencing temporary difficulties communicating with the Splitkar engine. Please try again in a few moments." 
                });
            }
        } catch (err) {
            console.error('[WhatsApp Webhook] Webhook post failure:', err.message);
            await sock.sendMessage(from, { 
                text: "⚠️ Network connectivity issues: I couldn't reach the Splitkar servers. Please notify the administrator." 
            });
        }
    });
}

// --- Express API Endpoints for Flask ---

// POST /send - Admin broadcast dispatching endpoint.
//
// Flask presents its WHATSAPP_API_KEY as `x-api-key` (see
// splitkar/services/whatsapp.py). This endpoint previously ignored that header
// entirely, so once the agent was reachable on a public hostname, anyone could
// send WhatsApp messages from the linked number.
app.post('/send', async (req, res) => {
    if (!secretsMatch(req.get('x-api-key'), WHATSAPP_API_KEY)) {
        console.warn(`[Broadcast Dispatcher] Rejected an unauthorized /send from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

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
