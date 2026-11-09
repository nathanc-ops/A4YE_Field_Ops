'use strict';
// Address lookup for the customer/location forms.
//  - Google Places API (New), when a key is set (Settings → Address lookup, or GOOGLE_MAPS_API_KEY):
//    type-ahead suggestions, then details (street/city/state/ZIP + coordinates) for the one picked.
//    The key stays on the server; the browser never sees it.
//  - Otherwise the free US Census geocoder: no key, US only, needs a fairly complete address
//    (house number + street, ideally city or ZIP), returns standardized matches with coordinates.

const TIMEOUT = 8000;
const titleCase = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
  .replace(/\b(Ne|Nw|Se|Sw|Po)\b/g, m => m.toUpperCase()).replace(/(\d)(St|Nd|Rd|Th)\b/g, (m, d, x) => d + x.toLowerCase());

async function getJSON(url, opts = {}) {
  let r;
  try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) }); }
  catch { const e = new Error("Can't reach the address lookup service right now. Type the address in and use Map ↗ to check it."); e.status = 502; throw e; }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!r.ok) {
    const msg = (data && data.error && (data.error.message || data.error.status)) || `HTTP ${r.status}`;
    const e = new Error(`Address lookup failed: ${msg}`); e.status = 502; throw e;
  }
  return data;
}

// ------------------------------------------------------------ Google Places (New)
async function googleSuggest(key, q, session) {
  const d = await getJSON('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({ input: q, includedRegionCodes: ['us'], ...(session ? { sessionToken: session } : {}) }),
  });
  return (d && d.suggestions || []).filter(s => s.placePrediction).slice(0, 6).map(({ placePrediction: p }) => ({
    id: p.placeId,
    text: p.text && p.text.text,
    main: p.structuredFormat && p.structuredFormat.mainText ? p.structuredFormat.mainText.text : p.text && p.text.text,
    secondary: p.structuredFormat && p.structuredFormat.secondaryText ? p.structuredFormat.secondaryText.text : '',
  }));
}
function fromGoogleComponents(d) {
  const part = (type, short) => { const c = (d.addressComponents || []).find(x => x.types && x.types.includes(type)); return c ? (short ? c.shortText : c.longText) : ''; };
  const street = [part('street_number'), part('route', true) || part('route')].filter(Boolean).join(' ');
  const unit = part('subpremise');
  return {
    address: (street || (d.formattedAddress || '').split(',')[0]) + (unit ? ` #${unit}` : ''),
    city: part('locality') || part('postal_town') || part('sublocality') || part('administrative_area_level_3'),
    state: part('administrative_area_level_1', true),
    zip: part('postal_code'),
    lat: d.location ? d.location.latitude : null, lng: d.location ? d.location.longitude : null,
    formatted: d.formattedAddress || '', provider: 'google',
  };
}
async function googleDetails(key, id, session) {
  if (!/^[A-Za-z0-9_-]{10,300}$/.test(String(id || ''))) { const e = new Error('Bad place id'); e.status = 400; throw e; }
  const d = await getJSON(`https://places.googleapis.com/v1/places/${id}${session ? `?sessionToken=${encodeURIComponent(session)}` : ''}`, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'addressComponents,formattedAddress,location' },
  });
  return fromGoogleComponents(d);
}

// ------------------------------------------------------------ US Census geocoder (free, no key)
async function censusSuggest(q) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' + new URLSearchParams({ address: q, benchmark: 'Public_AR_Current', format: 'json' });
  const d = await getJSON(url);
  const matches = (d && d.result && d.result.addressMatches) || [];
  return matches.slice(0, 6).map(m => {
    const [street, city, state, zip] = String(m.matchedAddress || '').split(',').map(x => x.trim());
    const a = { address: titleCase(street), city: titleCase(city), state: (state || '').toUpperCase(), zip: zip || '',
      lat: m.coordinates ? m.coordinates.y : null, lng: m.coordinates ? m.coordinates.x : null, provider: 'census' };
    return { ...a, main: a.address, secondary: [a.city, a.state, a.zip].filter(Boolean).join(', ') };
  });
}

function keyFrom(settings) { return (settings.google_maps_api_key || process.env.GOOGLE_MAPS_API_KEY || '').trim(); }

async function suggest(settings, q, session) {
  q = String(q || '').trim().slice(0, 200);
  const key = keyFrom(settings);
  if (q.length < 4) return { provider: key ? 'google' : 'census', results: [] };
  if (key) return { provider: 'google', results: await googleSuggest(key, q, session) };
  // the Census matcher needs a house number and a street name; don't hammer it with partial words
  if (!/\d+\s+\S{2,}/.test(q)) return { provider: 'census', results: [] };
  return { provider: 'census', results: await censusSuggest(q) };
}
async function details(settings, id, session) {
  const key = keyFrom(settings);
  if (!key) { const e = new Error('Google Maps key is not set'); e.status = 400; throw e; }
  return googleDetails(key, id, session);
}

module.exports = { suggest, details, fromGoogleComponents, titleCase };
