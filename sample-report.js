const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const LOGO = path.join(__dirname, 'audits', 'amelia-logo.png');

const SAMPLE = {
  businessName:      'Glow Skin + Wellness Med Spa',
  city:              'Nashville, TN',
  phone:             '(615) 748-0192',
  website:           'glowskinnashville.com',
  instagram:         '@glowskinnashville',
  googleRating:      4.3,
  googleReviews:     47,
  responseTimeHours: null, // null = no response within 24h
  auditDate:         'May 15, 2026',
  auditor:           'JB Marketing · Powered by Amelia AI',
};

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  ink:     '#0A0A1A',
  purple:  '#7C3AED',
  purpleL: '#A78BFA',
  purpleD: '#4C1D95',
  red:     '#DC2626',
  redL:    '#FEE2E2',
  amber:   '#D97706',
  green:   '#16A34A',
  greenL:  '#DCFCE7',
  white:   '#FFFFFF',
  slate:   '#64748B',
  light:   '#F8F7FF',
  border:  '#E5E7EB',
  dark:    '#111827',
};

const W = 612, H = 792, M = 32;

function doc_fill(doc, c)   { doc.fillColor(c);   return doc; }
function doc_stroke(doc, c) { doc.strokeColor(c); return doc; }

function badge(doc, x, y, w, h, r, fillC, label, labelC, fontSize) {
  doc.roundedRect(x, y, w, h, r).fill(fillC);
  doc.fillColor(labelC).font('Helvetica-Bold').fontSize(fontSize)
     .text(label, x, y + (h - fontSize * 1.2) / 2, { width: w, align: 'center' });
}

function kpiBox(doc, x, y, w, h, topColor, big, bigC, label, sub) {
  doc.rect(x, y, w, h).fill(C.white);
  doc.rect(x, y, w, 3).fill(topColor);
  doc.rect(x, y, w, h).strokeColor(C.border).lineWidth(0.5).stroke();

  doc.fillColor(bigC).font('Helvetica-Bold').fontSize(26)
     .text(big, x, y + 16, { width: w, align: 'center' });
  doc.fillColor(C.slate).font('Helvetica-Bold').fontSize(7)
     .text(label.toUpperCase(), x, y + 50, { width: w, align: 'center', characterSpacing: 0.5 });
  doc.fillColor(C.slate).font('Helvetica').fontSize(7)
     .text(sub, x, y + 62, { width: w, align: 'center' });
}

