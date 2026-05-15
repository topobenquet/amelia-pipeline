require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const CITY = process.env.CITY || 'Austin';

if (!API_KEY) {
  console.error('Error: GOOGLE_MAPS_API_KEY not found in .env file');
  process.exit(1);
}

const GEOCODING_API = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_API = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const PLACE_DETAILS_API = 'https://maps.googleapis.com/maps/api/place/details/json';

async function getCoordinates(city) {
  try {
    const response = await axios.get(GEOCODING_API, {
      params: {
        address: city,
        key: API_KEY
      }
    });

    if (response.data.results.length === 0) {
      throw new Error(`City "${city}" not found`);
    }

    const location = response.data.results[0].geometry.location;
    console.log(`✓ Found ${city}: ${location.lat}, ${location.lng}`);
    return location;
  } catch (error) {
    console.error('Geocoding error:', error.message);
    process.exit(1);
  }
}

async function searchMedicalSpas(location) {
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

      if (nextPageToken) {
        params.pagetoken = nextPageToken;
      }

      const response = await axios.get(PLACES_API, { params });

      if (response.data.results) {
        console.log(`\nPage ${pageCount + 1}: Found ${response.data.results.length} results`);

        for (const place of response.data.results) {
          const rating = place.rating || 0;
          const reviewCount = place.user_ratings_total || 0;

          if (rating < 4.5 || reviewCount < 20) {
            leads.push({
              placeId: place.place_id,
              name: place.name,
              rating: rating,
              reviews: reviewCount,
              types: place.types,
              fetched: false
            });
          }
        }
      }

      nextPageToken = response.data.next_page_token || null;

      if (nextPageToken) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      pageCount++;
    } while (nextPageToken && pageCount < 3);

    return leads;
  } catch (error) {
    console.error('Search error:', error.message);
    process.exit(1);
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
    console.error(`Error fetching details for ${placeId}:`, error.message);
    return null;
  }
}

async function main() {
  console.log(`\n🎯 Scout Agent - Medical Spa Finder`);
  console.log(`📍 City: ${CITY}`);
  console.log(`🔑 API Key: ${API_KEY.substring(0, 10)}...`);
  console.log('─'.repeat(50));

  const location = await getCoordinates(CITY);
  console.log('\n🔍 Searching for medical spas...');

  let leads = await searchMedicalSpas(location);
  console.log(`\n✓ Found ${leads.length} underserved medical spas (rating < 4.5 or < 20 reviews)`);

  console.log('\n📋 Fetching detailed information...');
  const detailedLeads = [];

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    process.stdout.write(`\r  [${i + 1}/${leads.length}] Fetching details...`);

    const details = await getPlaceDetails(lead.placeId);
    if (details) {
      detailedLeads.push({
        ...lead,
        ...details,
        fetched: true
      });
    }

    if ((i + 1) % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`\n\n✓ Successfully fetched ${detailedLeads.length} detailed leads`);

  const outputFile = `medspa-leads-${CITY.toLowerCase()}-${new Date().toISOString().split('T')[0]}.json`;
  fs.writeFileSync(outputFile, JSON.stringify(detailedLeads, null, 2));

  console.log(`\n💾 Leads saved to: ${outputFile}`);
  console.log(`\n📊 Summary:`);
  console.log(`   Total leads: ${detailedLeads.length}`);
  console.log(`   Avg rating: ${(detailedLeads.reduce((sum, l) => sum + l.rating, 0) / detailedLeads.length).toFixed(2)}`);
  console.log(`   Avg reviews: ${(detailedLeads.reduce((sum, l) => sum + l.reviews, 0) / detailedLeads.length).toFixed(0)}`);
}

main().catch(console.error);
