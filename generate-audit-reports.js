require('dotenv').config();
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const axios = require('axios');

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Content-Type': 'application/json',
  'Version': '2021-07-28'
};

// Personalized email templates by response bucket
function getEmailContent(entry) {
  const name = entry.lead.name;
  const city = entry.lead.city;
  const hours = entry.responseTimeHours;
  const responded = entry.status === 'responded';

  let subject, body;

  if (responded && hours <= 4) {
    // Fast responder — angle: "good, but let's make it instant"
    subject = `${name} — your response time is better than most 👏`;
    body = `Hi there,

I sent a message to ${name} earlier this week asking about Botox pricing — and you responded in about ${hours} hour${hours === 1 ? '' : 's'}. That's honestly better than most med spas in ${city}.

But here's the thing: in today's market, even a 2-hour delay can cost you a booking. Potential clients are texting 3-4 places at once and going with whoever responds first.

I put together a quick audit of your phone and messaging system. The good news: you're already ahead of your competition. The opportunity: with an AI receptionist handling your DMs and texts 24/7, you'd capture every lead instantly — even at midnight, weekends, and when your staff is with a client.

I'd love to show you what that looks like in a 15-minute demo. No pitch, just a look at what's possible.

Book a time here: clinics.amelia.im/widget/booking/amelia-sales-call

Would you be open to a quick call this week?

Best,
Juan Benquet
AI Voice & Text Automation for Med Spas`;

  } else if (responded && hours > 4) {
    // Slow responder — angle: "you lost X hours of response time"
    subject = `${name} — a potential client waited ${Math.round(hours)} hours for a reply`;
    body = `Hi there,

Earlier this week I sent a message to ${name} asking about Botox pricing. I heard back after about ${Math.round(hours)} hours.

In med spa industry benchmarks, leads that don't hear back within 5 minutes are 10x less likely to convert. After 1 hour, that drops even further.

I put together a brief audit of your patient communication — and the numbers show a clear opportunity. Your competition in ${city} is moving fast. AI-powered text and voice receptionists are now handling appointment booking, answering FAQs, and qualifying leads automatically — 24/7, instantly.

I'd love to share the full audit with you and show you exactly what an AI receptionist would look like for ${name}. Takes 15 minutes.

Would that be worth a quick call?

Best,
Juan Benquet
AI Voice & Text Automation for Med Spas`;

  } else {
    // No reply — angle: "you missed a potential $500+ client"
    subject = `${name} — a potential Botox client never heard back`;
    body = `Hi there,

A few days ago I reached out to ${name} asking about Botox pricing and whether I could book a consultation.

I never got a response.

I'm not saying this to criticize — I know running a med spa is demanding and messages slip through. But that inquiry represented a potential $500–$1,500 treatment. Multiply that by the number of unanswered messages per week, and the math gets uncomfortable fast.

I put together a short audit of what a prospective client experiences when they contact ${name}. The findings are worth seeing.

The solution is simpler than you'd think: an AI receptionist that responds to every text, DM, and missed call instantly — 24/7, in your voice, booking directly into your calendar.

Could I share the audit and show you a quick demo? It's 15 minutes and could change how you think about patient acquisition.

Book a time: clinics.amelia.im/widget/booking/amelia-sales-call

Best,
Juan Benquet
AI Voice & Text Automation for Med Spas`;
  }

  return { subject, body };
}

async function generatePDF(entry) {
  const doc = new PDFDocument({ margin: 50 });
  const safeName = entry.lead.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const filename = `audit-${safeName}.pdf`;
  const filepath = path.join(__dirname, 'audits', filename);

  if (!fs.existsSync(path.join(__dirname, 'audits'))) {
    fs.mkdirSync(path.join(__dirname, 'audits'));
  }

  doc.pipe(fs.createWriteStream(filepath));

  const responded = entry.status === 'responded';
  const hours = entry.responseTimeHours;

  // Header
  doc.rect(0, 0, 612, 80).fill('#1a1a2e');
  doc.fillColor('white').fontSize(20).font('Helvetica-Bold')
    .text('MED SPA COMMUNICATION AUDIT', 50, 25);
  doc.fontSize(10).font('Helvetica')
    .text('Prepared by JB Marketing — AI Voice & Text Automation', 50, 52);

  doc.fillColor('black').moveDown(3);

  // Business info
  doc.fontSize(16).font('Helvetica-Bold').text(entry.lead.name);
  doc.fontSize(10).font('Helvetica').fillColor('#555')
    .text(`${entry.lead.city}  |  ${entry.lead.phone}  |  ${entry.lead.website}`);
  doc.text(`Google Rating: ${entry.lead.rating}⭐ (${entry.lead.reviews} reviews)`);
  doc.moveDown();

  // Divider
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ddd').stroke();
  doc.moveDown();

  // Audit result
  doc.fillColor('black').fontSize(14).font('Helvetica-Bold').text('SMS Response Audit');
  doc.moveDown(0.5);

  const scoreColor = responded && hours <= 1 ? '#27ae60'
    : responded && hours <= 4 ? '#f39c12'
    : responded ? '#e67e22'
    : '#e74c3c';

  const scoreLabel = responded && hours <= 1 ? '🟢 FAST RESPONSE'
    : responded && hours <= 4 ? '🟡 MODERATE RESPONSE'
    : responded ? '🟠 SLOW RESPONSE'
    : '🔴 NO RESPONSE';

  doc.fontSize(24).font('Helvetica-Bold').fillColor(scoreColor).text(scoreLabel);
  doc.moveDown(0.5);

  if (responded) {
    doc.fontSize(12).font('Helvetica').fillColor('black')
      .text(`Response time: ${entry.responseTimeHours} hours`);
    doc.text(`Message received: "${entry.responseText?.substring(0, 120)}..."`);
  } else {
    doc.fontSize(12).font('Helvetica').fillColor('black')
      .text('No response received within 24 hours of initial inquiry.');
  }

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ddd').stroke();
  doc.moveDown();

  // Industry benchmark
  doc.fillColor('black').fontSize(14).font('Helvetica-Bold').text('Industry Benchmarks');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica')
    .text('• Leads contacted within 5 min are 21x more likely to convert')
    .text('• Average med spa response time: 3.2 hours')
    .text('• 42% of med spa inquiries never receive a response')
    .text('• Average value of a new Botox client: $800–$1,500/year');

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ddd').stroke();
  doc.moveDown();

  // What AI fixes
  doc.fillColor('black').fontSize(14).font('Helvetica-Bold').text('What AI Receptionist Solves');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica')
    .text('✓ Responds to every SMS, Instagram DM, and missed call in under 60 seconds')
    .text('✓ Books appointments directly into your calendar — 24/7')
    .text('✓ Answers pricing, availability, and FAQ questions automatically')
    .text('✓ Follows up with leads who don\'t book on first contact')
    .text('✓ Works while your staff is with clients, after hours, and on weekends');

  doc.moveDown(2);

  // CTA box
  doc.rect(50, doc.y, 512, 60).fill('#1a1a2e');
  doc.fillColor('white').fontSize(13).font('Helvetica-Bold')
    .text('Ready to see this in action?', 70, doc.y - 50);
  doc.fontSize(10).font('Helvetica')
    .text('Book a free 15-min demo → clinics.amelia.im/widget/booking/amelia-sales-call', 70, doc.y - 30);

  doc.end();

  return new Promise((resolve, reject) => {
    doc.on('finish', () => resolve(filepath));
    doc.on('error', reject);
  });
}

