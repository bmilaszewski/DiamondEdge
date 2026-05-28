const db = require("./db");
const fetch = require("node-fetch").default;
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const SEASON = 2026;

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
// Fetch Season Stats (hitters)
// ---------------------

async function fetchSeasonStats(mlbId) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=season&season=${SEASON}&group=hitting`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.stats?.length || !data.stats[0].splits?.length) return null;
  return data.stats[0].splits[0].stat;
}

// ---------------------
// Pitch Arsenal — MLB Stats API
//
// pitchArsenal has no career endpoint — season param is required.
// To approximate career tendencies we fetch the last 3 seasons and
// weighted-average usage %. Velocity/spin use the most recent season
// that has data (these change year-to-year so older values aren't useful).
// ---------------------

async function fetchArsenalForSeason(mlbId, season) {
  const url =
    `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats` +
    `?stats=pitchArsenal&season=${season}&group=pitching`;

  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.stats?.length || !data.stats[0].splits?.length) return [];

  return data.stats[0].splits
    .filter(split => split.stat?.type?.code)
    .map((split) => {
      const s = split.stat;
      return {
        pitch_type:    s.type.code,
        pitch_name:    s.type.displayName  || null,
        usage_pct:     s.percentage   != null ? s.percentage   : null,
        avg_velocity:  s.averageSpeed != null ? s.averageSpeed : null,
        avg_spin_rate: s.averageSpin  != null ? s.averageSpin  : null,
      };
    });
}

async function fetchArsenalFromMlbApi(mlbId) {
  // Fetch last 3 seasons — current first so it gets priority for velocity/spin
  const seasons = [SEASON, SEASON - 1, SEASON - 2];
  const byPitchType = {};  // pitch_type -> aggregated data

  for (const season of seasons) {
    const pitches = await fetchArsenalForSeason(mlbId, season);

    for (const p of pitches) {
      if (!byPitchType[p.pitch_type]) {
        // First time seeing this pitch — seed it
        byPitchType[p.pitch_type] = {
          pitch_type:       p.pitch_type,
          pitch_name:       p.pitch_name,
          usage_weighted:   0,   // sum of (usage * weight)
          weight_total:     0,   // sum of weights
          avg_velocity:     null,
          avg_spin_rate:    null,
          seasons_seen:     0,
        };
      }

      const entry = byPitchType[p.pitch_type];

      // Resolve pitch name from whichever season has it
      if (!entry.pitch_name && p.pitch_name) {
        entry.pitch_name = p.pitch_name;
      }

      // Weight recent seasons more: current=3, last=2, two ago=1
      const weight = seasons.length - seasons.indexOf(season);
      if (p.usage_pct != null) {
        entry.usage_weighted += p.usage_pct * weight;
        entry.weight_total   += weight;
      }

      // Use most recent season's velocity and spin (only set on first encounter)
      if (entry.avg_velocity  == null && p.avg_velocity  != null) entry.avg_velocity  = p.avg_velocity;
      if (entry.avg_spin_rate == null && p.avg_spin_rate != null) entry.avg_spin_rate = p.avg_spin_rate;

      entry.seasons_seen++;
    }
  }

  return Object.values(byPitchType).map(entry => ({
    pitch_type:    entry.pitch_type,
    pitch_name:    entry.pitch_name,
    usage_pct:     entry.weight_total > 0
                     ? parseFloat((entry.usage_weighted / entry.weight_total).toFixed(3))
                     : null,
    avg_velocity:  entry.avg_velocity  != null ? parseFloat(entry.avg_velocity.toFixed(1))  : null,
    avg_spin_rate: entry.avg_spin_rate != null ? Math.round(entry.avg_spin_rate)             : null,
  })).filter(p => p.pitch_type);
}

// ---------------------
// Pitch Arsenal — Baseball Savant enrichment
// Tries current season first, falls back to previous seasons
// until it finds data with a meaningful pitch count
// ---------------------

async function fetchSavantForSeason(mlbId, season) {
  try {
    const url =
      `https://baseballsavant.mlb.com/player-services/statcast-pitching` +
      `?playerId=${mlbId}&season=${season}&type=pitcher`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;

    // Require at least 50 pitches of data to consider it valid
    const hasEnoughData = data.some(p => (p.pitches || 0) >= 50);
    if (!hasEnoughData) return null;

    return data;
  } catch {
    return null;
  }
}

