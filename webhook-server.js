require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_H    = {
  Authorization: `Bearer ${process.env.GHL_API_KEY}`,
  'Content-Type': 'application/json',
  Version: '2021-07-28',
};

const BOOKING_URL = 'https://clinics.amelia.im/widget/booking/amelia-sales-call';

// Keywords that signal genuine interest
const INTEREST_KEYWORDS = [
  'interested', 'yes', 'yeah', 'sure', 'tell me more', 'how much',
  'price', 'pricing', 'cost', 'how does it work', 'more info',
  'sounds good', 'love to', 'would like', 'learn more', 'schedule',
  'book', 'call', 'demo', 'show me', 'what is this', 'what\'s this',
];

// Keywords that signal they want to unsubscribe
const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'remove', 'no thanks', 'not interested', 'dont contact'];

const LOG_FILE = path.join(__dirname, 'webhook.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function detectIntent(text) {
  const lower = text.toLowerCase();
  if (OPT_OUT_KEYWORDS.some(k => lower.includes(k))) return 'opt_out';
  if (INTEREST_KEYWORDS.some(k => lower.includes(k)))  return 'interested';
  return 'neutral';
}

async function sendReply(contactId, conversationId, message) {
  await axios.post(`${GHL_BASE}/conversations/messages`, {
    type: 'SMS', contactId, conversationId, message,
  }, { headers: GHL_H });
}

async function handleInboundSMS(payload) {
  const { contactId, conversationId, body, type } = payload;
  if (type !== 'SMS' && type !== 'INBOUND') return;
  if (!body || !contactId || !conversationId) return;

  const intent = detectIntent(body);
  log(`  Inbound from ${contactId}: "${body.slice(0, 80)}" → intent: ${intent}`);

  if (intent === 'opt_out') {
    log(`  Opt-out detected — no reply sent`);
    return;
  }

  if (intent === 'interested') {
    const niche = process.env.NICHE || 'medspa';
    const replies = {
      medspa: `Hi! Thanks for reaching out. Amelia is an AI receptionist that responds to every SMS, DM, and missed call in under 60 seconds — and books directly into your calendar.\n\nYou can book a free 15-min demo here:\n${BOOKING_URL}\n\nLooking forward to showing you how it works! — Juan`,
      chiro:  `Hi! Thanks for getting back to me. Amelia is an AI receptionist that responds to every new patient inquiry instantly — 24/7, including nights and weekends — and books directly into your schedule.\n\nBook a free 15-min demo:\n${BOOKING_URL}\n\n— Juan`,
      dental: `Hi! Thanks for responding. Amelia is an AI receptionist that handles every new patient inquiry instantly and books appointments directly into your calendar — nights, weekends, no problem.\n\nSee it live in 15 min:\n${BOOKING_URL}\n\n— Juan`,
    };
    const reply = replies[niche] || replies['medspa'];

    try {
      await sendReply(contactId, conversationId, reply);
      log(`  ✅ Booking link sent to ${contactId}`);

      // Log to Sheets
      await logInterestToSheet(contactId, body);
    } catch (e) {
      log(`  ❌ Reply failed: ${e.message}`);
    }
  }
}

async function logInterestToSheet(contactId, replyText) {
  try {
    const { google } = require('googleapis');
    const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));
    const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Interested!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        new Date().toLocaleDateString('en-US'),
        contactId,
        replyText.slice(0, 200),
        'Booking link sent',
        BOOKING_URL,
      ]] },
    });
  } catch (e) {
    log(`  Sheets log failed: ${e.message}`);
  }
}

// ─── Static assets (signature images) ────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── GHL Webhook endpoint ──────────────────────────────────────────────────────
app.use(express.json());

