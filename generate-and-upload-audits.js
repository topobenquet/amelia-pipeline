require('dotenv').config();
const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');
const { google }  = require('googleapis');
const http        = require('http');
const url         = require('url');
const axios       = require('axios');

const LOGO_WHITE      = path.join(__dirname, 'audits', 'amelia-logo-white.png');
const LOGO_DARK       = path.join(__dirname, 'audits', 'amelia-logo.png');
const LOGO            = fs.existsSync(LOGO_WHITE) ? LOGO_WHITE : (fs.existsSync(LOGO_DARK) ? LOGO_DARK : null);
const CREDS_PATH      = path.join(__dirname, 'credentials.json');
const TOKEN_PATH      = path.join(__dirname, 'token.json');
const AUDITS_DIR      = path.join(__dirname, 'audits');
const DRIVE_FOLDER    = 'Amelia Audits';
const BOOKING_URL     = 'https://clinics.amelia.im/schedule';
const BOOKING_DISPLAY = 'clinics.amelia.im/schedule';
const ARIAL_UNICODE   = '/Library/Fonts/Arial Unicode.ttf';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
];

// ─── Google Auth ──────────────────────────────────────────────────────────────
async function getAuth() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3456/callback');

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2.setCredentials(token);
    // Refresh if expired
    if (token.expiry_date && token.expiry_date < Date.now()) {
      const { credentials } = await oAuth2.refreshAccessToken();
      oAuth2.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials));
    }
    return oAuth2;
  }

  // First-time auth — open browser, catch callback
  const authUrl = oAuth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n🔐 Opening browser for Google auth...');
  try { require('child_process').exec(`open "${authUrl}"`); } catch { console.log('   Open this URL manually:\n  ', authUrl); }

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const qs = new url.URL(req.url, 'http://localhost:3456').searchParams;
      const code = qs.get('code');
      res.end('<h2>Auth complete — you can close this tab.</h2>');
      server.close();
      code ? resolve(code) : reject(new Error('No code in callback'));
    }).listen(3456);
    setTimeout(() => { server.close(); reject(new Error('Auth timeout')); }, 120_000);
  });

  const { tokens } = await oAuth2.getToken(code);
  oAuth2.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('✅ Google auth saved\n');
  return oAuth2;
}

// ─── Drive helpers ────────────────────────────────────────────────────────────
async function getOrCreateFolder(drive, name) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    spaces: 'drive',
  });
  if (res.data.files.length) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return folder.data.id;
}

async function uploadPDF(drive, folderId, fileName, filePath) {
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: 'application/pdf' },
    media: { mimeType: 'application/pdf', body: fs.createReadStream(filePath) },
    fields: 'id',
  });
  const fileId = res.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}

// ─── PDF generation ───────────────────────────────────────────────────────────
const C = {
  ink: '#0A0A1A', purple: '#7C3AED', purpleL: '#A78BFA', purpleD: '#4C1D95',
  red: '#DC2626', amber: '#D97706', green: '#16A34A',
  white: '#FFFFFF', slate: '#64748B', light: '#F8F7FF', border: '#E5E7EB', dark: '#111827',
};
const W = 612, PH = 792, M = 32;

// Register Arial Unicode once for ✓/✗ support
const HAS_UNICODE = fs.existsSync(ARIAL_UNICODE);

function useUnicode(doc) { if (HAS_UNICODE) doc.font(ARIAL_UNICODE); }
function useBold(doc)    { doc.font('Helvetica-Bold'); }
function useReg(doc)     { doc.font('Helvetica'); }

function kpiBox(doc, x, y, w, h, topColor, big, bigC, label, sub) {
  doc.rect(x, y, w, h).fill(C.white);
  doc.rect(x, y, w, 3).fill(topColor);
  doc.rect(x, y, w, h).strokeColor(C.border).lineWidth(0.5).stroke();
  useBold(doc);
  doc.fillColor(bigC).fontSize(22).text(big, x, y + 14, { width: w, align: 'center' });
  useBold(doc);
  doc.fillColor(C.slate).fontSize(7).text(label.toUpperCase(), x, y + 48, { width: w, align: 'center', characterSpacing: 0.5 });
  useReg(doc);
  doc.fillColor(C.slate).fontSize(6.5).text(sub, x, y + 60, { width: w, align: 'center' });
}

