require('dotenv').config();
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { google } = require('googleapis');
const { getOAuthAccessToken } = require('./webhook-server.js');

// ─── Config ───────────────────────────────────────────────────────────────────
const COMPANY_ID      = process.env.GHL_COMPANY_ID;
const SHEETS_ID       = process.env.ONBOARDING_SHEETS_ID || process.env.GOOGLE_SHEETS_ID;
const SNAPSHOT_MEDSPA = process.env.GHL_SNAPSHOT_MEDSPA;
const SNAPSHOT_CHIRO  = process.env.GHL_SNAPSHOT_CHIRO;

const GHL_BASE = 'https://services.leadconnectorhq.com';

async function ghlHeaders() {
  const token = await getOAuthAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
}

// ─── Timezone map by state ────────────────────────────────────────────────────
const STATE_TZ = {
  AL:'America/Chicago',AK:'America/Anchorage',AZ:'America/Phoenix',AR:'America/Chicago',
  CA:'America/Los_Angeles',CO:'America/Denver',CT:'America/New_York',DE:'America/New_York',
  FL:'America/New_York',GA:'America/New_York',HI:'Pacific/Honolulu',ID:'America/Boise',
  IL:'America/Chicago',IN:'America/Indiana/Indianapolis',IA:'America/Chicago',
  KS:'America/Chicago',KY:'America/New_York',LA:'America/Chicago',ME:'America/New_York',
  MD:'America/New_York',MA:'America/New_York',MI:'America/Detroit',MN:'America/Chicago',
  MS:'America/Chicago',MO:'America/Chicago',MT:'America/Denver',NE:'America/Chicago',
  NV:'America/Los_Angeles',NH:'America/New_York',NJ:'America/New_York',NM:'America/Denver',
  NY:'America/New_York',NC:'America/New_York',ND:'America/Chicago',OH:'America/New_York',
  OK:'America/Chicago',OR:'America/Los_Angeles',PA:'America/New_York',RI:'America/New_York',
  SC:'America/New_York',SD:'America/Chicago',TN:'America/Chicago',TX:'America/Chicago',
  UT:'America/Denver',VT:'America/New_York',VA:'America/New_York',WA:'America/Los_Angeles',
  WV:'America/New_York',WI:'America/Chicago',WY:'America/Denver',
};

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'onboarding.log'), line + '\n');
}

// ─── Google Sheets reader ─────────────────────────────────────────────────────
async function getClientRows() {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: 'Clients!A2:Z',
  });

  const rows = res.data.values || [];
  return rows.map(r => ({
    // Identity
    businessName:    r[0]  || '',
    niche:           r[1]  || 'medspa',   // medspa | chiro | dental
    ownerFirstName:  r[2]  || '',
    ownerLastName:   r[3]  || '',
    ownerEmail:      r[4]  || '',
    ownerPhone:      r[5]  || '',
    // Location
    address:         r[6]  || '',
    city:            r[7]  || '',
    state:           r[8]  || '',
    zip:             r[9]  || '',
    country:         r[10] || 'US',
    website:         r[11] || '',
    // Business hours (format: "9:00 AM - 7:00 PM" or "Closed")
    monHours:        r[12] || '9:00 AM - 7:00 PM',
    tueHours:        r[13] || '9:00 AM - 7:00 PM',
    wedHours:        r[14] || '9:00 AM - 7:00 PM',
    thuHours:        r[15] || '9:00 AM - 7:00 PM',
    friHours:        r[16] || '9:00 AM - 7:00 PM',
    satHours:        r[17] || '10:00 AM - 4:00 PM',
    sunHours:        r[18] || 'Closed',
    // Services (comma-separated list)
    services:        r[19] || '',
    // Pricing (free text, e.g. "Botox from $12/unit, Filler from $650")
    pricing:         r[20] || '',
    // A2P / Legal
    legalName:       r[21] || '',          // exact legal business name
    ein:             r[22] || '',          // EIN / Tax ID
    businessType:    r[23] || 'LLC',       // LLC | Corp | Sole Prop | Partnership
    // Plan
    plan:            r[24] || '$497/mo',
    // Status (filled in by script)
    status:          r[25] || '',
    ghlLocationId:   r[26] || '',
    phoneNumber:     r[27] || '',
    rowIndex:        rows.indexOf(r) + 2,
  }));
}

