const db = require("./db");

// ---------- PROMISE WRAPPERS ----------

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// ---------- IMPORT HITTER RECENT STATS ----------

async function importHitterRecentStats(player, season) {
  try {
    console.log(`\nFetching recent stats for ${player.name}`);

    const windows = [5, 10, 20];

    const url = `https://statsapi.mlb.com/api/v1/people/${player.mlb_id}/stats?stats=gameLog&group=hitting&season=${season}`;

    const res = await fetch(url);

    if (!res.ok) {
      console.log(`❌ Failed request for ${player.name}`);
      return;
    }

    const json = await res.json();

    if (!json.stats || !json.stats.length || !json.stats[0].splits) {
      console.log(`No game logs for ${player.name}`);
      return;
    }

    let games = json.stats[0].splits;

    if (!games.length) {
      console.log(`No splits for ${player.name}`);
      return;
    }

    // Remove future games just in case
    const today = new Date();
    games = games.filter(g => new Date(g.date) <= today);

    // Sort newest → oldest
    games.sort((a, b) => new Date(b.date) - new Date(a.date));

    for (const window of windows) {
      const slice = games.slice(0, window);
      if (!slice.length) continue;

      let ab = 0, h = 0, bb = 0, tb = 0, k = 0, hr = 0, go = 0, fo = 0;

      for (const g of slice) {
        const s = g.stat;

        ab += Number(s.atBats || 0);
        h  += Number(s.hits || 0);
        bb += Number(s.baseOnBalls || 0);
        tb += Number(s.totalBases || 0);
        k  += Number(s.strikeOuts || 0);
        hr += Number(s.homeRuns || 0);
        go += Number(s.groundOuts || 0);
        fo += Number(s.flyOuts || 0);
      }

      if (ab === 0) {
        console.log(`${player.name} has 0 AB in last ${window}`);
        continue;
      }

      const avg   = parseFloat((h / ab).toFixed(3));
      const obp   = parseFloat(((h + bb) / (ab + bb)).toFixed(3));
      const slg   = parseFloat((tb / ab).toFixed(3));
      const ops   = parseFloat((obp + slg).toFixed(3));
      const iso   = parseFloat((slg - avg).toFixed(3));
      const go_ao = fo ? parseFloat((go / fo).toFixed(3)) : null;

      console.log(
        `Inserting ${player.name} - Last ${window}: AVG ${avg.toFixed(3)}`
      );

      await runQuery(`
        INSERT OR REPLACE INTO hitter_recent_stats
        (mlb_id, name, team, position, season, window, games, at_bats, hits,
         avg, obp, slg, ops, iso,
         strikeouts, walks, home_runs, groundout_airout)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        player.mlb_id,
        player.name,
        player.team,
        player.position,
        season,
        window,
        slice.length,
        ab,
        h,
        avg,
        obp,
        slg,
        ops,
        iso,
        k,
        bb,
        hr,
        go_ao
      ]);
    }

  } catch (err) {
    console.error(`Error importing ${player.name}`, err);
  }
}

// ---------- MAIN RUN FUNCTION ----------

async function run() {
  console.log("Starting recent hitter import...\n");

  const season = 2026;
  const CONCURRENCY = 10;

  const hitters = await dbAll(`SELECT * FROM players WHERE position != 'P'`);
  console.log(`Found ${hitters.length} hitters`);

  for (let i = 0; i < hitters.length; i += CONCURRENCY) {
    const batch = hitters.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(p => importHitterRecentStats(p, season)));
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, hitters.length)}/${hitters.length}\r`);
  }

  console.log("\nFinished importing recent hitter stats.");
  process.exit();
}

// ---------- EXECUTE ----------

run().catch(err => {
  console.error("Fatal error:", err);
});
