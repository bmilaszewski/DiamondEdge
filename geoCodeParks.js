/**
 * geocodeParks.js
 *
 * Reads parkcode.txt and geocodes every park to lat/lng using the
 * OpenStreetMap Nominatim API (free, no key required).
 *
 * Strategy:
 *   1. Deduplicate by city first — most historical parks share a city,
 *      so we only hit the API once per unique city (~50 calls total).
 *   2. For modern/well-known parks, try the exact park name first for
 *      better precision, then fall back to city-level.
 *   3. Respect Nominatim's 1 req/sec rate limit.
 *
 * Output: park_coordinates.json — keyed by PARKID
 *
 * Usage:
 *   node geocodeParks.js                          (looks for parkcode.txt in same dir)
 *   node geocodeParks.js /path/to/parkcode.txt    (explicit path)
 */

const fs   = require("fs");
const path = require("path");

// ---------------------
// Config
// ---------------------

const PARKCODE_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "parkcode.txt");

const OUTPUT_PATH = path.join(__dirname, "park_coordinates.json");

const RATE_LIMIT_MS = 1100; // slightly over 1s to be safe

// ---------------------
// Helpers
// ---------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// US state abbreviation → full name for better geocoding results
const STATE_NAMES = {
  AL:"Alabama", AK:"Alaska", AZ:"Arizona", AR:"Arkansas", CA:"California",
  CO:"Colorado", CT:"Connecticut", DE:"Delaware", FL:"Florida", GA:"Georgia",
  HI:"Hawaii", ID:"Idaho", IL:"Illinois", IN:"Indiana", IA:"Iowa",
  KS:"Kansas", KY:"Kentucky", LA:"Louisiana", ME:"Maine", MD:"Maryland",
  MA:"Massachusetts", MI:"Michigan", MN:"Minnesota", MS:"Mississippi",
  MO:"Missouri", MT:"Montana", NE:"Nebraska", NV:"Nevada", NH:"New Hampshire",
  NJ:"New Jersey", NM:"New Mexico", NY:"New York", NC:"North Carolina",
  ND:"North Dakota", OH:"Ohio", OK:"Oklahoma", OR:"Oregon", PA:"Pennsylvania",
  RI:"Rhode Island", SC:"South Carolina", SD:"South Dakota", TN:"Tennessee",
  TX:"Texas", UT:"Utah", VT:"Vermont", VA:"Virginia", WA:"Washington",
  WV:"West Virginia", WI:"Wisconsin", WY:"Wyoming",
  // Canadian provinces
  ONT:"Ontario", QUE:"Quebec", BC:"British Columbia",
  // International
  England:"England", JAP:"Japan", Australia:"Australia", MX:"Mexico",
  PR:"Puerto Rico",
};

// Normalize city name quirks that trip up Nominatim
function normalizeCity(city) {
  const overrides = {
    "St. Louis":       "Saint Louis",
    "St. Petersburg":  "Saint Petersburg",
  };
  return overrides[city] || city;
}

// ---------------------
// Parse parkcode.txt
// ---------------------

function parseParkcode(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.trim().split(/\r?\n/);

  // First line is header
  const header = lines[0].split(",").map((h) => h.trim());

  const parks = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // CSV fields — the NOTES field can contain commas inside quotes
    // Simple approach: split on comma but respect quoted fields
    const fields = [];
    let current = "";
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { fields.push(current.trim()); current = ""; }
      else current += ch;
    }
    fields.push(current.trim());

    const park = {};
    header.forEach((h, idx) => { park[h] = fields[idx] || ""; });
    parks.push(park);
  }

  return parks;
}

// ---------------------
// Nominatim geocoder
// ---------------------

async function geocodeByName(name, city, state) {
  const stateName = STATE_NAMES[state] || state;
  const query = `${name}, ${normalizeCity(city)}, ${stateName}`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "MLB-stats-project/1.0 (retrosheet-park-geocoder)" }
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;

  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), method: "name" };
}

async function geocodeByCity(city, state) {
  const stateName = STATE_NAMES[state] || state;
  const query = `${normalizeCity(city)}, ${stateName}`;
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "MLB-stats-project/1.0 (retrosheet-park-geocoder)" }
  });

  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;

  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), method: "city" };
}

// ---------------------
// Main
// ---------------------

