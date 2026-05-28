/**
 * ALLYEARSimportSavantHitterStats.js
 *
 * Bulk historical import of Baseball Savant hitter Statcast data.
 * Fetches 2017 → current season, one API call per year.
 *
 * Mirrors ALLYEARSimportPitcherPitchType.js / ALLYEARSimportHitterVsPitchType.js
 * in structure and rate-limiting approach.
 *
 * Why this matters for the strikeout model:
 *   - iz_contact_percent (zone contact%) explains ~70% of hitter K variance (R²=0.695)
 *   - bat_speed explains ~33% of whiff variance (R²=0.331)
 *   - oz_swing_percent (chase%) has a weak positive correlation (R²=0.060)
 *   Historical data lets the model learn these patterns across seasons.
 *
 * USAGE:
 *   node ALLYEARSimportSavantHitterStats.js              (2017 → current)
 *   node ALLYEARSimportSavantHitterStats.js --year 2024  (single year)
 *   node ALLYEARSimportSavantHitterStats.js --year 2022,2023,2024
 *   node ALLYEARSimportSavantHitterStats.js --start 2021 (2021 → current)
 *
 * NOTE: bat_speed and fast_swing_rate are only available from 2024+ on Savant.
 *       Earlier years will have NULL for those columns — the model handles
 *       this gracefully via median imputation.
 */

"use strict";

const db    = require("./db");
const fetch = require("node-fetch").default;

const CURRENT_SEASON = 2026;
const RATE_LIMIT_MS  = 1200;  // be polite to Savant — 1.2s between requests

// ─── CLI args ────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const yearArg  = args[args.indexOf("--year")  + 1];
const startArg = args[args.indexOf("--start") + 1];

function getYears() {
  if (yearArg) return yearArg.split(",").map(y => parseInt(y.trim(), 10));
  const start = startArg ? parseInt(startArg, 10) : 2017;
  const years = [];
  for (let y = start; y <= CURRENT_SEASON; y++) years.push(y);
  return years;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Value parsers ───────────────────────────────────────────────────────────
const num = v => { if (v === "" || v == null) return null; const n = parseFloat(v);  return isNaN(n) ? null : n; };
const int = v => { if (v === "" || v == null) return null; const n = parseInt(v,10); return isNaN(n) ? null : n; };
const str = v => { if (v === "" || v == null) return null; return String(v).trim(); };

// ─── CREATE TABLE (idempotent) ────────────────────────────────────────────────
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS savant_hitter_stats (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    mlb_id                INTEGER NOT NULL,
    name                  TEXT,
    season                INTEGER NOT NULL,
    player_age            INTEGER,
    bat_side              TEXT,

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

    -- Primary K-model features
    whiff_percent         REAL,    -- overall whiff%
    swing_percent         REAL,
    z_swing_percent       REAL,
    z_swing_miss_percent  REAL,
    oz_swing_percent      REAL,    -- chase% [r=0.245 vs K%, R²=0.060]
    oz_swing_miss_percent REAL,
    iz_contact_percent    REAL,    -- in-zone contact% [r=-0.834 vs K%, R²=0.695 — DOMINANT]
    f_strike_percent      REAL,
    meatball_percent      REAL,
    meatball_swing_pct    REAL,

    -- Swing metrics (bat_speed r=0.575 vs whiff%, R²=0.331 — available 2024+)
    bat_speed             REAL,
    fast_swing_rate       REAL,
    sprint_speed          REAL,

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

// ─── Parse a CSV row from Savant ──────────────────────────────────────────────
function getName(row) {
  const first = row.first_name || "";
  const last  = row.last_name  || "";
  if (first || last) return `${first} ${last}`.trim();
  // Fallback: "Last, First" format
  const col0 = Object.values(row)[0] || "";
  if (col0.includes(",")) {
    const [l, f] = col0.split(",").map(s => s.trim());
    return `${f} ${l}`.trim();
  }
  return col0.trim() || null;
}

function rowToParams(r, year) {
  return [
    int(r.player_id),
    getName(r),
    year,
    int(r.player_age),
    str(r.bat_side || r.stand),

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

    num(r.whiff_percent),
    num(r.swing_percent),
    num(r.z_swing_percent),
    num(r.z_swing_miss_percent),
    num(r.oz_swing_percent),
    num(r.oz_swing_miss_percent),
    num(r.iz_contact_percent),
    num(r.f_strike_percent),
    num(r.meatball_percent   || null),
    num(r.meatball_swing_percent || null),

    // bat_speed and fast_swing_rate are only available 2024+ on Savant
    num(r.avg_swing_speed    || null),
    num(r.fast_swing_rate    || null),
    num(r.sprint_speed       || null),
  ];
}

// ─── Fetch one year from Savant ───────────────────────────────────────────────
async function fetchYear(year) {
  // bat_speed / fast_swing_rate exist on Savant from 2024 onwards
  const hasBatSpeed = year >= 2024;

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
    `?year=${year}&type=batter&filter=&min=1` +
    `&selections=${selections}&chart=false&csv=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" },
    timeout: 30000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text  = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  return lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.replace(/"/g, "").trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });
}

// ─── Import one year ──────────────────────────────────────────────────────────
async function importYear(year) {
  process.stdout.write(`  ${year}  fetching... `);

  let rows;
  try {
    rows = await fetchYear(year);
  } catch (err) {
    console.log(`❌ fetch failed: ${err.message}`);
    return { inserted: 0, failed: 0 };
  }

  if (!rows.length) {
    console.log("⚠️  no data returned");
    return { inserted: 0, failed: 0 };
  }

  process.stdout.write(`${rows.length} hitters  inserting... `);

  // Delete existing rows for this year before re-inserting
  await runQuery("DELETE FROM savant_hitter_stats WHERE season = ?", [year]);
  await runQuery("BEGIN TRANSACTION");

  let inserted = 0, failed = 0;
  for (const row of rows) {
    try {
      await runQuery(INSERT_SQL, rowToParams(row, year));
      inserted++;
    } catch (err) {
      failed++;
    }
  }

  await runQuery("COMMIT");
  console.log(`✅ ${inserted} inserted${failed ? `, ${failed} failed` : ""}`);
  return { inserted, failed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  const years = getYears();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Baseball Savant Hitter Stats — All Years Import");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Years to import: ${years.join(", ")}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms between requests`);
  console.log(`  Note: bat_speed available 2024+ only; earlier years → NULL`);
  console.log();

  // Ensure table exists
  await runQuery(CREATE_TABLE_SQL);
  console.log("✓ savant_hitter_stats table ready\n");

  let totalInserted = 0, totalFailed = 0;

  for (let i = 0; i < years.length; i++) {
    const { inserted, failed } = await importYear(years[i]);
    totalInserted += inserted;
    totalFailed   += failed;

    // Rate limit between requests (skip after last)
    if (i < years.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  COMPLETE — ${totalInserted} total rows inserted, ${totalFailed} failed`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\nNext steps:");
  console.log("  1. Run the strikeout model training:");
  console.log("     python strikeoutPredictorv2.py --train");
  console.log("  2. Refresh predictions:");
  console.log("     node server.js   (predictions auto-refresh hourly)");

  process.exit(0);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});