async function generate() {
  const doc = new PDFDocument({ size: [W, H], margin: 0, compress: true });
  const out  = path.join(__dirname, 'audits', 'sample-audit-report.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  doc.pipe(fs.createWriteStream(out));

  // ══════════════════════════════════════════════════════════════════════════
  // 1. HEADER  (0–68)
  // ══════════════════════════════════════════════════════════════════════════
  doc.rect(0, 0, W, 68).fill(C.ink);

  // Logo
  if (fs.existsSync(LOGO)) {
    doc.image(LOGO, M, 10, { height: 48, fit: [130, 48] });
  } else {
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(20).text('AMELIA', M, 22);
  }

  // Right side: report label
  doc.fillColor(C.purpleL).font('Helvetica-Bold').fontSize(8.5)
     .text('MYSTERY SHOPPER AUDIT REPORT', 0, 18,
           { width: W - M, align: 'right', characterSpacing: 1.2 });
  doc.fillColor(C.slate).font('Helvetica').fontSize(8)
     .text(SAMPLE.auditDate + '  ·  ' + SAMPLE.auditor, 0, 34,
           { width: W - M, align: 'right' });

  // Purple accent line
  doc.rect(0, 68, W, 3).fill(C.purple);

  // ══════════════════════════════════════════════════════════════════════════
  // 2. BUSINESS INFO BAR  (71–108)
  // ══════════════════════════════════════════════════════════════════════════
  doc.rect(0, 71, W, 37).fill(C.light);

  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12)
     .text(SAMPLE.businessName, M, 78);

  const info = `${SAMPLE.city}   ·   ${SAMPLE.phone}   ·   ${SAMPLE.website}   ·   ${SAMPLE.instagram}`;
  doc.fillColor(C.slate).font('Helvetica').fontSize(7.8)
     .text(info, M, 94);

  // Stars
  const ratingX = W - M - 90;
  doc.fillColor(C.amber).font('Helvetica-Bold').fontSize(10)
     .text(`★ ${SAMPLE.googleRating}`, ratingX, 78);
  doc.fillColor(C.slate).font('Helvetica').fontSize(7)
     .text(`${SAMPLE.googleReviews} reviews · Google`, ratingX, 93);

  // ══════════════════════════════════════════════════════════════════════════
  // 3. SCORE CARD  (112–210)
  // ══════════════════════════════════════════════════════════════════════════
  const scoreY = 112;

  // Left: big verdict circle
  const cx = M + 48, cy = scoreY + 48;
  doc.circle(cx, cy, 46).fill(C.red);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(10)
     .text('NO', cx - 46, cy - 20, { width: 92, align: 'center' });
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(10)
     .text('REPLY', cx - 46, cy - 6, { width: 92, align: 'center' });
  doc.fillColor(C.white).font('Helvetica').fontSize(7)
     .text('24 hours', cx - 46, cy + 8, { width: 92, align: 'center' });

  // Right: headline + description
  const textX = M + 108;
  doc.fillColor(C.red).font('Helvetica-Bold').fontSize(17)
     .text('This business never responded.', textX, scoreY + 6, { width: W - textX - M });

  doc.fillColor(C.ink).font('Helvetica').fontSize(9).lineGap(3)
     .text(
       'We contacted Glow Skin + Wellness Med Spa via SMS and Instagram DM, asking about Botox pricing and availability — exactly how a real client would reach out.\n\nAfter 24 hours: silence.',
       textX, scoreY + 28, { width: W - textX - M - 4 }
     );

  // Response time gradient bar
  const barY = scoreY + 90;
  const barX = M + 108;
  const barW = W - barX - M;
  const barH = 14;

  // Gradient simulation: green → yellow → red
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const t   = i / steps;
    const bx  = barX + (barW * i) / steps;
    const bw  = barW / steps + 1;
    const r   = Math.round(22  + (220 - 22)  * t);
    const g   = Math.round(163 + (38  - 163) * t);
    const b   = Math.round(74  + (38  - 74)  * t);
    doc.rect(bx, barY, bw, barH).fill(`#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`);
  }
  doc.roundedRect(barX, barY, barW, barH, 3).strokeColor(C.border).lineWidth(0.5).stroke();

  // Labels under bar
  const labels = [['Instant', 0], ['< 5 min', 0.15], ['1 hr', 0.35], ['4 hrs', 0.58], ['24 hrs', 0.80], ['∞ No reply', 1]];
  doc.fillColor(C.slate).font('Helvetica').fontSize(6.5);
  labels.forEach(([lbl, pos]) => {
    const lx = barX + barW * pos - (pos === 1 ? 28 : pos === 0 ? 0 : 10);
    doc.text(lbl, lx, barY + barH + 3, { width: 36 });
    doc.moveTo(barX + barW * pos, barY).lineTo(barX + barW * pos, barY + barH + 1)
       .strokeColor('rgba(0,0,0,0.15)').lineWidth(0.5).stroke();
  });

  // Arrow pointing to "No reply"
  const arrowX = barX + barW - 2;
  doc.polygon([arrowX, barY - 3], [arrowX - 5, barY - 10], [arrowX + 5, barY - 10])
     .fill(C.red);
  doc.fillColor(C.red).font('Helvetica-Bold').fontSize(6.5)
     .text('YOU ARE HERE', arrowX - 28, barY - 20, { width: 60, align: 'center' });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. KPI ROW  (225–305)
  // ══════════════════════════════════════════════════════════════════════════
  const kpiY = 228;
  const kpiH = 80;
  const gap  = 6;
  const kpiW = (W - M * 2 - gap * 3) / 4;

  const kpis = [
    { big: '∞',      bigC: C.red,   top: C.red,   label: 'Your Response Time', sub: 'No reply in 24 hours'       },
    { big: '~12',    bigC: C.red,   top: C.red,   label: 'Leads Lost / Month',  sub: 'Est. unanswered inquiries'  },
    { big: '$4,320', bigC: C.amber, top: C.amber, label: 'Monthly Rev. Lost',   sub: 'At 30% conversion rate'     },
    { big: '< 60s',  bigC: C.green, top: C.green, label: 'Amelia Responds In',  sub: '24 / 7 / 365, automatically'},
  ];

  kpis.forEach((k, i) => {
    kpiBox(doc, M + i * (kpiW + gap), kpiY, kpiW, kpiH, k.top, k.big, k.bigC, k.label, k.sub);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. REVENUE IMPACT BANNER  (315–370)
  // ══════════════════════════════════════════════════════════════════════════
  const bannerY = 318;
  doc.rect(0, bannerY, W, 50).fill(C.dark);

  // Left text
  doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
     .text('ESTIMATED ANNUAL REVENUE AT RISK', M, bannerY + 8, { characterSpacing: 0.8 });
  doc.fillColor(C.red).font('Helvetica-Bold').fontSize(26)
     .text('$51,840', M, bannerY + 18);

  // Separator
  doc.moveTo(M + 110, bannerY + 8).lineTo(M + 110, bannerY + 42)
     .strokeColor('#374151').lineWidth(1).stroke();

  // Breakdown
  const cols = [
    { label: 'Avg client LTV',   val: '$1,200 / yr' },
    { label: 'Unanswered / mo',  val: '~12 msgs'    },
    { label: 'Close rate',       val: '30%'          },
    { label: 'Revenue lost / mo',val: '$4,320'       },
  ];
  cols.forEach((c, i) => {
    const cx2 = M + 120 + i * 118;
    doc.fillColor('#6B7280').font('Helvetica').fontSize(7)
       .text(c.label, cx2, bannerY + 10, { width: 110 });
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(11)
       .text(c.val, cx2, bannerY + 22, { width: 110 });
  });

  // Right badge
  doc.roundedRect(W - M - 100, bannerY + 10, 100, 30, 6).fill(C.purple);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5)
     .text('Fixable in 48 hours', W - M - 100, bannerY + 14, { width: 100, align: 'center' });
  doc.fillColor(C.purpleL).font('Helvetica').fontSize(7)
     .text('with Amelia AI', W - M - 100, bannerY + 27, { width: 100, align: 'center' });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. COMPARISON TABLE  (378–540)
  // ══════════════════════════════════════════════════════════════════════════
  const tblY  = 378;
  const col0  = 182;
  const col12 = (W - M * 2 - col0) / 2;

  // Header row
  doc.rect(M, tblY, W - M * 2, 22).fill(C.ink);
  doc.fillColor('#9CA3AF').font('Helvetica-Bold').fontSize(7.5)
     .text('COMMUNICATION CATEGORY', M + 8, tblY + 7, { width: col0 - 8, characterSpacing: 0.4 });
  doc.fillColor(C.red).font('Helvetica-Bold').fontSize(7.5)
     .text('WITHOUT AI  ✗', M + col0 + 8, tblY + 7, { width: col12 - 16, align: 'center', characterSpacing: 0.4 });
  doc.fillColor(C.green).font('Helvetica-Bold').fontSize(7.5)
     .text('WITH AMELIA AI  ✓', M + col0 + col12 + 8, tblY + 7, { width: col12 - 16, align: 'center', characterSpacing: 0.4 });

  const rows = [
    ['SMS / Text inquiry',         'Hours or never',            'Answered in < 60 seconds'],
    ['Instagram DM',               'Ignored for days',          'Instant reply, books appt.'],
    ['After-hours contact',        'Goes to voicemail',         'AI handles it fully'],
    ['New patient booking',        'Needs staff to call back',  'Booked into calendar live'],
    ['Lead follow-up',             'Manual & inconsistent',     'Automated sequences'],
    ['Missed call recovery',       'Lost forever',              'SMS sent within 60 sec'],
  ];

  rows.forEach((row, i) => {
    const ry = tblY + 22 + i * 24;
    doc.rect(M, ry, W - M * 2, 24).fill(i % 2 === 0 ? C.white : C.light);

    // vertical dividers
    [col0, col0 + col12].forEach(offset => {
      doc.moveTo(M + offset, ry).lineTo(M + offset, ry + 24)
         .strokeColor(C.border).lineWidth(0.5).stroke();
    });

    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.2)
       .text(row[0], M + 8, ry + 7, { width: col0 - 12 });
    doc.fillColor(C.red).font('Helvetica').fontSize(8.2)
       .text('✗  ' + row[1], M + col0 + 8, ry + 7, { width: col12 - 16 });
    doc.fillColor(C.green).font('Helvetica').fontSize(8.2)
       .text('✓  ' + row[2], M + col0 + col12 + 8, ry + 7, { width: col12 - 16 });
  });

  // bottom border
  const tblBot = tblY + 22 + rows.length * 24;
  doc.rect(M, tblY, W - M * 2, tblBot - tblY).strokeColor(C.border).lineWidth(0.5).stroke();

  // ══════════════════════════════════════════════════════════════════════════
  // 7. SOCIAL PROOF STRIP  (tblBot+8 → tblBot+56)
  // ══════════════════════════════════════════════════════════════════════════
  const proofY = tblBot + 8;
  doc.rect(M, proofY, W - M * 2, 48).fill(C.light);
  doc.rect(M, proofY, 3, 48).fill(C.purple);

  doc.fillColor(C.amber).font('Helvetica-Bold').fontSize(9)
     .text('★★★★★', M + 12, proofY + 8);
  doc.fillColor(C.ink).font('Helvetica').fontSize(8.2).lineGap(2)
     .text(
       '"After installing Amelia, we stopped missing weekend inquiries entirely. Our front desk focuses on in-clinic patients. We\'ve added 3–4 new bookings a week we would have lost."',
       M + 12, proofY + 20, { width: W - M * 2 - 160, italics: true }
     );
  doc.fillColor(C.slate).font('Helvetica').fontSize(7)
     .text('— Practice Manager, Austin Med Spa  ·  Client since Jan 2026', M + 12, proofY + 38);

  // ROI badge
  doc.roundedRect(W - M - 130, proofY + 9, 126, 30, 8).fill(C.purple);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(9.5)
     .text('ROI in under 30 days', W - M - 130, proofY + 13, { width: 126, align: 'center' });
  doc.fillColor(C.purpleL).font('Helvetica').fontSize(7.5)
     .text('Avg client sees 14× return', W - M - 130, proofY + 27, { width: 126, align: 'center' });

  // ══════════════════════════════════════════════════════════════════════════
  // 8. CTA FOOTER  (proofY+58 → bottom)
  // ══════════════════════════════════════════════════════════════════════════
  const footerY = proofY + 58;
  doc.rect(0, footerY, W, H - footerY).fill(C.purple);

  // Subtle grid pattern
  doc.save();
  doc.opacity(0.05);
  for (let gx = 0; gx < W; gx += 24) {
    doc.moveTo(gx, footerY).lineTo(gx, H).strokeColor(C.white).lineWidth(0.5).stroke();
  }
  for (let gy = footerY; gy < H; gy += 24) {
    doc.moveTo(0, gy).lineTo(W, gy).strokeColor(C.white).lineWidth(0.5).stroke();
  }
  doc.restore();

  // Headline
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(15)
     .text('See Amelia handle your next patient inquiry — live, in 15 minutes.', M, footerY + 18,
           { width: W - M * 2, align: 'center' });

  doc.fillColor('rgba(255,255,255,0.75)').font('Helvetica').fontSize(8.5)
     .text('No contracts · No setup fees · Cancel anytime · Live in 48 hours', M, footerY + 40,
           { width: W - M * 2, align: 'center' });

  // CTA button
  const btnW = 310, btnH = 36, btnX = (W - btnW) / 2, btnY = footerY + 56;
  doc.roundedRect(btnX, btnY, btnW, btnH, 8).fill(C.white);
  doc.fillColor(C.purple).font('Helvetica-Bold').fontSize(11)
     .text('Book Your Free Demo  →', btnX, btnY + 11, { width: btnW, align: 'center' });

  // URL below button
  doc.fillColor('rgba(255,255,255,0.7)').font('Helvetica').fontSize(8)
     .text('clinics.amelia.im/widget/booking/amelia-sales-call', M, btnY + 44,
           { width: W - M * 2, align: 'center' });

  // Fine print
  doc.fillColor('rgba(255,255,255,0.4)').font('Helvetica').fontSize(6.5)
     .text(
       `Confidential · Prepared exclusively for ${SAMPLE.businessName} · © ${new Date().getFullYear()} Amelia AI by JB Marketing`,
       M, H - 16, { width: W - M * 2, align: 'center' }
     );

  doc.end();
  return new Promise((res, rej) => {
    doc.on('finish', () => res(out));
    doc.on('error', rej);
  });
}

generate()
  .then(p => {
    console.log(`\n✅ Report generated:\n   ${p}\n`);
    require('child_process').exec(`open "${p}"`);
  })
  .catch(console.error);
