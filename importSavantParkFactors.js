/**
 * importSavantParkFactors.js
 *
 * Fetches HR-specific park factors from Baseball Savant's statcast park
 * factors leaderboard and upserts hr_factor into the park_factors table.
 *
 * Source:
 *   https://baseballsavant.mlb.com/leaderboard/statcast-park-factors
 *   ?type=year&year=YYYY&batSide=&stat=index_wOBA&condition=All&rolling=3&parks=mlb
 *
 * The page embeds data in multiple possible formats (script tag JSON, HTML table).
 * We try several extraction strategies and fall back gracefully.
 *
 * hr_factor stored as multiplier (1.0 = neutral):
 *   Savant index_HR 100 → 1.00
 *   Savant index_HR 128 → 1.28  (Coors)
 *   Savant index_HR  92 → 0.92  (pitcher friendly)
 *
 * USAGE:
 *   node importSavantParkFactors.js              (current season)
 *   node importSavantParkFactors.js --year 2024  (specific year)
 *   node importSavantParkFactors.js --all        (2017 → current)
 */

"use strict";

const db    = require("./db");
const fetch = require("node-fetch").default;
const https = require("https");

const CURRENT_SEASON = 2026;
const RATE_MS        = 1500;

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const allYears  = args.includes("--all");
const yearIdx   = args.indexOf("--year");
const yearArg   = yearIdx !== -1 ? args[yearIdx + 1] : null;

function getYears() {
  if (yearArg)   return [parseInt(yearArg, 10)];
  if (allYears) {
    const yrs = [];
    for (let y = 2017; y <= CURRENT_SEASON; y++) yrs.push(y);
    return yrs;
  }
  return [CURRENT_SEASON];
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (e, row) => { e ? rej(e) : res(row); }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Team abbrev → Retrosheet park_id ────────────────────────────────────────
const TEAM_TO_PARK = {
  ARI:"PHO01", ATL:"ATL03", BAL:"BAL12", BOS:"BOS07",
  CHC:"CHI11", CWS:"CHI12", CIN:"CIN09", CLE:"CLE08",
  COL:"DEN02", DET:"DET05", HOU:"HOU03", KCR:"KAN06",
  KC:"KAN06",  LAA:"ANA01", LAD:"LOS03", MIA:"MIA02",
  MIL:"MIL06", MIN:"MIN04", NYM:"NYC20", NYY:"NYC21",
  OAK:"SAC01", ATH:"SAC01", PHI:"PHI13", PIT:"PIT08",
  SDP:"SAN02", SD:"SAN02",  SEA:"SEA03", SFG:"SFO03",
  SF:"SFO03",  STL:"STL10", TBR:"TAM02", TB:"TAM02",
  TEX:"ARL03", TOR:"TOR02", WSN:"WAS11", WAS:"WAS11",
  AZ:"PHO01",
};

// ─── Fetch page with retry ─────────────────────────────────────────────────
async function fetchPage(year) {
  const url =
    `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors` +
    `?type=year&year=${year}&batSide=&stat=index_wOBA&condition=All&rolling=3&parks=mlb`;

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://baseballsavant.mlb.com/",
    "Connection": "keep-alive",
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, timeout: 30000 });
      if (res.status === 403) { console.log(`  HTTP 403 (attempt ${attempt})`); await sleep(3000 * attempt); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(2000 * attempt);
    }
  }
  return null;
}