function arrowPos(h) {
  if (h === null || h === undefined) return 1.0;
  const milestones = [[0, 0], [0.0833, 0.15], [1, 0.35], [4, 0.58], [24, 0.80], [Infinity, 1.0]];
  for (let i = 1; i < milestones.length; i++) {
    const [h0, p0] = milestones[i - 1];
    const [h1, p1] = milestones[i];
    if (h <= h1) return p0 + ((h - h0) / (h1 - h0)) * (p1 - p0);
  }
  return 1.0;
}

function bucketInfo(h) {
  if (h === null || h === undefined) {
    return {
      accentColor: C.red,
      verdict: 'NO REPLY',
      verdictSub: 'within 24 hrs',
      headline: 'This business never responded.',
      description: 'We contacted this med spa via SMS asking about Botox pricing and availability — exactly like a real client would.\n\nAfter 24 hours: silence. Every minute of silence is a booking going to a competitor.',
      kpiResponse: 'None', kpiResponseColor: C.red,
      kpiSub: 'No reply in 24 hours',
    };
  }
  const fmtShort = h < 1 ? `${Math.round(h * 60)} min` : h === 1 ? '1 hr' : `${Math.round(h)} hrs`;
  const fmtLong  = h < 1 ? `${Math.round(h * 60)} minutes` : `${Math.round(h)} hours`;
  if (h <= 4) {
    return {
      accentColor: C.green,
      verdict: fmtShort,
      verdictSub: 'response time',
      headline: 'Good news — you responded quickly.',
      description: `You replied to our mystery shopper text in ${fmtLong}. That puts you ahead of most med spas in your city.\n\nThe remaining gap: nights, weekends, and peak treatment hours — those inquiries still wait for a human to pick up.`,
      kpiResponse: fmtShort, kpiResponseColor: C.green,
      kpiSub: 'vs. 5-min optimal',
    };
  }
  return {
    accentColor: C.amber,
    verdict: fmtShort,
    verdictSub: 'response time',
    headline: 'You responded — but leads were already gone.',
    description: `You replied in ${fmtLong}. Better than nothing — but leads who don't hear back within 5 minutes are 21x less likely to convert.\n\nDuring that window, they were texting 2-3 other clinics. Whoever replied first won the booking.`,
    kpiResponse: fmtShort, kpiResponseColor: C.amber,
    kpiSub: 'vs. 5-min optimal',
  };
}

function revenueLost(h) {
  if (!h || h > 8) return '$51,840';
  if (h > 4) return '$38,400';
  if (h > 1) return '$24,000';
  return '$12,000';
}

// Draw colored pill indicator + text (replaces ✗/✓ Unicode)
function statusCell(doc, x, y, w, isPositive, text) {
  const color = isPositive ? C.green : C.red;
  const label = isPositive ? 'YES' : 'NO';
  // pill
  doc.roundedRect(x, y + 4, 20, 11, 3).fill(color);
  useBold(doc);
  doc.fillColor(C.white).fontSize(5.5).text(label, x, y + 6.5, { width: 20, align: 'center' });
  // text
  useReg(doc);
  doc.fillColor(isPositive ? '#15803D' : '#B91C1C').fontSize(8).text(text, x + 24, y + 6, { width: w - 28 });
}

// Draw concentric ring badge for score circle
function ringBadge(doc, cx, cy, color, topLine, bottomLine, sub) {
  // Outer faint ring
  doc.save().opacity(0.15).circle(cx, cy, 52).fill(color).restore();
  // Mid ring
  doc.save().opacity(0.30).circle(cx, cy, 44).fill(color).restore();
  // Inner solid
  doc.circle(cx, cy, 36).fill(color);

  useBold(doc);
  doc.fillColor(C.white).fontSize(bottomLine ? 11 : 15);
  if (bottomLine) {
    doc.text(topLine, cx - 36, cy - 16, { width: 72, align: 'center' });
    doc.text(bottomLine, cx - 36, cy - 2, { width: 72, align: 'center' });
  } else {
    doc.text(topLine, cx - 36, cy - 10, { width: 72, align: 'center' });
  }
  useReg(doc);
  doc.fillColor(C.white).fontSize(6.5).text(sub, cx - 36, cy + 16, { width: 72, align: 'center' });
}

