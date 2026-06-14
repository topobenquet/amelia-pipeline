require('dotenv').config();
const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────────────────────────
const LEADS_PER_DAY   = parseInt(process.env.LEADS_PER_DAY || '30');
const MIN_REVIEWS     = parseInt(process.env.MIN_REVIEWS || '30');
const STATE_FILE      = path.join(__dirname, 'pipeline-state.json');
const AUDITS_DIR      = path.join(__dirname, 'audits');
const CONTACTED_FILE  = path.join(__dirname, 'contacted-phones.json');
const DRIVE_FOLDER    = 'Amelia Audits';
const BOOKING_URL     = 'https://clinics.amelia.im/demo';

// Cities to rotate through (add more to increase reach)
const CITIES = [
  'Austin, TX', 'Denver, CO', 'Nashville, TN', 'Charlotte, NC',
  'Dallas, TX', 'Houston, TX', 'Atlanta, GA', 'Miami, FL',
  'Phoenix, AZ', 'San Diego, CA', 'Portland, OR', 'Seattle, WA',
];

// ─── State helpers (persisted to Google Sheets tab so Railway restarts don't wipe it) ─
const SHEETS_STATE_TAB      = '_pipeline_state';
const SHEETS_CONTACTED_TAB  = '_contacted_phones';

let _stateCache    = null;
let _contactedCache = null;

async function getSheetsClient() {
  // Always use service account for Sheets (has access, no quota issues)
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  } else {
    credentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
}

async function readSheetCell(sheets, tab) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${tab}!A1`,
    });
    const val = res.data.values?.[0]?.[0];
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function writeSheetCell(sheets, tab, data) {
  await ensureTab(sheets, tab);
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[JSON.stringify(data)]] },
  });
}

async function loadState() {
  // Try local file first (fast, works locally)
  try {
    const local = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    _stateCache = local;
    return local;
  } catch {}

  if (_stateCache) return _stateCache;

  // Load from Sheets
  try {
    const sheets = await getSheetsClient();
    const remote = await readSheetCell(sheets, SHEETS_STATE_TAB);
    if (remote) { _stateCache = remote; return remote; }
  } catch (e) { log(`  State Sheets load failed: ${e.message}`); }

  return { batches: [], cityIndex: 0 };
}

async function saveState(state) {
  _stateCache = state;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
  try {
    const sheets = await getSheetsClient();
    await writeSheetCell(sheets, SHEETS_STATE_TAB, state);
  } catch (e) { log(`  State Sheets sync failed: ${e.message}`); }
}

async function loadContacted() {
  if (fs.existsSync(CONTACTED_FILE)) {
    try {
      const phones = new Set(JSON.parse(fs.readFileSync(CONTACTED_FILE, 'utf8')));
      _contactedCache = phones;
      return phones;
    } catch {}
  }

  if (_contactedCache) return _contactedCache;

  // Load from Sheets
  try {
    const sheets = await getSheetsClient();
    const remote = await readSheetCell(sheets, SHEETS_CONTACTED_TAB);
    if (remote) {
      const phones = new Set(remote);
      _contactedCache = phones;
      return phones;
    }
  } catch {}

  // Rebuild from state as last resort
  const state = await loadState();
  const phones = new Set();
  for (const batch of state.batches) {
    for (const lead of (batch.leads || [])) {
      const p = (lead.phone || '').replace(/\D/g, '');
      if (p) phones.add(p);
    }
  }
  if (phones.size) log(`  Rebuilt contacted list from state: ${phones.size} phones`);
  _contactedCache = phones;
  return phones;
}

async function saveContacted(set) {
  _contactedCache = set;
  try { fs.writeFileSync(CONTACTED_FILE, JSON.stringify([...set])); } catch {}
  try {
    const sheets = await getSheetsClient();
    await writeSheetCell(sheets, SHEETS_CONTACTED_TAB, [...set]);
  } catch (e) { log(`  Contacted Sheets sync failed: ${e.message}`); }
}

// ─── Google Drive (Service Account) ──────────────────────────────────────────
function getDriveClient() {
  // Use OAuth user token for Drive (service accounts have no storage quota)
  if (process.env.GOOGLE_OAUTH_TOKEN) {
    const tokenData = JSON.parse(process.env.GOOGLE_OAUTH_TOKEN);
    const client_id     = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const client_secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!client_id) {
      // Local dev: read from credentials.json
      const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'credentials.json'), 'utf8'));
      const c = creds.installed || creds.web;
      return (() => {
        const oAuth2 = new google.auth.OAuth2(c.client_id, c.client_secret, 'http://localhost:3001/callback');
        oAuth2.setCredentials(tokenData);
        return { drive: google.drive({ version: 'v3', auth: oAuth2 }), auth: oAuth2 };
      })();
    }
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/callback');
    oAuth2.setCredentials(tokenData);
    return { drive: google.drive({ version: 'v3', auth: oAuth2 }), auth: oAuth2 };
  }

  // Fallback: service account (for Sheets only — Drive upload will fail)
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  } else {
    const SA_PATH = path.join(__dirname, 'service-account.json');
    credentials = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return { drive: google.drive({ version: 'v3', auth }), auth };
}

const SHEET_HEADERS = [
  'Date', 'Business Name', 'City', 'Phone', 'Email', 'Website',
  'Rating', 'Reviews', 'SMS Status', 'Response Time', 'Revenue at Risk',
  'Bucket', 'Audit Link', 'Instantly Status',
];

async function ensureSheetHeaders(sheets, sheetId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId, range: 'Sheet1!A1:N1',
  });
  const first = (res.data.values || [])[0];
  if (!first || first[0] !== 'Date') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

async function getSheetClient() {
  const sheets = await getSheetsClient();
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  await ensureSheetHeaders(sheets, sheetId);
  return { sheets, sheetId };
}

async function appendToSheet(rows) {
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  if (!sheetId) return;
  try {
    const sheets = await getSheetsClient();
    await ensureSheetHeaders(sheets, sheetId);
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  } catch (e) {
    log(`  Sheets append failed: ${e.message}`);
  }
}

// ─── Email sequences tab (one row per lead — survives state pruning) ──────────
const SEQ_TAB = '_email_sequences';
const SEQ_HEADERS = ['Name','City','Phone','Email','Website','Rating','Reviews','Bucket','ResponseTime','RevenueLost','AuditLink','Niche','Step','FirstSentAt','NextSendAt','LastSentAt'];

async function ensureRowsTab(sheets, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `${title}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

