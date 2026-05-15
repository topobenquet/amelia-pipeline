require('dotenv').config();
const fs    = require('fs');
const axios = require('axios');

const KEY  = process.env.INSTANTLY_API_KEY;
const BASE = 'https://api.instantly.ai/api/v2';
const H    = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// ─── Email sequences per bucket ───────────────────────────────────────────────
const SEQUENCES = {

  no_reply: [
    {
      subject: '{{business_name}} — we tested your response system',
      body: `Hi,

I reached out to {{business_name}} by text yesterday — asked about Botox pricing and whether I could book a consultation.

I never heard back.

I'm not a real patient. I'm Juan, and I run AI automation for med spas. That message was a mystery shopper test — and honestly, the result wasn't surprising. Most med spas in {{city}} have the same gap.

I put together a one-page audit of exactly what a real client experiences when they contact {{business_name}}. It shows response time benchmarks, estimated leads lost per month, and what the revenue impact looks like.

You can see it here: {{audit_link}}

No strings. Just thought you'd want to know.

Juan Benquet
AI Receptionist for Med Spas · Amelia AI
clinics.amelia.im`,
      delay: 0
    },
    {
      subject: 'the $51k problem most {{city}} med spas don\'t know they have',
      body: `Hi,

Quick follow-up on the audit I sent over for {{business_name}}.

Here's the math that surprised us:

  · Unanswered inquiries per month: ~12
  · Average new client value: $1,200/year
  · Close rate if responded within 5 min: 30%
  · Monthly revenue walking out the door: $4,320
  · Annually: {{revenue_lost}}

That's not a marketing problem. It's a response time problem.

Amelia — our AI receptionist — responds to every SMS, Instagram DM, and missed call in under 60 seconds. Books directly into your calendar. Works nights and weekends.

Worth a 15-minute look? clinics.amelia.im/widget/booking/amelia-sales-call

Juan`,
      delay: 4
    },
    {
      subject: 'last note for {{business_name}}',
      body: `Hi,

Last email, I promise.

You have {{reviews}} Google reviews at {{rating}} stars. That tells me you do great work. The clients who find you love you.

The problem is the ones who never become clients — because they texted, didn't hear back, and booked somewhere else.

Amelia handles that gap. One flat monthly fee, no contracts, live in 48 hours.

If the timing is ever right: clinics.amelia.im/widget/booking/amelia-sales-call

Rooting for you,
Juan`,
      delay: 5
    }
  ],

  slow_reply: [
    {
      subject: '{{business_name}} — your response time vs. the competition',
      body: `Hi,

Yesterday I sent {{business_name}} a text asking about Botox pricing — as a mystery shopper test.

You responded in about {{response_time}}. Honestly, that's better than most med spas in {{city}}.

But here's what the data shows: leads that don't hear back within 5 minutes are 21× less likely to convert. During those {{response_time}}, that lead is texting 2–3 other places. Whoever replies first usually wins the booking.

I put together a quick audit showing exactly where {{business_name}} stands: {{audit_link}}

No agenda — just thought you'd find it useful.

Juan Benquet · Amelia AI`,
      delay: 0
    },
    {
      subject: 'what if you responded to every inquiry in 60 seconds?',
      body: `Hi,

Following up on the audit I shared for {{business_name}}.

Picture this: a potential client texts at 8pm on a Friday asking about a facial package. Your team is off. Right now, that lead waits until Monday — if they don't book somewhere else first.

With Amelia, they get a reply in 60 seconds. A real conversation. A booking confirmed before they close the app.

Setup takes 48 hours. One flat monthly fee. No contracts.

Want to see it live? clinics.amelia.im/widget/booking/amelia-sales-call

Juan`,
      delay: 4
    },
    {
      subject: 'one thing before I stop bugging you — {{business_name}}',
      body: `Hi,

Last one.

You responded to our test in {{response_time}} — that puts you ahead of 60% of med spas in {{city}}.

Imagine being in the top 1%: responding instantly, 24/7, without hiring anyone new. That's what Amelia does.

clinics.amelia.im/widget/booking/amelia-sales-call

Juan`,
      delay: 5
    }
  ],

  fast_reply: [
    {
      subject: '{{business_name}} — you passed the test 👏',
      body: `Hi,

I sent {{business_name}} a mystery shopper text yesterday — asked about Botox pricing and availability.

You responded in {{response_time}}. That puts you in the top 20% of med spas we've tested in {{city}}. Genuinely impressive.

Here's the thing: even at that speed, there's a gap. Nights, weekends, when your team is with clients — those inquiries still wait.

I put together a short audit that shows the full picture: {{audit_link}}

Not a hard sell — just curious whether "instant, 24/7" would move the needle for a practice that's already doing well.

Juan Benquet · Amelia AI`,
      delay: 0
    },
    {
      subject: 'what good looks like vs. what great looks like',
      body: `Hi,

Quick follow-up on the {{business_name}} audit.

Good: responding to patient inquiries within {{response_time}}.
Great: responding to every single one in under 60 seconds — including the ones that come in at 11pm or during a packed treatment day.

Amelia bridges that gap. Not replacing your team — covering the hours and moments they can't.

15 minutes to see it live: clinics.amelia.im/widget/booking/amelia-sales-call

Juan`,
      delay: 4
    },
    {
      subject: 'final note — {{business_name}}',
      body: `Hi,

You're already ahead of the competition in {{city}}. This is my last note.

If you ever want to explore what "always on" patient communication looks like for {{business_name}}, I'm one link away:

clinics.amelia.im/widget/booking/amelia-sales-call

Keep doing what you're doing.

Juan`,
      delay: 5
    }
  ]
};

