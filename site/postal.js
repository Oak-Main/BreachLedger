'use strict';
// One publisher address for the whole site (decided Nov 10 2026: BreachLedger
// shows the San Diego address everywhere). legal/legal.config.json is the only
// place it is written; ue.config.js, /about, /privacy and /sources read it here.
const fs = require('fs');
const path = require('path');

const LEGAL_CONFIG = path.join(__dirname, '..', 'legal', 'legal.config.json');

function legalPostalAddress(file = LEGAL_CONFIG) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).postal_address;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('{{')) {
    throw new Error(`legal.config.json postal_address is not set: ${JSON.stringify(value)}`);
  }
  return value.trim();
}

// "1223 Cleveland Ave, Suite 200, San Diego, CA 92103" ->
// { streetAddress: "1223 Cleveland Ave, Suite 200", addressLocality: "San Diego",
//   addressRegion: "CA", postalCode: "92103" }
function parseUsAddress(address) {
  const m = /^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(address);
  if (!m) throw new Error(`cannot parse US postal address: ${address}`);
  return { streetAddress: m[1].trim(), addressLocality: m[2].trim(), addressRegion: m[3], postalCode: m[4] };
}

// Docs carry the {{POSTAL_ADDRESS}} token instead of an address.
function fillPostalAddress(text, address = legalPostalAddress()) {
  return text.split('{{POSTAL_ADDRESS}}').join(address);
}

module.exports = { legalPostalAddress, parseUsAddress, fillPostalAddress, LEGAL_CONFIG };
