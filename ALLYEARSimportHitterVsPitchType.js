/**
 * importHitterVsPitchType.js
 *
 * Fetches how every hitter performs against each pitch type from Baseball
 * Savant's pitch-arsenal-stats leaderboard (type=batter).
 *
 * One row per hitter per pitch type per year → hitter_vs_pitch_type table.
 *
 * STRATEGY:
 *   Fetches by pitch type, not by player — one API call covers ALL hitters
 *   against e.g. all sliders in 2024. That's 8 pitch types × seasons = ~80
 *   total calls for a full historical run, very manageable.
 *
 * USAGE:
 *   node importHitterVsPitchType.js                  (current season only)
 *   node importHitterVsPitchType.js --all            (2015 → current season)
 *   node importHitterVsPitchType.js --year 2023      (specific year)
 *   node importHitterVsPitchType.js --year 2020,2021 (multiple years)
 */

const db    = require("./db");
const fetch = require("node-fetch").default;

const CURRENT_SEASON = 2026;
const RATE_LIMIT_MS  = 800;

// ---------------------
// Pitch types Baseball Savant supports on the batter leaderboard
// ---------------------

const PITCH_TYPES = [
  { code: "FF", name: "Four-Seam Fastball" },
  { code: "SL", name: "Slider"             },
  { code: "CH", name: "Changeup"           },
  { code: "CU", name: "Curveball"          },
  { code: "SI", name: "Sinker"             },
  { code: "FC", name: "Cutter"             },
  { code: "ST", name: "Sweeper"            },
  { code: "FS", name: "Splitter"           },
];

// ---------------------
// CLI args
// ---------------------

const args = process.argv.slice(2);
const allYears   = args.includes("--all");
const yearArg    = args[args.indexOf("--year") + 1];

function getYears() {
  if (allYears) {
    const years = [];
    for (let y = 2017; y <= CURRENT_SEASON; y++) years.push(y);
    return years;
  }
  if (yearArg) {
    return yearArg.split(",").map(y => parseInt(y.trim(), 10));
  }
  const years = [];
  for (let y = 2017; y <= CURRENT_SEASON; y++) years.push(y);
  return years;
}

// ---------------------
// DB helpers
// ---------------------

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------------
// Parse a numeric value — null if empty/missing
// ---------------------

function n(v) {
  if (v === "" || v == null) return null;
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function i(v) {
  if (v === "" || v == null) return null;
  const x = parseInt(v, 10);
  return isNaN(x) ? null : x;
}

// ---------------------
// Fetch one pitch type for one year from Savant
// Returns array of row objects
// ---------------------

async function fetchPitchType(pitchCode, year) {
  const url =
    `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats` +
    `?type=batter&year=${year}&pitch_type=${pitchCode}&min=1&csv=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const text = await res.text();
  const lines = text.trim().split("\n");

  if (lines.length < 2) return []; // empty — no data for this pitch type/year

  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());

  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.replace(/"/g, "").trim());
    const obj  = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ""; });
    return obj;
  }).filter(r => {
    const pt = (r.pitch_type || "").trim().toUpperCase();

    // Must have a player ID
    if (!r.player_id && !r.batter_id && !r.mlb_id) return false;

    // Must EXACTLY match the pitch type we requested
    if (pt !== pitchCode.toUpperCase()) return false;

    return true;
});
}

// ---------------------
// Resolve player ID from the row — Savant uses different field names
// ---------------------

function getPlayerId(row) {
  return row.player_id || row.batter_id || row.mlb_id || row.id || null;
}

function getNameFromRow(row) {
  // Case 1: historical CSV — only one name field
  const firstCol = Object.values(row)[0] || "";
  if (firstCol.includes(",")) {
    const [last, first] = firstCol.split(",").map(s => s.trim());
    return `${first} ${last}`.trim();
  }

  // Case 2: current Savant scrape — separate fields
  const first = row.first_name || row['first name'] || "";
  const last  = row.last_name  || row['last name'] || "";
  return `${first} ${last}`.trim() || null;
}

// ---------------------
// Import one pitch type for one year
// ---------------------

async function importOne(pitchCode, pitchName, year) {
  process.stdout.write(`  ${year}  ${pitchCode.padEnd(3)} ${pitchName.padEnd(22)} → `);

  let rows;
  try {
    rows = await fetchPitchType(pitchCode, year);
  } catch (err) {
    console.log(`❌ fetch failed: ${err.message}`);
    return 0;
  }

  if (!rows.length) {
    console.log("no data");
    return 0;
  }


  let inserted = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const row of rows) {
    const mlbId = i(getPlayerId(row));
    if (!mlbId) { skipped++; continue; }

    const name = getNameFromRow(row);

    // Field names vary slightly by year — check all known variants
    const pa      = i(row.pa)            ?? i(row.pas);
    const pitches = i(row.pitches)       ?? i(row.n_pitches) ?? i(row.total_pitches);
    const ba      = n(row.ba)            ?? n(row.avg)       ?? n(row.batting_avg);
    const slg     = n(row.slg)           ?? n(row.slg_percent);
    const woba    = n(row.woba);
    const xwoba   = n(row.est_woba)      ?? n(row.xwoba);
    const whiff   = n(row.whiff_percent) ?? n(row.whiff);
    const putAway = n(row.put_away)      ?? n(row.put_away_percent);
    const runVal  = n(row.run_value)     ?? n(row.rv);

    try {
      await runQuery(
        `INSERT OR REPLACE INTO hitter_vs_pitch_type
          (mlb_id, name, year, pitch_type, pitch_name,
           pitches, pa, ba, slg, woba, xwoba,
           whiff_percent, put_away_percent, run_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mlbId, name, year, pitchCode, pitchName,
          pitches, pa, ba, slg, woba, xwoba,
          whiff, putAway, runVal,
        ]
      );
      inserted++;
    } catch (err) {
      errors++;
      // Surface first 3 errors per call — enough to diagnose without flooding
      if (errors <= 3) {
        process.stdout.write(`\n   ⚠️  ${name} (${mlbId}): ${err.message}\n   `);
      }
    }
  }

  const parts = [`${inserted} inserted`];
  if (skipped) parts.push(`${skipped} no-id`);
  if (errors)  parts.push(`${errors} errors`);
  console.log(parts.join(", "));
  return inserted;
}


// ---------------------
// Main
// ---------------------

async function run() {
  const years = getYears();

  console.log(`\n⚾  Hitter vs Pitch Type Import`);
  console.log(`   Seasons : ${years.join(", ")}`);
  console.log(`   Pitches : ${PITCH_TYPES.map(p => p.code).join(", ")}`);
  console.log(`   Total   : ${years.length * PITCH_TYPES.length} API calls\n`);

  // For current season — delete existing rows first so we get fresh data
  if (years.includes(CURRENT_SEASON)) {
    await runQuery(
      `DELETE FROM hitter_vs_pitch_type WHERE year = ?`,
      [CURRENT_SEASON]
    );
  }

  let totalRows = 0;

  for (const year of years) {
    console.log(`\n── ${year} ──────────────────────────`);
    for (const { code, name } of PITCH_TYPES) {
      await sleep(RATE_LIMIT_MS);
      const count = await importOne(code, name, year);
      totalRows += count;
    }
  }

  console.log(`\n✅ Done — ${totalRows} total rows inserted into hitter_vs_pitch_type\n`);
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});