const CAMPAIGN_NAMES = {
  no_reply:   'Amelia Audit — A: No Reply',
  slow_reply: 'Amelia Audit — B: Slow Reply (4–24h)',
  fast_reply: 'Amelia Audit — C: Fast Reply (<4h)',
};

async function createCampaign(bucket) {
  const steps = SEQUENCES[bucket].map((email, i) => ({
    type: 'email',
    delay: email.delay,
    delay_unit: 'days',
    variants: [{ subject: email.subject, body: email.body }]
  }));

  const payload = {
    name: CAMPAIGN_NAMES[bucket],
    campaign_schedule: {
      schedules: [{
        name: 'Weekdays',
        timing: { from: '00:00', to: '23:59' },
        days: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false },
        timezone: 'Etc/GMT+12'
      }]
    },
    sequences: [{ steps }],
    daily_limit: 30,
    stop_on_reply: true,
    open_tracking: true,
    prioritize_new_leads: true,
  };

  const res = await axios.post(`${BASE}/campaigns`, payload, { headers: H });
  return res.data;
}

async function addLeadsToCampaign(campaignId, leads) {
  if (!leads.length) return 0;

  let added = 0;
  for (const l of leads) {
    try {
      await axios.post(`${BASE}/leads`, {
        campaign_id:   campaignId,
        email:         l.email,
        first_name:    '',
        company_name:  l.business_name,
        website:       l.website,
        personalization: l.audit_link,
        variables: {
          business_name: l.business_name,
          city:          l.city,
          phone:         l.phone,
          website:       l.website,
          ig_handle:     l.ig_handle,
          rating:        l.rating,
          reviews:       l.reviews,
          response_time: l.response_time,
          revenue_lost:  l.revenue_lost,
          audit_link:    l.audit_link,
        }
      }, { headers: H });
      added++;
    } catch(e) {
      console.warn(`\n   ⚠️  Skipped ${l.email}: ${e.response?.data?.message || e.message}`);
    }
  }
  return added;
}

