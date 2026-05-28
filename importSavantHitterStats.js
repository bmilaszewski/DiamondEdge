/**
 * importSavantHitterStats.js
 *
 * Imports Baseball Savant Statcast data for HITTERS into savant_hitter_stats.
 * Mirrors importSavantPitcherStats.js exactly — same structure, same patterns.
 *
 * Key columns captured (critical for strikeout model):
 *   k_percent          — season K%
 *   whiff_percent      — overall whiff rate
 *   oz_swing_percent   — chase rate (out-of-zone swing%)  [r=0.245 vs K%]
 *   iz_contact_percent — in-zone contact%                 [r=-0.834 vs K%, R²=0.695]
 *   z_swing_miss_percent — zone swing-and-miss%
 *   bat_speed          — avg bat speed mph                [r=0.575 vs whiff%]
 *   sprint_speed       — ft/sec sprint speed
 *   barrel_batted_rate — barrel %
 *   hard_hit_percent   — hard-hit %
 *   exit_velocity_avg  — avg exit velo
 *
 * USAGE:
 *   node importSavantHitterStats.js                    (CSV import + current season scrape)
 *   node importSavantHitterStats.js --csv-only         (CSV only)
 *   node importSavantHitterStats.js --current-only     (current season scrape only)
 *   node importSavantHitterStats.js --csv ./path.csv   (use specific CSV file)
 *
 * DOWNLOADING HISTORICAL CSV FROM BASEBALL SAVANT:
 *   1. Go to https://baseballsavant.mlb.com/leaderboard/custom
 *   2. Set: Type=Batter, Min PA=1, select all years (download one file per year
 *      or use the bulk export). Columns to include at minimum:
 *        player_id, last_name, first_name, year, player_age, bat_side,
 *        pa, ab, strikeout, walk, k_percent, bb_percent,
 *        batting_avg, slg_percent, on_base_percent, on_base_plus_slg,
 *        home_run, xba, xslg, woba, xwoba, xobp, xiso, wobacon, xwobacon,
 *        exit_velocity_avg, launch_angle_avg, sweet_spot_percent,
 *        barrel, barrel_batted_rate, hard_hit_percent,
 *        groundballs_percent, flyballs_percent, linedrives_percent,
 *        whiff_percent, swing_percent, z_swing_percent, z_swing_miss_percent,
 *        oz_swing_percent, oz_swing_miss_percent, iz_contact_percent,
 *        f_strike_percent, bat_speed, fast_swing_rate, sprint_speed
 *   3. Save as hitter_stats.csv in the project root
 */

"use strict";

const db    = require("./db");
const fetch = require("node-fetch").default;
const fs    = require("fs");
const path  = require("path");
const csv   = require("csv-parser");

const CURRENT_SEASON = 2026;
const DEFAULT_CSV    = path.join(__dirname, "hitter_stats.csv");

// ─── CLI args ────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const csvOnly     = args.includes("--csv-only");
const currentOnly = args.includes("--current-only");
const csvPath     = (() => {
  const i = args.indexOf("--csv");
  return i !== -1 ? path.resolve(args[i + 1]) : DEFAULT_CSV;
})();

// ─── DB helpers ──────────────────────────────────────────────────────────────
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// ─── Value parsers ───────────────────────────────────────────────────────────
const num = v => { if (v === "" || v == null) return null; const n = parseFloat(v);  return isNaN(n) ? null : n; };
const int = v => { if (v === "" || v == null) return null; const n = parseInt(v,10); return isNaN(n) ? null : n; };
const str = v => { if (v === "" || v == null) return null; return String(v).trim(); };

// ─── Name helper (same logic as pitcher import) ───────────────────────────────
function getNameFromRow(row) {
  // Historical CSV: "Last, First" in first column
  const firstCol = Object.values(row)[0] || "";
  if (firstCol.includes(",")) {
    const [last, first] = firstCol.split(",").map(s => s.trim());
    return `${first} ${last}`.trim();
  }
  // Current-season scrape: separate first_name / last_name fields
  const first = row.first_name || row["first name"] || "";
  const last  = row.last_name  || row["last name"]  || "";
  return `${first} ${last}`.trim() || null;
}

