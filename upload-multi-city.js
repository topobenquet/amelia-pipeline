require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = './token.json';
const CREDENTIALS_PATH = './credentials.json';

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret } = credentials.installed;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:8080'
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  throw new Error('Token not found. Run upload-to-sheets.js first to authenticate.');
}

async function uploadToSheets(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEETS_ID not found in .env');
  }

  // Read leads data
  const leadsFile = 'medspa-leads-multi-city-2026-05-14.json';
  if (!fs.existsSync(leadsFile)) {
    throw new Error(`Leads file not found: ${leadsFile}`);
  }

  const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));

  // Prepare data with city column
  const values = [
    ['City', 'Name', 'Rating', 'Reviews', 'Address', 'Phone', 'Website', 'Google Maps', 'Hours']
  ];

  for (const lead of leads) {
    values.push([
      lead.city,
      lead.name,
      lead.rating,
      lead.reviews,
      lead.address,
      lead.phone,
      lead.website,
      lead.gmaps_url,
      lead.hours.join('; ')
    ]);
  }

  // Update sheet
  try {
    console.log('📊 Uploading to Google Sheet...\n');
    const response = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      resource: { values }
    });

    console.log(`✅ Updated ${response.data.updatedRows} rows`);
    console.log(`📍 View at: https://docs.google.com/spreadsheets/d/${spreadsheetId}\n`);
  } catch (error) {
    console.error('Error updating sheet:', error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log('\n🚀 Multi-City Lead Uploader\n');
    const auth = await authorize();
    await uploadToSheets(auth);
    console.log('✨ Complete!\n');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
