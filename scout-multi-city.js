require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const cheerio = require('cheerio');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const CITIES = ['Austin', 'Denver', 'Nashville', 'Charlotte'];

if (!API_KEY) {
  console.error('Error: GOOGLE_MAPS_API_KEY not found in .env file');
  process.exit(1);
}

const GEOCODING_API = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_API = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const PLACE_DETAILS_API = 'https://maps.googleapis.com/maps/api/place/details/json';

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Content-Type': 'application/json',
  'Version': '2021-07-28'
};

async function getCoordinates(city) {
  try {
    const response = await axios.get(GEOCODING_API, {
      params: { address: city, key: API_KEY }
    });
    if (response.data.results.length === 0) throw new Error(`City "${city}" not found`);
    return response.data.results[0].geometry.location;
  } catch (error) {
    console.error(`❌ Geocoding error for ${city}:`, error.message);
    return null;
  }
}

async function searchMedicalSpas(city, location) {
  const leads = [];
  let nextPageToken = null;
  let pageCount = 0;

  try {
    do {
      const params = {
        location: `${location.lat},${location.lng}`,
        radius: 15000,
        keyword: 'medical spa',
        key: API_KEY
      };
      if (nextPageToken) params.pagetoken = nextPageToken;

      const response = await axios.get(PLACES_API, { params });

      if (response.data.results) {
        for (const place of response.data.results) {
          const rating = place.rating || 0;
          const reviewCount = place.user_ratings_total || 0;
          if (rating < 4.5 || reviewCount < 20) {
            leads.push({
              placeId: place.place_id,
              name: place.name,
              city,
              rating,
              reviews: reviewCount,
              types: place.types,
              fetched: false
            });
          }
        }
      }

      nextPageToken = response.data.next_page_token || null;
      if (nextPageToken) await new Promise(resolve => setTimeout(resolve, 2000));
      pageCount++;
    } while (nextPageToken && pageCount < 3);

    return leads;
  } catch (error) {
    console.error(`❌ Search error for ${city}:`, error.message);
    return [];
  }
}

async function getPlaceDetails(placeId) {
  try {
    const response = await axios.get(PLACE_DETAILS_API, {
      params: {
        place_id: placeId,
        fields: 'name,formatted_address,formatted_phone_number,website,opening_hours,url,rating,user_ratings_total',
        key: API_KEY
      }
    });
    const result = response.data.result;
    return {
      name: result.name,
      address: result.formatted_address,
      phone: result.formatted_phone_number || 'N/A',
      website: result.website || 'N/A',
      hours: result.opening_hours?.weekday_text || [],
      gmaps_url: result.url,
      rating: result.rating || 0,
      reviews: result.user_ratings_total || 0
    };
  } catch (error) {
    return null;
  }
}

async function scrapeEmail(websiteUrl) {
  if (!websiteUrl || websiteUrl === 'N/A') return null;
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    // Match emails, exclude common false positives
    const matches = res.data.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
    const filtered = matches.filter(e =>
      !e.includes('sentry') && !e.includes('example') &&
      !e.includes('wix') && !e.includes('wordpress') &&
      !e.includes('png') && !e.includes('jpg') && !e.includes('svg')
    );
    return filtered[0] || null;
  } catch {
    return null;
  }
}