// ─── Row → INSERT params ─────────────────────────────────────────────────────
function rowToParams(r) {
  const name = getNameFromRow(r);
  return [
    int(r.player_id),
    name,
    int(r.year),
    int(r.player_age),
    str(r.bat_side || r.stand),

    // Counting / rate
    int(r.pa),
    int(r.ab),
    int(r.strikeout),
    int(r.walk),
    int(r.home_run),
    num(r.k_percent),
    num(r.bb_percent),
    num(r.batting_avg),
    num(r.slg_percent),
    num(r.on_base_percent),
    num(r.on_base_plus_slg),
    num(r.babip),

    // Expected stats
    num(r.xba),
    num(r.xslg),
    num(r.woba),
    num(r.xwoba),
    num(r.xobp),
    num(r.xiso),
    num(r.wobacon),
    num(r.xwobacon),
    num(r.xbadiff),
    num(r.xslgdiff),
    num(r.wobadiff),

    // Batted ball
    num(r.exit_velocity_avg),
    num(r.launch_angle_avg),
    num(r.sweet_spot_percent),
    int(r.barrel),
    num(r.barrel_batted_rate),
    num(r.hard_hit_percent),
    num(r.groundballs_percent),
    num(r.flyballs_percent),
    num(r.linedrives_percent),
    num(r.popups_percent),

    // ── Plate discipline (K-model features) ──────────────────────────────────
    num(r.whiff_percent),          // overall whiff%
    num(r.swing_percent),
    num(r.z_swing_percent),        // zone swing%
    num(r.z_swing_miss_percent),   // zone swing-miss%
    num(r.oz_swing_percent),       // chase% — r=0.245 vs K%
    num(r.oz_swing_miss_percent),
    num(r.iz_contact_percent),     // in-zone contact% — r=-0.834 vs K%, R²=0.695
    num(r.f_strike_percent),
    num(r.meatball_percent || null),
    num(r.meatball_swing_percent || null),

    // ── Speed / athleticism (K-model: bat speed r=0.575 vs whiff%) ───────────
    num(r.avg_swing_speed    || null),
    num(r.fast_swing_rate),        // % of swings ≥75 mph
    num(r.sprint_speed),           // ft/sec
  ];
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS savant_hitter_stats (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    mlb_id                INTEGER NOT NULL,
    name                  TEXT,
    season                INTEGER NOT NULL,
    player_age            INTEGER,
    bat_side              TEXT,

    -- Counting / rate
    pa                    INTEGER,
    ab                    INTEGER,
    strikeouts            INTEGER,
    walks                 INTEGER,
    home_runs             INTEGER,
    k_percent             REAL,
    bb_percent            REAL,
    batting_avg           REAL,
    slg_percent           REAL,
    obp                   REAL,
    ops                   REAL,
    babip                 REAL,

    -- Expected stats
    xba                   REAL,
    xslg                  REAL,
    woba                  REAL,
    xwoba                 REAL,
    xobp                  REAL,
    xiso                  REAL,
    wobacon               REAL,
    xwobacon              REAL,
    xbadiff               REAL,
    xslgdiff              REAL,
    wobadiff              REAL,

    -- Batted ball
    exit_velocity_avg     REAL,
    launch_angle_avg      REAL,
    sweet_spot_percent    REAL,
    barrel                INTEGER,
    barrel_batted_rate    REAL,
    hard_hit_percent      REAL,
    groundballs_percent   REAL,
    flyballs_percent      REAL,
    linedrives_percent    REAL,
    popups_percent        REAL,

    -- Plate discipline (K-model primary features)
    whiff_percent         REAL,    -- overall whiff rate
    swing_percent         REAL,
    z_swing_percent       REAL,
    z_swing_miss_percent  REAL,    -- zone swing-miss%
    oz_swing_percent      REAL,    -- chase% [r=0.245 vs K%]
    oz_swing_miss_percent REAL,
    iz_contact_percent    REAL,    -- in-zone contact% [r=-0.834 vs K%, R²=0.695]
    f_strike_percent      REAL,
    meatball_percent      REAL,
    meatball_swing_pct    REAL,

    -- Speed / swing metrics (K-model: bat speed r=0.575 vs whiff%)
    bat_speed             REAL,    -- avg bat speed mph
    fast_swing_rate       REAL,    -- % swings ≥75 mph
    sprint_speed          REAL,    -- ft/sec

    UNIQUE(mlb_id, season)
  )
`;

// ─── INSERT SQL ───────────────────────────────────────────────────────────────
const INSERT_SQL = `
  INSERT OR REPLACE INTO savant_hitter_stats (
    mlb_id, name, season, player_age, bat_side,
    pa, ab, strikeouts, walks, home_runs,
    k_percent, bb_percent, batting_avg, slg_percent, obp, ops, babip,
    xba, xslg, woba, xwoba, xobp, xiso, wobacon, xwobacon, xbadiff, xslgdiff, wobadiff,
    exit_velocity_avg, launch_angle_avg, sweet_spot_percent, barrel, barrel_batted_rate,
    hard_hit_percent, groundballs_percent, flyballs_percent, linedrives_percent, popups_percent,
    whiff_percent, swing_percent, z_swing_percent, z_swing_miss_percent,
    oz_swing_percent, oz_swing_miss_percent, iz_contact_percent,
    f_strike_percent, meatball_percent, meatball_swing_pct,
    bat_speed, fast_swing_rate, sprint_speed
  ) VALUES (
    ?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,
    ?,?,?
  )
`;

// ─── Import from CSV ─────────────────────────────────────────────────────────
async function importFromCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ CSV not found: ${filePath}`);
    console.error(`   Download from Baseball Savant → leaderboard/custom (type=batter)`);
    console.error(`   Save as: ${filePath}`);
    return 0;
  }

  console.log(`\n📂 Reading ${path.basename(filePath)}...`);
  const rows = [];
  await new Promise(resolve => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", row => rows.push(row))
      .on("end", resolve);
  });

  console.log(`   ${rows.length} rows found`);

  // Year breakdown
  const byYear = {};
  rows.forEach(r => { byYear[r.year] = (byYear[r.year] || 0) + 1; });
  console.log(`   Years: ${Object.entries(byYear).sort().map(([y,c]) => `${y}(${c})`).join(", ")}\n`);

  await runQuery("BEGIN TRANSACTION");
  let inserted = 0, failed = 0;
  for (const row of rows) {
    try {
      await runQuery(INSERT_SQL, rowToParams(row));
      inserted++;
    } catch (err) {
      const name = getNameFromRow(row);
      console.error(`  ❌ ${name} ${row.year}: ${err.message}`);
      failed++;
    }
  }
  await runQuery("COMMIT");

  console.log(`✅ CSV import complete — ${inserted} inserted, ${failed} failed`);
  return inserted;
}

