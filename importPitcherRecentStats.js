const db = require("./db");
const fetch = require("node-fetch").default;

// Promisify db.all
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Promisify db.run
function runQuery(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Convert baseball innings (5.1, 6.2) properly
function convertIP(ipString) {
  if (!ipString) return 0;

  const parts = ipString.split(".");
  const innings = parseInt(parts[0], 10);
  const outs = parts[1] ? parseInt(parts[1], 10) : 0;

  return innings + outs / 3;
}

// Convert true decimal back to baseball format (5.3333 → 5.1)
function formatBaseballIP(decimalIP) {
  const fullInnings = Math.floor(decimalIP);
  const remainder = decimalIP - fullInnings;

  const outs = Math.round(remainder * 3);

  if (outs === 0) return fullInnings;
  return parseFloat(`${fullInnings}.${outs}`);
}


// Fetch pitcher game logs
async function fetchPitcherGameLogs(mlbId, season) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=gameLog&group=pitching&season=${season}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.stats?.length) return [];
  return data.stats[0].splits || [];
}

// Import recent stats
async function importPitcherRecent(pitcher, season) {
  const windows = [5, 10, 20];
  let games = await fetchPitcherGameLogs(pitcher.mlb_id, season);

  if (!games.length) {
    console.log(`No pitching stats for ${pitcher.name}`);
    return;
  }

  // Sort newest → oldest
  games.sort((a, b) => new Date(b.date) - new Date(a.date));

  for (const window of windows) {
    const slice = games.slice(0, window);

    let g = 0,
      gs = 0,
      ip = 0,
      w = 0,
      l = 0,
      er = 0,
      k = 0,
      bb = 0,
      hr = 0;

    for (const game of slice) {
      const s = game.stat;

      g += 1;
      gs += +s.gamesStarted || 0;
      ip += convertIP(s.inningsPitched);
      w += +s.wins || 0;
      l += +s.losses || 0;
      er += +s.earnedRuns || 0;
      k += +s.strikeOuts || 0;
      bb += +s.baseOnBalls || 0;
      hr += +s.homeRuns || 0;
    }

    const era = ip ? ((er * 9) / ip).toFixed(2) : 0;
    const whip = ip ? ((bb + hr) / ip).toFixed(2) : 0;

    await runQuery(
      `INSERT OR REPLACE INTO pitcher_recent_stats
      (mlb_id, name, team, position, season, window,
       games, games_started, innings_pitched, wins, losses,
       era, whip, strikeouts, walks, home_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pitcher.mlb_id,
        pitcher.name,
        pitcher.team,
        pitcher.position,
        season,
        window,
        g,
        gs,
        formatBaseballIP(ip),
        w,
        l,
        era,
        whip,
        k,
        bb,
        hr,
      ]
    );

    console.log(
      `Inserted ${pitcher.name} - Last ${window}: ERA ${era}`
    );
  }
}

// Main runner
async function run() {
  const season = 2026;
  const CONCURRENCY = 10;

  const pitchers = await dbAll("SELECT * FROM players WHERE position='P'");
  console.log(`Found ${pitchers.length} pitchers`);

  for (let i = 0; i < pitchers.length; i += CONCURRENCY) {
    const batch = pitchers.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(p => importPitcherRecent(p, season).catch(err =>
      console.error(`Error importing ${p.name}`, err.message)
    )));
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, pitchers.length)}/${pitchers.length}\r`);
  }

  console.log("\nAll pitcher recent stats imported");
}

run();