async function main() {
  console.log('\n🚀 Setting up Instantly campaigns + uploading leads\n');

  // Load + merge data
  const auditFiles  = fs.readdirSync('.').filter(f => f.startsWith('sms-audit-')).sort().reverse();
  const leadsFiles  = fs.readdirSync('.').filter(f => f.startsWith('medspa-leads-')).sort().reverse();

  if (!auditFiles.length) { console.error('❌ No audit file'); process.exit(1); }

  const rawEntries = JSON.parse(fs.readFileSync(auditFiles[0], 'utf8'));
  const leadsMap   = {};
  if (leadsFiles.length) {
    JSON.parse(fs.readFileSync(leadsFiles[0], 'utf8')).forEach(l => {
      const k = (l.phone || '').replace(/\D/g, '');
      if (k) leadsMap[k] = l;
    });
  }

  const AUDIT_LINK_BASE = 'https://clinics.amelia.im/audit/';

  function bucket(entry) {
    if (entry.status !== 'responded') return 'no_reply';
    return entry.responseTimeHours <= 4 ? 'fast_reply' : 'slow_reply';
  }

  function formatHours(h) {
    if (!h) return 'over 24 hours';
    if (h < 1) return `${Math.round(h * 60)} minutes`;
    return h === 1 ? '1 hour' : `${Math.round(h)} hours`;
  }

  // Segment leads
  const segments = { no_reply: [], slow_reply: [], fast_reply: [] };

  for (const entry of rawEntries) {
    const phone = (entry.lead?.phone || '').replace(/\D/g, '');
    const match = leadsMap[phone] || {};
    const email = entry.lead?.email || match.email;
    if (!email) continue;

    const name  = entry.lead.name;
    const slug  = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const hours = entry.responseTimeHours;

    segments[bucket(entry)].push({
      email,
      business_name: name,
      city:          entry.lead.city || match.city || '',
      phone:         entry.lead.phone || match.phone || '',
      website:       match.website || entry.lead.website || '',
      ig_handle:     match.instagram || entry.lead.instagram || '',
      rating:        String(match.rating || entry.lead.rating || ''),
      reviews:       String(match.reviews || entry.lead.reviews || ''),
      response_time: formatHours(hours),
      revenue_lost:  !hours || hours > 8 ? '$51,840/yr' : hours > 4 ? '$38,400/yr' : '$24,000/yr',
      audit_link:    AUDIT_LINK_BASE + slug,
    });
  }

  // Load existing campaign IDs if already created
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync('instantly-campaigns.json', 'utf8')); } catch {}

  // Fetch remote campaigns to find any already created by name
  let remoteCampaigns = [];
  try {
    const r = await axios.get(`${BASE}/campaigns`, { headers: H, params: { limit: 50 } });
    remoteCampaigns = r.data.items || [];
  } catch {}

  // Create campaigns + upload leads
  const results = { ...existing };
  for (const [b, leads] of Object.entries(segments)) {
    process.stdout.write(`\n📋 ${CAMPAIGN_NAMES[b]}...`);

    try {
      // Reuse existing campaign if found by name
      const found = remoteCampaigns.find(c => c.name === CAMPAIGN_NAMES[b]);
      const campaign = found || await createCampaign(b);
      if (found) process.stdout.write(' (existing)');

      const added = await addLeadsToCampaign(campaign.id, leads);
      results[b]  = { id: campaign.id, name: campaign.name || CAMPAIGN_NAMES[b], leads: added };
      console.log(` ✅ (${added} leads)`);
    } catch(e) {
      console.log(` ❌ ${e.response?.data?.message || e.message}`);
    }
  }

  // Save campaign IDs
  fs.writeFileSync('instantly-campaigns.json', JSON.stringify(results, null, 2));

  console.log('\n─────────────────────────────────────────────────');
  console.log('\n✅ All done! Campaign IDs saved to instantly-campaigns.json');
  console.log('\n⚠️  NEXT STEP — Connect your sending email in Instantly:');
  console.log('   1. Instantly → Settings → Email Accounts → Add Account');
  console.log('   2. Use a domain separate from amelia.im (e.g. getamelia.co)');
  console.log('   3. Configure SPF + DKIM + DMARC on that domain');
  console.log('   4. Let it warm for 14 days before activating campaigns');
  console.log('   5. Then: Instantly → Campaigns → select each → Add Sending Account → Launch\n');
}

module.exports = { SEQUENCES, CAMPAIGN_NAMES };

if (require.main === module) {
  main().catch(console.error);
}
