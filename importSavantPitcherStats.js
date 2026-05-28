/**
 * importSavantPitcherStats.js
 *
 * One-time import of historical Baseball Savant pitcher data from a downloaded
 * CSV file, plus a live scrape of the current season from the Savant endpoint.
 *
 * USAGE:
 *   node importSavantPitcherStats.js                         (imports CSV + scrapes current season)
 *   node importSavantPitcherStats.js --csv-only              (CSV import only)
 *   node importSavantPitcherStats.js --current-only          (current season scrape only)
 *   node importSavantPitcherStats.js --csv ./path/to/file.csv
 */

const db     = require("./db");
const fetch  = require("node-fetch").default;
const fs     = require("fs");
const path   = require("path");
const csv    = require("csv-parser");

const CURRENT_SEASON = 2026;
const DEFAULT_CSV    = path.join(__dirname, "stats.csv");

// ---------------------
// CLI args
// ---------------------

const args       = process.argv.slice(2);
const csvOnly    = args.includes("--csv-only");
const currentOnly = args.includes("--current-only");
const csvPath    = (() => {
  const i = args.indexOf("--csv");
  return i !== -1 ? path.resolve(args[i + 1]) : DEFAULT_CSV;
})();

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

// ---------------------
// Parse a value — returns null if empty string
// ---------------------

