/**
 * importGameResults.js
 *
 * Parses Retrosheet game log files (GL####.TXT) into the game_results table.
 * This is the TRAINING LABELS for the ML model — every row is one game with
 * its outcome, conditions, and starting pitchers.
 *
 * Retrosheet field indices used:
 *   0  = date (YYYYMMDD)
 *   1  = game number (0=single, 1/2=DH)
 *   2  = day of week
 *   3  = visiting team (Retro code)
 *   6  = home team (Retro code)
 *   9  = visiting score
 *   10 = home score
 *   12 = day/night (D/N)
 *   13 = completion info
 *   16 = park ID
 *   17 = attendance
 *   18 = game time (minutes)
 *   101 = visiting SP Retro ID
 *   102 = visiting SP name
 *   103 = home SP Retro ID
 *   104 = home SP name
 *
 * USAGE:
 *   node importGameResults.js                    (imports all GL####.TXT in ./gamelogs)
 *   node importGameResults.js --dir ./gamelogs   (explicit directory)
 *   node importGameResults.js --year 2024        (single year only)
 */

const db   = require("./db");

// WAL mode allows concurrent reads while writing — prevents SQLITE_BUSY
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA synchronous=NORMAL");
db.run("PRAGMA cache_size=10000");

const fs   = require("fs");
const path = require("path");

// ---------------------
// Retrosheet team → modern abbreviation
// ---------------------
const RETRO_TO_MODERN = {
  ANA:"LAA", ARI:"AZ",  ATL:"ATL", BAL:"BAL", BOS:"BOS",
  CHA:"CWS", CHN:"CHC", CIN:"CIN", CLE:"CLE", COL:"COL",
  DET:"DET", FLO:"MIA", HOU:"HOU", KCA:"KC",  LAN:"LAD",
  MIA:"MIA", MIL:"MIL", MIN:"MIN", NYA:"NYY", NYN:"NYM",
  OAK:"ATH", PHI:"PHI", PIT:"PIT", SDN:"SD",  SEA:"SEA",
  SFN:"SF",  SLN:"STL", TBA:"TB",  TEX:"TEX", TOR:"TOR",
  WAS:"WSH", MON:"MON",
};

// ---------------------
// CLI args
// ---------------------
const args   = process.argv.slice(2);
const dirArg = args[args.indexOf("--dir") + 1] || path.join(__dirname, "gamelogs");
const yrArg  = args[args.indexOf("--year") + 1] || null;

// ---------------------
// DB helpers
// ---------------------
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
// Create game_results table
// ---------------------
async function createTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS game_results (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      game_date       TEXT NOT NULL,      -- YYYY-MM-DD
      season          INTEGER NOT NULL,
      game_number     INTEGER DEFAULT 0,  -- 0=single, 1/2=doubleheader
      day_night       TEXT,               -- D or N
      park_id         TEXT,

      -- Teams (modern abbreviations)
      home_team       TEXT NOT NULL,
      away_team       TEXT NOT NULL,

      -- Scores
      home_score      INTEGER,
      away_score      INTEGER,
      home_won        INTEGER,            -- 1 or 0
      total_runs      INTEGER,

      -- Starting pitchers (Retrosheet IDs — for crosswalk)
      home_sp_retro   TEXT,
      home_sp_name    TEXT,
      away_sp_retro   TEXT,
      away_sp_name    TEXT,

      -- Game context
      attendance      INTEGER,
      game_time_min   INTEGER,            -- length in minutes

      -- Run differential
      run_diff        INTEGER,            -- home - away (positive = home won by X)

      UNIQUE (game_date, home_team, game_number)
    )
  `);

  // Index for fast lookup by team + date
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_gr_home ON game_results(home_team, game_date)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_gr_away ON game_results(away_team, game_date)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_gr_date ON game_results(game_date)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_gr_season ON game_results(season)`);
}

