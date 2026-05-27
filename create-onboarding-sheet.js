require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const { google } = require('googleapis');

// Creates the "Clients" tab in your onboarding Google Sheet with headers and an example row

async function createOnboardingSheet() {
  const creds = JSON.parse(fs.readFileSync(path.join(__dirname, 'service-account.json'), 'utf8'));
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheetId = process.env.ONBOARDING_SHEETS_ID || process.env.GOOGLE_SHEETS_ID;

  const headers = [
    'Business Name', 'Niche (medspa/chiro/dental)',
    'Owner First Name', 'Owner Last Name', 'Owner Email', 'Owner Phone',
    'Address', 'City', 'State (2-letter)', 'ZIP', 'Country',
    'Website',
    'Mon Hours', 'Tue Hours', 'Wed Hours', 'Thu Hours', 'Fri Hours', 'Sat Hours', 'Sun Hours',
    'Services (comma-separated)',
    'Pricing (free text)',
    'Legal Business Name', 'EIN / Tax ID', 'Business Type (LLC/Corp/Sole Prop)',
    'Plan',
    // Auto-filled by script:
    'Status', 'GHL Location ID', 'Phone Number (purchased)',
  ];

  const exampleRow = [
    'Glow Med Spa', 'medspa',
    'Sarah', 'Johnson', 'sarah@glowmedspa.com', '(512) 555-0123',
    '123 Main St', 'Austin', 'TX', '78701', 'US',
    'https://glowmedspa.com',
    '9:00 AM - 7:00 PM', '9:00 AM - 7:00 PM', '9:00 AM - 7:00 PM', '9:00 AM - 7:00 PM',
    '9:00 AM - 7:00 PM', '10:00 AM - 4:00 PM', 'Closed',
    'Botox, Dermal Fillers, Laser Hair Removal, Chemical Peels, Microneedling, IV Therapy',
    'Botox from $12/unit · Filler from $650/syringe · Laser Hair Removal from $99/session',
    'Glow Med Spa LLC', '12-3456789', 'LLC',
    '$497/mo',
    '', '', '',
  ];

  // Try to find or create "Clients" sheet
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheet = meta.data.sheets.find(s => s.properties.title === 'Clients');

  if (!existingSheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: 'Clients' } } }],
      },
    });
    console.log('Created "Clients" tab');
  } else {
    console.log('"Clients" tab already exists — updating headers');
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Clients!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers, exampleRow] },
  });

  console.log('✅ Onboarding sheet ready');
  console.log(`URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0`);
  console.log('\nHeaders:');
  headers.forEach((h, i) => console.log(`  Col ${String.fromCharCode(65+i)}: ${h}`));
}

createOnboardingSheet().catch(console.error);