app.post('/webhook/ghl', async (req, res) => {
  res.sendStatus(200); // ACK immediately so GHL doesn't retry
  try {
    const payload = req.body;
    log(`Webhook received: type=${payload.type} contact=${payload.contactId}`);
    await handleInboundSMS(payload);
  } catch (e) {
    log(`Webhook error: ${e.message}`);
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── GHL OAuth flow ───────────────────────────────────────────────────────────
const OAUTH_TOKEN_FILE = path.join(__dirname, 'ghl-oauth-tokens.json');

function saveOAuthTokens(tokens) {
  fs.writeFileSync(OAUTH_TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadOAuthTokens() {
  try { return JSON.parse(fs.readFileSync(OAUTH_TOKEN_FILE, 'utf8')); } catch { return null; }
}

async function refreshOAuthToken() {
  const tokens = loadOAuthTokens();
  if (!tokens?.refresh_token) throw new Error('No refresh token stored — re-authorize at /oauth/start');
  const res = await axios.post('https://services.leadconnectorhq.com/oauth/token', new URLSearchParams({
    client_id:     process.env.GHL_CLIENT_ID,
    client_secret: process.env.GHL_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: tokens.refresh_token,
  }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const updated = { ...tokens, ...res.data, refreshed_at: new Date().toISOString() };
  saveOAuthTokens(updated);
  log(`OAuth token refreshed`);
  return updated.access_token;
}

async function getOAuthAccessToken() {
  const tokens = loadOAuthTokens();
  if (!tokens) throw new Error('Not authorized — visit /oauth/start');
  // Refresh if expires within 30 min
  const expiresAt = new Date(tokens.refreshed_at || tokens.authorized_at).getTime() + (tokens.expires_in * 1000);
  if (Date.now() > expiresAt - 1800000) {
    return await refreshOAuthToken();
  }
  return tokens.access_token;
}

// Step 1: redirect to GHL authorization page
app.get('/oauth/start', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri:  `https://${req.headers.host}/oauth/callback`,
    client_id:     process.env.GHL_CLIENT_ID,
    scope:         'locations.write locations.read users.write users.read businesses.readonly',
  });
  // Agency-level app uses chooseagency endpoint
  res.redirect(`https://marketplace.gohighlevel.com/oauth/chooselocation?${params}`);
});

// Step 2: GHL redirects here with ?code=...
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code parameter');
  try {
    const tokenRes = await axios.post('https://services.leadconnectorhq.com/oauth/token', new URLSearchParams({
      client_id:     process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  `https://${req.headers.host}/oauth/callback`,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tokens = { ...tokenRes.data, authorized_at: new Date().toISOString() };
    saveOAuthTokens(tokens);
    log(`OAuth authorized — access token stored`);
    res.send(`
      <h2>✅ Amelia Onboarding authorized!</h2>
      <p>Token stored. You can now create sub-accounts via the onboarding script.</p>
      <p>Access token expires in ${Math.round(tokens.expires_in / 3600)}h — auto-refreshes.</p>
    `);
  } catch (e) {
    log(`OAuth callback error: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
    res.status(500).send(`OAuth error: ${e.message}`);
  }
});

// OAuth status check
app.get('/oauth/status', (req, res) => {
  const tokens = loadOAuthTokens();
  if (!tokens) return res.json({ status: 'not_authorized', action: 'Visit /oauth/start to authorize' });
  const authorizedAt = tokens.refreshed_at || tokens.authorized_at;
  const expiresAt = new Date(new Date(authorizedAt).getTime() + tokens.expires_in * 1000);
  res.json({ status: 'authorized', authorized_at: authorizedAt, expires_at: expiresAt, scope: tokens.scope });
});

module.exports.getOAuthAccessToken = getOAuthAccessToken;

// ─── Daily summary email ───────────────────────────────────────────────────────
async function sendDailySummary() {
  const STATE_FILE     = path.join(__dirname, 'pipeline-state.json');
  const SUMMARY_EMAIL  = process.env.SUMMARY_EMAIL;
  if (!SUMMARY_EMAIL) return;

  let state = { batches: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  const today     = new Date().toISOString().split('T')[0];
  const todayBatch = state.batches.find(b => b.date === today);
  const smsSent   = todayBatch?.smsSent || 0;
  const total     = todayBatch?.leads?.length || 0;
  const landlines = todayBatch?.leads?.filter(l => l.status === 'landline').length || 0;
  const city      = todayBatch?.city || '—';

  const processed = state.batches.filter(b => b.status === 'processed');
  const responded = processed.flatMap(b => b.leads).filter(l => l.status === 'responded').length;
  const noReply   = processed.flatMap(b => b.leads).filter(l => l.status === 'no_reply').length;

  const subject = `Amelia Pipeline — Daily Report ${today}`;
  const body = `
Daily Pipeline Summary — ${today}

TODAY
  City: ${city}
  Leads scraped: ${total}
  SMS sent: ${smsSent}
  Landlines skipped: ${landlines}

ALL TIME
  Batches processed: ${processed.length}
  Responded: ${responded}
  No reply: ${noReply}
  Response rate: ${responded + noReply > 0 ? Math.round(responded / (responded + noReply) * 100) : 0}%

View sheet: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_ID}
  `.trim();

  // Send via GHL email (uses existing API key)
  try {
    await axios.post(`${GHL_BASE}/conversations/messages`, {
      type: 'Email',
      contactId: process.env.SUMMARY_CONTACT_ID, // your own GHL contact ID
      subject,
      html: `<pre style="font-family:monospace">${body}</pre>`,
    }, { headers: GHL_H });
    log(`Daily summary sent to ${SUMMARY_EMAIL}`);
  } catch (e) {
    log(`Summary email failed: ${e.message}`);
  }
}

// ─── Start server ──────────────────────────────────────────────────────────────
function startWebhookServer() {
  app.listen(PORT, () => {
    log(`Webhook server listening on port ${PORT}`);
    log(`GHL webhook URL: https://YOUR-RAILWAY-DOMAIN/webhook/ghl`);
  });
}

module.exports = { startWebhookServer, sendDailySummary };