async function run() {
  if (!fs.existsSync(PARKCODE_PATH)) {
    console.error(`❌ parkcode.txt not found at: ${PARKCODE_PATH}`);
    console.error(`   Usage: node geocodeParks.js /path/to/parkcode.txt`);
    process.exit(1);
  }

  console.log(`📂 Reading ${PARKCODE_PATH}...`);
  const parks = parseParkcode(PARKCODE_PATH);
  console.log(`   Found ${parks.length} parks\n`);

  // ---------------------
  // Step 1: Deduplicate cities so we minimize API calls
  // key = "CITY|STATE" → { lat, lng }
  // ---------------------

  const cityCache = {};

  // Modern parks (END is blank = still active) — try name lookup for precision
  const modernParks = parks.filter((p) => !p.END || p.END.trim() === "");
  const historicalParks = parks.filter((p) => p.END && p.END.trim() !== "");

  console.log(`🏟️  Modern parks (name lookup): ${modernParks.length}`);
  console.log(`📜 Historical parks (city fallback): ${historicalParks.length}\n`);

  const results = {};

  // ---------------------
  // Step 2: Geocode modern parks by name first
  // ---------------------

  console.log("--- Modern parks (attempting name-level geocoding) ---\n");

  for (const park of modernParks) {
    const cityKey = `${park.CITY}|${park.STATE}`;
    process.stdout.write(`  ${park.PARKID.padEnd(8)} ${park.NAME.substring(0, 35).padEnd(36)} → `);

    try {
      await sleep(RATE_LIMIT_MS);
      let coords = await geocodeByName(park.NAME, park.CITY, park.STATE);

      if (!coords) {
        // Try AKA names
        const akas = park.AKA ? park.AKA.split(";").map((s) => s.trim()) : [];
        for (const aka of akas) {
          await sleep(RATE_LIMIT_MS);
          coords = await geocodeByName(aka, park.CITY, park.STATE);
          if (coords) break;
        }
      }

      if (!coords) {
        // Fall back to city
        await sleep(RATE_LIMIT_MS);
        coords = await geocodeByCity(park.CITY, park.STATE);
      }

      if (coords) {
        results[park.PARKID] = {
          park_id:   park.PARKID,
          name:      park.NAME,
          city:      park.CITY,
          state:     park.STATE,
          lat:       coords.lat,
          lng:       coords.lng,
          method:    coords.method,
          end:       park.END || null,
        };
        cityCache[cityKey] = { lat: coords.lat, lng: coords.lng };
        console.log(`${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}  [${coords.method}]`);
      } else {
        console.log("⚠️  NOT FOUND");
        results[park.PARKID] = {
          park_id: park.PARKID, name: park.NAME,
          city: park.CITY, state: park.STATE,
          lat: null, lng: null, method: "failed", end: park.END || null,
        };
      }
    } catch (err) {
      console.log(`❌ ERROR: ${err.message}`);
    }
  }

  // ---------------------
  // Step 3: Historical parks — city lookup with cache
  // ---------------------

  console.log("\n--- Historical parks (city-level geocoding with cache) ---\n");

  for (const park of historicalParks) {
    const cityKey = `${park.CITY}|${park.STATE}`;
    process.stdout.write(`  ${park.PARKID.padEnd(8)} ${park.NAME.substring(0, 35).padEnd(36)} → `);

    try {
      let coords = null;

      if (cityCache[cityKey]) {
        // Already looked up this city
        coords = { ...cityCache[cityKey], method: "city-cache" };
      } else {
        await sleep(RATE_LIMIT_MS);
        coords = await geocodeByCity(park.CITY, park.STATE);
        if (coords) cityCache[cityKey] = { lat: coords.lat, lng: coords.lng };
      }

      if (coords) {
        results[park.PARKID] = {
          park_id:  park.PARKID,
          name:     park.NAME,
          city:     park.CITY,
          state:    park.STATE,
          lat:      coords.lat,
          lng:      coords.lng,
          method:   coords.method,
          end:      park.END || null,
        };
        console.log(`${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}  [${coords.method}]`);
      } else {
        console.log("⚠️  NOT FOUND");
        results[park.PARKID] = {
          park_id: park.PARKID, name: park.NAME,
          city: park.CITY, state: park.STATE,
          lat: null, lng: null, method: "failed", end: park.END || null,
        };
      }
    } catch (err) {
      console.log(`❌ ERROR: ${err.message}`);
    }
  }

  // ---------------------
  // Step 4: Write output
  // ---------------------

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));

  const total     = Object.keys(results).length;
  const succeeded = Object.values(results).filter((r) => r.lat !== null).length;
  const failed    = total - succeeded;

  console.log(`\n✅ Done.`);
  console.log(`   ${succeeded} / ${total} parks geocoded successfully`);
  if (failed) console.log(`   ⚠️  ${failed} parks could not be geocoded (check manually)`);
  console.log(`   Output written to: ${OUTPUT_PATH}`);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});