// One-time script: extract already-contacted leads (SMS sent, email known,
// no sequence started) from Sheet1 into the _email_backlog tab.
// The pipeline's Phase 1b then drips BACKLOG_PER_DAY of them per day.
require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const BACKLOG_TAB = '_email_backlog';
const HEADERS = ['Name','City','Phone','Email','Website','Rating','Reviews','SentDate','Niche','Status'];

const MEDSPA_HINTS = /med ?spa|medspa|aesthetic|botox|laser|skin|beauty|rejuvenat|glow|drip|wellness spa|facial/i;

function detectNiche(name) {
  return MEDSPA_HINTS.test(name || '') ? 'medspa' : 'chiro';
}

async function main() {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEETS_ID;

  // 1. Read all rows
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Sheet1!A2:N' });
  const rows = res.data.values || [];
  console.log('Total rows:', rows.length);

  // 2. Filter: SMS sent + valid email + no sequence started
  const candidates = rows.filter(r =>
    (r[8] || '').includes('SMS Sent') &&
    r[4] && r[4].includes('@') && r[4] !== 'email@email.com' &&
    !(r[13] || '').includes('Email seq')
  );

  // 3. Dedupe by email (keep first occurrence)
  const seen = new Set();
  const unique = candidates.filter(r => {
    const key = r[4].toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log('Unique recoverable leads:', unique.length);

  // 4. Also skip any email already in _email_sequences (safety)
  let alreadySequenced = new Set();
  try {
    const seqRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: '_email_sequences!D2:D' });
    (seqRes.data.values || []).forEach(v => v[0] && alreadySequenced.add(v[0].toLowerCase().trim()));
  } catch {}
  const final = unique.filter(r => !alreadySequenced.has(r[4].toLowerCase().trim()));
  console.log('After excluding already-sequenced:', final.length);

  // 5. Ensure backlog tab exists (recreate fresh)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === BACKLOG_TAB);
  if (existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: existing.properties.sheetId } }] },
    });
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: BACKLOG_TAB } } }] },
  });

  // 6. Write rows: Name, City, Phone, Email, Website, Rating, Reviews, SentDate, Niche, Status
  const values = [HEADERS, ...final.map(r => [
    r[1] || '',                          // Name
    r[2] || '',                          // City
    r[3] || '',                          // Phone
    r[4],                                // Email
    r[5] || '',                          // Website
    (r[6] || '').replace('⭐', '').trim(), // Rating
    r[7] || '',                          // Reviews
    r[0] || '',                          // SentDate
    detectNiche(r[1]),                   // Niche
    'queued',                            // Status
  ])];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${BACKLOG_TAB}!A1`, valueInputOption: 'RAW',
    requestBody: { values },
  });

  const niches = { chiro: 0, medspa: 0 };
  values.slice(1).forEach(v => niches[v[8]]++);
  console.log(`\n✅ ${final.length} leads queued in ${BACKLOG_TAB}`);
  console.log(`   chiro: ${niches.chiro} | medspa: ${niches.medspa}`);
  console.log(`   At ${process.env.BACKLOG_PER_DAY || 25}/day → drains in ~${Math.ceil(final.length / (parseInt(process.env.BACKLOG_PER_DAY) || 25))} days`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
