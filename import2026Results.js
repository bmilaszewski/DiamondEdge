/**
 * import2026Results.js
 *
 * Fetches completed 2026 MLB game scores from the ESPN scoreboard API and
 * inserts them into the game_results table. This is the critical fix for
 * rolling-window staleness: predict_today builds L5/L15/L30 windows from
 * game_results, but that table previously ended at 2025-09-28.
 *
 * USAGE:
 *   node import2026Results.js                        (2026-04-01 → yesterday)
 *   node import2026Results.js --start 2026-04-15     (specific start date)
 *   node import2026Results.js --date 2026-05-10      (single date)
 */

const db = require("./db");
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA synchronous=NORMAL");

let nodeFetch;
try { nodeFetch = require("node-fetch").default; } catch (_) {}

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ── ESPN team abbreviation → game_results abbreviation ──────────────────────
const ESPN_ABBR_MAP = {
  ARI: "AZ",  AZ: "AZ",   ATL: "ATL", BAL: "BAL", BOS: "BOS",
  CHC: "CHC", CWS: "CWS", CHW: "CWS", CIN: "CIN", CLE: "CLE",
  COL: "COL", DET: "DET", HOU: "HOU", KC:  "KC",  KCR: "KC",
  LAA: "LAA", LAD: "LAD", MIA: "MIA", MIL: "MIL", MIN: "MIN",
  NYM: "NYM", NYY: "NYY", OAK: "ATH", ATH: "ATH", PHI: "PHI",
  PIT: "PIT", SD:  "SD",  SDP: "SD",  SF:  "SF",  SFG: "SF",
  SEA: "SEA", STL: "STL", TB:  "TB",  TBR: "TB",  TEX: "TEX",
  TOR: "TOR", WSH: "WSH", WSN: "WSH",
};

const ESPN_NAME_MAP = {
  "Arizona Diamondbacks": "AZ",   "Atlanta Braves": "ATL",
  "Baltimore Orioles": "BAL",     "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC",          "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN",       "Cleveland Guardians": "CLE",
  "Colorado Rockies": "COL",      "Detroit Tigers": "DET",
  "Houston Astros": "HOU",        "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA",    "Los Angeles Dodgers": "LAD",
  "Miami Marlins": "MIA",         "Milwaukee Brewers": "MIL",
  "Minnesota Twins": "MIN",       "New York Mets": "NYM",
  "New York Yankees": "NYY",      "Oakland Athletics": "ATH",
  "Athletics": "ATH",             "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT",    "San Diego Padres": "SD",
  "San Francisco Giants": "SF",   "Seattle Mariners": "SEA",
  "St. Louis Cardinals": "STL",   "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX",         "Toronto Blue Jays": "TOR",
  "Washington Nationals": "WSH",
};