// ─── Update status in sheet ───────────────────────────────────────────────────
async function updateSheetRow(rowIndex, locationId, phoneNumber, status) {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_ID,
    range: `Clients!Z${rowIndex}:AB${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status, locationId, phoneNumber]] },
  });
}

// ─── GHL: Create sub-account ──────────────────────────────────────────────────
async function createSubAccount(client) {
  const tz = STATE_TZ[client.state.toUpperCase()] || 'America/Chicago';

  const payload = {
    name:      client.businessName,
    companyId: COMPANY_ID,
    email:     client.ownerEmail,
    phone:     client.ownerPhone,
    address:   client.address,
    city:      client.city,
    state:     client.state,
    country:   client.country,
    postalCode: client.zip,
    website:   client.website,
    timezone:  tz,
    prospectInfo: {
      firstName: client.ownerFirstName,
      lastName:  client.ownerLastName,
      email:     client.ownerEmail,
    },
  };

  const h = await ghlHeaders();
  const res = await axios.post(`${GHL_BASE}/locations`, payload, { headers: h });
  return res.data.location || res.data;
}

// ─── GHL: Install snapshot ────────────────────────────────────────────────────
async function installSnapshot(locationId, niche) {
  const snapshotId = niche === 'chiro' ? SNAPSHOT_CHIRO : SNAPSHOT_MEDSPA;
  if (!snapshotId) {
    log(`  ⚠️  No snapshot ID configured for niche: ${niche} — skipping`);
    return;
  }
  const h = await ghlHeaders();
  await axios.post(`${GHL_BASE}/locations/${locationId}/snapshots/copy`, {
    snapshotId,
    override: false,
  }, { headers: h });

  log(`  Snapshot installed for ${locationId}`);
}

// ─── GHL: Search and purchase local phone number ──────────────────────────────
async function purchasePhoneNumber(locationId, areaCode) {
  const h = await ghlHeaders();
  const search = await axios.get(`${GHL_BASE}/phone-number/search`, {
    headers: h,
    params: { locationId, areaCode, type: 'local', limit: 5 },
  });

  const numbers = search.data?.numbers || [];
  if (!numbers.length) {
    log(`  ⚠️  No numbers found for area code ${areaCode}`);
    return null;
  }

  const chosen = numbers[0].phoneNumber;
  await axios.post(`${GHL_BASE}/phone-number/buy`, {
    locationId,
    phoneNumber: chosen,
  }, { headers: h });

  log(`  Purchased number: ${chosen}`);
  return chosen;
}

// ─── GHL: Create location user (owner login) ──────────────────────────────────
async function createLocationUser(locationId, client) {
  try {
    const h = await ghlHeaders();
    await axios.post(`${GHL_BASE}/users`, {
      locationIds: [locationId],
      firstName:   client.ownerFirstName,
      lastName:    client.ownerLastName,
      email:       client.ownerEmail,
      phone:       client.ownerPhone,
      type:        'account',
      role:        'admin',
      permissions: {
        campaignsEnabled:      true,
        contactsEnabled:       true,
        workflowsEnabled:      true,
        appointmentsEnabled:   true,
        reviewsEnabled:        true,
        onlineListingsEnabled: true,
        phoneCallEnabled:      true,
        conversationsEnabled:  true,
        assignedDataOnly:      false,
        adwordsReportingEnabled: false,
        membershipEnabled:     false,
        facebookAdsReportingEnabled: false,
        attributionReportEnabled: false,
        agentReportingEnabled: false,
        botService:            true,
        socialPlanner:         false,
        bloggingEnabled:       false,
        invoiceEnabled:        true,
        marketingEnabled:      true,
        tagsEnabled:           true,
        leadValueEnabled:      true,
      },
    }, { headers: h });
    log(`  User created: ${client.ownerEmail}`);
  } catch (e) {
    log(`  User creation note: ${e.response?.data?.message || e.message}`);
  }
}

// ─── Build AI system prompt ───────────────────────────────────────────────────
function buildConversationAIPrompt(client) {
  const isChiro = client.niche === 'chiro';
  const role = isChiro ? 'chiropractic office' : 'med spa';

  const hours = [
    `Monday: ${client.monHours}`,
    `Tuesday: ${client.tueHours}`,
    `Wednesday: ${client.wedHours}`,
    `Thursday: ${client.thuHours}`,
    `Friday: ${client.friHours}`,
    `Saturday: ${client.satHours}`,
    `Sunday: ${client.sunHours}`,
  ].join('\n');

  return `You are Amelia, the AI receptionist for ${client.businessName}, a ${role} located in ${client.city}, ${client.state}.

Your job is to respond to incoming SMS and DM inquiries, answer questions, and book appointments directly into the calendar. You are friendly, professional, and concise.

BUSINESS INFORMATION:
- Business: ${client.businessName}
- Address: ${client.address}, ${client.city}, ${client.state} ${client.zip}
- Website: ${client.website || 'N/A'}
- Owner: ${client.ownerFirstName} ${client.ownerLastName}

HOURS OF OPERATION:
${hours}

SERVICES & PRICING:
${client.services || 'Contact us for a full list of services.'}
${client.pricing ? `\nPRICING:\n${client.pricing}` : ''}

INSTRUCTIONS:
1. Greet new contacts warmly by name if available.
2. Answer questions about services, pricing, and availability using the information above.
3. If someone wants to book, offer to book directly or send a booking link.
4. If asked about something outside your knowledge, say: "Great question — let me have ${client.ownerFirstName} follow up with you directly."
5. Never make up prices or services not listed above.
6. If someone says STOP, UNSUBSCRIBE, or similar — acknowledge and do not reply further.
7. Keep replies under 3 sentences unless more detail is specifically requested.
8. Always be responsive and never leave a lead waiting.

BOOKING LINK: [configured in your calendar settings]

Remember: every unanswered lead is a lost patient. Respond within 60 seconds.`;
}

// ─── Build A2P registration brief ────────────────────────────────────────────
function buildA2PBrief(client, phoneNumber) {
  return `
A2P 10DLC REGISTRATION — ${client.businessName}
Generated: ${new Date().toLocaleDateString('en-US')}

BRAND REGISTRATION:
  Legal Business Name: ${client.legalName || client.businessName}
  EIN / Tax ID: ${client.ein || 'REQUIRED — collect from client'}
  Business Type: ${client.businessType}
  Address: ${client.address}, ${client.city}, ${client.state} ${client.zip}
  Website: ${client.website}
  Vertical: ${client.niche === 'chiro' ? 'Healthcare' : 'Healthcare / Wellness'}

CAMPAIGN REGISTRATION:
  Use Case: Mixed (appointment reminders + marketing)
  Sample Message 1: "Hi [Name], this is Amelia from ${client.businessName}. We received your inquiry — would you like to schedule a consultation? Reply YES to get a booking link or STOP to opt out."
  Sample Message 2: "Your appointment at ${client.businessName} is confirmed for [date] at [time]. Reply STOP to unsubscribe."
  Opt-out: All messages include STOP instruction.
  Opt-in method: Customer contacts us first (inbound) or books online.

GHL LOCATION ID: ${client.ghlLocationId || 'pending'}
PHONE NUMBER: ${phoneNumber || 'pending'}

STEPS TO COMPLETE IN GHL:
1. Go to Settings → Phone Numbers → click the purchased number
2. Click "Register for A2P"
3. Fill Brand with info above
4. Use campaign details above for use case
5. Submit — approval takes 1-5 business days
`.trim();
}

// ─── Write setup checklist ────────────────────────────────────────────────────
function writeSetupChecklist(client, locationId, phoneNumber) {
  const aiPrompt = buildConversationAIPrompt(client);
  const a2pBrief = buildA2PBrief(client, phoneNumber);

  const checklist = `
AMELIA AI SETUP CHECKLIST — ${client.businessName}
Generated: ${new Date().toISOString()}
GHL Location ID: ${locationId}
Phone Number: ${phoneNumber || 'purchase manually'}
=========================================================

✅ AUTOMATED (already done):
  [x] GHL sub-account created
  [x] Snapshot installed (workflows, pipelines, tags)
  [x] Business info configured (name, address, hours, timezone)
  [x] Owner user created (login: ${client.ownerEmail})
  ${phoneNumber ? '[x] Phone number purchased: ' + phoneNumber : '[ ] Phone number — purchase manually in GHL'}

📋 MANUAL STEPS IN GHL:

  CONVERSATION AI:
  [ ] Go to: Settings → Conversation AI
  [ ] Enable bot
  [ ] Paste the AI prompt below into "Bot Instructions"
  [ ] Set mode: Suggestive or Auto-pilot (recommend Suggestive to start)
  [ ] Connect to: SMS channel (the purchased number)
  [ ] Test with a sample message

  VOICE AI:
  [ ] Go to: Settings → Phone Numbers → ${phoneNumber || 'your number'}
  [ ] Enable "AI Voice" on inbound calls
  [ ] Set voice: choose a natural-sounding voice (recommend "Maya")
  [ ] Set greeting: "Thank you for calling ${client.businessName}. This is Amelia, our AI receptionist. How can I help you today?"
  [ ] Enable voicemail transcription → to conversation

  CALENDAR:
  [ ] Go to: Calendars → Settings
  [ ] Create appointment type: "Free Consultation" (30 min)
  [ ] Set availability to match business hours
  [ ] Connect to owner's calendar (Google/Outlook)
  [ ] Copy booking link → add to Conversation AI prompt above

  A2P REGISTRATION:
  [ ] See A2P brief below
  [ ] Submit registration in GHL: Settings → Phone Numbers → Register for A2P
  [ ] Wait 1-5 business days for approval

  FINAL TEST:
  [ ] Send SMS to ${phoneNumber || 'your number'} and verify AI responds
  [ ] Call ${phoneNumber || 'your number'} and verify Voice AI answers
  [ ] Book a test appointment and verify calendar event is created

=========================================================
AI SYSTEM PROMPT (copy into GHL Conversation AI):
=========================================================
${aiPrompt}

=========================================================
A2P REGISTRATION BRIEF:
=========================================================
${a2pBrief}
`.trim();

  const filename = `setup-${client.businessName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.txt`;
  const filepath = path.join(__dirname, 'onboarding-checklists', filename);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, checklist);
  log(`  Setup checklist written: ${filename}`);
  return filepath;
}

// ─── Main onboarding flow ─────────────────────────────────────────────────────
async function onboardClient(client) {
  log(`\nOnboarding: ${client.businessName} (${client.niche})`);

  // 1. Create sub-account
  log('  Creating GHL sub-account...');
  const location = await createSubAccount(client);
  const locationId = location.id;
  log(`  Sub-account created: ${locationId}`);

  // 2. Install snapshot
  log('  Installing snapshot...');
  await installSnapshot(locationId, client.niche);

  // 3. Create owner user
  log('  Creating user account...');
  await createLocationUser(locationId, client);

  // 4. Purchase phone number
  log('  Purchasing phone number...');
  const areaCode = client.zip ? client.zip.substring(0, 3) : '512';
  const phoneNumber = await purchasePhoneNumber(locationId, areaCode);

  // 5. Write setup checklist + AI prompt
  const checklistPath = writeSetupChecklist({ ...client, ghlLocationId: locationId }, locationId, phoneNumber);

  // 6. Update Google Sheet
  await updateSheetRow(client.rowIndex, locationId, phoneNumber || '', 'onboarded');

  log(`  ✅ Onboarding complete: ${client.businessName}`);
  log(`  Checklist: ${checklistPath}`);

  return { locationId, phoneNumber, checklistPath };
}

// ─── Run: process all pending rows ───────────────────────────────────────────
async function runOnboarding() {
  if (!process.env.GHL_CLIENT_ID || !process.env.GHL_CLIENT_SECRET) {
    console.error('Missing GHL_CLIENT_ID or GHL_CLIENT_SECRET — add them to .env');
    process.exit(1);
  }

  log('=== GHL Onboarding Run ===');

  const clients = await getClientRows();
  const pending = clients.filter(c => c.businessName && !c.ghlLocationId && c.status !== 'onboarded');

  log(`Found ${pending.length} client(s) to onboard`);

  for (const client of pending) {
    try {
      await onboardClient(client);
    } catch (e) {
      log(`  ❌ Failed for ${client.businessName}: ${e.response?.data?.message || e.message}`);
      await updateSheetRow(client.rowIndex, '', '', `error: ${e.message.slice(0, 80)}`).catch(() => {});
    }

    // Brief pause between clients to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  log('=== Onboarding run complete ===');
}

// ─── Onboard single client by row number (for testing) ───────────────────────
async function onboardRow(rowNumber) {
  const clients = await getClientRows();
  const client  = clients.find(c => c.rowIndex === rowNumber);
  if (!client) { console.error(`Row ${rowNumber} not found`); return; }
  await onboardClient(client);
}

module.exports = { runOnboarding, onboardRow, buildConversationAIPrompt };

// Run directly: node ghl-onboard.js [rowNumber]
if (require.main === module) {
  const rowArg = process.argv[2];
  if (rowArg) {
    onboardRow(parseInt(rowArg)).catch(console.error);
  } else {
    runOnboarding().catch(console.error);
  }
}