function num(v) {
  if (v === "" || v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function int(v) {
  if (v === "" || v == null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function str(v) {
  if (v === "" || v == null) return null;
  return v.trim();
}

// ---------------------
// Map one CSV row → INSERT params
// ---------------------

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

function rowToParams(r) {
  // Name is "Last, First" — flip to "First Last" for consistency
  const name = getNameFromRow(r); // always parse from first column

  return [
    int(r.player_id),
    name,
    int(r.year),
    int(r.player_age),
    str(r.pitch_hand),

    // Traditional
    int(r.p_game),
    str(r.p_formatted_ip),
    int(r.pa),
    int(r.strikeout),
    int(r.walk),
    num(r.k_percent),
    num(r.bb_percent),
    num(r.p_era),
    num(r.batting_avg),
    int(r.home_run),
    num(r.babip),
    int(r.p_quality_start),

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

    // Plate discipline
    num(r.whiff_percent),
    num(r.swing_percent),
    num(r.z_swing_percent),
    num(r.z_swing_miss_percent),
    num(r.oz_swing_percent),
    num(r.oz_swing_miss_percent),
    num(r.iz_contact_percent),
    num(r.f_strike_percent),
    num(r.meatball_percent),
    num(r.meatball_swing_percent),

    // Pitch counts
    int(r.pitch_count),
    int(r.pitch_count_fastball),
    int(r.pitch_count_breaking),
    int(r.pitch_count_offspeed),

    // FF
    str(r.n_ff_formatted),
    num(r.ff_avg_speed),
    int(r.ff_avg_spin),
    num(r.ff_avg_break_x),
    num(r.ff_avg_break_z),
    num(r.ff_avg_break_z_induced),

    // SL
    str(r.n_sl_formatted),
    num(r.sl_avg_speed),
    int(r.sl_avg_spin),
    num(r.sl_avg_break_x),
    num(r.sl_avg_break_z),
    num(r.sl_avg_break_z_induced),

    // CH
    str(r.n_ch_formatted),
    num(r.ch_avg_speed),
    int(r.ch_avg_spin),
    num(r.ch_avg_break_x),
    num(r.ch_avg_break_z),
    num(r.ch_avg_break_z_induced),

    // CU
    str(r.n_cu_formatted),
    num(r.cu_avg_speed),
    int(r.cu_avg_spin),
    num(r.cu_avg_break_x),
    num(r.cu_avg_break_z),
    num(r.cu_avg_break_z_induced),

    // SI
    str(r.n_si_formatted),
    num(r.si_avg_speed),
    int(r.si_avg_spin),
    num(r.si_avg_break_x),
    num(r.si_avg_break_z),
    num(r.si_avg_break_z_induced),

    // FC
    str(r.n_fc_formatted),
    num(r.fc_avg_speed),
    int(r.fc_avg_spin),
    num(r.fc_avg_break_x),
    num(r.fc_avg_break_z),
    num(r.fc_avg_break_z_induced),

    // ST
    str(r.n_st_formatted),
    num(r.st_avg_speed),
    int(r.st_avg_spin),
    num(r.st_avg_break_x),
    num(r.st_avg_break_z),
    num(r.st_avg_break_z_induced),

    // FS
    str(r.n_fs_formatted),
    num(r.fs_avg_speed),
    int(r.fs_avg_spin),
    num(r.fs_avg_break_x),
    num(r.fs_avg_break_z),
    num(r.fs_avg_break_z_induced),

    // Group aggregates
    num(r.fastball_avg_speed),
    int(r.fastball_avg_spin),
    num(r.breaking_avg_speed),
    int(r.breaking_avg_spin),
    num(r.offspeed_avg_speed),
    int(r.offspeed_avg_spin),
  ];
}

const INSERT_SQL = `
  INSERT OR REPLACE INTO savant_pitcher_stats (
    mlb_id, name, season, player_age, pitch_hand,
    games, innings_pitched, pa, strikeouts, walks,
    k_percent, bb_percent, era, batting_avg_against, home_run, babip, quality_start,
    xba, xslg, woba, xwoba, xobp, xiso, wobacon, xwobacon, xbadiff, xslgdiff, wobadiff,
    exit_velocity_avg, launch_angle_avg, sweet_spot_percent, barrel, barrel_batted_rate,
    hard_hit_percent, groundballs_percent, flyballs_percent, linedrives_percent, popups_percent,
    whiff_percent, swing_percent, z_swing_percent, z_swing_miss_percent,
    oz_swing_percent, oz_swing_miss_percent, iz_contact_percent,
    f_strike_percent, meatball_percent, meatball_swing_percent,
    pitch_count, pitch_count_fastball, pitch_count_breaking, pitch_count_offspeed,
    ff_count, ff_avg_speed, ff_avg_spin, ff_avg_break_x, ff_avg_break_z, ff_avg_break_z_induced,
    sl_count, sl_avg_speed, sl_avg_spin, sl_avg_break_x, sl_avg_break_z, sl_avg_break_z_induced,
    ch_count, ch_avg_speed, ch_avg_spin, ch_avg_break_x, ch_avg_break_z, ch_avg_break_z_induced,
    cu_count, cu_avg_speed, cu_avg_spin, cu_avg_break_x, cu_avg_break_z, cu_avg_break_z_induced,
    si_count, si_avg_speed, si_avg_spin, si_avg_break_x, si_avg_break_z, si_avg_break_z_induced,
    fc_count, fc_avg_speed, fc_avg_spin, fc_avg_break_x, fc_avg_break_z, fc_avg_break_z_induced,
    st_count, st_avg_speed, st_avg_spin, st_avg_break_x, st_avg_break_z, st_avg_break_z_induced,
    fs_count, fs_avg_speed, fs_avg_spin, fs_avg_break_x, fs_avg_break_z, fs_avg_break_z_induced,
    fastball_avg_speed, fastball_avg_spin,
    breaking_avg_speed, breaking_avg_spin,
    offspeed_avg_speed, offspeed_avg_spin
  ) VALUES (
    ?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,?,?,?,?,?,?,
    ?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,?
  )
`;

// ---------------------
// Import from CSV file
// ---------------------

async function importFromCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ CSV not found: ${filePath}`);
    return 0;
  }

  console.log(`\n📂 Reading ${path.basename(filePath)}...`);

  const rows = [];
  await new Promise((resolve) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", resolve);
  });

  console.log(`   ${rows.length} rows found`);

  // Show year breakdown
  const byYear = {};
  rows.forEach(r => { byYear[r.year] = (byYear[r.year] || 0) + 1; });
  console.log(`   Years: ${Object.entries(byYear).map(([y,c]) => `${y}(${c})`).join(", ")}\n`);

  await runQuery("BEGIN TRANSACTION");

  let inserted = 0, failed = 0;

  for (const row of rows) {
    try {
      await runQuery(INSERT_SQL, rowToParams(row));
      inserted++;
    } catch (err) {
      console.error(`  ❌ ${row["last_name, first_name"]} ${row.year}: ${err.message}`);
      failed++;
    }
  }

  await runQuery("COMMIT");

  console.log(`✅ CSV import complete — ${inserted} rows inserted, ${failed} failed`);
  return inserted;
}

// ---------------------
// Scrape current season from Savant
// ---------------------

async function scrapeCurrentSeason() {
  console.log(`\n🌐 Scraping ${CURRENT_SEASON} season from Baseball Savant...`);

  const selections = [
    "player_age", "p_game", "p_formatted_ip", "pa", "strikeouts", "walks",
    "k_percent", "bb_percent", "batting_avg", "p_era", "home_run", "babip",
    "p_quality_start", "xba", "xslg", "woba", "xwoba", "xobp", "xiso",
    "wobacon", "xwobacon", "xbadiff", "xslgdiff", "wobadiff",
    "exit_velocity_avg", "launch_angle_avg", "sweet_spot_percent",
    "barrel", "barrel_batted_rate", "hard_hit_percent",
    "groundballs_percent", "flyballs_percent", "linedrives_percent", "popups_percent",
    "whiff_percent", "swing_percent", "z_swing_percent", "z_swing_miss_percent",
    "oz_swing_percent", "oz_swing_miss_percent", "iz_contact_percent",
    "f_strike_percent", "meatball_percent", "meatball_swing_percent",
    "pitch_count", "pitch_count_fastball", "pitch_count_breaking", "pitch_count_offspeed",
    "n_ff_formatted", "ff_avg_speed", "ff_avg_spin", "ff_avg_break_x", "ff_avg_break_z", "ff_avg_break_z_induced",
    "n_sl_formatted", "sl_avg_speed", "sl_avg_spin", "sl_avg_break_x", "sl_avg_break_z", "sl_avg_break_z_induced",
    "n_ch_formatted", "ch_avg_speed", "ch_avg_spin", "ch_avg_break_x", "ch_avg_break_z", "ch_avg_break_z_induced",
    "n_cu_formatted", "cu_avg_speed", "cu_avg_spin", "cu_avg_break_x", "cu_avg_break_z", "cu_avg_break_z_induced",
    "n_si_formatted", "si_avg_speed", "si_avg_spin", "si_avg_break_x", "si_avg_break_z", "si_avg_break_z_induced",
    "n_fc_formatted", "fc_avg_speed", "fc_avg_spin", "fc_avg_break_x", "fc_avg_break_z", "fc_avg_break_z_induced",
    "n_st_formatted", "st_avg_speed", "st_avg_spin", "st_avg_break_x", "st_avg_break_z", "st_avg_break_z_induced",
    "n_fs_formatted", "fs_avg_speed", "fs_avg_spin", "fs_avg_break_x", "fs_avg_break_z", "fs_avg_break_z_induced",
    "fastball_avg_speed", "fastball_avg_spin",
    "breaking_avg_speed", "breaking_avg_spin",
    "offspeed_avg_speed", "offspeed_avg_spin",
    "pitch_hand",
  ].join(",");

  const url =
    `https://baseballsavant.mlb.com/leaderboard/custom` +
    `?year=${CURRENT_SEASON}&type=pitcher&filter=&min=1` +
    `&selections=${selections}&chart=false&csv=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" }
  });

  if (!res.ok) {
    console.error(`❌ Savant request failed: HTTP ${res.status}`);
    return 0;
  }

  const text = await res.text();
  const lines = text.trim().split("\n");

  if (lines.length < 2) {
    console.log("⚠️  No data returned from Savant (season may not have started yet)");
    return 0;
  }

  // Parse CSV manually — same structure as the downloaded file
  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  const rows = lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.replace(/"/g, "").trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ""; });
    return obj;
  });

  console.log(`   ${rows.length} pitchers found for ${CURRENT_SEASON}`);

  // Delete existing current season rows before re-inserting
  await runQuery(`DELETE FROM savant_pitcher_stats WHERE season = ?`, [CURRENT_SEASON]);

  await runQuery("BEGIN TRANSACTION");
  let inserted = 0, failed = 0;

  for (const row of rows) {
    // Savant CSV uses same column names as download — map year manually
    row.year = String(CURRENT_SEASON);
    try {
      await runQuery(INSERT_SQL, rowToParams(row));
      inserted++;
    } catch (err) {
      console.error(`  ❌ ${row["last_name, first_name"]}: ${err.message}`);
      failed++;
    }
  }

  await runQuery("COMMIT");
  console.log(`✅ Current season scraped — ${inserted} pitchers inserted, ${failed} failed`);
  return inserted;
}

// ---------------------
// Main
// ---------------------

async function run() {
  console.log("═══════════════════════════════════════════");
  console.log("  Savant Pitcher Stats Import");
  console.log("═══════════════════════════════════════════");

  if (!currentOnly) {
    await importFromCsv(csvPath);
  }

  if (!csvOnly) {
    await scrapeCurrentSeason();
  }

  console.log("\n✅ All done.");
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});