async function scrapeInstagram(websiteUrl) {
  if (!websiteUrl || websiteUrl === 'N/A') return null;
  try {
    const res = await axios.get(websiteUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    const $ = cheerio.load(res.data);

    // Look for instagram.com links in the page
    let handle = null;
    $('a[href*="instagram.com"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
      if (match && match[1] && !['p', 'reel', 'explore', 'share'].includes(match[1])) {
        handle = match[1].replace(/\/$/, '');
        return false; // break
      }
    });

    // Also check meta tags and page text
    if (!handle) {
      const html = res.data;
      const match = html.match(/instagram\.com\/([A-Za-z0-9_.]{3,30})[/"']/);
      if (match && match[1] && !['p', 'reel', 'explore', 'share', 'accounts'].includes(match[1])) {
        handle = match[1];
      }
    }

    return handle ? `@${handle}` : null;
  } catch {
    return null;
  }
}

async function pushToGHL(lead) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return null;

  const phone = lead.phone.replace(/\D/g, '');
  if (!phone || phone === 'NA') return null;

  try {
    const payload = {
      locationId: GHL_LOCATION_ID,
      firstName: lead.name,
      companyName: lead.name,
      phone: `+1${phone}`,
      address1: lead.address,
      city: lead.city,
      source: 'Scout Agent',
      tags: ['medspa-lead', 'audit-prospect', lead.city.toLowerCase().replace(/\s/g, '-')],
      customFields: [
        { key: 'website', value: lead.website },
        { key: 'google_rating', value: String(lead.rating) },
        { key: 'google_reviews', value: String(lead.reviews) },
        { key: 'google_maps_url', value: lead.gmaps_url || '' }
      ]
    };

    const response = await axios.post(`${GHL_BASE_URL}/contacts/`, payload, { headers: GHL_HEADERS });
    return response.data?.contact?.id || null;
  } catch (error) {
    // Skip duplicates silently, log other errors
    if (error.response?.status !== 422) {
      console.error(`   GHL error for ${lead.name}: ${error.response?.data?.message || error.message}`);
    }
    return null;
  }
}

async function main() {
  console.log(`\n🎯 Scout Agent - Multi-City Medical Spa Finder`);
  console.log(`📍 Cities: ${CITIES.join(', ')}`);
  if (GHL_API_KEY) console.log(`🔗 GHL sync: enabled (location: ${GHL_LOCATION_ID})`);
  console.log('─'.repeat(60));

  const allLeads = [];
  let ghlCreated = 0;

  for (const city of CITIES) {
    console.log(`\n🔍 Searching ${city}...`);

    const location = await getCoordinates(city);
    if (!location) continue;

    const leads = await searchMedicalSpas(city, location);
    console.log(`   ✓ Found ${leads.length} underserved spas`);

    console.log(`   📋 Fetching details + syncing to GHL...`);
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      process.stdout.write(`\r   [${i + 1}/${leads.length}]`);

      const details = await getPlaceDetails(lead.placeId);
      if (details) {
        const fullLead = { ...lead, ...details, fetched: true };

        // Scrape email and Instagram from website
        const [email, instagram] = await Promise.all([
          scrapeEmail(details.website),
          scrapeInstagram(details.website)
        ]);
        if (email) fullLead.email = email;
        if (instagram) fullLead.instagram = instagram;

        // Push to GHL
        const ghlId = await pushToGHL(fullLead);
        if (ghlId) {
          fullLead.ghlContactId = ghlId;
          ghlCreated++;
        }

        allLeads.push(fullLead);
      }

      if ((i + 1) % 5 === 0) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`\r   ✓ Processed ${leads.length} leads             `);
  }

  const outputFile = `medspa-leads-multi-city-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(outputFile, JSON.stringify(allLeads, null, 2));

  console.log(`\n💾 Leads saved to: ${outputFile}`);
  console.log(`\n📊 Summary:`);
  console.log(`   Total leads: ${allLeads.length}`);
  console.log(`   Avg rating: ${(allLeads.reduce((sum, l) => sum + l.rating, 0) / allLeads.length).toFixed(2)}`);
  console.log(`   Avg reviews: ${(allLeads.reduce((sum, l) => sum + l.reviews, 0) / allLeads.length).toFixed(0)}`);
  if (GHL_API_KEY) console.log(`   GHL contacts created: ${ghlCreated}`);

  const cityCounts = {};
  allLeads.forEach(l => { cityCounts[l.city] = (cityCounts[l.city] || 0) + 1; });
  console.log(`   By city:`, Object.entries(cityCounts).map(([city, count]) => `${city} (${count})`).join(', '));
  console.log();
}

main().catch(console.error);
