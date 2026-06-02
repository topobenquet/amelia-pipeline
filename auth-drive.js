require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');

const CREDS = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
const { client_secret, client_id, redirect_uris } = CREDS.installed || CREDS.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/callback');

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  prompt: 'consent',
});

console.log('\n👉 Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback...\n');

const server = http.createServer(async (req, res) => {
  const code = url.parse(req.url, true).query.code;
  if (!code) { res.end('No code'); return; }
  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync('token.json', JSON.stringify(tokens, null, 2));
  res.end('<h2>✅ Auth complete! You can close this tab.</h2>');
  console.log('✅ token.json saved');
  server.close();
  process.exit(0);
}).listen(3001);