async function sendEmail(entry, emailContent, pdfPath) {
  if (!entry.lead.email) return false;

  try {
    // Find contact in GHL to get conversation
    const contactRes = await axios.get(`${GHL_BASE_URL}/contacts/`, {
      params: { locationId: GHL_LOCATION_ID, query: entry.lead.phone?.replace(/\D/g, ''), limit: 1 },
      headers: GHL_HEADERS
    });
    const contact = contactRes.data?.contacts?.[0];
    if (!contact) return false;

    // Get/create conversation
    const convSearch = await axios.get(`${GHL_BASE_URL}/conversations/search`, {
      params: { locationId: GHL_LOCATION_ID, contactId: contact.id },
      headers: GHL_HEADERS
    });
    let convId = convSearch.data?.conversations?.[0]?.id;

    if (!convId) {
      const convRes = await axios.post(`${GHL_BASE_URL}/conversations/`, {
        locationId: GHL_LOCATION_ID, contactId: contact.id
      }, { headers: GHL_HEADERS });
      convId = convRes.data?.conversation?.id;
    }

    // Send email via GHL
    await axios.post(`${GHL_BASE_URL}/conversations/messages`, {
      type: 'Email',
      contactId: contact.id,
      conversationId: convId,
      subject: emailContent.subject,
      message: emailContent.body,
      html: emailContent.body.replace(/\n/g, '<br>')
    }, { headers: GHL_HEADERS });

    return true;
  } catch (error) {
    console.error(`   Email error: ${error.response?.data?.message || error.message}`);
    return false;
  }
}

async function main() {
  const auditFiles = fs.readdirSync('.').filter(f => f.startsWith('sms-audit-')).sort().reverse();
  if (auditFiles.length === 0) {
    console.error('❌ No sms-audit file found. Run mystery-texter.js first.');
    process.exit(1);
  }

  const auditFile = auditFiles[0];
  const results = JSON.parse(fs.readFileSync(auditFile, 'utf8'));

  console.log(`\n📊 Generating Audit Reports + Emails`);
  console.log(`📋 Processing ${results.length} leads from ${auditFile}\n`);
  console.log('─'.repeat(70));

  let pdfsGenerated = 0, emailsSent = 0, noEmail = 0;

  for (const entry of results) {
    console.log(`\n${entry.lead.name} (${entry.lead.city})`);
    console.log(`   Status: ${entry.status} ${entry.responseTimeHours ? `(${entry.responseTimeHours}h)` : ''}`);

    // Generate PDF
    try {
      const pdfPath = await generatePDF(entry);
      entry.pdfPath = pdfPath;
      pdfsGenerated++;
      console.log(`   📄 PDF generated`);
    } catch (e) {
      console.log(`   ❌ PDF error: ${e.message}`);
    }

    // Generate and send email
    if (entry.lead.email) {
      const emailContent = getEmailContent(entry);
      entry.emailSubject = emailContent.subject;

      const sent = await sendEmail(entry, emailContent, entry.pdfPath);
      if (sent) {
        emailsSent++;
        console.log(`   📧 Email sent → ${entry.lead.email}`);
      } else {
        console.log(`   ❌ Email failed → ${entry.lead.email}`);
      }
    } else {
      noEmail++;
      console.log(`   ⚠️  No email address found`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  fs.writeFileSync(auditFile, JSON.stringify(results, null, 2));

  console.log('\n' + '─'.repeat(70));
  console.log(`\n✅ Summary:`);
  console.log(`   PDFs generated: ${pdfsGenerated}`);
  console.log(`   Emails sent:    ${emailsSent}`);
  console.log(`   No email:       ${noEmail}`);
  console.log(`\n💾 Updated: ${auditFile}`);
  console.log(`\n📁 PDFs saved in: ./audits/\n`);
}

main().catch(console.error);