// ─── Parse park factor data from HTML ────────────────────────────────────────
function parseHtml(html, year) {
  const results = [];

  // Strategy 1: JSON array in script tag — multiple common patterns
  const jsonPatterns = [
    /var\s+data\s*=\s*(\[[\s\S]*?\]);/,
    /window\.tableData\s*=\s*(\[[\s\S]*?\]);/,
    /tableData\s*=\s*(\[[\s\S]*?\]);/,
    /"leaderboard_data"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /data\s*=\s*JSON\.parse\s*\(\s*'([\s\S]*?)'\s*\)/,
  ];

  for (const pat of jsonPatterns) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      let jsonStr = m[1].replace(/\\'/g, "'");
      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr) || arr.length < 10) continue;
      // Check it has HR-related fields
      const sample = arr[0];
      const keys = Object.keys(sample).map(k => k.toLowerCase());
      if (!keys.some(k => k.includes("hr") || k.includes("home_run") || k.includes("team"))) continue;

      for (const row of arr) {
        const team = (row.team_abbrev || row.team_id || row.team || row.Team || "").toUpperCase().trim();
        const hrIndex =
          row.index_HR ?? row.hr_factor ?? row.HR_index ?? row.hr_index ??
          row.index_hr ?? row["HR"] ?? null;
        if (!team || hrIndex == null) continue;
        const factor = parseFloat(hrIndex);
        if (!isNaN(factor) && factor > 0) {
          results.push({ team, hr_factor: factor / 100 });
        }
      }
      if (results.length >= 20) return results;
    } catch (_) { /* try next */ }
  }

  // Strategy 2: HTML table — look for <tr> rows with team + index data
  if (results.length === 0) {
    const tableMatch = html.match(/<tbody[\s\S]*?<\/tbody>/i);
    if (tableMatch) {
      const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
      for (const row of rows) {
        const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
          .map(td => td.replace(/<[^>]+>/g, "").trim());
        if (cells.length < 4) continue;

        // Try to identify team and HR index columns by content
        const teamCell = cells.find(c => TEAM_TO_PARK[c.toUpperCase()]);
        if (!teamCell) continue;

        // HR index is typically a 2-3 digit number near 100
        const numericCells = cells
          .map(c => parseFloat(c))
          .filter(n => !isNaN(n) && n > 50 && n < 200);

        if (numericCells.length > 0) {
          // Second or third numeric is typically HR index
          const hrIdx = numericCells[Math.min(1, numericCells.length - 1)];
          results.push({ team: teamCell.toUpperCase(), hr_factor: hrIdx / 100 });
        }
      }
    }
  }

  return results;
}

// ─── Upsert into park_factors ─────────────────────────────────────────────────
async function upsertYear(year) {
  process.stdout.write(`  ${year}  fetching... `);

  let html;
  try {
    html = await fetchPage(year);
  } catch (e) {
    console.log(`❌ fetch failed: ${e.message}`);
    return 0;
  }

  if (!html || html.length < 500) {
    console.log("❌ empty or blocked response");
    return 0;
  }

  const parsed = parseHtml(html, year);
  if (parsed.length === 0) {
    console.log(`⚠️  could not parse park factor data (HTML length=${html.length})`);
    console.log("   → Tip: download the page manually and check the structure");
    return 0;
  }

  process.stdout.write(`${parsed.length} parks parsed... `);
  await run("BEGIN TRANSACTION");
  let updated = 0;

  for (const { team, hr_factor } of parsed) {
    const parkId = TEAM_TO_PARK[team];
    if (!parkId) continue;

    const existing = await get(
      "SELECT id FROM park_factors WHERE park_id=? AND season=?",
      [parkId, year]
    );

    if (existing) {
      await run(
        "UPDATE park_factors SET hr_factor=? WHERE park_id=? AND season=?",
        [hr_factor, parkId, year]
      );
    } else {
      await run(
        `INSERT OR IGNORE INTO park_factors (park_id, season, home_team, hr_factor, games_home)
         VALUES (?, ?, ?, ?, 81)`,
        [parkId, year, team, hr_factor]
      );
    }
    updated++;
  }

  await run("COMMIT");
  console.log(`✅ ${updated} parks updated`);
  return updated;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const years = getYears();

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Savant HR Park Factors Import");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Years: ${years.join(", ")}`);
  console.log();
  console.log("  NOTE: If Savant returns 0 rows, hrPredictor.py will");
  console.log("  automatically compute HR factors from historical_lineups.");
  console.log("  You do NOT need this script for the model to work.");
  console.log();

  let total = 0;
  for (let i = 0; i < years.length; i++) {
    total += await upsertYear(years[i]);
    if (i < years.length - 1) await sleep(RATE_MS);
  }

  console.log(`\n  Done — ${total} total park-season rows updated`);

  if (total === 0) {
    console.log("\n  ⚠️  No rows updated. This is OK — hrPredictor.py now computes");
    console.log("  HR park factors directly from your historical_lineups data.");
    console.log("  Run: python hrPredictor.py --train  to rebuild the model.\n");
  }

  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });