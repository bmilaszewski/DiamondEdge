/**
 * importHitterVsPitcher.js
 *
 * For every hitter in today's daily_lineups that has a resolved opposing pitcher,
 * fetches their career head-to-head stats from the MLB Stats API and stores them
 * in the hitter_vs_pitcher table.
 *
 * MLB Stats API endpoint used:
 *   /api/v1/people/{hitterId}/stats?stats=vsPlayer&opposingPlayerId={pitcherId}&group=hitting
 *
 * Run AFTER importDailyLineups.js:
 *   node importDailyLineups.js && node importHitterVsPitcher.js
 */

const db = require("./db");
const fetch = require("node-fetch").default;

// ---------------------
// DB Helpers
// ---------------------

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

// ---------------------
// Fetch head-to-head stats from MLB Stats API
// Returns the career stat split, or null if no data.
// ---------------------

async function fetchVsPlayerStats(hitterMlbId, pitcherMlbId) {
  const url =
    `https://statsapi.mlb.com/api/v1/people/${hitterMlbId}/stats` +
    `?stats=vsPlayer&opposingPlayerId=${pitcherMlbId}&group=hitting`;

  const res = await fetch(url);

  if (!res.ok) {
    console.log(`   ⚠️  HTTP ${res.status} for hitter ${hitterMlbId} vs pitcher ${pitcherMlbId}`);
    return null;
  }

  const data = await res.json();

  // The API returns an array of stat groups; find the one with splits
  if (!data.stats?.length) return null;

  for (const statGroup of data.stats) {
    if (statGroup.splits?.length) {
      // Each split is one season — sum them all for career totals
      return statGroup.splits;
    }
  }

  return null;
}

// ---------------------
// Aggregate all splits into career totals
// ---------------------

function aggregateSplits(splits) {
  let ab = 0, h = 0, doubles = 0, triples = 0, hr = 0;
  let rbi = 0, bb = 0, k = 0, tb = 0;

  for (const split of splits) {
    const s = split.stat;
    ab      += +s.atBats      || 0;
    h       += +s.hits        || 0;
    doubles += +s.doubles     || 0;
    triples += +s.triples     || 0;
    hr      += +s.homeRuns    || 0;
    rbi     += +s.rbi         || 0;
    bb      += +s.baseOnBalls || 0;
    k       += +s.strikeOuts  || 0;
    tb      += +s.totalBases  || 0;
  }

  if (ab === 0) return null; // No plate appearances — nothing useful to store

  const avg = +(h / ab).toFixed(3);
  const obp = +((h + bb) / (ab + bb || 1)).toFixed(3);
  const slg = +(tb / ab).toFixed(3);
  const ops = +(obp + slg).toFixed(3);

  return { ab, h, doubles, triples, hr, rbi, bb, k, tb, avg, obp, slg, ops };
}

// ---------------------
// Main
// ---------------------

async function run() {
  const today = new Date().toISOString().split("T")[0];
  const season = 2026;

  console.log(`\n🔍 Loading today's matchups from daily_lineups (${today})...\n`);

  // Pull every hitter that has a resolved opposing pitcher
  const matchups = await dbAll(
    `SELECT
       dl.mlb_id         AS hitter_mlb_id,
       dl.name           AS hitter_name,
       dl.team           AS hitter_team,
       dl.pitcher_mlb_id,
       dl.pitcher_name,
       dl.opponent       AS pitcher_team,
       dl.game_date
     FROM daily_lineups dl
     WHERE dl.batting_order > 0
       AND dl.pitcher_mlb_id IS NOT NULL
       AND dl.game_date = ?
     ORDER BY dl.team, dl.batting_order`,
    [today]
  );

  if (!matchups.length) {
    console.log("❌ No matchups found. Run importDailyLineups.js first.");
    return;
  }

  console.log(`Found ${matchups.length} hitter-pitcher matchups to process.\n`);

  // Clear today's existing hitter_vs_pitcher rows so we get a clean import
  await runQuery(
    `DELETE FROM hitter_vs_pitcher WHERE game_date = ?`,
    [today]
  );

  let inserted = 0;
  let noData   = 0;
  const CONCURRENCY = 10;

  async function processMatchup(m) {
    try {
      const splits = await fetchVsPlayerStats(m.hitter_mlb_id, m.pitcher_mlb_id);
      if (!splits) { noData++; return; }
      const totals = aggregateSplits(splits);
      if (!totals) { noData++; return; }
      await runQuery(
        `INSERT OR REPLACE INTO hitter_vs_pitcher
          (hitter_mlb_id, hitter_name, hitter_team,
           pitcher_mlb_id, pitcher_name, pitcher_team,
           game_date, season,
           at_bats, hits, doubles, triples, home_runs,
           rbi, walks, strikeouts, total_bases,
           avg, obp, slg, ops)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.hitter_mlb_id, m.hitter_name, m.hitter_team,
          m.pitcher_mlb_id, m.pitcher_name, m.pitcher_team,
          m.game_date, season,
          totals.ab, totals.h, totals.doubles, totals.triples, totals.hr,
          totals.rbi, totals.bb, totals.k, totals.tb,
          totals.avg, totals.obp, totals.slg, totals.ops,
        ]
      );
      inserted++;
    } catch (err) {
      console.log(`  ERROR ${m.hitter_name} vs ${m.pitcher_name}: ${err.message}`);
    }
  }

  for (let i = 0; i < matchups.length; i += CONCURRENCY) {
    await Promise.all(matchups.slice(i, i + CONCURRENCY).map(processMatchup));
    process.stdout.write(`  ${Math.min(i + CONCURRENCY, matchups.length)}/${matchups.length}\r`);
  }

  console.log(`\n✅ Done. ${inserted} matchups inserted, ${noData} with no prior history.\n`);
  process.exit(0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
