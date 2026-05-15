require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Content-Type': 'application/json',
  'Version': '2021-07-28'
};

async function getConversationMessages(conversationId) {
  try {
    const res = await axios.get(`${GHL_BASE_URL}/conversations/${conversationId}/messages`, {
      headers: GHL_HEADERS
    });
    return res.data?.messages || [];
  } catch (error) {
    return [];
  }
}

async function main() {
  // Find the most recent audit file
  const auditFiles = fs.readdirSync('.').filter(f => f.startsWith('sms-audit-')).sort().reverse();
  if (auditFiles.length === 0) {
    console.error('❌ No sms-audit file found. Run mystery-texter.js first.');
    process.exit(1);
  }

  const auditFile = auditFiles[0];
  const results = JSON.parse(fs.readFileSync(auditFile, 'utf8'));

  console.log(`\n📊 Response Checker — ${auditFile}`);
  console.log(`📋 Checking ${results.length} conversations`);
  console.log('─'.repeat(70));

  let responded = 0, noReply = 0;
  const responseTimeBuckets = { under1h: 0, under4h: 0, under24h: 0, over24h: 0, noReply: 0 };

  for (const entry of results) {
    const messages = await getConversationMessages(entry.conversationId);

    // Find first inbound reply (direction: inbound) after our sent message
    const sentAt = new Date(entry.sentAt);
    const reply = messages.find(m =>
      m.direction === 'inbound' && new Date(m.dateAdded) > sentAt
    );

    if (reply) {
      const respondedAt = new Date(reply.dateAdded);
      const hoursToRespond = (respondedAt - sentAt) / (1000 * 60 * 60);

      entry.respondedAt = respondedAt.toISOString();
      entry.responseTimeHours = Math.round(hoursToRespond * 10) / 10;
      entry.responseText = reply.body || reply.message || '';
      entry.status = 'responded';

      responded++;
      if (hoursToRespond < 1) responseTimeBuckets.under1h++;
      else if (hoursToRespond < 4) responseTimeBuckets.under4h++;
      else if (hoursToRespond < 24) responseTimeBuckets.under24h++;
      else responseTimeBuckets.over24h++;

      console.log(`✅ ${entry.lead.name.substring(0, 40).padEnd(40)} ${hoursToRespond.toFixed(1)}h`);
    } else {
      entry.status = 'no_reply';
      entry.responseTimeHours = null;
      responseTimeBuckets.noReply++;
      noReply++;
      console.log(`❌ ${entry.lead.name.substring(0, 40).padEnd(40)} no reply`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  // Save updated results
  fs.writeFileSync(auditFile, JSON.stringify(results, null, 2));

  // Summary
  console.log('\n' + '─'.repeat(70));
  console.log('\n📈 AUDIT RESULTS SUMMARY\n');
  console.log(`   Total messaged:    ${results.length}`);
  console.log(`   Responded:         ${responded} (${Math.round(responded/results.length*100)}%)`);
  console.log(`   No reply:          ${noReply} (${Math.round(noReply/results.length*100)}%)`);
  console.log(`\n   Response speed breakdown:`);
  console.log(`   Under 1 hour:      ${responseTimeBuckets.under1h}`);
  console.log(`   1–4 hours:         ${responseTimeBuckets.under4h}`);
  console.log(`   4–24 hours:        ${responseTimeBuckets.under24h}`);
  console.log(`   Over 24 hours:     ${responseTimeBuckets.over24h}`);
  console.log(`   Never replied:     ${responseTimeBuckets.noReply}`);

  const avgResponse = results
    .filter(r => r.responseTimeHours !== null)
    .reduce((sum, r) => sum + r.responseTimeHours, 0) / (responded || 1);

  if (responded > 0) {
    console.log(`\n   Avg response time: ${avgResponse.toFixed(1)} hours`);
  }

  console.log(`\n💾 Updated: ${auditFile}`);
  console.log(`\n➡️  Next: node generate-audit-reports.js\n`);
}

main().catch(console.error);
