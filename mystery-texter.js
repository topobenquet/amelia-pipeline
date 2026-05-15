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

const MESSAGE = "Hi there! Saw your med spa online and wanted to ask about pricing for Botox. Do you have a menu or consult I could book?";

async function getOrCreateConversation(contactId) {
  try {
    const search = await axios.get(`${GHL_BASE_URL}/conversations/search`, {
      params: { locationId: GHL_LOCATION_ID, contactId },
      headers: GHL_HEADERS
    });
    const existing = search.data?.conversations?.[0];
    if (existing) return existing.id;

    const res = await axios.post(`${GHL_BASE_URL}/conversations/`, {
      locationId: GHL_LOCATION_ID,
      contactId
    }, { headers: GHL_HEADERS });
    return res.data?.conversation?.id;
  } catch (error) {
    return null;
  }
}

async function sendMessage(contactId, conversationId, type) {
  try {
    const res = await axios.post(`${GHL_BASE_URL}/conversations/messages`, {
      type,
      contactId,
      conversationId,
      message: MESSAGE
    }, { headers: GHL_HEADERS });
    return res.data?.messageId || res.data?.id;
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    return { error: msg };
  }
}

async function main() {
  console.log('\n📱 Mystery Texter — SMS + Instagram Campaign\n');
  console.log(`📍 Location: ${GHL_LOCATION_ID}`);
  console.log(`💬 Message: "${MESSAGE}"\n`);
  console.log('─'.repeat(70));

  const leadsFile = 'medspa-leads-multi-city-2026-05-14.json';
  const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));

  const results = [];
  let smsSent = 0, igSent = 0, smsFailed = 0, igFailed = 0, skipped = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const phone = lead.phone?.replace(/\D/g, '');
    const hasPhone = phone && lead.phone !== 'N/A';
    const hasIG = !!lead.instagram;

    console.log(`\n[${i + 1}/${leads.length}] ${lead.name} (${lead.city})`);

    if (!hasPhone && !hasIG) {
      console.log(`   ⚠️  No phone or Instagram — skipping`);
      skipped++;
      continue;
    }

    // Find contact in GHL
    let contact = null;
    try {
      const contactRes = await axios.get(`${GHL_BASE_URL}/contacts/`, {
        params: { locationId: GHL_LOCATION_ID, query: phone || lead.name, limit: 1 },
        headers: GHL_HEADERS
      });
      contact = contactRes.data?.contacts?.[0];
    } catch (e) {
      console.log(`   ❌ Could not find contact`);
      continue;
    }

    if (!contact) {
      console.log(`   ❌ Contact not in GHL`);
      continue;
    }

    const conversationId = await getOrCreateConversation(contact.id);
    if (!conversationId) {
      console.log(`   ❌ Could not get conversation`);
      continue;
    }

    const entry = {
      lead: {
        name: lead.name, city: lead.city,
        phone: lead.phone, website: lead.website,
        instagram: lead.instagram || null,
        rating: lead.rating, reviews: lead.reviews
      },
      contactId: contact.id,
      conversationId,
      message: MESSAGE,
      sentAt: new Date().toISOString(),
      sms: null,
      instagram: null
    };

    // Send SMS
    if (hasPhone) {
      const result = await sendMessage(contact.id, conversationId, 'SMS');
      if (result?.error) {
        console.log(`   📱 SMS  ❌ ${result.error}`);
        smsFailed++;
        entry.sms = { status: 'failed', error: result.error };
      } else {
        console.log(`   📱 SMS  ✅ sent`);
        smsSent++;
        entry.sms = { status: 'sent', messageId: result };
      }
      await new Promise(r => setTimeout(r, 800));
    }

    // Send Instagram DM
    if (hasIG) {
      const result = await sendMessage(contact.id, conversationId, 'IG');
      if (result?.error) {
        console.log(`   📸 IG   ❌ ${result.error}`);
        igFailed++;
        entry.instagram = { status: 'failed', error: result.error };
      } else {
        console.log(`   📸 IG   ✅ sent (${lead.instagram})`);
        igSent++;
        entry.instagram = { status: 'sent', messageId: result, handle: lead.instagram };
      }
      await new Promise(r => setTimeout(r, 800));
    } else {
      console.log(`   📸 IG   — no handle found`);
    }

    results.push(entry);
  }

  console.log('\n' + '─'.repeat(70));
  console.log('\n📊 Campaign Summary:');
  console.log(`   📱 SMS sent:       ${smsSent}`);
  console.log(`   📱 SMS failed:     ${smsFailed}`);
  console.log(`   📸 IG sent:        ${igSent}`);
  console.log(`   📸 IG failed:      ${igFailed}`);
  console.log(`   ⚠️  Skipped:        ${skipped}`);

  const outFile = `sms-audit-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\n💾 Saved to: ${outFile}`);
  console.log(`\n⏰ Run in 24h: node response-checker.js\n`);
}

main().catch(console.error);
