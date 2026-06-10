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

const ASSETS_URL = 'https://raw.githubusercontent.com/topobenquet/amelia-pipeline/main/public';

function buildSignatureHTML(niche, step) {
  const title = niche === 'chiro' ? 'AI Receptionist for Chiropractic Offices'
    : niche === 'dental' ? 'AI Receptionist for Dental Offices'
    : 'AI Receptionist for Med Spas';

  const utm = `utm_source=email&utm_medium=cold_outreach&utm_campaign=audit_sequence&utm_content=step_${step}&utm_term=${encodeURIComponent(niche)}`;
  const demoUrl  = `https://clinics.amelia.im/demo?${utm}`;
  const logoUrl  = `https://clinics.amelia.im?${utm}`;

  return `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1a1a1a;margin-top:24px;padding-top:16px;border-top:2px solid #7C3AED;">
  <tr>
    <td style="padding-right:16px;vertical-align:top;">
      <img src="${ASSETS_URL}/juan.jpg" width="64" height="64"
        style="border-radius:50%;display:block;object-fit:cover;" alt="Juan Benquet">
    </td>
    <td style="vertical-align:top;">
      <div style="font-weight:700;font-size:15px;color:#0A0B1A;">Juan Benquet</div>
      <div style="font-size:12px;color:#7C3AED;font-weight:600;margin-top:2px;">Founder &amp; CEO · Amelia AI</div>
      <div style="font-size:11px;color:#6B7280;margin-top:4px;">${title}</div>
      <div style="margin-top:8px;">
        <a href="${demoUrl}"
          style="font-size:11px;color:#7C3AED;text-decoration:none;font-weight:600;">📅 Book a demo</a>
        &nbsp;&nbsp;
        <a href="${logoUrl}"
          style="font-size:11px;color:#6B7280;text-decoration:none;">🌐 clinics.amelia.im</a>
      </div>
      <div style="margin-top:10px;">
        <a href="${logoUrl}">
          <img src="${ASSETS_URL}/amelia-logo.png" height="28" alt="Amelia AI" style="display:block;border:none;">
        </a>
      </div>
    </td>
  </tr>
</table>`;
}

async function sendSequenceEmail(lead, step) {
  const bucket   = lead.bucket || 'no_reply';
  const sequence = getSequences()[bucket];
  if (!sequence || step >= sequence.length) return false;

  const email   = sequence[step];
  const vars    = buildVars(lead);
  const subject = fillTemplate(email.subject, vars);
  const text    = fillTemplate(email.body, vars);
  const niche   = process.env.NICHE || 'medspa';

  // Strip plain-text signature block (everything from "Juan Benquet" closing onwards)
  const cleanText = text.replace(/\n+Juan Benquet[\s\S]*$/m, '').trimEnd();

  // Convert plain text to HTML paragraphs (no UTMs on body links — audit goes to Drive)
  // Wrap bare URLs in <a> tags so they're clickable in all clients (Outlook doesn't auto-link)
  const linkify = s => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#7C3AED;font-weight:bold;">$1</a>');
  const bodyHtml = cleanText
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 14px;line-height:1.6;">${linkify(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px 0;background:#fff;font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:600px;">
  <div style="padding:0 24px;">
    ${bodyHtml}
    ${buildSignatureHTML(niche, step)}
  </div>
</body></html>`;

  const transport = getTransport();
  await transport.sendMail({
    from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to:      lead.email,
    subject,
    text,   // plain text fallback
    html,   // HTML with signature
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
