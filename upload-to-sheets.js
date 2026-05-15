require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const PORT = 8080;

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret } = credentials.installed;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    `http://localhost:${PORT}`
  );

  // Check if we have a saved token
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  // Get new token
  return getNewToken(oauth2Client);
}

async function getNewToken(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔐 Opening browser for authentication...\n');

  // Start local server to capture redirect
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const qs = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const code = qs.get('code');

        if (code) {

          res.end(`
            <html>
              <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h1>✅ Authentication successful!</h1>
                <p>You can close this window and return to your terminal.</p>
              </body>
            </html>
          `);

          server.close();

          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
          console.log('✓ Token saved\n');

          resolve(oauth2Client);
        } else {
          res.end('Invalid request');
        }
      } catch (error) {
        console.error('Error:', error.message);
        server.close();
        reject(error);
      }
    });

    server.listen(PORT, async () => {
      console.log(`📱 Opening browser...\n`);
      try {
        const open = (await import('open')).default;
        open(authUrl);
      } catch (e) {
        console.log(`Visit this URL: ${authUrl}`);
      }
    });
  });
}

async function uploadToSheets(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

  if (!spreadsheetId) {
    throw new Error('GOOGLE_SHEETS_ID not found in .env');
  }

  // Read leads data
  const leadsFile = 'medspa-leads-austin-2026-05-14.json';
  if (!fs.existsSync(leadsFile)) {
    throw new Error(`Leads file not found: ${leadsFile}`);
  }

  const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));

  // Prepare data
  const values = [
    ['Name', 'Rating', 'Reviews', 'Address', 'Phone', 'Website', 'Google Maps', 'Hours']
  ];

  for (const lead of leads) {
    values.push([
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
    console.log('\n🚀 Scout Agent - Google Sheets Uploader\n');
    const auth = await authorize();
    await uploadToSheets(auth);
    console.log('✨ Complete!\n');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