function normTeam(name, abbr) {
  if (abbr) {
    const mapped = ESPN_ABBR_MAP[abbr.trim().toUpperCase()];
    if (mapped) return mapped;
  }
  if (name) {
    const full = ESPN_NAME_MAP[name.trim()];
    if (full) return full;
    // Try last word (nickname)
    const nick = name.trim().split(" ").slice(-1)[0];
    for (const [k, v] of Object.entries(ESPN_NAME_MAP)) {
      if (k.split(" ").slice(-1)[0] === nick) return v;
    }
  }
  return null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function run(sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function(e) { e ? rej(e) : res(this); }));
}
function all(sql, params = []) {
  return new Promise((res, rej) => db.all(sql, params, (e, r) => { e ? rej(e) : res(r); }));
}
function get(sql, params = []) {
  return new Promise((res, rej) => db.get(sql, params, (e, r) => { e ? rej(e) : res(r); }));
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function dateRange(startStr, endStr) {
  const dates = [];
  const cur = new Date(startStr + "T12:00:00Z");
  const end = new Date(endStr + "T12:00:00Z");
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── Fetch ESPN scoreboard for one date ───────────────────────────────────────
async function fetchEspnScores(date) {
  if (!nodeFetch) throw new Error("node-fetch not available");
  const compact = date.replace(/-/g, "");
  const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${compact}&limit=30`;
  const res = await nodeFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).events || [];
}

// ── Extract completed games from ESPN events ──────────────────────────────────
function extractGames(events, date) {
  const seenPairs = {};
  const games = [];

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    const state = comp.status?.type?.state || "pre";
    if (state !== "post") continue; // only completed games

    let homeTeam = null, awayTeam = null, homeScore = null, awayScore = null;
    let homeSpName = null, awaySpName = null;

    for (const c of (comp.competitors || [])) {
      const t = normTeam(
        c.team?.displayName || c.team?.name || "",
        c.team?.abbreviation || ""
      );
      const sc = c.score != null ? parseInt(c.score, 10) : null;
      if (c.homeAway === "home") { homeTeam = t; homeScore = sc; }
      else { awayTeam = t; awayScore = sc; }

      // SP names from probables (if ESPN returns them for post games)
      const prob = (c.probables || [])[0];
      if (prob?.athlete?.displayName) {
        if (c.homeAway === "home") homeSpName = prob.athlete.displayName;
        else awaySpName = prob.athlete.displayName;
      }
    }

    if (!homeTeam || !awayTeam || homeScore == null || awayScore == null) continue;
    if (homeScore === awayScore) continue; // no ties in MLB (extra innings always decides)

    const pairKey = `${awayTeam}|${homeTeam}`;
    seenPairs[pairKey] = (seenPairs[pairKey] || 0) + 1;
    const gameNumber = seenPairs[pairKey];

    games.push({
      game_date:   date,
      season:      parseInt(date.slice(0, 4), 10),
      game_number: gameNumber,
      home_team:   homeTeam,
      away_team:   awayTeam,
      home_score:  homeScore,
      away_score:  awayScore,
      home_won:    homeScore > awayScore ? 1 : 0,
      total_runs:  homeScore + awayScore,
      run_diff:    homeScore - awayScore,
      home_sp:     homeSpName,
      away_sp:     awaySpName,
    });
  }

  return games;
}

// ── Look up SP names from historical_lineups ──────────────────────────────────
async function enrichSpNames(games) {
  for (const g of games) {
    if (g.home_sp && g.away_sp) continue;

    // In historical_lineups:
    //   pitcher_name for AWAY team = HOME SP (the pitcher the away team faces)
    //   pitcher_name for HOME team = AWAY SP (the pitcher the home team faces)
    const awayRow = await get(
      `SELECT pitcher_name FROM historical_lineups
       WHERE game_date=? AND team=? AND is_home=0 AND pitcher_name IS NOT NULL LIMIT 1`,
      [g.game_date, g.away_team]
    );
    const homeRow = await get(
      `SELECT pitcher_name FROM historical_lineups
       WHERE game_date=? AND team=? AND is_home=1 AND pitcher_name IS NOT NULL LIMIT 1`,
      [g.game_date, g.home_team]
    );

    if (!g.home_sp && awayRow?.pitcher_name) g.home_sp = awayRow.pitcher_name;
    if (!g.away_sp && homeRow?.pitcher_name) g.away_sp = homeRow.pitcher_name;
  }
  return games;
}

// ── Look up park_id from last known game at that venue ────────────────────────
async function enrichParkIds(games) {
  const cache = {};
  for (const g of games) {
    if (!cache[g.home_team]) {
      const row = await get(
        `SELECT park_id FROM game_results
         WHERE home_team=? AND park_id IS NOT NULL
         ORDER BY season DESC, game_date DESC LIMIT 1`,
        [g.home_team]
      );
      cache[g.home_team] = row?.park_id || null;
    }
    g.park_id = cache[g.home_team];
  }
  return games;
}

// ── Insert one game into game_results ─────────────────────────────────────────
async function insertGame(g) {
  await run(`
    INSERT OR IGNORE INTO game_results
      (game_date, season, game_number, day_night, park_id,
       home_team, away_team,
       home_score, away_score, home_won, total_runs,
       home_sp_name, away_sp_name,
       run_diff)
    VALUES (?,?,?,NULL,?, ?,?, ?,?,?,?, ?,?, ?)
  `, [
    g.game_date, g.season, g.game_number, g.park_id,
    g.home_team, g.away_team,
    g.home_score, g.away_score, g.home_won, g.total_runs,
    g.home_sp || null, g.away_sp || null,
    g.run_diff,
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const defaultEnd = yesterday.toISOString().slice(0, 10);

  const singleDate = argVal("--date");
  const startDate  = singleDate || argVal("--start") || "2026-04-01";
  const endDate    = singleDate || defaultEnd;

  const dates = dateRange(startDate, endDate);

  console.log(`\n⚾  Import 2026 Game Results from ESPN`);
  console.log(`   Range: ${startDate} → ${endDate} (${dates.length} dates)\n`);

  let totalInserted = 0, totalSkipped = 0, totalErrors = 0;

  for (const date of dates) {
    process.stdout.write(`  ${date}  `);
    try {
      const events = await fetchEspnScores(date);
      let games = extractGames(events, date);

      if (games.length === 0) {
        console.log(`→ 0 completed games`);
        continue;
      }

      // Enrich with SP names from historical_lineups + park_ids
      games = await enrichSpNames(games);
      games = await enrichParkIds(games);

      let inserted = 0, skipped = 0;
      for (const g of games) {
        const before = await get(
          "SELECT id FROM game_results WHERE game_date=? AND home_team=? AND game_number=?",
          [g.game_date, g.home_team, g.game_number]
        );
        await insertGame(g);
        if (!before) inserted++;
        else skipped++;
      }

      totalInserted += inserted;
      totalSkipped  += skipped;
      console.log(`→ ${inserted} inserted, ${skipped} already existed  (${games.map(g=>`${g.away_team}@${g.home_team} ${g.away_score}-${g.home_score}`).join(", ")})`);

      // Slight delay to avoid rate-limiting
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      totalErrors++;
      console.log(`→ ERROR: ${err.message}`);
    }
  }

  console.log(`\n✅ Done: ${totalInserted} inserted, ${totalSkipped} already existed, ${totalErrors} date errors`);

  // Show updated season breakdown
  const counts = await all(`
    SELECT season, COUNT(*) as games
    FROM game_results WHERE season >= 2025
    GROUP BY season ORDER BY season
  `);
  console.log("\n📊 game_results 2025+ breakdown:");
  for (const r of counts) {
    console.log(`   ${r.season}:  ${r.games} games`);
  }

  db.close();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
