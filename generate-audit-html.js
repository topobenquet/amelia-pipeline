const { execSync } = require('child_process');
const fs        = require('fs');
const path      = require('path');

function buildHTML(lead) {
  const {
    businessName, city, phone, website, googleRating, googleReviews,
    responseTimeHours, instagram,
  } = lead;

  const noReply = !responseTimeHours;

  // Estimate monthly inquiry volume from review count (proxy for practice size)
  const reviewCount = Number(googleReviews) || 0;
  const baseInquiries = reviewCount >= 200 ? 45
    : reviewCount >= 100 ? 32
    : reviewCount >= 50  ? 22
    : reviewCount >= 20  ? 16
    : 12;

  // Loss rate by response time
  const lossRate = noReply ? 0.85
    : responseTimeHours > 8  ? 0.70
    : responseTimeHours > 4  ? 0.50
    : responseTimeHours > 1  ? 0.30
    : 0.10;

  const leadsLost    = Math.max(1, Math.round(baseInquiries * lossRate));
  const LTV          = 1200;
  const CLOSE_RATE   = 0.30;
  const revMonthRaw  = leadsLost * LTV * CLOSE_RATE;
  const revYearRaw   = revMonthRaw * 12;

  function fmt(n) { return '$' + n.toLocaleString('en-US'); }
  const revenueMonth = fmt(revMonthRaw);
  const revenueYear  = fmt(revYearRaw);
  const date         = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const stars = Math.round(googleRating || 0);
  const starsHTML = Array.from({ length: 5 }, (_, i) =>
    `<span style="color:${i < stars ? '#FBBF24' : '#D1D5DB'}">★</span>`
  ).join('');

  const responseLabel = noReply ? 'No reply' :
    responseTimeHours < 1 ? `${Math.round(responseTimeHours * 60)} min` :
    responseTimeHours === 1 ? '1 hour' : `${Math.round(responseTimeHours)} hrs`;

  const timelinePoints = [
    { label: 'Instant', color: '#16A34A' },
    { label: '5 min',   color: '#16A34A' },
    { label: '1 hr',    color: '#D97706' },
    { label: '4 hrs',   color: '#EA580C' },
    { label: '24 hrs',  color: '#DC2626' },
    { label: noReply ? 'No reply' : responseLabel, color: '#DC2626', active: true },
  ];

  const websiteDisplay = (website || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Inter',sans-serif; background:#F0F2F5; width:800px; }

  /* ── HEADER ── */
  .header { background:#0A0B1A; padding:32px 36px 28px; color:#fff; position:relative; }
  .header-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; }
  .brand-tag { font-size:11px; font-weight:700; letter-spacing:2px; color:#A78BFA; text-transform:uppercase; margin-bottom:4px; }
  .header-date { font-size:12px; color:#94A3B8; margin-top:2px; }
  .logo { display:flex; align-items:center; gap:8px; }
  .logo-star { font-size:20px; color:#7C3AED; }
  .logo-text { font-size:18px; font-weight:800; color:#fff; letter-spacing:-0.5px; }
  .business-name { font-size:38px; font-weight:900; line-height:1.1; letter-spacing:-1px; color:#fff; margin:12px 0 16px; max-width:520px; }
  .header-meta { display:flex; gap:20px; align-items:center; font-size:12px; color:#94A3B8; flex-wrap:wrap; }
  .header-meta span { display:flex; align-items:center; gap:5px; }
  .google-badge { position:absolute; top:32px; right:36px; background:#fff; border-radius:12px; padding:12px 16px; text-align:center; min-width:110px; box-shadow:0 4px 20px rgba(0,0,0,0.3); }
  .google-badge .g-logo { font-size:13px; font-weight:800; margin-bottom:4px; letter-spacing:-0.3px; }
  .google-badge .g-score { font-size:28px; font-weight:900; color:#0A0B1A; line-height:1; }
  .google-badge .g-stars { font-size:16px; margin:2px 0; }
  .google-badge .g-reviews { font-size:10px; color:#6B7280; }

  /* ── MAIN CONTENT ── */
  .content { padding:20px 24px; display:flex; flex-direction:column; gap:16px; }

  /* ── RESPONSE CARD ── */
  .response-card { background:#fff; border-radius:14px; padding:22px 24px; display:flex; gap:20px; align-items:center; box-shadow:0 1px 4px rgba(0,0,0,0.08); border:1px solid #E5E7EB; }
  .badge-no-reply { background:#FEF2F2; border:2px solid #FCA5A5; border-radius:50%; width:86px; height:86px; flex-shrink:0; display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden; }
  .badge-no-reply .x-icon { font-size:20px; color:#DC2626; font-weight:900; line-height:1; }
  .badge-no-reply .badge-label { font-size:10px; font-weight:900; color:#DC2626; letter-spacing:1.5px; text-align:center; line-height:1.15; margin-top:3px; text-transform:uppercase; }
  .badge-no-reply .badge-time { font-size:8px; color:#DC2626; opacity:0.65; margin-top:2px; text-align:center; white-space:nowrap; }
  .response-text h3 { font-size:16px; font-weight:800; color:#0A0B1A; margin-bottom:6px; }
  .response-text p { font-size:12.5px; color:#4B5563; line-height:1.6; }
  .response-text .highlight { color:#DC2626; font-weight:700; }
  .phone-icon { margin-left:auto; flex-shrink:0; opacity:0.15; font-size:48px; }

  /* ── TIMELINE ── */
  .timeline-card { background:#fff; border-radius:14px; padding:20px 24px; box-shadow:0 1px 4px rgba(0,0,0,0.08); border:1px solid #E5E7EB; }
  .timeline-track { display:flex; align-items:flex-start; position:relative; margin-top:8px; }
  .timeline-line { position:absolute; top:9px; left:0; right:0; height:3px; background:linear-gradient(to right,#16A34A,#D97706,#DC2626); border-radius:2px; z-index:0; }
  .timeline-points { display:flex; justify-content:space-between; width:100%; position:relative; z-index:1; align-items:flex-start; }
  .t-point { display:flex; flex-direction:column; align-items:center; gap:6px; }
  .t-dot { width:18px; height:18px; border-radius:50%; background:#fff; border:2.5px solid #D1D5DB; }
  .t-dot.active { background:#DC2626; border-color:#DC2626; width:20px; height:20px; box-shadow:0 0 0 4px rgba(220,38,38,0.15); }
  .t-dot.green  { border-color:#16A34A; }
  .t-dot.amber  { border-color:#D97706; }
  .t-dot.red    { border-color:#DC2626; }
  .t-label { font-size:10px; color:#6B7280; font-weight:500; white-space:nowrap; }
  .t-label.active { color:#DC2626; font-weight:700; }
  .you-here { background:#DC2626; color:#fff; font-size:9px; font-weight:700; letter-spacing:0.5px; border-radius:4px; padding:2px 6px; margin-top:2px; white-space:nowrap; }

  /* ── STATS GRID ── */
  .stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
  .stat-card { background:#fff; border-radius:12px; padding:16px 14px; text-align:center; box-shadow:0 1px 4px rgba(0,0,0,0.08); border:1px solid #E5E7EB; }
  .stat-icon { font-size:20px; margin-bottom:6px; }
  .stat-value { font-size:22px; font-weight:900; color:#0A0B1A; line-height:1; }
  .stat-label { font-size:10px; font-weight:600; color:#374151; margin-top:3px; text-transform:uppercase; letter-spacing:0.5px; }
  .stat-sub { font-size:9.5px; color:#9CA3AF; margin-top:2px; }
  .stat-card.green .stat-value { color:#16A34A; }
  .stat-card.red .stat-value   { color:#DC2626; }
  .stat-card.purple .stat-value { color:#7C3AED; }

  /* ── REVENUE BAND ── */
  .revenue-band { background:#EDE9FE; border-radius:14px; padding:18px 24px; border:1px solid #DDD6FE; }
  .revenue-band-title { font-size:11px; font-weight:700; color:#7C3AED; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:12px; }
  .revenue-items { display:flex; gap:32px; align-items:center; }
  .rev-item { display:flex; flex-direction:column; gap:2px; }
  .rev-item-icon { font-size:16px; margin-bottom:2px; }
  .rev-item-label { font-size:10px; color:#6B7280; font-weight:500; }
  .rev-item-val { font-size:15px; font-weight:800; color:#4C1D95; }
  .fixable { margin-left:auto; background:#7C3AED; color:#fff; border-radius:10px; padding:10px 16px; display:flex; align-items:center; gap:8px; }
  .fixable-check { font-size:18px; }
  .fixable-text { font-size:12px; font-weight:700; line-height:1.3; }

  /* ── COMPARISON TABLE ── */
  .table-wrap { background:#fff; border-radius:14px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.08); border:1px solid #E5E7EB; }
  .table-header { display:grid; grid-template-columns:1fr 1fr 1fr; background:#111827; }
  .th { padding:12px 16px; font-size:11px; font-weight:700; color:#9CA3AF; text-transform:uppercase; letter-spacing:1px; }
  .th.purple-col { background:#7C3AED; color:#fff; display:flex; align-items:center; gap:6px; }
  .table-row { display:grid; grid-template-columns:1fr 1fr 1fr; border-bottom:1px solid #F3F4F6; }
  .table-row:last-child { border-bottom:none; }
  .table-row:nth-child(odd) { background:#FAFAFA; }
  .td { padding:11px 16px; font-size:12px; color:#374151; display:flex; align-items:center; gap:8px; }
  .td.no  { color:#DC2626; font-weight:600; }
  .td.yes { color:#16A34A; font-weight:600; }
  .td.desc { color:#6B7280; font-size:11.5px; }
  .td.yes-desc { color:#4C1D95; font-size:11.5px; font-weight:500; background:#F5F3FF; }
  .pill-no  { background:#FEE2E2; color:#DC2626; border-radius:6px; padding:2px 8px; font-size:10px; font-weight:700; }
  .pill-yes { background:#DCFCE7; color:#16A34A; border-radius:6px; padding:2px 8px; font-size:10px; font-weight:700; }

  /* ── TESTIMONIAL ── */
  .testimonial { background:#fff; border-radius:14px; padding:22px 24px; display:flex; gap:20px; align-items:flex-start; box-shadow:0 1px 4px rgba(0,0,0,0.08); border:1px solid #E5E7EB; }
  .quote-mark { font-size:60px; color:#7C3AED; line-height:0.6; margin-top:10px; flex-shrink:0; font-family:Georgia,serif; }
  .quote-text { font-size:13.5px; color:#1F2937; line-height:1.7; font-style:italic; }
  .quote-author { margin-top:10px; font-size:11px; color:#6B7280; font-weight:600; }
  .trust-badge { margin-left:auto; flex-shrink:0; background:#0A0B1A; border-radius:50%; width:88px; height:88px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; border:2px solid #7C3AED; }
  .trust-badge .stars-small { color:#FBBF24; font-size:10px; }
  .trust-badge .trust-num { color:#fff; font-size:18px; font-weight:900; line-height:1; }
  .trust-badge .trust-label { color:#A78BFA; font-size:8px; font-weight:600; line-height:1.3; }

  /* ── CTA FOOTER ── */
  .cta-footer { background:#0A0B1A; border-radius:14px; padding:24px 28px; display:flex; align-items:center; gap:24px; }
  .cta-left { flex:1; }
  .cta-roi { font-size:22px; font-weight:900; color:#fff; line-height:1.2; }
  .cta-roi span { color:#A78BFA; }
  .cta-divider { width:1px; height:60px; background:#2D3748; }
  .cta-right { flex:2; }
  .cta-tagline { font-size:14px; font-weight:700; color:#fff; margin-bottom:6px; }
  .cta-features { font-size:10.5px; color:#64748B; margin-bottom:14px; }
  .cta-btn { display:inline-block; background:#7C3AED; color:#fff; font-size:13px; font-weight:700; padding:12px 28px; border-radius:10px; text-decoration:none; letter-spacing:0.3px; }
  .cta-url { font-size:10px; color:#64748B; margin-top:8px; }

  /* ── FOOTER ── */
  .page-footer { text-align:center; padding:12px 24px 16px; font-size:9.5px; color:#9CA3AF; }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-top">
    <div>
      <div class="brand-tag">Mystery Shopper Audit Report</div>
      <div class="header-date">${date} &nbsp;•&nbsp; Powered by Amelia AI</div>
    </div>
    <div class="logo">
      <div class="logo-star">✦</div>
      <div class="logo-text">AMELIA AI</div>
    </div>
  </div>
  <div class="business-name">${businessName}</div>
  <div class="header-meta">
    ${city ? `<span>📍 ${city}</span>` : ''}
    ${phone ? `<span>📞 ${phone}</span>` : ''}
    ${websiteDisplay ? `<span>🌐 ${websiteDisplay}</span>` : ''}
  </div>
  ${googleRating ? `
  <div class="google-badge">
    <div class="g-logo"><span style="color:#4285F4">G</span><span style="color:#EA4335">o</span><span style="color:#FBBC05">o</span><span style="color:#4285F4">g</span><span style="color:#34A853">l</span><span style="color:#EA4335">e</span></div>
    <div class="g-score">${googleRating}</div>
    <div class="g-stars">${starsHTML}</div>
    <div class="g-reviews">${googleReviews || 0} reviews</div>
  </div>` : ''}
</div>

<div class="content">

  <!-- RESPONSE STATUS -->
  <div class="response-card">
    <div class="badge-no-reply">
      <div class="x-icon">✕</div>
      <div class="badge-label">NO<br>REPLY</div>
      <div class="badge-time">24h+</div>
    </div>
    <div class="response-text">
      <h3>This business never responded.</h3>
      <p>We contacted this ${city?.includes('chiro') ? 'chiropractic office' : 'med spa'} via SMS asking about ${city?.includes('chiro') ? 'new patient availability' : 'Botox pricing and availability'} —<br>exactly like a real client would.</p>
      <p style="margin-top:6px"><span class="highlight">After 24 hours: silence.</span> Every minute of silence is a booking going to a competitor.</p>
    </div>
    <div class="phone-icon">📱</div>
  </div>

  <!-- TIMELINE -->
  <div class="timeline-card">
    <div class="timeline-track">
      <div class="timeline-line"></div>
      <div class="timeline-points">
        ${timelinePoints.map((p, i) => `
        <div class="t-point">
          <div class="t-dot ${p.active ? 'active' : i <= 1 ? 'green' : i <= 2 ? 'amber' : 'red'}"></div>
          <div class="t-label ${p.active ? 'active' : ''}">${p.label}</div>
          ${p.active ? '<div class="you-here">YOU ARE HERE</div>' : ''}
        </div>`).join('')}
      </div>
    </div>
  </div>

  <!-- STATS -->
  <div class="stats-grid">
    <div class="stat-card red">
      <div class="stat-icon">👤</div>
      <div class="stat-value">~${leadsLost}</div>
      <div class="stat-label">Leads Lost / Month</div>
      <div class="stat-sub">Est. unanswered inquiries</div>
    </div>
    <div class="stat-card red">
      <div class="stat-icon">💸</div>
      <div class="stat-value">${revenueMonth}</div>
      <div class="stat-label">Monthly Rev. Lost</div>
      <div class="stat-sub">At 30% conversion rate</div>
    </div>
    <div class="stat-card green">
      <div class="stat-icon">⚡</div>
      <div class="stat-value">&lt; 60s</div>
      <div class="stat-label">Amelia Responds In</div>
      <div class="stat-sub">24/7/365, automated</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-icon">📈</div>
      <div class="stat-value">${revenueYear}</div>
      <div class="stat-label">Est. Annual Rev. at Risk</div>
      <div class="stat-sub">Based on avg client LTV</div>
    </div>
  </div>

  <!-- REVENUE BAND -->
  <div class="revenue-band">
    <div class="revenue-band-title">Your Potential Revenue at Risk</div>
    <div class="revenue-items">
      <div class="rev-item">
        <div class="rev-item-icon">👤</div>
        <div class="rev-item-label">Avg client LTV</div>
        <div class="rev-item-val">$1,200/yr</div>
      </div>
      <div class="rev-item">
        <div class="rev-item-icon">💬</div>
        <div class="rev-item-label">Unanswered / mo</div>
        <div class="rev-item-val">~${leadsLost} leads</div>
      </div>
      <div class="rev-item">
        <div class="rev-item-icon">🎯</div>
        <div class="rev-item-label">Close rate</div>
        <div class="rev-item-val">30%</div>
      </div>
      <div class="fixable">
        <div class="fixable-check">✓</div>
        <div class="fixable-text">Fixable in 48 hours<br>with Amelia AI</div>
      </div>
    </div>
  </div>

  <!-- COMPARISON TABLE -->
  <div class="table-wrap">
    <div class="table-header">
      <div class="th">Communication Channel</div>
      <div class="th">Without AI</div>
      <div class="th purple-col">✦ With Amelia AI</div>
    </div>
    ${[
      ['SMS / Text inquiry',     'Hours or never',          'Answered in < 60 seconds'],
      ['Instagram DM',           'Ignored for days',        'Instant reply, books appt.'],
      ['After-hours contact',    'Goes to voicemail',       'AI handles it fully'],
      ['New patient booking',    'Needs staff to call back','Booked into calendar live'],
      ['Lead follow-up',         'Manual & inconsistent',   'Automated sequences'],
      ['Missed call recovery',   'Lost forever',            'SMS sent within 60 sec'],
    ].map(([channel, without, with_]) => `
    <div class="table-row">
      <div class="td">💬 ${channel}</div>
      <div class="td desc"><span class="pill-no">NO</span> ${without}</div>
      <div class="td yes-desc"><span class="pill-yes">YES</span> ${with_}</div>
    </div>`).join('')}
  </div>

  <!-- TESTIMONIAL -->
  <div class="testimonial">
    <div class="quote-mark">"</div>
    <div style="flex:1">
      <div class="quote-text">After installing Amelia, we stopped missing weekend inquiries entirely. Our front desk now focuses on in-clinic patients. We added 3-4 new bookings a week we would have lost.</div>
      <div class="quote-author">— Practice Manager, Austin Med Spa &nbsp;•&nbsp; Amelia client since Jan 2026</div>
    </div>
    <div class="trust-badge">
      <div class="stars-small">★★★★★</div>
      <div class="trust-num">100+</div>
      <div class="trust-label">TRUSTED BY<br>MED SPAS</div>
    </div>
  </div>

  <!-- CTA -->
  <div class="cta-footer">
    <div class="cta-left">
      <div class="cta-roi">ROI in under<br>30 days</div>
      <div style="font-size:13px;color:#A78BFA;font-weight:700;margin-top:4px">Avg client: <span style="color:#fff;font-size:18px;font-weight:900">14x</span> return</div>
    </div>
    <div class="cta-divider"></div>
    <div class="cta-right">
      <div class="cta-tagline">See Amelia handle your next patient inquiry — live.</div>
      <div class="cta-features">White-glove onboarding &nbsp;•&nbsp; Month-to-month &nbsp;•&nbsp; Cancel anytime &nbsp;•&nbsp; Live in 48 hours</div>
      <a class="cta-btn" href="https://clinics.amelia.im/demo">Book Your Free Demo &nbsp;→</a>
      <div class="cta-url">🌐 clinics.amelia.im/demo</div>
    </div>
  </div>

</div>

<!-- PAGE FOOTER -->
<div class="page-footer">
  Confidential &nbsp;•&nbsp; Prepared exclusively for ${businessName} &nbsp;•&nbsp; © ${new Date().getFullYear()} Amelia AI
</div>

</body>
</html>`;
}


function log_safe(msg) { try { console.log(`[${new Date().toISOString()}] ${msg}`); } catch {} }

async function generatePDF(lead, outputPath) {
  const html = buildHTML(lead);
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle2', timeout: 20000 });
    } catch {
      // Slow external resources (fonts) — render with what loaded
      log_safe('PDF: networkidle timeout, rendering anyway');
    }
    await new Promise(r => setTimeout(r, 500));
    await page.emulateMediaType('screen');
    await page.pdf({ path: outputPath, width: '800px', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  const testLead = {
    businessName: 'Revive Medical Spa', city: 'Denver, CO',
    phone: '(720) 248-7355', website: 'https://revivedripmedspa.com/',
    googleRating: 5, googleReviews: 9, responseTimeHours: null,
  };
  const out = path.join(__dirname, 'audits', 'test-audit-html.pdf');
  generatePDF(testLead, out).then(() => console.log('✅ PDF generated:', out)).catch(console.error);
}

module.exports = { generatePDF };
