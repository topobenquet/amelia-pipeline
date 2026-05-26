require('dotenv').config();
const nodemailer = require('nodemailer');

const FROM_NAME  = 'Juan Benquet';
const FROM_EMAIL = process.env.GMAIL_FROM || 'juan@amelia.im';

function getTransport() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: FROM_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

// Cumulative days from first email (day 0)
const CUMULATIVE_DELAYS = [0, 4, 9, 39, 99];

const { SEQUENCES_MEDSPA, SEQUENCES_CHIRO } = require('./setup-instantly-campaigns.js');

function getSequences() {
  const niche = process.env.NICHE || 'medspa';
  if (niche === 'chiro') return SEQUENCES_CHIRO;
  return SEQUENCES_MEDSPA;
}

function fillTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

function buildVars(lead) {
  return {
    business_name: lead.name,
    city:          lead.city,
    phone:         lead.phone,
    website:       lead.website || '',
    ig_handle:     lead.instagram || '',
    rating:        String(lead.rating || ''),
    reviews:       String(lead.reviews || ''),
    response_time: lead.responseTime || 'over 24 hours',
    revenue_lost:  lead.revenueLost || '$43,200/yr',
    audit_link:    lead.auditLink || 'https://clinics.amelia.im/demo',
  };
}

async function sendSequenceEmail(lead, step) {
  const bucket   = lead.bucket || 'no_reply';
  const sequence = getSequences()[bucket];
  if (!sequence || step >= sequence.length) return false;

  const email  = sequence[step];
  const vars   = buildVars(lead);
  const subject = fillTemplate(email.subject, vars);
  const text    = fillTemplate(email.body, vars);

  const transport = getTransport();
  await transport.sendMail({
    from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to:      lead.email,
    subject,
    text,
  });

  return true;
}

// Returns next send date given first sent date and next step index
function nextSendDate(firstSentAt, nextStep) {
  const d = new Date(firstSentAt);
  d.setDate(d.getDate() + CUMULATIVE_DELAYS[nextStep]);
  return d;
}

function isDue(nextSendAt) {
  return new Date() >= new Date(nextSendAt);
}

module.exports = { sendSequenceEmail, nextSendDate, isDue, CUMULATIVE_DELAYS };
