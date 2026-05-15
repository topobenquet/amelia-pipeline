const fs = require('fs');

const leadsFile = 'medspa-leads-austin-2026-05-14.json';
const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));

// Create CSV header
const headers = ['Name', 'Rating', 'Reviews', 'Address', 'Phone', 'Website', 'Google Maps', 'Hours'];
const rows = [headers];

// Add each lead as a row
for (const lead of leads) {
  rows.push([
    lead.name,
    lead.rating,
    lead.reviews,
    lead.address,
    lead.phone,
    lead.website,
    lead.gmaps_url,
    lead.hours.join('; ')
  ]);
}

// Write CSV file
const csvContent = rows.map(row =>
  row.map(cell => {
    // Escape cells that contain commas or quotes
    if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"'))) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  }).join(',')
).join('\n');

const csvFile = 'medspa-leads-austin.csv';
fs.writeFileSync(csvFile, csvContent);

console.log(`✓ CSV exported to: ${csvFile}`);
console.log(`✓ Rows: ${rows.length - 1} leads`);
console.log('\n📋 To import into Google Sheets:');
console.log('1. Open your Google Sheet');
console.log('2. Click "File" → "Import" → "Upload"');
console.log(`3. Select ${csvFile}`);
console.log('4. Choose "Replace current sheet" and click "Import"');
