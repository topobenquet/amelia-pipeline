require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const OpenAI = require('openai');
const PDFDocument = require('pdfkit');
const path = require('path');

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WORKFLOW_ID = process.env.GHL_WORKFLOW_ID; // Set this after creating workflow in GHL
const FROM_NUMBER = process.env.GHL_FROM_NUMBER || '+16469068015';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// GHL API v2
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Content-Type': 'application/json',
  'Version': '2021-07-28'
};

async function initiateCalls() {
  console.log('\n🚀 Mystery Caller - Audit Campaign\n');
  console.log(`📍 Location: ${GHL_LOCATION_ID}`);
  console.log(`📞 From: ${FROM_NUMBER}`);
  console.log('─'.repeat(60));

  // Load leads
  const leadsFile = 'medspa-leads-multi-city-2026-05-14.json';
  if (!fs.existsSync(leadsFile)) {
    console.error(`❌ Leads file not found: ${leadsFile}`);
    process.exit(1);
  }

  const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
  console.log(`\n📋 Loaded ${leads.length} leads`);

  if (!WORKFLOW_ID) {
    console.log('\n⚠️  GHL_WORKFLOW_ID not set in .env');
    console.log('📋 Running in DRY RUN mode — contacts will be created but NOT added to workflow\n');
  }

  const auditResults = [];

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    console.log(`[${i + 1}/${leads.length}] ${lead.name} (${lead.city})`);

    try {
      // Step 1: Create or find contact in GHL
      const contact = await createContact(lead);

      if (!contact) {
        console.log(`   ❌ Failed to create contact`);
        continue;
      }

      console.log(`   ✓ Contact ready (${contact.id})`);

      // Step 2: Add to workflow to trigger the call
      if (WORKFLOW_ID) {
        const triggered = await addToWorkflow(contact.id);
        if (triggered) {
          console.log(`   ✓ Added to call workflow`);
        } else {
          console.log(`   ⚠️  Failed to add to workflow`);
        }
      }

      auditResults.push({
        lead,
        status: WORKFLOW_ID ? 'call_queued' : 'contact_created',
        contactId: contact.id,
        timestamp: new Date().toISOString(),
        transcript: 'Pending — call recording will be available in GHL',
        quality: {
          responseTime: 'pending',
          greetingQuality: 'pending',
          recommendedImprovements: [
            'Add business hours to voicemail',
            'Include callback process',
            'Reduce voicemail length'
          ]
        }
      });

      // GHL rate limit: 10 calls/min = 1 every 6 seconds
      if (i < leads.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }

    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
    }
  }

  // Save results
  console.log(`\n📊 Campaign Summary:`);
  console.log(`   Contacts created: ${auditResults.length}`);
  console.log(`   Calls queued: ${auditResults.filter(r => r.status === 'call_queued').length}`);

  const resultsFile = `audit-campaign-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(resultsFile, JSON.stringify(auditResults, null, 2));
  console.log(`\n💾 Results saved to: ${resultsFile}\n`);

  return auditResults;
}

async function createContact(lead) {
  try {
    const phone = lead.phone.replace(/\D/g, '');
    if (!phone || lead.phone === 'N/A') {
      console.log(`   ⚠️  No phone number`);
      return null;
    }

    // Search for existing contact by phone
    const searchRes = await axios.get(`${GHL_BASE_URL}/contacts/`, {
      params: { locationId: GHL_LOCATION_ID, query: phone, limit: 1 },
      headers: GHL_HEADERS
    });

    if (searchRes.data?.contacts?.length > 0) {
      return searchRes.data.contacts[0];
    }

    // Create new contact if not found
    const payload = {
      locationId: GHL_LOCATION_ID,
      firstName: lead.name,
      companyName: lead.name,
      phone: `+1${phone}`,
      address1: lead.address,
      city: lead.city,
      source: 'Mystery Caller Audit',
      tags: ['mystery-caller-audit', lead.city.toLowerCase().replace(/\s/g, '-')]
    };

    const response = await axios.post(`${GHL_BASE_URL}/contacts/`, payload, { headers: GHL_HEADERS });
    return response.data?.contact;

  } catch (error) {
    console.error(`   Contact error: ${error.response?.data?.message || error.message}`);
    return null;
  }
}

async function addToWorkflow(contactId) {
  try {
    await axios.post(
      `${GHL_BASE_URL}/contacts/${contactId}/workflow/${WORKFLOW_ID}`,
      {},
      { headers: GHL_HEADERS }
    );
    return true;
  } catch (error) {
    console.error(`   Workflow error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function transcribeRecording(recordingUrl) {
  try {
    const response = await axios.get(recordingUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data);

    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioBuffer], 'call-recording.mp3', { type: 'audio/mpeg' }),
      model: 'whisper-1'
    });

    return transcription.text;
  } catch (error) {
    console.error('Transcription error:', error.message);
    return null;
  }
}

async function generateAuditPDF(auditResult) {
  const doc = new PDFDocument();
  const filename = `audit-${auditResult.lead.name.replace(/\s+/g, '-')}.pdf`;
  const filepath = path.join(__dirname, filename);

  doc.pipe(fs.createWriteStream(filepath));

  doc.fontSize(20).font('Helvetica-Bold').text('Medical Spa Phone System Audit', { underline: true });
  doc.fontSize(10).text(`Generated: ${new Date().toLocaleDateString()}`, { color: '#666' });
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Business Information');
  doc.fontSize(10).font('Helvetica').text(`Name: ${auditResult.lead.name}`);
  doc.text(`Location: ${auditResult.lead.city}`);
  doc.text(`Phone: ${auditResult.lead.phone}`);
  doc.text(`Website: ${auditResult.lead.website}`);
  doc.text(`Rating: ${auditResult.lead.rating} ⭐ (${auditResult.lead.reviews} reviews)`);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Call Audit Results');
  doc.fontSize(10).font('Helvetica').text(`Response Type: ${auditResult.quality.responseTime}`);
  doc.text(`Greeting Quality: ${auditResult.quality.greetingQuality}`);
  doc.text(`Transcript: ${auditResult.transcript}`);
  doc.moveDown();

  doc.fontSize(12).font('Helvetica-Bold').text('Recommended Improvements');
  auditResult.quality.recommendedImprovements.forEach(item => {
    doc.fontSize(10).text(`• ${item}`);
  });
  doc.moveDown();

  doc.fontSize(11).font('Helvetica-Bold').text('Ready to improve your phone system?');
  doc.fontSize(10).font('Helvetica').text('See how AI-powered voice reception can capture every lead.');

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('finish', () => {
      console.log(`   📄 PDF generated: ${filename}`);
      resolve(filepath);
    });
    doc.on('error', reject);
  });
}

// Main execution
initiateCalls().catch(console.error);