async function appendSequenceRow(entry) {
  const sheets = await getSheetsClient();
  await ensureRowsTab(sheets, SEQ_TAB, SEQ_HEADERS);
  const seq = entry.emailSequence;
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: `${SEQ_TAB}!A1`, valueInputOption: 'RAW',
    requestBody: { values: [[
      entry.name, entry.city || '', entry.phone || '', entry.email,
      entry.website || '', entry.rating || '', entry.reviews || '',
      entry.bucket || 'no_reply', entry.responseTime || '', entry.revenueLost || '',
      entry.auditLink || '', entry.niche || process.env.NICHE || 'chiro',
      seq.step, seq.firstSentAt, seq.nextSendAt || '', seq.lastSentAt || seq.firstSentAt,
    ]] },
  });
}

async function getDriveFolderId(drive) {
  // Use explicit folder ID from env if set (preferred — avoids Drive quota issues)
  if (process.env.DRIVE_FOLDER_ID) return process.env.DRIVE_FOLDER_ID;

  const res = await drive.files.list({
    q: `name='${DRIVE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });
  if (res.data.files.length) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: DRIVE_FOLDER, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return folder.data.id;
}

async function uploadPDF(drive, folderId, fileName, filePath) {
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: 'application/pdf' },
    media: { mimeType: 'application/pdf', body: fs.createReadStream(filePath) },
    fields: 'id',
  });
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });
  return `https://drive.google.com/file/d/${res.data.id}/view`;
}

// ─── GHL helpers ──────────────────────────────────────────────────────────────
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_H    = {
  Authorization: `Bearer ${process.env.GHL_API_KEY}`,
  'Content-Type': 'application/json',
  Version: '2021-07-28',
};

async function getOrCreateContact(lead) {
  const phone = lead.phone.replace(/\D/g, '');

  // Search first
  const searchRes = await axios.get(`${GHL_BASE}/contacts/`, {
    headers: GHL_H,
    params: { locationId: process.env.GHL_LOCATION_ID, query: phone, limit: 1 },
  });
  const existing = searchRes.data?.contacts?.[0];
  if (existing) {
    log(`    Contact found: ${existing.id}`);
    return existing.id;
  }

  // Create
  const createRes = await axios.post(`${GHL_BASE}/contacts/`, {
    locationId: process.env.GHL_LOCATION_ID,
    firstName:  lead.name,
    phone:      lead.phone,
    email:      lead.email || undefined,
    website:    lead.website || undefined,
    tags:       [`${process.env.NICHE || 'medspa'}-lead`, 'audit-prospect', lead.city.split(',')[0].trim()],
  }, { headers: GHL_H });

  const id = createRes.data?.contact?.id;
  if (!id) throw new Error(`Contact create failed: ${JSON.stringify(createRes.data)}`);
  log(`    Contact created: ${id}`);
  return id;
}

async function getOrCreateConversation(contactId) {
  const search = await axios.get(`${GHL_BASE}/conversations/search`, {
    headers: GHL_H,
    params: { locationId: process.env.GHL_LOCATION_ID, contactId },
  });
  const existing = search.data?.conversations?.[0];
  if (existing) return existing.id;

  const res = await axios.post(`${GHL_BASE}/conversations/`, {
    locationId: process.env.GHL_LOCATION_ID,
    contactId,
  }, { headers: GHL_H });
  const id = res.data?.conversation?.id || res.data?.id;
  if (!id) throw new Error(`Conversation create failed: ${JSON.stringify(res.data)}`);
  return id;
}

const SMS_MESSAGES = {
  medspa: 'Hi there! Saw your med spa online and wanted to ask about pricing for Botox. Do you have a menu or consult I could book?',
  chiro:  'Hi! I found your chiropractic office online and wanted to ask about pricing for a new patient consultation. Do you have availability this week?',
  dental: 'Hi! I came across your dental office online and wanted to ask about pricing for a cleaning and checkup. Are you accepting new patients?',
};

async function sendSMS(contactId, conversationId) {
  const niche   = process.env.NICHE || 'medspa';
  const message = SMS_MESSAGES[niche] || SMS_MESSAGES['medspa'];
  const res = await axios.post(`${GHL_BASE}/conversations/messages`, {
    type: 'SMS', contactId, conversationId, message,
  }, { headers: GHL_H });
  return res.data?.messageId || res.data?.id;
}

async function checkResponses(entries) {
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.conversationId || entry.status === 'responded') continue;
    try {
      const res = await axios.get(`${GHL_BASE}/conversations/${entry.conversationId}/messages`, { headers: GHL_H });
      const messages = res.data?.messages?.messages || [];
      const inbound = messages.find(m => m.direction === 'inbound' && new Date(m.dateAdded).getTime() > new Date(entry.sentAt).getTime());
      if (inbound && /\bstop\b|unsubscribe|dnd enabled|do not contact|not interested/i.test(inbound.body || '')) {
        entry.status = 'opted_out';
        entry.responseText = inbound.body;
      } else if (inbound) {
        entry.status = 'responded';
        entry.respondedAt = inbound.dateAdded;
        entry.responseText = inbound.body;
        entry.responseTimeHours = (new Date(inbound.dateAdded) - new Date(entry.sentAt)) / 3600000;
      } else {
        entry.status = 'no_reply';
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return entries;
}

// ─── Email sequence (Gmail SMTP) ──────────────────────────────────────────────
const { sendSequenceEmail, nextSendDate, isDue } = require('./email-sender.js');

// ─── Short.io link shortener ──────────────────────────────────────────────────
async function createShortLink(driveUrl, slug) {
  if (!process.env.SHORT_IO_API_KEY) return driveUrl;
  // Retry with a unique suffix if the path is taken (re-runs, same-name businesses)
  for (let attempt = 0; attempt < 3; attempt++) {
    const linkPath = attempt === 0 ? slug : `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const res = await axios.post('https://api.short.io/links', {
        domain:      process.env.SHORT_IO_DOMAIN || 'go.amelia.im',
        originalURL: driveUrl,
        path:        linkPath,
      }, { headers: { authorization: process.env.SHORT_IO_API_KEY, 'content-type': 'application/json' } });
      return res.data.shortURL || driveUrl;
    } catch (e) {
      const msg = JSON.stringify(e.response?.data || e.message);
      if (e.response?.status === 409 || /exist|duplicate|taken/i.test(msg)) continue; // path taken — retry with suffix
      log(`  Short.io failed (${msg.slice(0, 120)}), using Drive link`);
      return driveUrl;
    }
  }
  log(`  Short.io: no free path for ${slug} after 3 tries, using Drive link`);
  return driveUrl;
}

// ─── Google Maps scrape ───────────────────────────────────────────────────────
async function scrapeLeads(city, count, contacted) {
  const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  const NICHE    = process.env.NICHE || 'medspa';
  const NICHE_QUERIES = {
    medspa:        ['med spa', 'medical spa', 'medspa', 'aesthetic clinic', 'botox clinic'],
    chiro:         ['chiropractor', 'chiropractic clinic', 'chiropractic office', 'back pain clinic', 'spine clinic'],
    dental:        ['dental clinic', 'dentist office', 'cosmetic dentist', 'dental spa', 'orthodontist'],
  };
  const queries = NICHE_QUERIES[NICHE] || NICHE_QUERIES['medspa'];
  const leads    = [];
  const seen     = new Set();

  for (const query of queries) {
    if (leads.length >= count) break;
    try {
      let pageToken;
      do {
        const params = {
          query: `${query} in ${city}`,
          key: MAPS_KEY,
          ...(pageToken ? { pagetoken: pageToken } : {}),
        };
        const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', { params });
        for (const place of (res.data.results || [])) {
          if (leads.length >= count) break;
          if (seen.has(place.place_id)) continue;
          seen.add(place.place_id);

          // Get details (phone not in text search results)
          const det = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
            params: { place_id: place.place_id, fields: 'name,formatted_phone_number,website,rating,user_ratings_total,formatted_address', key: MAPS_KEY },
          });
          const d = det.data.result;
          const phone = (d.formatted_phone_number || '').replace(/\D/g, '');
          if (!phone || contacted.has(phone)) continue;
          if ((d.user_ratings_total || 0) < MIN_REVIEWS) continue;

          leads.push({
            name:    d.name,
            phone:   d.formatted_phone_number || '',
            website: d.website || '',
            city:    city,
            rating:  d.rating || null,
            reviews: d.user_ratings_total || 0,
            email:   null,
            instagram: null,
          });
          await new Promise(r => setTimeout(r, 300));
        }
        pageToken = res.data.next_page_token;
        if (pageToken) await new Promise(r => setTimeout(r, 2000));
      } while (pageToken && leads.length < count);
    } catch (e) {
      console.warn(`  Maps error for "${query}" in ${city}:`, e.message);
    }
  }
  return leads;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_BLACKLIST = ['example', 'sentry', 'wix.com', 'squarespace', 'wordpress', '@2x', 'png', 'jpg', 'svg', 'domain'];

function extractEmail(html) {
  const matches = html.match(EMAIL_REGEX) || [];
  return matches.find(e => !EMAIL_BLACKLIST.some(b => e.toLowerCase().includes(b))) || null;
}

// Try to scrape email from website — checks homepage + /contact + /about
async function scrapeEmail(websiteUrl) {
  if (!websiteUrl) return null;
  const base = websiteUrl.startsWith('http') ? websiteUrl.replace(/\/$/, '') : `https://${websiteUrl}`;
  const pages = [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`];

  for (const url of pages) {
    try {
      const res = await axios.get(url, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        maxRedirects: 3,
      });
      const email = extractEmail(res.data);
      if (email) return email;
    } catch { /* try next page */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

// ─── PDF generation (inline, avoids circular imports) ─────────────────────────
async function generateAndUploadPDF(lead, drive, folderId) {
  // Delegate to generate-and-upload-audits.js generatePDF function
  const { generatePDF } = require('./generate-audit-html.js');
  const slug    = lead.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  const pdfPath = path.join(AUDITS_DIR, `${slug}.pdf`);
  fs.mkdirSync(AUDITS_DIR, { recursive: true });
  await generatePDF({
    businessName:      lead.name,
    city:              lead.city,
    phone:             lead.phone,
    website:           lead.website,
    instagram:         lead.instagram || '',
    googleRating:      lead.rating,
    googleReviews:     lead.reviews,
    responseTimeHours: lead.responseTimeHours ?? null,
  }, pdfPath);
  return uploadPDF(drive, folderId, `${slug}-audit.pdf`, pdfPath);
}

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync('pipeline.log', line + '\n');
}

// ─── PHASE 1: Check responses + process ready batches ────────────────────────
async function phase1_processReadyBatches() {
  log('── PHASE 1: Checking ready batches ──');
  const state  = await loadState();
  const ready  = state.batches.filter(b => {
    if (b.status !== 'sms_sent') return false;
    const hoursSinceSent = (Date.now() - new Date(b.sentAt).getTime()) / 3600000;
    return hoursSinceSent >= 23;
  });

  if (!ready.length) { log('  No batches ready for processing'); return { reports: 0, failedBatches: 0 }; }

  let drive, auth, folderId;
  try {
    ({ drive, auth } = getDriveClient());
    folderId = await getDriveFolderId(drive);
  } catch (e) {
    log(`  Drive setup failed: ${e.message}`);
    return { reports: 0, failedBatches: ready.length };
  }
  let totalReports = 0, failedBatches = 0;

  for (const batch of ready) {
    log(`  Processing batch ${batch.date} (${batch.leads.length} leads)...`);
    const entries = await checkResponses(batch.leads);

    let processed = 0;
    for (const entry of entries) {
      if (!entry.email) continue;
      if (entry.status === 'opted_out') { log(`    🚫 ${entry.name} opted out — skipped`); continue; }
      try {
        // Generate + upload PDF + create short link
        const driveLink = await generateAndUploadPDF(entry, drive, folderId);
        const slug      = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50);
        const auditLink = await createShortLink(driveLink, slug);
        entry.audit_link = auditLink;
        log(`  🔗 Audit link: ${auditLink}`);

        // Bucket
        const bucket = entry.status !== 'responded' ? 'no_reply'
          : entry.responseTimeHours <= 4 ? 'fast_reply' : 'slow_reply';

        const hours = entry.responseTimeHours;
        const responseTime = !hours ? 'over 24 hours' : hours < 1 ? `${Math.round(hours*60)} minutes` : `${Math.round(hours)} hours`;
        const baseInq  = (entry.reviews||0) >= 200 ? 45 : (entry.reviews||0) >= 100 ? 32 : (entry.reviews||0) >= 50 ? 22 : (entry.reviews||0) >= 20 ? 16 : 12;
        const lossRate = !hours ? 0.85 : hours > 8 ? 0.70 : hours > 4 ? 0.50 : hours > 1 ? 0.30 : 0.10;
        const revenueLost = '$' + (Math.max(1, Math.round(baseInq * lossRate)) * 1200 * 0.30 * 12).toLocaleString('en-US') + '/yr';

        // Send day-0 email via Gmail
        entry.bucket       = bucket;
        entry.responseTime = responseTime;
        entry.revenueLost  = revenueLost;
        entry.auditLink    = auditLink;
        const firstSentAt  = new Date().toISOString();
        await sendSequenceEmail(entry, 0);
        entry.emailSequence = {
          step:        0,
          firstSentAt,
          lastSentAt:  firstSentAt,
          nextSendAt:  nextSendDate(firstSentAt, 1).toISOString(),
        };
        // Persist sequence to its own tab — state batches get pruned, this survives
        await appendSequenceRow(entry);

        // Update Sheets row with results
        await appendToSheet([[
          new Date(entry.sentAt || batch.sentAt).toLocaleDateString('en-US'),
          entry.name, entry.city, entry.phone, entry.email, entry.website || '',
          entry.rating ? `${entry.rating}⭐` : '', entry.reviews || '',
          entry.status === 'responded' ? 'Responded' : 'No Reply',
          responseTime, revenueLost,
          bucket === 'no_reply' ? 'A - No Reply' : bucket === 'slow_reply' ? 'B - Slow Reply' : 'C - Fast Reply',
          driveLink, 'Email seq started',
        ]]);

        processed++;
        log(`    ✅ ${entry.name} → ${bucket}`);
      } catch (e) {
        log(`    ❌ ${entry.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    const withEmail = entries.filter(e => e.email && e.status !== 'opted_out').length;
    if (processed === 0 && withEmail > 0) {
      // Every lead failed (e.g. expired token, missing module) — keep for retry tomorrow
      batch.leads = entries;
      failedBatches++;
      log(`  Batch ${batch.date} FAILED (0/${withEmail} sent) — will retry next run`);
    } else {
      batch.status      = 'processed';
      batch.processedAt = new Date().toISOString();
      batch.leads       = entries;
      totalReports += processed;
      log(`  Batch ${batch.date} done — ${processed} reports sent`);
    }
  }

  await saveState(state);
  return { reports: totalReports, failedBatches };
}

// ─── PHASE 2: Scrape new leads + send SMS ─────────────────────────────────────
async function phase2_scrapeAndSend() {
  log('── PHASE 2: Scraping new leads ──');
  const state     = await loadState();
  const contacted = await loadContacted();

  // Pick next city (CITY_OVERRIDE forces a specific city for testing)
  const city = process.env.CITY_OVERRIDE || CITIES[state.cityIndex % CITIES.length];
  if (!process.env.CITY_OVERRIDE) state.cityIndex = (state.cityIndex + 1) % CITIES.length;
  log(`  City: ${city}`);

  const today   = new Date().toISOString().split('T')[0];
  const batch   = { date: today, sentAt: new Date().toISOString(), status: 'sms_sent', leads: [], city };
  let   smsSent = 0;
  const MAX_ATTEMPTS = LEADS_PER_DAY * 4; // safety cap to avoid infinite loop
  let   attempts = 0;
  let   fetchSize = Math.ceil(LEADS_PER_DAY * 1.8); // fetch extra to account for landlines

  while (smsSent < LEADS_PER_DAY && attempts < MAX_ATTEMPTS) {
    const needed  = LEADS_PER_DAY - smsSent;
    const toFetch = Math.max(needed, fetchSize);
    log(`  Fetching ${toFetch} leads (${smsSent}/${LEADS_PER_DAY} SMS sent so far)...`);

    const rawLeads = await scrapeLeads(city, toFetch, contacted);
    if (!rawLeads.length) { log('  No more new leads available in this city'); break; }

    // Scrape emails
    for (const lead of rawLeads) {
      lead.email = await scrapeEmail(lead.website);
      await new Promise(r => setTimeout(r, 200));
    }
    log(`  Emails found: ${rawLeads.filter(l => l.email).length}/${rawLeads.length}`);

    for (const lead of rawLeads) {
      if (smsSent >= LEADS_PER_DAY) break;
      attempts++;
      const phone = lead.phone.replace(/\D/g, '');

      // Mark as contacted immediately so next scrape batch skips it
      contacted.add(phone);

      try {
        const contactId      = await getOrCreateContact(lead);
        const conversationId = await getOrCreateConversation(contactId);
        let smsStatus = 'pending';
        try {
          await sendSMS(contactId, conversationId);
          smsSent++;
          smsStatus = 'pending';
          log(`  ✅ SMS → ${lead.name} (${lead.phone}) [${smsSent}/${LEADS_PER_DAY}]`);
        } catch (smsErr) {
          if (smsErr.response?.status === 400) {
            smsStatus = 'landline';
            log(`  📵 Landline — ${lead.name} (${lead.phone})`);
          } else {
            smsStatus = 'failed';
            log(`  ❌ SMS error for ${lead.name}: ${smsErr.message}`);
          }
        }
        batch.leads.push({ ...lead, contactId, conversationId, sentAt: new Date().toISOString(), status: smsStatus });
      } catch (e) {
        log(`  ❌ Contact/conv failed for ${lead.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 6000)); // GHL rate limit: 10/min
    }

    // Save progress after each batch so we don't lose data if process stops
    await saveContacted(contacted);
    fetchSize = Math.ceil(needed * 2); // next round fetch 2x what we still need
  }

  batch.smsSent = smsSent;
  // Only keep leads with emails in state (reduces size, Phase 1 only needs these)
  batch.leads = batch.leads.filter(l => l.email);
  state.batches.push(batch);
  // Keep last 4 unprocessed batches (email-only leads keep size well under Sheets 50k cell limit)
  state.batches = state.batches.filter(b => b.status !== 'processed').slice(-4);
  await saveState(state);
  await saveContacted(contacted);
  log(`  Phase 2 done — ${smsSent} SMS sent`);

  // Log to Google Sheets — one row per lead, uniform columns
  const statusLabel = { pending: 'SMS Sent', landline: 'Landline — No SMS', failed: 'Failed' };
  const sheetRows = batch.leads.map(l => [
    new Date(l.sentAt).toLocaleDateString('en-US'),
    l.name, l.city, l.phone, l.email || '', l.website || '',
    l.rating ? `${l.rating}⭐` : '', l.reviews || '',
    statusLabel[l.status] || l.status,
    '', '', '', '', l.status === 'pending' ? 'Awaiting response' : 'N/A — no SMS',
  ]);
  await appendToSheet(sheetRows);
  log(`  Logged ${sheetRows.length} rows to Sheets`);
  return { smsSent, city };
}

// ─── PHASE 3: Send follow-up emails in sequence ───────────────────────────────
async function phase3_sendFollowUps() {
  log('── PHASE 3: Sending follow-up emails ──');
  const { CUMULATIVE_DELAYS } = require('./email-sender.js');
  const sheets = await getSheetsClient();
  await ensureRowsTab(sheets, SEQ_TAB, SEQ_HEADERS);
  const res  = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: `${SEQ_TAB}!A2:P`,
  });
  const rows = res.data.values || [];
  let sent = 0;

  for (let i = 0; i < rows.length; i++) {
    const [name, city, phone, email, website, rating, reviews, bucket,
           responseTime, revenueLost, auditLink, niche, stepS, firstSentAt, nextSendAt] = rows[i];
    if (!email || !firstSentAt) continue;
    const step     = parseInt(stepS || '0', 10);
    const nextStep = step + 1;
    if (nextStep >= CUMULATIVE_DELAYS.length) continue; // sequence complete
    if (!nextSendAt || !isDue(nextSendAt)) continue;

    const entry = {
      name, city, phone, email, website,
      rating: parseFloat(rating) || null, reviews: parseInt(reviews) || 0,
      bucket, responseTime, revenueLost, auditLink, niche,
      status: bucket === 'no_reply' ? 'no_reply' : 'responded',
    };

    try {
      await sendSequenceEmail(entry, nextStep);
      const now     = new Date().toISOString();
      const newNext = nextStep + 1 < CUMULATIVE_DELAYS.length
        ? nextSendDate(firstSentAt, nextStep + 1).toISOString() : '';
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `${SEQ_TAB}!M${i + 2}:P${i + 2}`, valueInputOption: 'RAW',
        requestBody: { values: [[nextStep, firstSentAt, newNext, now]] },
      });
      sent++;
      log(`  ✅ Step ${nextStep} → ${name} (${email})`);
    } catch (e) {
      log(`  ❌ Step ${nextStep} failed for ${email}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  log(`  Phase 3 done — ${sent} follow-up emails sent`);
  return { sent };
}

// ─── PHASE 1b: Process recovered backlog (drip N/day to protect Gmail rep) ────
const BACKLOG_TAB = '_email_backlog';

async function checkResponseByPhone(phone, sentDate) {
  try {
    const q = await axios.get(`${GHL_BASE}/contacts/`, {
      headers: GHL_H,
      params: { locationId: process.env.GHL_LOCATION_ID, query: phone },
    });
    const contact = q.data?.contacts?.[0];
    if (!contact) return { status: 'no_reply', responseTimeHours: null };

    const conv = await axios.get(`${GHL_BASE}/conversations/search`, {
      headers: GHL_H,
      params: { locationId: process.env.GHL_LOCATION_ID, contactId: contact.id },
    });
    const convId = conv.data?.conversations?.[0]?.id;
    if (!convId) return { status: 'no_reply', responseTimeHours: null };

    const msgs = await axios.get(`${GHL_BASE}/conversations/${convId}/messages`, { headers: GHL_H });
    const messages = msgs.data?.messages?.messages || [];
    const inbound = messages.find(m => m.direction === 'inbound');
    if (inbound) {
      // Opt-outs (STOP / DnD) must never enter the email sequence
      if (/\bstop\b|unsubscribe|dnd enabled|do not contact|not interested/i.test(inbound.body || '')) {
        return { status: 'opted_out', responseTimeHours: null };
      }
      const hours = Math.max(0.1, (new Date(inbound.dateAdded) - new Date(sentDate)) / 3600000);
      return { status: 'responded', responseTimeHours: hours, respondedAt: inbound.dateAdded };
    }
  } catch {}
  return { status: 'no_reply', responseTimeHours: null };
}

async function phase1b_processBacklog() {
  const cap = parseInt(process.env.BACKLOG_PER_DAY || '25', 10);
  if (!cap) return { reports: 0 };
  log('── PHASE 1b: Processing recovered backlog ──');

  const sheets = await getSheetsClient();
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: `${BACKLOG_TAB}!A2:J`,
    });
  } catch { log('  No backlog tab — skipping'); return { reports: 0 }; }

  const rows   = res.data.values || [];
  const queued = rows.map((r, i) => ({ r, i })).filter(x => (x.r[9] || '') === 'queued').slice(0, cap);
  if (!queued.length) { log('  Backlog empty'); return { reports: 0 }; }
  log(`  ${queued.length} backlog leads to process (cap ${cap}/day)`);

  let drive, folderId;
  try {
    ({ drive } = getDriveClient());
    folderId = await getDriveFolderId(drive);
  } catch (e) { log(`  Drive setup failed: ${e.message}`); return { reports: 0, failed: true }; }

  let processed = 0;
  for (const { r, i } of queued) {
    const [name, city, phone, email, website, rating, reviews, sentDate, niche] = r;
    const entry = {
      name, city, phone, email, website,
      rating: parseFloat(rating) || null, reviews: parseInt(reviews) || 0,
      niche: niche || 'chiro', sentAt: sentDate,
    };
    try {
      Object.assign(entry, await checkResponseByPhone(phone, sentDate));

      if (entry.status === 'opted_out') {
        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: `${BACKLOG_TAB}!J${i + 2}`, valueInputOption: 'RAW',
          requestBody: { values: [['skipped_optout']] },
        });
        log(`    🚫 ${name} opted out — skipped`);
        continue;
      }

      const driveLink = await generateAndUploadPDF(entry, drive, folderId);
      const slug      = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50);
      const auditLink = await createShortLink(driveLink, slug);

      const hours    = entry.responseTimeHours;
      const bucket   = entry.status !== 'responded' ? 'no_reply' : hours <= 4 ? 'fast_reply' : 'slow_reply';
      const baseInq  = (entry.reviews||0) >= 200 ? 45 : (entry.reviews||0) >= 100 ? 32 : (entry.reviews||0) >= 50 ? 22 : (entry.reviews||0) >= 20 ? 16 : 12;
      const lossRate = !hours ? 0.85 : hours > 8 ? 0.70 : hours > 4 ? 0.50 : hours > 1 ? 0.30 : 0.10;

      entry.bucket       = bucket;
      entry.responseTime = !hours ? 'over 24 hours' : hours < 1 ? `${Math.round(hours*60)} minutes` : `${Math.round(hours)} hours`;
      entry.revenueLost  = '$' + (Math.max(1, Math.round(baseInq * lossRate)) * 1200 * 0.30 * 12).toLocaleString('en-US') + '/yr';
      entry.auditLink    = auditLink;

      await sendSequenceEmail(entry, 0);
      const firstSentAt = new Date().toISOString();
      entry.emailSequence = {
        step: 0, firstSentAt, lastSentAt: firstSentAt,
        nextSendAt: nextSendDate(firstSentAt, 1).toISOString(),
      };
      await appendSequenceRow(entry);

      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `${BACKLOG_TAB}!J${i + 2}`, valueInputOption: 'RAW',
        requestBody: { values: [['sent']] },
      });

      processed++;
      log(`    ✅ ${entry.name} → ${bucket}`);
    } catch (e) {
      log(`    ❌ ${name}: ${e.message}`);
    }
    await new Promise(r2 => setTimeout(r2, 1500));
  }
  log(`  Phase 1b done — ${processed} backlog leads emailed`);
  return { reports: processed, queued: queued.length };
}

// ─── Daily run summary email ─────────────────────────────────────────────────
async function sendRunSummary(r) {
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: process.env.GMAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const reports   = (r.phase1?.reports || 0) + (r.phase1b?.reports || 0);
    const hasIssues = r.errors.length > 0 || (r.phase1?.failedBatches || 0) > 0 || r.phase1b?.failed;
    const date      = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });

    const lines = [
      `Amelia Pipeline — ${date}`,
      '',
      `📄 Reportes enviados (PDF + email día 0): ${reports}`,
      `   · Batches nuevos:  ${r.phase1?.reports ?? '—'}${(r.phase1?.failedBatches||0) > 0 ? `  ⚠️ ${r.phase1.failedBatches} batch(es) FALLARON — reintentan mañana` : ''}`,
      `   · Backlog:         ${r.phase1b?.reports ?? '—'}${r.phase1b?.failed ? '  ⚠️ FALLÓ' : ''}`,
      `📱 SMS enviados:      ${r.phase2?.smsSent ?? '—'}  (${r.phase2?.city || '—'})`,
      `📬 Follow-ups:        ${r.phase3?.sent ?? '—'}`,
      '',
      r.errors.length ? `ERRORES:\n${r.errors.map(e => '  · ' + e).join('\n')}` : 'Sin errores.',
      '',
      `Sheet: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_ID}`,
    ];

    await t.sendMail({
      from: `Amelia Pipeline <${process.env.GMAIL_FROM}>`,
      to: process.env.SUMMARY_EMAIL || 'ppcmccjb@gmail.com',
      subject: `${hasIssues ? '⚠️' : '✅'} Amelia Pipeline ${date} — ${reports} reportes, ${r.phase2?.smsSent ?? 0} SMS, ${r.phase3?.sent ?? 0} follow-ups`,
      text: lines.join('\n'),
    });
    log('  Run summary emailed');
  } catch (e) {
    log(`  Summary email failed: ${e.message}`);
  }
}