// ---------------------
// Parse one CSV line (Retrosheet format, quoted fields)
// ---------------------
function parseLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { fields.push(cur); cur = ""; }
    else cur += ch;
  }
  fields.push(cur);
  return fields;
}

function f(fields, idx) {
  const v = fields[idx];
  return (v === undefined || v === "") ? null : v.trim();
}

function fi(fields, idx) {
  const v = f(fields, idx);
  if (v === null) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// ---------------------
// Import one GL####.TXT file
// ---------------------
async function importFile(filePath, year) {
  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(l => l.trim());

  let inserted = 0, skipped = 0, errors = 0;

  for (const line of lines) {
    const fields = parseLine(line);
    if (fields.length < 12) continue;

    const dateRaw = f(fields, 0);  // YYYYMMDD
    if (!dateRaw || dateRaw.length !== 8) continue;

    const gameDate = `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`;
    const season   = parseInt(dateRaw.slice(0,4), 10);

    const awayRetro = f(fields, 3);
    const homeRetro = f(fields, 6);
    if (!awayRetro || !homeRetro) continue;

    const homeTeam = RETRO_TO_MODERN[homeRetro] || homeRetro;
    const awayTeam = RETRO_TO_MODERN[awayRetro] || awayRetro;

    const homeScore = fi(fields, 10);
    const awayScore = fi(fields, 9);
    if (homeScore === null || awayScore === null) continue;
    if (homeScore === awayScore) continue; // skip ties

    const homeWon  = homeScore > awayScore ? 1 : 0;
    const gameNum  = fi(fields, 1) || 0;
    const dayNight = f(fields, 12);
    const parkId   = f(fields, 16);
    const attend   = fi(fields, 17);
    const gameTime = fi(fields, 18);

    // Starting pitchers (fields 101-104 in full game log format)
    const homeSPRetro = f(fields, 101);
    const homeSPName  = f(fields, 102);
    const awaySPRetro = f(fields, 103);
    const awaySPName  = f(fields, 104);

    try {
      await runQuery(`
        INSERT OR IGNORE INTO game_results
          (game_date, season, game_number, day_night, park_id,
           home_team, away_team,
           home_score, away_score, home_won, total_runs,
           home_sp_retro, home_sp_name, away_sp_retro, away_sp_name,
           attendance, game_time_min, run_diff)
        VALUES (?,?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?, ?,?,?)
      `, [
        gameDate, season, gameNum, dayNight, parkId,
        homeTeam, awayTeam,
        homeScore, awayScore, homeWon, homeScore + awayScore,
        homeSPRetro, homeSPName, awaySPRetro, awaySPName,
        attend, gameTime,
        homeScore - awayScore,
      ]);
      inserted++;
    } catch (err) {
      errors++;
      if (errors <= 3) console.error(`  ❌ ${gameDate} ${homeTeam} vs ${awayTeam}: ${err.message}`);
    }
  }

  return { inserted, skipped, errors, total: lines.length };
}

// ---------------------
// Build team rolling records (W/L, run diff, recent form)
// Used as features during training
// ---------------------
async function buildTeamRecords() {
  console.log("\n📊 Building team rolling records...");

  await runQuery(`DROP TABLE IF EXISTS team_records`);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS team_records (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      team           TEXT NOT NULL,
      game_date      TEXT NOT NULL,
      season         INTEGER NOT NULL,

      -- Season to date
      wins           INTEGER,
      losses         INTEGER,
      win_pct        REAL,
      runs_scored    INTEGER,
      runs_allowed   INTEGER,
      run_diff_total INTEGER,

      -- Rolling 10-game form
      l10_wins       INTEGER,
      l10_run_diff   INTEGER,

      -- Rolling 20-game form
      l20_wins       INTEGER,
      l20_run_diff   INTEGER,

      -- Pythagorean win% (RS^2 / (RS^2 + RA^2)) — better predictor than W/L
      pythag_wpct    REAL,

      UNIQUE (team, game_date)
    )
  `);

  // Get all teams and seasons
  const teamSeasons = await dbAll(`
    SELECT DISTINCT home_team as team, season FROM game_results
    UNION
    SELECT DISTINCT away_team as team, season FROM game_results
    ORDER BY season, team
  `);

  const total = teamSeasons.length;
  let done = 0;

  for (const { team, season } of teamSeasons) {
    // Get all games for this team this season, in order
    const games = await dbAll(`
      SELECT
        game_date,
        CASE WHEN home_team = ? THEN home_score ELSE away_score END as rs,
        CASE WHEN home_team = ? THEN away_score ELSE home_score END as ra,
        CASE WHEN home_team = ? THEN home_won
             ELSE (1 - home_won) END as won
      FROM game_results
      WHERE (home_team = ? OR away_team = ?) AND season = ?
      ORDER BY game_date
    `, [team, team, team, team, team, season]);

    let wins = 0, losses = 0, rs = 0, ra = 0;

    // Wrap each team-season in a transaction — critical for performance
    // and prevents SQLITE_BUSY from individual lock acquisitions
    await runQuery("BEGIN TRANSACTION");
    try {
      for (let i = 0; i < games.length; i++) {
        const g = games[i];
        // Compute BEFORE this game (what we'd know going in)
        const pythag = (rs + ra) > 0
          ? (rs ** 2) / (rs ** 2 + ra ** 2)
          : 0.5;

        const l10  = games.slice(Math.max(0, i-10), i);
        const l20  = games.slice(Math.max(0, i-20), i);
        const l10w  = l10.reduce((s, x) => s + x.won, 0);
        const l20w  = l20.reduce((s, x) => s + x.won, 0);
        const l10rd = l10.reduce((s, x) => s + (x.rs - x.ra), 0);
        const l20rd = l20.reduce((s, x) => s + (x.rs - x.ra), 0);

        await runQuery(`
          INSERT OR REPLACE INTO team_records
            (team, game_date, season, wins, losses, win_pct,
             runs_scored, runs_allowed, run_diff_total,
             l10_wins, l10_run_diff, l20_wins, l20_run_diff, pythag_wpct)
          VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?,?)
        `, [
          team, g.game_date, season,
          wins, losses, wins / Math.max(wins + losses, 1),
          rs, ra, rs - ra,
          l10w, l10rd, l20w, l20rd,
          pythag,
        ]);

        // Update running totals AFTER insert (we record pre-game state)
        if (g.won) wins++; else losses++;
        rs += g.rs;
        ra += g.ra;
      }
      await runQuery("COMMIT");
    } catch (err) {
      await runQuery("ROLLBACK");
      throw err;
    }

    done++;
    if (done % 50 === 0 || done === total) {
      process.stdout.write(`\r   ${done}/${total} team-seasons...`);
    }
  }
  console.log();

  const count = await dbAll("SELECT COUNT(*) as n FROM team_records");
  console.log(`   ✅ ${count[0].n} team-game records built`);
}

// ---------------------
// Crosswalk: link Retrosheet SP IDs to MLBAM IDs
// Uses the players table (name matching as fallback)
// ---------------------
async function buildSpCrosswalk() {
  console.log("\n🔗 Building SP Retrosheet→MLBAM crosswalk...");

  await runQuery(`
    CREATE TABLE IF NOT EXISTS retro_to_mlbam (
      retro_id    TEXT PRIMARY KEY,
      retro_name  TEXT,
      mlb_id      INTEGER,
      matched     INTEGER DEFAULT 0  -- 1=exact, 2=fuzzy, 0=unmatched
    )
  `);

  // Get all unique SP retro IDs from game_results
  const sps = await dbAll(`
    SELECT DISTINCT home_sp_retro as retro_id, home_sp_name as retro_name
    FROM game_results WHERE home_sp_retro IS NOT NULL
    UNION
    SELECT DISTINCT away_sp_retro, away_sp_name
    FROM game_results WHERE away_sp_retro IS NOT NULL
  `);

  let matched = 0, unmatched = 0;

  for (const sp of sps) {
    if (!sp.retro_id) continue;

    // Try exact name match in players table
    // Retrosheet names: "Last, First" → we need "First Last"
    let name = sp.retro_name || "";
    if (name.includes(",")) {
      const [last, first] = name.split(",").map(s => s.trim());
      name = `${first} ${last}`.trim();
    }

    const player = await dbAll(
      `SELECT mlb_id FROM players WHERE name = ? AND position = 'P' LIMIT 1`,
      [name]
    );

    if (player.length) {
      await runQuery(`
        INSERT OR REPLACE INTO retro_to_mlbam (retro_id, retro_name, mlb_id, matched)
        VALUES (?, ?, ?, 1)
      `, [sp.retro_id, sp.retro_name, player[0].mlb_id]);
      matched++;
    } else {
      // Fuzzy: try last name only
      const lastName = name.split(" ").slice(-1)[0];
      const fuzzy = await dbAll(
        `SELECT mlb_id, name FROM players WHERE name LIKE ? AND position = 'P' LIMIT 1`,
        [`%${lastName}%`]
      );

      if (fuzzy.length) {
        await runQuery(`
          INSERT OR REPLACE INTO retro_to_mlbam (retro_id, retro_name, mlb_id, matched)
          VALUES (?, ?, ?, 2)
        `, [sp.retro_id, sp.retro_name, fuzzy[0].mlb_id]);
        matched++;
      } else {
        await runQuery(`
          INSERT OR IGNORE INTO retro_to_mlbam (retro_id, retro_name, mlb_id, matched)
          VALUES (?, ?, NULL, 0)
        `, [sp.retro_id, sp.retro_name]);
        unmatched++;
      }
    }
  }

  console.log(`   ✅ ${matched} pitchers matched, ${unmatched} unmatched`);
}

// ---------------------
// Main
// ---------------------
async function run() {
  const logsDir = path.resolve(dirArg);

  if (!fs.existsSync(logsDir)) {
    console.error(`❌ Directory not found: ${logsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(logsDir)
    .filter(f => /^GL\d{4}\.TXT$/i.test(f))
    .filter(f => !yrArg || f.includes(yrArg))
    .sort();

  if (!files.length) {
    console.error(`❌ No GL####.TXT files found in ${logsDir}`);
    process.exit(1);
  }

  console.log(`\n⚾  Game Results Import`);
  console.log(`   Directory: ${logsDir}`);
  console.log(`   Files found: ${files.length}\n`);

  await createTable();

  let totalInserted = 0, totalErrors = 0;

  for (const file of files) {
    const year = parseInt(file.match(/\d{4}/)[0], 10);
    process.stdout.write(`  ${file}  →  `);

    const result = await importFile(path.join(logsDir, file), year);
    totalInserted += result.inserted;
    totalErrors   += result.errors;

    console.log(`${result.inserted} games`);
  }

  console.log(`\n✅ Total: ${totalInserted} games imported`);

  await buildTeamRecords();
  await buildSpCrosswalk();

  // Summary
  const counts = await dbAll(`
    SELECT season, COUNT(*) as games,
           ROUND(AVG(home_won)*100, 1) as home_win_pct,
           ROUND(AVG(total_runs), 2) as avg_runs
    FROM game_results
    GROUP BY season ORDER BY season
  `);

  console.log("\n📊 Season breakdown:");
  console.log("   Season  Games   HW%   Avg Runs");
  for (const r of counts) {
    console.log(`   ${r.season}   ${String(r.games).padStart(5)}   ${r.home_win_pct}%   ${r.avg_runs}`);
  }

  process.exit(0);
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});