// Draw individual filled star
function drawStar(doc, cx, cy, r, color) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const outerA = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    const innerA = outerA + Math.PI / 5;
    pts.push([cx + r * Math.cos(outerA), cy + r * Math.sin(outerA)]);
    pts.push([cx + (r * 0.42) * Math.cos(innerA), cy + (r * 0.42) * Math.sin(innerA)]);
  }
  doc.polygon(...pts).fill(color);
}

async function generatePDF(lead, outPath) {
  const b   = bucketInfo(lead.responseTimeHours);
  const rev = revenueLost(lead.responseTimeHours);
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, PH], margin: 0, compress: true });
    const writeStream = fs.createWriteStream(outPath);
    doc.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);

    // ── 1. HEADER ──────────────────────────────────────────────────────────────
    doc.rect(0, 0, W, 70).fill(C.ink);

    if (LOGO) {
      doc.image(LOGO, M, 11, { height: 46, fit: [140, 46] });
    } else {
      useBold(doc);
      doc.fillColor(C.white).fontSize(22).text('AMELIA', M, 22);
    }

    useBold(doc);
    doc.fillColor(C.purpleL).fontSize(8)
       .text('MYSTERY SHOPPER AUDIT REPORT', 0, 19, { width: W - M, align: 'right', characterSpacing: 1.3 });
    useReg(doc);
    doc.fillColor(C.slate).fontSize(7.5)
       .text(`${today}  ·  Powered by Amelia AI`, 0, 35, { width: W - M, align: 'right' });

    // Purple accent bar
    doc.rect(0, 70, W, 3).fill(C.purple);

    // ── 2. BUSINESS INFO BAR ───────────────────────────────────────────────────
    doc.rect(0, 73, W, 42).fill(C.light);

    // Business name
    useBold(doc);
    doc.fillColor(C.ink).fontSize(13).text(lead.businessName, M, 80, { width: W - M * 2 - 110 });

    // Info line
    const infoLine = [lead.city, lead.phone, lead.website].filter(Boolean).join('   ·   ');
    useReg(doc);
    doc.fillColor(C.slate).fontSize(7.5).text(infoLine, M, 97, { width: W - M * 2 - 110 });

    // Google rating badge (right side)
    if (lead.googleRating) {
      const rating = parseFloat(lead.googleRating);
      const reviews = lead.googleReviews || 0;
      const badgeX = W - M - 100, badgeY = 77;

      doc.roundedRect(badgeX, badgeY, 100, 34, 6).fill(C.white);
      doc.roundedRect(badgeX, badgeY, 100, 34, 6).strokeColor(C.border).lineWidth(0.5).stroke();

      // Stars (draw 5 individual stars)
      const starY = badgeY + 8, starStart = badgeX + 8;
      for (let s = 0; s < 5; s++) {
        const filled = s < Math.round(rating);
        drawStar(doc, starStart + s * 13 + 6, starY + 5, 5, filled ? C.amber : '#D1D5DB');
      }

      // Rating number + review count
      useBold(doc);
      doc.fillColor(C.amber).fontSize(10).text(`${rating}`, badgeX + 71, badgeY + 4, { width: 24, align: 'right' });
      useReg(doc);
      doc.fillColor(C.slate).fontSize(6).text(`${reviews} reviews`, badgeX + 8, badgeY + 22, { width: 84, align: 'center' });
    }

    // ── 3. SCORE CARD ──────────────────────────────────────────────────────────
    const scoreY = 122;
    const cx = M + 56, cy = scoreY + 52;

    // Draw ring circles FIRST (graphics only, no text yet)
    doc.save().opacity(0.15).circle(cx, cy, 52).fill(b.accentColor).restore();
    doc.save().opacity(0.30).circle(cx, cy, 44).fill(b.accentColor).restore();
    doc.circle(cx, cy, 36).fill(b.accentColor);

    // Render ALL text top-to-bottom so PDFKit cursor never jumps backwards
    const textX = M + 122;

    // [y=126] Headline — right column
    useBold(doc);
    doc.fillColor(b.accentColor).fontSize(16).text(b.headline, textX, scoreY + 4, { width: W - textX - M });

    // [y=148] Description — right column
    useReg(doc);
    doc.fillColor(C.ink).fontSize(8.8).lineGap(3)
       .text(b.description, textX, scoreY + 26, { width: W - textX - M - 4 });

    // [y=158+] Ring badge text — left column (rendered after right column so y is valid)
    const ringLines = b.verdict === 'NO REPLY' ? ['NO', 'REPLY'] : [b.verdict];
    const ringFontSize = ringLines.length === 2 ? 11 : 15;
    useBold(doc);
    doc.fillColor(C.white).fontSize(ringFontSize);
    if (ringLines.length === 2) {
      doc.text(ringLines[0], cx - 36, cy - 16, { width: 72, align: 'center' });
      doc.text(ringLines[1], cx - 36, cy - 2,  { width: 72, align: 'center' });
    } else {
      doc.text(ringLines[0], cx - 36, cy - 10, { width: 72, align: 'center' });
    }
    useReg(doc);
    doc.fillColor(C.white).fontSize(6.5).text(b.verdictSub, cx - 36, cy + 16, { width: 72, align: 'center' });

    // Response time gradient bar
    const barY = scoreY + 95, barX = M + 122, barW = W - barX - M, barH = 13;
    for (let i = 0; i < 40; i++) {
      const t = i / 40;
      const bx = barX + (barW * i) / 40;
      const r = Math.round(22  + (220 - 22)  * t);
      const g = Math.round(163 + (38  - 163) * t);
      const bv= Math.round(74  + (38  - 74)  * t);
      doc.rect(bx, barY, barW / 40 + 1, barH)
         .fill(`#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${bv.toString(16).padStart(2,'0')}`);
    }
    doc.roundedRect(barX, barY, barW, barH, 3).strokeColor(C.border).lineWidth(0.4).stroke();

    const lbls = [['Instant', 0], ['5 min', 0.15], ['1 hr', 0.35], ['4 hrs', 0.58], ['24 hrs', 0.80], ['No reply', 1]];
    useReg(doc);
    doc.fillColor(C.slate).fontSize(6);
    lbls.forEach(([lbl, pos]) => {
      const lx = barX + barW * pos - (pos === 1 ? 22 : pos === 0 ? 0 : 8);
      doc.text(lbl, lx, barY + barH + 3, { width: 30 });
    });

    const pos      = arrowPos(lead.responseTimeHours);
    const arrowX   = Math.min(barX + barW * pos, barX + barW - 2);
    const arrowClr = b.accentColor;
    doc.polygon([arrowX, barY - 2], [arrowX - 5, barY - 9], [arrowX + 5, barY - 9]).fill(arrowClr);
    useBold(doc);
    doc.fillColor(arrowClr).fontSize(6).text('YOU ARE HERE', arrowX - 28, barY - 19, { width: 60, align: 'center' });

    // ── 4. KPI ROW ─────────────────────────────────────────────────────────────
    const kpiY = 242, kpiH = 78, gap = 5;
    const kpiW = (W - M * 2 - gap * 3) / 4;
    const kpis = [
      { big: b.kpiResponse, bigC: b.kpiResponseColor, top: b.kpiResponseColor, label: 'Your Response Time', sub: b.kpiSub },
      { big: '~12',    bigC: C.red,   top: C.red,   label: 'Leads Lost / Month',  sub: 'Est. unanswered inquiries' },
      { big: '$4,320', bigC: C.amber, top: C.amber, label: 'Monthly Rev. Lost',   sub: 'At 30% conversion rate'   },
      { big: '< 60s',  bigC: C.green, top: C.green, label: 'Amelia Responds In',  sub: '24/7/365, automated'      },
    ];
    kpis.forEach((k, i) => kpiBox(doc, M + i * (kpiW + gap), kpiY, kpiW, kpiH, k.top, k.big, k.bigC, k.label, k.sub));

    // ── 5. REVENUE BANNER ──────────────────────────────────────────────────────
    const bannerY = 328;
    doc.rect(0, bannerY, W, 56).fill(C.dark);

    useReg(doc);
    doc.fillColor('#9CA3AF').fontSize(7.5)
       .text('ESTIMATED ANNUAL REVENUE AT RISK', M, bannerY + 7, { characterSpacing: 0.8 });
    useBold(doc);
    // fontSize 22 keeps number ≤ 140px wide — well clear of the separator
    doc.fillColor(C.red).fontSize(22).text(rev + '/yr', M, bannerY + 20);

    // Separator — starts at M+155 (safely past the number)
    const sepX = M + 155;
    doc.moveTo(sepX, bannerY + 8).lineTo(sepX, bannerY + 48).strokeColor('#374151').lineWidth(1).stroke();

    // 4 stat columns
    const badgeW = 104;
    const colAreaW = W - sepX - M - badgeW - 24;
    const colW = colAreaW / 4;
    const statCols = [
      { label: 'Avg client LTV',    val: '$1,200/yr' },
      { label: 'Unanswered / mo',   val: '~12 leads'  },
      { label: 'Close rate',        val: '30%'        },
      { label: 'Monthly rev. lost', val: '$4,320'     },
    ];
    statCols.forEach((col, i) => {
      const cx2 = sepX + 12 + i * colW;
      useReg(doc);
      doc.fillColor('#6B7280').fontSize(6.5).text(col.label, cx2, bannerY + 10, { width: colW - 4 });
      useBold(doc);
      doc.fillColor(C.white).fontSize(11).text(col.val, cx2, bannerY + 23, { width: colW - 4 });
    });

    // Fix badge (far right)
    doc.roundedRect(W - M - badgeW, bannerY + 12, badgeW, 32, 6).fill(C.purple);
    useBold(doc);
    doc.fillColor(C.white).fontSize(8).text('Fixable in 48 hours', W - M - badgeW, bannerY + 16, { width: badgeW, align: 'center' });
    useReg(doc);
    doc.fillColor('#C4B5FD').fontSize(7).text('with Amelia AI', W - M - badgeW, bannerY + 29, { width: badgeW, align: 'center' });

    // ── 6. COMPARISON TABLE ────────────────────────────────────────────────────
    const tblY = 392, col0 = 180, col12 = (W - M * 2 - col0) / 2;

    // Header
    doc.rect(M, tblY, W - M * 2, 22).fill(C.ink);
    useBold(doc);
    doc.fillColor('#9CA3AF').fontSize(7).text('COMMUNICATION CHANNEL', M + 8, tblY + 7, { width: col0 - 8, characterSpacing: 0.4 });

    // "WITHOUT AI" header with red pill
    const h1x = M + col0 + 8;
    doc.roundedRect(h1x + 18, tblY + 5, 68, 12, 3).fill('#7F1D1D');
    doc.fillColor('#FCA5A5').fontSize(7).text('WITHOUT AI', h1x + 18, tblY + 7.5, { width: 68, align: 'center' });

    // "WITH AMELIA AI" header with green pill
    const h2x = M + col0 + col12 + 8;
    doc.roundedRect(h2x + 10, tblY + 5, 80, 12, 3).fill('#14532D');
    doc.fillColor('#86EFAC').fontSize(7).text('WITH AMELIA AI', h2x + 10, tblY + 7.5, { width: 80, align: 'center' });

    const rows = [
      ['SMS / Text inquiry',   'Hours or never',           'Answered in < 60 seconds' ],
      ['Instagram DM',         'Ignored for days',          'Instant reply, books appt.'],
      ['After-hours contact',  'Goes to voicemail',         'AI handles it fully'      ],
      ['New patient booking',  'Needs staff to call back',  'Booked into calendar live'],
      ['Lead follow-up',       'Manual & inconsistent',     'Automated sequences'      ],
      ['Missed call recovery', 'Lost forever',              'SMS sent within 60 sec'   ],
    ];
    rows.forEach((row, i) => {
      const ry = tblY + 22 + i * 24;
      doc.rect(M, ry, W - M * 2, 24).fill(i % 2 === 0 ? C.white : C.light);
      [col0, col0 + col12].forEach(offset => {
        doc.moveTo(M + offset, ry).lineTo(M + offset, ry + 24).strokeColor(C.border).lineWidth(0.4).stroke();
      });
      useBold(doc);
      doc.fillColor(C.ink).fontSize(8).text(row[0], M + 8, ry + 8, { width: col0 - 12 });
      statusCell(doc, M + col0 + 6, ry, col12 - 12, false, row[1]);
      statusCell(doc, M + col0 + col12 + 6, ry, col12 - 12, true, row[2]);
    });
    const tblBot = tblY + 22 + rows.length * 24;
    doc.rect(M, tblY, W - M * 2, tblBot - tblY).strokeColor(C.border).lineWidth(0.4).stroke();

    // ── 7. SOCIAL PROOF ────────────────────────────────────────────────────────
    const proofY = tblBot + 6;
    const proofH = 56;
    doc.rect(M, proofY, W - M * 2, proofH).fill(C.light);
    doc.rect(M, proofY, 3, proofH).fill(C.purple);

    // Stars
    for (let s = 0; s < 5; s++) drawStar(doc, M + 18 + s * 13, proofY + 13, 5, C.amber);

    // Quote
    useReg(doc);
    doc.fillColor('#1E293B').fontSize(8).lineGap(2.5)
       .text(
         '"After installing Amelia, we stopped missing weekend inquiries entirely. Our front desk now focuses on in-clinic patients. We added 3-4 new bookings a week we would have lost."',
         M + 12, proofY + 22, { width: W - M * 2 - 155 }
       );

    // Attribution (with extra spacing below quote)
    useReg(doc);
    doc.fillColor(C.slate).fontSize(7)
       .text('— Practice Manager, Austin Med Spa  ·  Amelia client since Jan 2026', M + 12, proofY + 43, { width: W - M * 2 - 155 });

    // ROI badge
    doc.roundedRect(W - M - 132, proofY + 10, 128, 36, 8).fill(C.purple);
    useBold(doc);
    doc.fillColor(C.white).fontSize(10).text('ROI in under 30 days', W - M - 132, proofY + 15, { width: 128, align: 'center' });
    useReg(doc);
    doc.fillColor('#C4B5FD').fontSize(7.5).text('Avg client: 14x return', W - M - 132, proofY + 30, { width: 128, align: 'center' });

    // ── 8. CTA FOOTER ──────────────────────────────────────────────────────────
    const footerY = proofY + proofH + 6;
    doc.rect(0, footerY, W, PH - footerY).fill(C.purple);

    // Subtle dot-grid pattern
    doc.save().opacity(0.06);
    for (let gx = 16; gx < W; gx += 20) {
      for (let gy = footerY + 10; gy < PH - 10; gy += 20) {
        doc.circle(gx, gy, 1).fill(C.white);
      }
    }
    doc.restore();

    useBold(doc);
    doc.fillColor(C.white).fontSize(14)
       .text('See Amelia handle your next patient inquiry — live.', M, footerY + 16, { width: W - M * 2, align: 'center' });
    useReg(doc);
    doc.fillColor('rgba(255,255,255,0.7)').fontSize(8.5)
       .text('White-glove onboarding  ·  Month-to-month  ·  Cancel anytime  ·  Live in 48 hours', M, footerY + 36, { width: W - M * 2, align: 'center' });

    // CTA button (with clickable link)
    const btnW = 300, btnH = 38, btnX = (W - btnW) / 2, btnY = footerY + 54;
    doc.roundedRect(btnX, btnY, btnW, btnH, 10).fill(C.white);
    // Shadow effect (darker rect behind)
    doc.save().opacity(0.15).roundedRect(btnX + 2, btnY + 3, btnW, btnH, 10).fill(C.ink).restore();
    doc.roundedRect(btnX, btnY, btnW, btnH, 10).fill(C.white);
    useBold(doc);
    doc.fillColor(C.purple).fontSize(12).text('Book Your Free Demo  →', btnX, btnY + 12, { width: btnW, align: 'center' });
    doc.link(btnX, btnY, btnW, btnH, BOOKING_URL);

    useReg(doc);
    doc.fillColor('rgba(255,255,255,0.55)').fontSize(7.5)
       .text(BOOKING_DISPLAY, M, btnY + 46, { width: W - M * 2, align: 'center' });

    // Fine print
    useReg(doc);
    doc.fillColor('rgba(255,255,255,0.35)').fontSize(6)
       .text(
         `Confidential  ·  Prepared exclusively for ${lead.businessName}  ·  © ${new Date().getFullYear()} Amelia AI`,
         M, PH - 14, { width: W - M * 2, align: 'center' }
       );

    doc.end();
  });
}