async function fetchSavantEnrichment(mlbId) {
  const seasons = [SEASON, SEASON - 1, SEASON - 2];

  for (const season of seasons) {
    const data = await fetchSavantForSeason(mlbId, season);
    if (!data) continue;

    const enrichment = {};
    for (const pitch of data) {
      if (!pitch.pitch_type) continue;
      enrichment[pitch.pitch_type] = {
        whiff_pct:    pitch.whiff_percent != null ? parseFloat((pitch.whiff_percent / 100).toFixed(3)) : null,
        put_away_pct: pitch.put_away      != null ? parseFloat((pitch.put_away      / 100).toFixed(3)) : null,
        ba_against:   pitch.batting_avg   != null ? parseFloat(pitch.batting_avg.toFixed(3))           : null,
        slg_against:  pitch.slg          != null ? parseFloat(pitch.slg.toFixed(3))                    : null,
      };
    }

    if (Object.keys(enrichment).length) {
      if (season < SEASON) {
        console.log(`  (using ${season} Savant data — current season insufficient)`);
      }
      return enrichment;
    }
  }

  return {};
}

// ---------------------
// Import Arsenal for all pitchers
// ---------------------

// async function importArsenalForAllPitchers(pitcherByTeam, gameDate) {
//   console.log("\n⚾ Fetching pitch arsenal for today's starting pitchers...\n");

//   await runQuery(`DELETE FROM pitcher_arsenal WHERE game_date = ?`, [gameDate]);

//   let totalRows = 0;

//   for (const [team, pitcher] of Object.entries(pitcherByTeam)) {
//     if (!pitcher.mlb_id) {
//       console.log(`  ⚠️  ${pitcher.name} (${team}) — no mlb_id, skipping`);
//       continue;
//     }

//     process.stdout.write(`  ${pitcher.name.padEnd(28)} `);

//     const pitches = await fetchArsenalFromMlbApi(pitcher.mlb_id);
//     if (!pitches.length) {
//       console.log("no arsenal data");
//       continue;
//     }

//     const savant = await fetchSavantEnrichment(pitcher.mlb_id);

//     for (const pitch of pitches) {
//       const e = savant[pitch.pitch_type] || {};
//       await runQuery(
//         `INSERT OR REPLACE INTO pitcher_arsenal
//           (mlb_id, name, team, season, game_date,
//            pitch_type, pitch_name,
//            usage_pct, avg_velocity, avg_spin_rate,
//            whiff_pct, put_away_pct, batting_avg_against, slugging_against)
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           pitcher.mlb_id, pitcher.name, team, SEASON, gameDate,
//           pitch.pitch_type, pitch.pitch_name,
//           pitch.usage_pct, pitch.avg_velocity, pitch.avg_spin_rate,
//           e.whiff_pct    ?? null, e.put_away_pct ?? null,
//           e.ba_against   ?? null, e.slg_against  ?? null,
//         ]
//       );
//       totalRows++;
//     }

//     const summary = pitches
//       .map(p => `${p.pitch_name} ${p.usage_pct != null ? (p.usage_pct * 100).toFixed(0) + "%" : "?"}`)
//       .join(", ");
//     console.log(summary);
//   }

//   console.log(`\n✅ Arsenal import done — ${totalRows} pitch rows inserted.`);
// }

// ---------------------
// Main Import
// ---------------------

