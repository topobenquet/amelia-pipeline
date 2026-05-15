require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const AUDIT_LINK_BASE = 'https://clinics.amelia.im/audit/'; // placeholder — replace with real hosted URL
const BOOKING_LINK    = 'clinics.amelia.im/widget/booking/amelia-sales-call';

// ─── Load audit data ──────────────────────────────────────────────────────────
const auditFiles = fs.readdirSync('.').filter(f => f.startsWith('sms-audit-')).sort().reverse();
if (!auditFiles.length) {
  console.error('❌ No sms-audit file found. Run mystery-texter.js + response-checker.js first.');
  process.exit(1);
}
const auditFile = auditFiles[0];
const rawEntries = JSON.parse(fs.readFileSync(auditFile, 'utf8'));

// Cross-reference with leads file to pull emails + instagram
const leadsFiles = fs.readdirSync('.').filter(f => f.startsWith('medspa-leads-')).sort().reverse();
const leadsMap   = {};
if (leadsFiles.length) {
  const leads = JSON.parse(fs.readFileSync(leadsFiles[0], 'utf8'));
  leads.forEach(l => {
    const key = (l.phone || '').replace(/\D/g, '');
    if (key) leadsMap[key] = l;
  });
}

// Merge email + instagram into audit entries
const entries = rawEntries.map(entry => {
  const phone = (entry.lead?.phone || '').replace(/\D/g, '');
  const match = leadsMap[phone];
  if (match) {
    entry.lead.email     = entry.lead.email     || match.email     || null;
    entry.lead.instagram = entry.lead.instagram || match.instagram || null;
    entry.lead.rating    = entry.lead.rating    ?? match.rating;
    entry.lead.reviews   = entry.lead.reviews   ?? match.reviews;
  }
  return entry;
});

console.log(`\n📂 Loaded: ${auditFile} (${entries.length} entries)`);
console.log(`📧 Leads with email: ${entries.filter(e => e.lead.email).length}\n`);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function bucket(entry) {
  if (entry.status !== 'responded') return 'no_reply';
  if (entry.responseTimeHours <= 4)  return 'fast_reply';
  return 'slow_reply';
}

function formatHours(h) {
  if (!h) return null;
  if (h < 1)  return `${Math.round(h * 60)} minutes`;
  if (h === 1) return '1 hour';
  return `${Math.round(h)} hours`;
}

function revenueLost(hours) {
  // Harsher estimate for slower responses
  if (!hours) return '$51,840/yr';
  if (hours > 8)  return '$51,840/yr';
  if (hours > 4)  return '$38,400/yr';
  if (hours > 1)  return '$24,000/yr';
  return '$12,000/yr';
}

function escapeCSV(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toRow(entry, fields) {
  return fields.map(f => escapeCSV(entry[f])).join(',');
}

// ─── Build rows ───────────────────────────────────────────────────────────────
const buckets = { no_reply: [], slow_reply: [], fast_reply: [] };

for (const entry of entries) {
  if (!entry.lead.email) continue; // Instantly needs an email

  const b    = bucket(entry);
  const name = entry.lead.name;
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

  const row = {
    email:          entry.lead.email,
    first_name:     'Hi',                          // neutral opener — we don't know owner name
    business_name:  name,
    city:           entry.lead.city,
    phone:          entry.lead.phone || '',
    website:        entry.lead.website || '',
    ig_handle:      entry.lead.instagram || '',
    rating:         String(entry.lead.rating || ''),
    reviews:        String(entry.lead.reviews || ''),
    response_time:  formatHours(entry.responseTimeHours) || 'over 24 hours',
    revenue_lost:   revenueLost(entry.responseTimeHours),
    audit_link:     AUDIT_LINK_BASE + slug,
    booking_link:   BOOKING_LINK,
    bucket:         b,
  };

  buckets[b].push(row);
}

// ─── Write CSVs ───────────────────────────────────────────────────────────────
const FIELDS = [
  'email', 'first_name', 'business_name', 'city', 'phone',
  'website', 'ig_handle', 'rating', 'reviews',
  'response_time', 'revenue_lost', 'audit_link', 'booking_link'
];

const outDir = path.join(__dirname, 'instantly-exports');
fs.mkdirSync(outDir, { recursive: true });

const BUCKET_LABELS = {
  no_reply:   'Campaign-A-No-Reply',
  slow_reply: 'Campaign-B-Slow-Reply',
  fast_reply: 'Campaign-C-Fast-Reply',
};

let total = 0;
for (const [b, rows] of Object.entries(buckets)) {
  if (!rows.length) {
    console.log(`⚪ ${BUCKET_LABELS[b]}: 0 leads (skipped)`);
    continue;
  }

  const header = FIELDS.join(',');
  const lines  = rows.map(r => toRow(r, FIELDS));
  const csv    = [header, ...lines].join('\n');

  const file = path.join(outDir, `${BUCKET_LABELS[b]}.csv`);
  fs.writeFileSync(file, csv);
  total += rows.length;

  console.log(`✅ ${BUCKET_LABELS[b]}: ${rows.length} leads → ${file}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n📊 Export Summary:`);
console.log(`   Total leads exported: ${total}`);
console.log(`   Leads skipped (no email): ${entries.length - total}`);
console.log(`\n📁 Files saved in: ./instantly-exports/`);
console.log(`\n─────────────────────────────────────────────────`);
console.log(`\n📋 INSTANTLY SETUP CHECKLIST:`);
console.log(`   1. Create 3 campaigns: A (No Reply), B (Slow), C (Fast)`);
console.log(`   2. Import each CSV into its matching campaign`);
console.log(`   3. Paste email templates from instantly-sequences.md`);
console.log(`   4. Set sending schedule: Mon–Fri, 8am–5pm (contact timezone)`);
console.log(`   5. Sending limit: 30 emails/day per inbox while warming`);
console.log(`   6. Enable open tracking + reply detection`);
console.log(`   7. Set campaign to STOP on reply (avoid over-sending)\n`);