// ─── Scrape current season from Savant ───────────────────────────────────────
async function scrapeCurrentSeason() {
  console.log(`\n🌐 Scraping ${CURRENT_SEASON} hitter data from Baseball Savant...`);

  // These are the exact column keys Savant's custom leaderboard returns for batters
  const selections = [
    "player_age", "pa", "ab", "strikeout", "walk", "home_run",
    "k_percent", "bb_percent", "batting_avg", "slg_percent", "on_base_percent",
    "on_base_plus_slg", "babip",
    "xba", "xslg", "woba", "xwoba", "xobp", "xiso",
    "wobacon", "xwobacon", "xbadiff", "xslgdiff", "wobadiff",
    "exit_velocity_avg", "launch_angle_avg", "sweet_spot_percent",
    "barrel", "barrel_batted_rate", "hard_hit_percent",
    "groundballs_percent", "flyballs_percent", "linedrives_percent", "popups_percent",
    "whiff_percent", "swing_percent",
    "z_swing_percent", "z_swing_miss_percent",
    "oz_swing_percent", "oz_swing_miss_percent",
    "iz_contact_percent", "f_strike_percent", "meatball_percent", "meatball_swing_percent",
    "avg_swing_speed", "fast_swing_rate", "sprint_speed",
    "bat_side",
  ].join(",");

  const url =
    `https://baseballsavant.mlb.com/leaderboard/custom` +
    `?year=${CURRENT_SEASON}&type=batter&filter=&min=1` +
    `&selections=${selections}&chart=false&csv=true`;

  console.log(`   URL: ${url.substring(0, 100)}...`);

  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" }
    });
  } catch (err) {
    console.error(`❌ Network error: ${err.message}`);
    return 0;
  }

  if (!res.ok) {
    console.error(`❌ Savant returned HTTP ${res.status}`);
    return 0;
  }

  const text  = await res.text();
  const lines = text.trim().split("\n");

  if (lines.length < 2) {
    console.log("⚠️  No data returned (season may not have started or min PA too high)");
    return 0;
  }

  // Parse CSV — same pattern as pitcher import
  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  const rows = lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.replace(/"/g, "").trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });

  console.log(`   ${rows.length} hitters found for ${CURRENT_SEASON}`);

  // Delete existing current-season rows before re-inserting
  await runQuery("DELETE FROM savant_hitter_stats WHERE season = ?", [CURRENT_SEASON]);
  await runQuery("BEGIN TRANSACTION");

  let inserted = 0, failed = 0;
  for (const row of rows) {
    row.year = String(CURRENT_SEASON);
    try {
      await runQuery(INSERT_SQL, rowToParams(row));
      inserted++;
    } catch (err) {
      const name = getNameFromRow(row);
      console.error(`  ❌ ${name}: ${err.message}`);
      failed++;
    }
  }
  await runQuery("COMMIT");

  console.log(`✅ Current season scraped — ${inserted} hitters inserted, ${failed} failed`);
  return inserted;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Savant Hitter Stats Import");
  console.log("═══════════════════════════════════════════════════════");

  // Ensure table exists
  await runQuery(CREATE_TABLE_SQL);
  console.log("✓ savant_hitter_stats table ready\n");

  if (!currentOnly) await importFromCsv(csvPath);
  if (!csvOnly)     await scrapeCurrentSeason();

  console.log("\n✅ All done.");
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});