async function run() {
  // Use US Eastern date — games are organized by ET calendar date, not UTC.
  // Subtract 3 h so games past midnight ET still belong to the previous day.
  const dateArgIdx = process.argv.indexOf('--date');
  const today = dateArgIdx !== -1
    ? process.argv[dateArgIdx + 1]
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
        .format(new Date(Date.now() - 3 * 60 * 60 * 1000));
  const filePath = path.join(__dirname, "dailyLineups.csv");

  if (!fs.existsSync(filePath)) {
    console.log("❌ dailyLineups.csv not found.");
    return;
  }

  console.log("🧹 Clearing existing daily_lineups table...");
  await runQuery(`DELETE FROM daily_lineups`);
  await runQuery(`DELETE FROM sqlite_sequence WHERE name='daily_lineups'`);

  console.log("📥 Reading CSV...");

  const lineupRows = [];
  await new Promise((resolve) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => lineupRows.push(row))
      .on("end", resolve);
  });

  console.log(`Processing ${lineupRows.length} lineup rows`);

  // ---------------------
  // Build pitcherByTeam: team -> { mlb_id, name, handedness }
  // ---------------------

  const pitcherByTeam = {};

  for (const row of lineupRows) {
    if (parseInt(row.batting_order) === 0 && row.position === "SP") {
      const found = await dbAll(
        `SELECT mlb_id, name FROM players WHERE name = ? AND team = ?`,
        [row.name, row.team]
      );

      if (found.length) {
        pitcherByTeam[row.team] = {
          mlb_id:     found[0].mlb_id,
          name:       found[0].name,
          handedness: row.handedness || null,
        };
      } else {
        // Fallback: name-only lookup for traded/called-up pitchers not yet updated in players table
        const byName = await dbAll(`SELECT mlb_id, name, team FROM players WHERE name = ?`, [row.name]);
        if (byName.length) {
          console.log(`⚠️  SP ${row.name} found under team=${byName[0].team}, CSV says ${row.team} — using DB record`);
          pitcherByTeam[row.team] = {
            mlb_id:     byName[0].mlb_id,
            name:       byName[0].name,
            handedness: row.handedness || null,
          };
        } else {
          pitcherByTeam[row.team] = {
            mlb_id:     null,
            name:       row.name,
            handedness: row.handedness || null,
          };
          console.log(`⚠️  SP not found in players table: ${row.name} (${row.team})`);
        }
      }
    }
  }

  console.log(`\n📋 Starting pitchers resolved for ${Object.keys(pitcherByTeam).length} teams`);
  for (const [team, sp] of Object.entries(pitcherByTeam)) {
    console.log(`   ${team}: ${sp.name} (${sp.handedness || "?"})`);
  }
  console.log();

  // ---------------------
  // Resolve players + fetch season stats in parallel
  // ---------------------

  const hitterRows = lineupRows.filter(r => parseInt(r.batting_order) !== 0);

  // Step 1: resolve player records from DB (fast, local)
  const resolved = [];
  for (const row of hitterRows) {
    let players = await dbAll(
      `SELECT * FROM players WHERE name = ? AND team = ?`,
      [row.name, row.team]
    );
    // Fallback: name-only lookup for recently traded players whose team hasn't been
    // updated in the players table yet (e.g. mid-season trades).
    if (!players.length) {
      players = await dbAll(`SELECT * FROM players WHERE name = ?`, [row.name]);
      if (players.length) {
        console.log(`⚠️  ${row.name} found under team=${players[0].team}, CSV says ${row.team} — using DB record (run importMlbRosters.js to fix)`);
      }
    }
    if (!players.length) {
      console.log(`⚠️  Hitter not found: ${row.name} (${row.team})`);
      continue;
    }
    resolved.push({ row, player: players[0] });
  }

  // Step 2: fetch season stats in parallel (10 at a time)
  const CONCURRENCY = 10;
  const statsMap = {};  // mlb_id → stats
  for (let i = 0; i < resolved.length; i += CONCURRENCY) {
    const batch = resolved.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ player }) => {
      try {
        statsMap[player.mlb_id] = await fetchSeasonStats(player.mlb_id);
      } catch (_) {
        statsMap[player.mlb_id] = null;
      }
    }));
    process.stdout.write(`  stats: ${Math.min(i + CONCURRENCY, resolved.length)}/${resolved.length}\r`);
  }
  console.log();

  // Step 3: insert all rows in a single transaction
  try {
    await runQuery("BEGIN TRANSACTION");

    for (const { row, player } of resolved) {
      // Use zeroed stats if the API returned nothing (called-up, injured return, etc.)
      // — still insert the player so they appear in the lineup display.
      const stats = statsMap[player.mlb_id] || {};

      const ab      = +stats.atBats   || 0;
      const hits    = +stats.hits     || 0;
      const doubles = +stats.doubles  || 0;
      const triples = +stats.triples  || 0;
      const hr      = +stats.homeRuns || 0;

      const avg = ab ? +(hits / ab).toFixed(3) : 0;
      const iso = ab ? +((doubles + 2 * triples + 3 * hr) / ab).toFixed(3) : 0;

      const opponent   = row.opponent || null;
      const opposingSP = opponent ? (pitcherByTeam[opponent] || null) : null;

      try {
        await runQuery(
          `INSERT INTO daily_lineups
            (mlb_id, name, team, opponent, position, batting_order, handedness,
             game_date, season,
             pitcher_mlb_id, pitcher_name, pitcher_handedness,
             games, at_bats, runs, hits, doubles, triples, home_runs,
             rbi, walks, strikeouts, stolen_bases,
             avg, obp, slg, ops, iso, is_home)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            player.mlb_id, player.name, row.team, opponent,
            row.position, parseInt(row.batting_order), row.handedness || null,
            today, SEASON,
            opposingSP?.mlb_id ?? null, opposingSP?.name ?? null, opposingSP?.handedness ?? null,
            +stats.gamesPlayed || 0, ab, +stats.runs || 0, hits, doubles, triples, hr,
            +stats.rbi || 0, +stats.baseOnBalls || 0, +stats.strikeOuts || 0, +stats.stolenBases || 0,
            avg, +stats.obp || 0, +stats.slg || 0, +stats.ops || 0, iso,
            row.is_home !== undefined ? parseInt(row.is_home) : null,
          ]
        );
        console.log(`✔  ${player.name} (${row.team}) vs ${opposingSP?.name ?? "unknown SP"}`);
      } catch (err) {
        console.error(`❌ Error inserting ${player.name}:`, err.message);
      }
    }

    await runQuery("COMMIT");
    console.log("\n✅ Daily lineups imported with opponent + pitcher info.");
  } catch (err) {
    await runQuery("ROLLBACK");
    console.error("❌ Transaction failed. Rolled back.", err.message);
    return;
  }

  // ── Persist to historical_lineups ──────────────────────────────────────
  // Add is_home column if it doesn't exist yet (schema migration)
  try { await runQuery(`ALTER TABLE historical_lineups ADD COLUMN is_home INTEGER`); } catch (_) {}

  await runQuery(`DELETE FROM historical_lineups WHERE game_date = ?`, [today]);
  const saved = await runQuery(`
    INSERT INTO historical_lineups
      (mlb_id, name, team, opponent, position, batting_order, handedness, game_date, season,
       pitcher_mlb_id, pitcher_name, pitcher_handedness,
       games, at_bats, runs, hits, doubles, triples, home_runs,
       rbi, walks, strikeouts, stolen_bases, avg, obp, slg, ops, iso, is_home)
    SELECT
      mlb_id, name, team, opponent, position, batting_order, handedness, game_date, season,
      pitcher_mlb_id, pitcher_name, pitcher_handedness,
      games, at_bats, runs, hits, doubles, triples, home_runs,
      rbi, walks, strikeouts, stolen_bases, avg, obp, slg, ops, iso, is_home
    FROM daily_lineups WHERE game_date = ?
  `, [today]);
  console.log(`💾 Saved ${saved.changes} rows to historical_lineups (${today}).`);

  // Arsenal runs after the transaction is fully closed — pitcherByTeam is in scope here
  // await importArsenalForAllPitchers(pitcherByTeam, today);
}

run();