// ─── Main pipeline run ────────────────────────────────────────────────────────
async function runPipeline() {
  log('═══════════════════════════════════════');
  log('  Amelia Pipeline — daily run starting');
  log('═══════════════════════════════════════');
  const r = { phase1: null, phase1b: null, phase2: null, phase3: null, errors: [] };
  try { r.phase1  = await phase1_processReadyBatches(); } catch (e) { log(`PHASE 1 ERROR: ${e.message}`);  r.errors.push(`Phase 1: ${e.message}`); }
  try { r.phase1b = await phase1b_processBacklog(); }     catch (e) { log(`PHASE 1b ERROR: ${e.message}`); r.errors.push(`Phase 1b: ${e.message}`); }
  try { r.phase2  = await phase2_scrapeAndSend(); }       catch (e) { log(`PHASE 2 ERROR: ${e.message}`);  r.errors.push(`Phase 2: ${e.message}`); }
  try { r.phase3  = await phase3_sendFollowUps(); }       catch (e) { log(`PHASE 3 ERROR: ${e.message}`);  r.errors.push(`Phase 3: ${e.message}`); }
  await sendRunSummary(r);
  log('  Pipeline run complete\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const { startWebhookServer, sendDailySummary } = require('./webhook-server');

// Always start webhook server (handles inbound SMS + health check)
startWebhookServer();

// Startup self-check: verify Drive auth works, alert immediately if not.
// Catches a stale GOOGLE_OAUTH_TOKEN on Railway before it silently breaks Phase 1/1b.
async function driveSelfCheck() {
  try {
    const { drive } = getDriveClient();
    const folderId  = await getDriveFolderId(drive);
    await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id)', pageSize: 1 });
    log('  ✅ Drive self-check OK');
  } catch (e) {
    log(`  ❌ Drive self-check FAILED: ${e.message}`);
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: process.env.GMAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD } });
      await t.sendMail({
        from: `Amelia Pipeline <${process.env.GMAIL_FROM}>`,
        to: process.env.SUMMARY_EMAIL || 'ppcmccjb@gmail.com',
        subject: '🚨 Amelia Pipeline — Drive token ROTO (PDFs no se generan)',
        text: `El token de Google Drive en Railway no funciona, así que Phase 1 y Phase 1b no pueden generar ni subir PDFs.\n\nError: ${e.message}\n\nSolución: re-autenticar (node auth-drive.js) y pegar el nuevo GOOGLE_OAUTH_TOKEN en Railway.`,
      });
      log('  Drive failure alert emailed');
    } catch (e2) { log(`  Alert email also failed: ${e2.message}`); }
  }
}
driveSelfCheck();

// Always schedule daily cron regardless of RUN_NOW
log('Pipeline scheduler started — daily run at 10:00 AM EST');
cron.schedule('0 10 * * *', runPipeline, { timezone: 'America/New_York' });

// If RUN_NOW=true, also run immediately (e.g. after a new deploy)
if (process.env.RUN_NOW === 'true') {
  log('RUN_NOW=true — running pipeline immediately');
  runPipeline().catch(console.error);
}

process.on('SIGTERM', () => { log('Received SIGTERM, shutting down'); process.exit(0); });

module.exports = { runPipeline, phase1_processReadyBatches, phase1b_processBacklog, phase3_sendFollowUps };
