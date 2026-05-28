const db = require("./db");
const fetch = require("node-fetch").default;

/* -------------------- DB HELPERS -------------------- */

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/* -------------------- HITTER RECENT IMPORT -------------------- */

async function importHitterRecent(hitter, season) {
  const windows = [5, 10, 20];

  const url = `https://statsapi.mlb.com/api/v1/people/${hitter.mlb_id}/stats/gameLog?season=${season}&group=hitting`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Node.js",
      "Accept": "application/json"
    }
  });

  const json = await res.json();

  if (!json.stats || !json.stats.length) return;

  const games = json.stats[0].splits;
  if (!games || !games.length) return;

  for (const window of windows) {
    const slice = games.slice(0, window); // most recent games FIRST

    let ab = 0,
      h = 0,
      bb = 0,
      tb = 0,
      so = 0,
      hr = 0,
      go = 0,
      fo = 0;

    for (const g of slice) {
      const s = g.stat;
      ab += Number(s.atBats) || 0;
      h += Number(s.hits) || 0;
      bb += Number(s.baseOnBalls) || 0;
      tb += Number(s.totalBases) || 0;
      so += Number(s.strikeOuts) || 0;
      hr += Number(s.homeRuns) || 0;
      go += Number(s.groundOuts) || 0;
      fo += Number(s.flyOuts) || 0;
    }

    if (!ab) continue;

    const avg = h / ab;
    const obp = (h + bb) / (ab + bb);
    const slg = tb / ab;
    const ops = obp + slg;
    const iso = slg - avg;
    const go_ao = fo ? go / fo : null;

    await dbRun(
      `
      INSERT OR REPLACE INTO hitter_recent_stats (
        mlb_id,
        name,
        team,
        position,
        season,
        window,
        games,
        avg,
        obp,
        slg,
        ops,
        iso,
        babip,
        strikeouts,
        walks,
        home_runs,
        groundout_airout
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        hitter.mlb_id,
        hitter.name,
        hitter.team,
        hitter.position,
        season,
        window,
        slice.length,
        avg.toFixed(3),
        obp.toFixed(3),
        slg.toFixed(3),
        ops.toFixed(3),
        iso.toFixed(3),
        null,
        so,
        bb,
        hr,
        go_ao ? go_ao.toFixed(2) : null
      ]
    );
  }
}

/* -------------------- RUNNER -------------------- */

async function run() {
  const season = 2026;

  console.log("Starting recent hitter stats import...");

  const hitters = await dbAll(
    `SELECT mlb_id, name, team, position FROM players WHERE position != 'P'`
  );

  console.log(`Found ${hitters.length} hitters`);

  for (const hitter of hitters) {
    try {
      await importHitterRecent(hitter, season);
      console.log(`✔ ${hitter.name}`);
    } catch (err) {
      console.error(`✖ ${hitter.name}`, err.message);
    }
  }

  console.log("✅ All hitter recent stats imported");
}

run();
