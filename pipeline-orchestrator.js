require('dotenv').config();
const cron   = require('node-cron');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────────────────────────
const LEADS_PER_DAY   = parseInt(process.env.LEADS_PER_DAY || '30');
const STATE_FILE      = path.join(__dirname, 'pipeline-state.json');
const AUDITS_DIR      = path.join(__dirname, 'audits');
const CONTACTED_FILE  = path.join(__dirname, 'contacted-phones.json');
const DRIVE_FOLDER    = 'Amelia Audits';
const BOOKING_URL     = 'https://clinics.amelia.im/schedule';

// Cities to rotate through (add more to increase reach)
const CITIES = [
  'Austin, TX', 'Denver, CO', 'Nashville, TN', 'Charlotte, NC',
  'Dallas, TX', 'Houston, TX', 'Atlanta, GA', 'Miami, FL',
  'Phoenix, AZ', 'San Diego, CA', 'Portland, OR', 'Seattle, WA',
];

// ─── State helpers ────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { batches: [], cityIndex: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadContacted() {
  try { return new Set(JSON.parse(fs.readFileSync(CONTACTED_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveContacted(set) {
  fs.writeFileSync(CONTACTED_FILE, JSON.stringify([...set]));
}

// ─── Google Drive (Service Account) ──────────────────────────────────────────
function getDriveClient() {
  const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH
    || path.join(__dirname, 'service-account.json');

  if (!fs.existsSync(SA_PATH)) {
    throw new Error(`Service account file not found at ${SA_PATH}.\nSet GOOGLE_SERVICE_ACCOUNT_PATH env var or place service-account.json in the project root.`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SA_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  return google.drive({ version: 'v3', auth });
}

async function getDriveFolderId(drive) {
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
  try {
    const res = await axios.get(`${GHL_BASE}/contacts/`, {
      headers: GHL_H,
      params: { locationId: process.env.GHL_LOCATION_ID, query: phone, limit: 1 },
    });
    const existing = res.data?.contacts?.[0];
    if (existing) return existing.id;
  } catch {}

  const res = await axios.post(`${GHL_BASE}/contacts/`, {
    locationId: process.env.GHL_LOCATION_ID,
    firstName: lead.name,
    phone: lead.phone,
    email: lead.email || undefined,
    website: lead.website || undefined,
    tags: ['medspa-lead', 'audit-prospect', lead.city.split(',')[0].trim()],
    customFields: lead.instagram
      ? [{ key: 'instagram', value: lead.instagram }] : [],
  }, { headers: GHL_H });
  return res.data?.contact?.id;
}

async function getOrCreateConversation(contactId, phone) {
  const search = await axios.get(`${GHL_BASE}/conversations/search`, {
    headers: GHL_H,
    params: { locationId: process.env.GHL_LOCATION_ID, contactId },
  });
  const existing = search.data?.conversations?.[0];
  if (existing) return existing.id;

  const res = await axios.post(`${GHL_BASE}/conversations/`, {
    locationId: process.env.GHL_LOCATION_ID,
    contactId,
    type: 'SMS',
  }, { headers: GHL_H });
  return res.data?.conversation?.id;
}

async function sendSMS(conversationId) {
  await axios.post(`${GHL_BASE}/conversations/messages`, {
    type: 'SMS',
    conversationId,
    message: "Hi there! Saw your med spa online and wanted to ask about pricing for Botox. Do you have a menu or consult I could book?",
  }, { headers: GHL_H });
}

async function checkResponses(entries) {
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.conversationId || entry.status === 'responded') continue;
    try {
      const res = await axios.get(`${GHL_BASE}/conversations/${entry.conversationId}/messages`, { headers: GHL_H });
      const messages = res.data?.messages?.messages || [];
      const inbound = messages.find(m => m.direction === 'inbound' && new Date(m.dateAdded).getTime() > new Date(entry.sentAt).getTime());
      if (inbound) {
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

// ─── Instantly helpers ─────────────────────────────────────────────────────────
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const INSTANTLY_H    = {
  Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
  'Content-Type': 'application/json',
};

const CAMPAIGN_NAMES = {
  no_reply:   'Amelia Audit — A: No Reply',
  slow_reply: 'Amelia Audit — B: Slow Reply (4–24h)',
  fast_reply: 'Amelia Audit — C: Fast Reply (<4h)',
};

async function getOrCreateCampaign(bucket) {
  const res = await axios.get(`${INSTANTLY_BASE}/campaigns`, {
    headers: INSTANTLY_H, params: { limit: 50 },
  });
  const found = res.data?.items?.find(c => c.name === CAMPAIGN_NAMES[bucket]);
  if (found) return found.id;

  // Create with sequences
  const { SEQUENCES } = require('./setup-instantly-campaigns.js');
  const steps = SEQUENCES[bucket].map(e => ({
    type: 'email', delay: e.delay, delay_unit: 'days',
    variants: [{ subject: e.subject, body: e.body }],
  }));
  const camp = await axios.post(`${INSTANTLY_BASE}/campaigns`, {
    name: CAMPAIGN_NAMES[bucket],
    campaign_schedule: {
      schedules: [{ name: 'Weekdays', timing: { from: '00:00', to: '23:59' },
        days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
        timezone: 'Etc/GMT+12' }],
    },
    sequences: [{ steps }],
    daily_limit: 50,
    stop_on_reply: true,
    open_tracking: true,
    prioritize_new_leads: true,
  }, { headers: INSTANTLY_H });
  return camp.data.id;
}

async function pushLeadToInstantly(campaignId, lead) {
  await axios.post(`${INSTANTLY_BASE}/leads`, {
    campaign_id:  campaignId,
    email:        lead.email,
    company_name: lead.business_name,
    website:      lead.website,
    variables: {
      business_name: lead.business_name,
      city:          lead.city,
      phone:         lead.phone,
      website:       lead.website,
      ig_handle:     lead.ig_handle || '',
      rating:        String(lead.rating || ''),
      reviews:       String(lead.reviews || ''),
      response_time: lead.response_time,
      revenue_lost:  lead.revenue_lost,
      audit_link:    lead.audit_link,
    },
  }, { headers: INSTANTLY_H });
}

// ─── Google Maps scrape ───────────────────────────────────────────────────────
async function scrapeLeads(city, count, contacted) {
  const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  const queries  = ['med spa', 'medical spa', 'medspa', 'aesthetic clinic', 'botox clinic'];
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
          const phone = (place.formatted_phone_number || '').replace(/\D/g, '');
          if (!phone || seen.has(phone) || contacted.has(phone)) continue;

          // Get details
          const det = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
            params: { place_id: place.place_id, fields: 'name,formatted_phone_number,website,rating,user_ratings_total,formatted_address', key: MAPS_KEY },
          });
          const d = det.data.result;
          seen.add(phone);
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

// Try to scrape email from website
async function scrapeEmail(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const base = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
    const res = await axios.get(base, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const match = res.data.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const email = match ? match[0] : null;
    if (email && email.includes('example')) return null;
    return email;
  } catch { return null; }
}

// ─── PDF generation (inline, avoids circular imports) ─────────────────────────
async function generateAndUploadPDF(lead, drive, folderId) {
  // Delegate to generate-and-upload-audits.js generatePDF function
  const { generatePDF } = require('./generate-and-upload-audits-lib.js');
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
  const state  = loadState();
  const ready  = state.batches.filter(b => {
    if (b.status !== 'sms_sent') return false;
    const hoursSinceSent = (Date.now() - new Date(b.sentAt).getTime()) / 3600000;
    return hoursSinceSent >= 24;
  });

  if (!ready.length) { log('  No batches ready for processing'); return; }

  let drive, folderId;
  try {
    drive    = getDriveClient();
    folderId = await getDriveFolderId(drive);
  } catch (e) {
    log(`  Drive setup failed: ${e.message}`);
    return;
  }

  for (const batch of ready) {
    log(`  Processing batch ${batch.date} (${batch.leads.length} leads)...`);
    const entries = await checkResponses(batch.leads);

    let processed = 0;
    for (const entry of entries) {
      if (!entry.email) continue;
      try {
        // Generate + upload PDF
        const driveLink = await generateAndUploadPDF(entry, drive, folderId);
        entry.audit_link = driveLink;

        // Bucket
        const bucket = entry.status !== 'responded' ? 'no_reply'
          : entry.responseTimeHours <= 4 ? 'fast_reply' : 'slow_reply';

        const hours = entry.responseTimeHours;
        const campaignId = await getOrCreateCampaign(bucket);
        await pushLeadToInstantly(campaignId, {
          email:         entry.email,
          business_name: entry.name,
          city:          entry.city,
          phone:         entry.phone,
          website:       entry.website,
          ig_handle:     entry.instagram || '',
          rating:        entry.rating,
          reviews:       entry.reviews,
          response_time: !hours ? 'over 24 hours' : hours < 1 ? `${Math.round(hours*60)} minutes` : `${Math.round(hours)} hours`,
          revenue_lost:  !hours || hours > 8 ? '$51,840/yr' : hours > 4 ? '$38,400/yr' : '$24,000/yr',
          audit_link:    driveLink,
        });
        processed++;
        log(`    ✅ ${entry.name} → ${bucket}`);
      } catch (e) {
        log(`    ❌ ${entry.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    batch.status     = 'processed';
    batch.processedAt = new Date().toISOString();
    batch.leads       = entries;
    log(`  Batch ${batch.date} done — ${processed} pushed to Instantly`);
  }

  saveState(state);
}

// ─── PHASE 2: Scrape new leads + send SMS ─────────────────────────────────────
async function phase2_scrapeAndSend() {
  log('── PHASE 2: Scraping new leads ──');
  const state     = loadState();
  const contacted = loadContacted();

  // Pick next city
  const city  = CITIES[state.cityIndex % CITIES.length];
  state.cityIndex = (state.cityIndex + 1) % CITIES.length;
  log(`  City: ${city}`);

  const rawLeads = await scrapeLeads(city, LEADS_PER_DAY, contacted);
  log(`  Scraped ${rawLeads.length} new leads`);

  if (!rawLeads.length) { log('  No new leads found, skipping'); saveState(state); return; }

  // Scrape emails
  for (const lead of rawLeads) {
    lead.email = await scrapeEmail(lead.website);
    await new Promise(r => setTimeout(r, 200));
  }
  const withEmail = rawLeads.filter(l => l.email).length;
  log(`  Emails found: ${withEmail}/${rawLeads.length}`);

  // Push contacts + send SMS
  const today   = new Date().toISOString().split('T')[0];
  const batch   = { date: today, sentAt: new Date().toISOString(), status: 'sms_sent', leads: [], city };
  let   smsSent = 0;

  for (const lead of rawLeads) {
    const phone = lead.phone.replace(/\D/g, '');
    try {
      const contactId      = await getOrCreateContact(lead);
      const conversationId = await getOrCreateConversation(contactId, phone);
      await sendSMS(conversationId);
      contacted.add(phone);
      batch.leads.push({ ...lead, contactId, conversationId, sentAt: new Date().toISOString(), status: 'pending' });
      smsSent++;
      log(`  SMS → ${lead.name} (${lead.phone})`);
    } catch (e) {
      log(`  ❌ SMS failed for ${lead.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 6000)); // GHL rate limit: 10/min
  }

  batch.smsSent = smsSent;
  state.batches.push(batch);
  saveState(state);
  saveContacted(contacted);
  log(`  Phase 2 done — ${smsSent} SMS sent`);
}

// ─── Main pipeline run ────────────────────────────────────────────────────────
async function runPipeline() {
  log('═══════════════════════════════════════');
  log('  Amelia Pipeline — daily run starting');
  log('═══════════════════════════════════════');
  try { await phase1_processReadyBatches(); } catch (e) { log(`PHASE 1 ERROR: ${e.message}`); }
  try { await phase2_scrapeAndSend(); }       catch (e) { log(`PHASE 2 ERROR: ${e.message}`); }
  log('  Pipeline run complete\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
if (process.env.RUN_NOW === 'true') {
  // Manual trigger: node pipeline-orchestrator.js (with RUN_NOW=true)
  runPipeline().catch(console.error);
} else {
  // Scheduled: runs daily at 9:00 AM UTC
  log('Pipeline scheduler started — waiting for 9:00 AM UTC...');
  cron.schedule('0 9 * * *', runPipeline, { timezone: 'UTC' });

  // Keep process alive
  process.on('SIGTERM', () => { log('Received SIGTERM, shutting down'); process.exit(0); });
}