// ─── Instantly lead update ────────────────────────────────────────────────────
async function updateInstantlyLeadLink(email, driveLink) {
  const KEY  = process.env.INSTANTLY_API_KEY;
  const BASE = 'https://api.instantly.ai/api/v2';
  const H    = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

  try {
    // Find lead by email
    const res = await axios.get(`${BASE}/leads`, { headers: H, params: { email, limit: 1 } });
    const lead = res.data?.items?.[0];
    if (!lead) return false;

    await axios.patch(`${BASE}/leads/${lead.id}`, {
      variables: { audit_link: driveLink }
    }, { headers: H });
    return true;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 Generating + uploading audit reports to Google Drive\n');

  // Load data
  const auditFiles = fs.readdirSync('.').filter(f => f.startsWith('sms-audit-')).sort().reverse();
  const leadsFiles = fs.readdirSync('.').filter(f => f.startsWith('medspa-leads-')).sort().reverse();
  if (!auditFiles.length) { console.error('❌ No sms-audit file'); process.exit(1); }

  const auditFile  = auditFiles[0];
  const rawEntries = JSON.parse(fs.readFileSync(auditFile, 'utf8'));

  const leadsMap = {};
  if (leadsFiles.length) {
    JSON.parse(fs.readFileSync(leadsFiles[0], 'utf8')).forEach(l => {
      const k = (l.phone || '').replace(/\D/g, '');
      if (k) leadsMap[k] = l;
    });
  }

  // Google Drive setup
  const auth  = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const folderId = await getOrCreateFolder(drive, DRIVE_FOLDER);
  console.log(`📁 Drive folder: "${DRIVE_FOLDER}"\n`);

  fs.mkdirSync(AUDITS_DIR, { recursive: true });

  let done = 0, skipped = 0;
  const linkMap = {};

  for (const entry of rawEntries) {
    const phone = (entry.lead?.phone || '').replace(/\D/g, '');
    const match = leadsMap[phone] || {};
    const email = entry.lead?.email || match.email;
    if (!email) { skipped++; continue; }

    const name = entry.lead.name;
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const pdfPath = path.join(AUDITS_DIR, `${slug}.pdf`);

    const leadData = {
      businessName:      name,
      city:              entry.lead.city || match.city || '',
      phone:             entry.lead.phone || match.phone || '',
      website:           match.website || entry.lead.website || '',
      instagram:         match.instagram ? `@${match.instagram.replace(/^@/, '')}` : '',
      googleRating:      match.rating   || entry.lead.rating   || null,
      googleReviews:     match.reviews  || entry.lead.reviews  || null,
      responseTimeHours: entry.responseTimeHours ?? null,
    };

    process.stdout.write(`  📄 ${name}...`);
    try {
      await generatePDF(leadData, pdfPath);
      const driveLink = await uploadPDF(drive, folderId, `${slug}-audit.pdf`, pdfPath);
      linkMap[slug] = driveLink;

      // Update entry in audit JSON
      entry.audit_link = driveLink;

      // Try to update Instantly lead
      const updated = await updateInstantlyLeadLink(email, driveLink);
      console.log(` ✅ ${updated ? '(Instantly updated)' : ''}\n     ${driveLink}`);
      done++;
    } catch(e) {
      console.log(` ❌ ${e.message}`);
    }
  }

  // Save updated audit JSON
  fs.writeFileSync(auditFile, JSON.stringify(rawEntries, null, 2));

  // Save link map
  fs.writeFileSync('audit-drive-links.json', JSON.stringify(linkMap, null, 2));

  console.log(`\n─────────────────────────────────────────────────`);
  console.log(`✅ Done — ${done} reports uploaded, ${skipped} skipped (no email)`);
  console.log(`📂 All PDFs local: ./audits/`);
  console.log(`☁️  All links: audit-drive-links.json`);
  console.log(`📝 Audit JSON updated with real Drive links`);
  console.log(`\n⚠️  If Instantly variables didn't update automatically,`);
  console.log(`   re-run: node setup-instantly-campaigns.js\n`);
}

main().catch(console.error);
