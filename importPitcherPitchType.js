/**
 * importPitcherPitchType.js
 *
 * Fetches how every pitcher performs WITH each pitch type from Baseball
 * Savant's pitch-arsenal-stats leaderboard (type=pitcher).
 *
 * Mirror of importHitterVsPitchType.js — same endpoint, same structure,
 * just type=pitcher instead of type=batter.
 *
 * Adds velocity and spin rate since pitchers are the ones throwing.
 * Run value is negative = good for the pitcher.
 *
 * One row per pitcher per pitch type per year → pitcher_vs_pitch_type table.
 *
 * USAGE:
 *   node importPitcherVsPitchType.js                  (2017 → current season)
 *   node importPitcherVsPitchType.js --all            (2015 → current season)
 *   node importPitcherVsPitchType.js --year 2023      (specific year)
 *   node importPitcherVsPitchType.js --year 2022,2023 (multiple years)
 *   node importPitcherVsPitchType.js --current        (current season only)
 */

const db    = require("./db");
const fetch = require("node-fetch").default;

const CURRENT_SEASON = 2026;
const RATE_LIMIT_MS  = 800;

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

const args        = process.argv.slice(2);
const allYears    = args.includes("--all");
const currentOnly = args.includes("--current");
const yearIndex   = args.indexOf("--year");
const yearArg     = yearIndex >= 0 ? args[yearIndex + 1] : null;

function getYears() {
  if (currentOnly) return [CURRENT_SEASON];
  if (allYears) {
    const years = [];
    for (let y = CURRENT_SEASON; y <= CURRENT_SEASON; y++) years.push(y);
    return years;
  }
  if (yearArg) {
    return yearArg.split(",").map(y => parseInt(y.trim(), 10));
  }
  // Default: 2017 → current (Statcast data reliable from 2017 onward)
  const years = [];
  for (let y = CURRENT_SEASON; y <= CURRENT_SEASON; y++) years.push(y);
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
// Value parsers
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
// Fetch one pitch type for one year (type=pitcher)
// ---------------------

async function fetchPitchType(pitchCode, year) {
  const url =
    `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats` +
    `?type=pitcher&year=${year}&pitchType=${pitchCode}&min=1&csv=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text  = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];

  // Strip quotes then split — handles "last_name, first_name" header correctly
  const headers = lines[0].replace(/"/g, "").split(",").map(h => h.trim().toLowerCase());

  return lines.slice(1).map(line => {
    const vals = line.replace(/"/g, "").split(",").map(v => v.trim());
    const obj  = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ""; });
    return obj;
  }).filter(r => {
    if (!r.player_id && !r.pitcher_id && !r.mlb_id) return false;
    // Only keep rows matching the requested pitch type
    if (r.pitch_type && r.pitch_type.trim() !== "" &&
        r.pitch_type.trim().toUpperCase() !== pitchCode.toUpperCase()) return false;
    return true;
  });
}

// ---------------------
// Resolve player ID — Savant uses different names across years
// ---------------------

function getPlayerId(row) {
  return row.player_id || row.pitcher_id || row.mlb_id || row.id || null;
}

function getNameFromRow(row) {
  // After header parsing: "last_name, first_name" becomes last_name + first_name cols
  const last  = row.last_name  || "";
  const first = row.first_name || "";
  if (last && first) return `${first.trim()} ${last.trim()}`.trim();

  // Fallback: first column value (may be "Last, First" format)
  const firstVal = Object.values(row)[0] || "";
  if (firstVal.includes(",")) {
    const comma = firstVal.indexOf(",");
    return `${firstVal.slice(comma + 1).trim()} ${firstVal.slice(0, comma).trim()}`.trim();
  }
  return firstVal.trim() || null;
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

  // Log column names on first call to catch field name changes
  if (!importOne._colsLogged) {
    importOne._colsLogged = true;
    console.log(`\n   [Savant columns: ${Object.keys(rows[0]).join(", ")}]\n`);
  }

  let inserted = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const row of rows) {
    const mlbId = i(getPlayerId(row));
    if (!mlbId) { skipped++; continue; }

    const name = getNameFromRow(row);

    // Outcomes — same fields as batter side
    const pa      = i(row.pa)            ?? i(row.pas);
    const pitches = i(row.pitches)       ?? i(row.n_pitches) ?? i(row.total_pitches);
    const ba      = n(row.ba)            ?? n(row.avg)       ?? n(row.batting_avg);
    const slg     = n(row.slg)           ?? n(row.slg_percent);
    const woba    = n(row.woba);
    const xwoba   = n(row.est_woba)      ?? n(row.xwoba);
    const whiff   = n(row.whiff_percent) ?? n(row.whiff);
    const putAway = n(row.put_away)      ?? n(row.put_away_percent);
    const runVal  = n(row.run_value)     ?? n(row.rv);

    // Pitcher-specific — velocity and spin for this pitch type
    const avgSpeed = n(row.avg_speed) ?? n(row.velocity) ?? n(row.release_speed_mean);
    const avgSpin  = i(row.avg_spin)  ?? i(row.spin_rate) ?? i(row.release_spin_rate_mean);

    try {
      await runQuery(
        `INSERT OR REPLACE INTO pitcher_pitch_type
          (mlb_id, name, year, pitch_type, pitch_name,
           pitches, pa, ba, slg, woba, xwoba,
           whiff_percent, put_away_percent, run_value,
           avg_speed, avg_spin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mlbId, name, year, pitchCode, pitchName,
          pitches, pa, ba, slg, woba, xwoba,
          whiff, putAway, runVal,
          avgSpeed, avgSpin,
        ]
      );
      inserted++;
    } catch (err) {
      errors++;
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

  console.log(`\n⚾  Pitcher vs Pitch Type Import`);
  console.log(`   Seasons : ${years.join(", ")}`);
  console.log(`   Pitches : ${PITCH_TYPES.map(p => p.code).join(", ")}`);
  console.log(`   Total   : ${years.length * PITCH_TYPES.length} API calls\n`);

  // Delete current season rows before re-inserting (always fresh)
  if (years.includes(CURRENT_SEASON)) {
    await runQuery(
      `DELETE FROM pitcher_pitch_type WHERE year = ?`,
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

  console.log(`\n✅ Done — ${totalRows} total rows inserted into pitcher_pitch_type\n`);
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});