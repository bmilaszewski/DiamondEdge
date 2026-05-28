/**
 * importParkFactors.js
 *
 * Computes multi-year park factors from game_results and scrapes
 * umpire tendency data from Baseball Savant.
 *
 * Park factor: how much a park inflates/deflates run scoring
 * relative to league average. 100 = neutral, 115 = 15% more runs (Coors).
 *
 * Also builds an umpire_tendencies table from the HP umpire fields
 * in Retrosheet game logs (fields 105-106).
 *
 * Run AFTER importGameResults.js.
 *
 * USAGE:
 *   node importParkFactors.js
 */

const db   = require("./db");
const fetch = require("node-fetch").default;

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); });
  });
}

// ---------------------
// Park factors from game_results
// 3-year rolling average is standard in baseball analytics
// ---------------------
async function buildParkFactors() {
  console.log("\n🏟️  Building park factors...");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS park_factors (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      park_id         TEXT NOT NULL,
      season          INTEGER NOT NULL,
      home_team       TEXT,

      -- Run factor (100 = league avg)
      run_factor      REAL,   -- 3-year rolling
      run_factor_1yr  REAL,   -- single season

      -- HR factor
      hr_factor       REAL,

      -- Game count used
      games_home      INTEGER,

      UNIQUE (park_id, season)
    )
  `);

  // Get all park-season combos
  const parkSeasons = await dbAll(`
    SELECT park_id, season, home_team,
           COUNT(*) as games,
           SUM(home_score + away_score) as total_runs,
           SUM(home_score + away_score) * 1.0 / COUNT(*) as rpg
    FROM game_results
    WHERE park_id IS NOT NULL
    GROUP BY park_id, season
    ORDER BY park_id, season
  `);

  // League average RPG by season
  const leagueAvg = {};
  const leagueRows = await dbAll(`
    SELECT season,
           SUM(home_score + away_score) * 1.0 / COUNT(*) as rpg
    FROM game_results GROUP BY season
  `);
  for (const r of leagueRows) leagueAvg[r.season] = r.rpg;

  // Group by park
  const byPark = {};
  for (const r of parkSeasons) {
    if (!byPark[r.park_id]) byPark[r.park_id] = [];
    byPark[r.park_id].push(r);
  }

  let inserted = 0;
  for (const [parkId, seasons] of Object.entries(byPark)) {
    for (let i = 0; i < seasons.length; i++) {
      const s = seasons[i];
      const lgAvg = leagueAvg[s.season] || 9.0;

      // 1-year factor
      const factor1yr = s.rpg / lgAvg * 100;

      // 3-year rolling (current + previous 2)
      const window = seasons.slice(Math.max(0, i - 2), i + 1);
      const totalRuns  = window.reduce((sum, x) => sum + x.total_runs, 0);
      const totalGames = window.reduce((sum, x) => sum + x.games, 0);
      const avgLg = window.reduce((sum, x) => sum + (leagueAvg[x.season] || 9.0), 0) / window.length;
      const factor3yr = (totalRuns / totalGames) / avgLg * 100;

      await runQuery(`
        INSERT OR REPLACE INTO park_factors
          (park_id, season, home_team, run_factor, run_factor_1yr, games_home)
        VALUES (?,?,?,?,?,?)
      `, [parkId, s.season, s.home_team, factor3yr, factor1yr, s.games]);
      inserted++;
    }
  }

  console.log(`   ✅ ${inserted} park-season factors computed`);

  // Show extreme parks
  const extremes = await dbAll(`
    SELECT park_id, home_team, season, run_factor
    FROM park_factors
    WHERE season = (SELECT MAX(season) FROM park_factors)
    ORDER BY run_factor DESC LIMIT 5
  `);
  console.log("   Top run-scoring parks (current season):");
  for (const p of extremes) {
    console.log(`     ${p.park_id} (${p.home_team}): ${p.run_factor?.toFixed(1)}`);
  }
}

// ---------------------
// Umpire tendencies from Baseball Savant
// Scrapes the umpire metrics leaderboard
// ---------------------
async function buildUmpireTendencies() {
  console.log("\n👨‍⚖️  Building umpire tendencies...");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS umpire_tendencies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      umpire_name  TEXT NOT NULL,
      season       INTEGER NOT NULL,

      -- Relative to league average
      k_rate_delta  REAL,   -- K% above/below avg (positive = more Ks)
      bb_rate_delta REAL,   -- BB% above/below avg
      run_rate      REAL,   -- runs per game in their games

      -- Raw
      total_games   INTEGER,
      total_pitches INTEGER,

      UNIQUE (umpire_name, season)
    )
  `);

  // Try Baseball Savant umpire leaderboard
  const season = new Date().getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/umpire-scorecard?year=${season}&type=hp&csv=true`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) {
      console.log(`   ⚠️  Savant umpire endpoint returned ${res.status} — skipping`);
      return;
    }

    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) {
      console.log("   ⚠️  No umpire data returned");
      return;
    }

    const headers = lines[0].replace(/"/g, "").split(",").map(h => h.trim().toLowerCase());
    const rows = lines.slice(1).map(line => {
      const vals = line.replace(/"/g, "").split(",").map(v => v.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
      return obj;
    });

    let inserted = 0;
    for (const row of rows) {
      const name = row.umpire || row.name || row.umpire_name;
      if (!name) continue;

      await runQuery(`
        INSERT OR REPLACE INTO umpire_tendencies
          (umpire_name, season, k_rate_delta, bb_rate_delta, total_games)
        VALUES (?,?,?,?,?)
      `, [
        name, season,
        parseFloat(row.k_pct_delta || row.k_percent_above || 0) || null,
        parseFloat(row.bb_pct_delta || row.bb_percent_above || 0) || null,
        parseInt(row.games || row.total_games || 0) || null,
      ]);
      inserted++;
    }

    console.log(`   ✅ ${inserted} umpire records imported`);
  } catch (err) {
    console.log(`   ⚠️  Umpire scrape failed: ${err.message}`);
  }
}

// ---------------------
// Rest days and travel features
// Computed from game_results — how many days off before each game
// ---------------------
async function buildRestAndTravel() {
  console.log("\n✈️  Building rest/travel features...");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS team_rest_travel (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      team           TEXT NOT NULL,
      game_date      TEXT NOT NULL,
      season         INTEGER NOT NULL,

      rest_days      INTEGER,   -- days since last game (0 = back-to-back)
      is_home        INTEGER,   -- 1 if home team
      prev_was_home  INTEGER,   -- 1 if previous game was at home
      travel_flag    INTEGER,   -- 1 if switching home/away

      UNIQUE (team, game_date)
    )
  `);

  const teams = await dbAll(`
    SELECT DISTINCT home_team as team FROM game_results
    UNION SELECT DISTINCT away_team FROM game_results
  `);

  let total = 0;
  for (const { team } of teams) {
    const games = await dbAll(`
      SELECT game_date, season,
             CASE WHEN home_team = ? THEN 1 ELSE 0 END as is_home
      FROM game_results
      WHERE home_team = ? OR away_team = ?
      ORDER BY game_date
    `, [team, team, team]);

    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const prev = games[i - 1];

      let restDays = null;
      let prevWasHome = null;
      let travelFlag = 0;

      if (prev) {
        const d1 = new Date(prev.game_date);
        const d2 = new Date(g.game_date);
        restDays = Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) - 1;
        prevWasHome = prev.is_home;
        travelFlag = prev.is_home !== g.is_home ? 1 : 0;
      }

      await runQuery(`
        INSERT OR REPLACE INTO team_rest_travel
          (team, game_date, season, rest_days, is_home, prev_was_home, travel_flag)
        VALUES (?,?,?,?,?,?,?)
      `, [team, g.game_date, g.season, restDays, g.is_home, prevWasHome, travelFlag]);
      total++;
    }
  }

  console.log(`   ✅ ${total} rest/travel records built`);
}

// ---------------------
// Main
// ---------------------
async function run() {
  const gameCount = await dbAll("SELECT COUNT(*) as n FROM game_results");
  if (!gameCount[0]?.n) {
    console.error("❌ game_results table is empty. Run importGameResults.js first.");
    process.exit(1);
  }
  console.log(`\n⚾  Contextual Features Builder`);
  console.log(`   Using ${gameCount[0].n} games from game_results\n`);

  await buildParkFactors();
  await buildUmpireTendencies();
  await buildRestAndTravel();

  console.log("\n✅ All contextual features built.");
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});