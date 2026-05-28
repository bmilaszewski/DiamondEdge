/**
 * importHistoricalLineups.js  — Retrosheet CSV edition (streaming)
 *
 * Imports historical lineup + per-game stats from Retrosheet CSV files.
 * Uses streaming to avoid loading millions of rows into memory at once.
 *
 * REQUIRED FILES (place in the same folder as this script):
 *   batting.csv      pitching.csv    gameinfo.csv
 *   teamstats.csv    allplayers.csv
 *
 * Download from https://www.retrosheet.org/game.htm
 * Usage: node importHistoricalLineups.js
 */

const db     = require('./db');
const fs     = require('fs');
const path   = require('path');
const csv    = require('csv-parser');

// ── Config ────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname);
const SEASON      = 2024;          // season to import
const CLEAR_FIRST = true;

const FILES = {
  allplayers: path.join(DATA_DIR, 'allplayers.csv'),
  gameinfo:   path.join(DATA_DIR, 'gameinfo.csv'),
  teamstats:  path.join(DATA_DIR, 'teamstats.csv'),
  pitching:   path.join(DATA_DIR, 'pitching.csv'),
  batting:    path.join(DATA_DIR, 'batting.csv'),
};

// ── DB helpers ────────────────────────────────────────────────────────────
const run = (sql, p=[]) => new Promise((res,rej) =>
  db.run(sql, p, function(e){ e ? rej(e) : res(this); }));

const all = (sql, p=[]) => new Promise((res,rej) =>
  db.all(sql, p, (e,r) => e ? rej(e) : res(r)));

// ── Streaming CSV reader — yields rows one at a time via callback ──────────
// Optionally filter to only rows matching season (checks `date` or `season` col)
function streamCSV(filePath, onRow, seasonFilter) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`Missing file: ${filePath}`));
      return;
    }
    let count = 0;
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => {
        // Season filter: check `season` column first, then first 4 chars of `date`
        if (seasonFilter !== undefined) {
          const rowSeason = parseInt(row.season || (row.date || '').slice(0,4) || 0);
          if (rowSeason && rowSeason !== seasonFilter) return;
        }
        count++;
        onRow(row);
      })
      .on('end',   () => resolve(count))
      .on('error', reject);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
const fmtDate = d => d && d.length >= 8
  ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`
  : (d || '');

const TEAM_MAP = {
  ANA:'LAA', CAL:'LAA', MON:'WAS', FLO:'MIA', TBA:'TB',
  KCA:'KC',  CHA:'CWS', NYA:'NYY', NYN:'NYM', SFN:'SF',
  SDN:'SD',  LAN:'LAD', SLN:'STL', CHN:'CHC', ARI:'AZ',
};
const mapTeam = t => TEAM_MAP[t] || t;

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('All tables ready.\nConnected to SQLite database\n');

  // Check files
  const missing = Object.entries(FILES).filter(([,p]) => !fs.existsSync(p));
  if (missing.length) {
    console.error('Missing Retrosheet CSV files:');
    missing.forEach(([k,p]) => console.error(`  ${k}: ${p}`));
    console.error('\nPlace CSVs from retrosheet.org in:', DATA_DIR);
    process.exit(1);
  }

  if (CLEAR_FIRST) {
    console.log(`Clearing historical_lineups for season ${SEASON}...`);
    await run('DELETE FROM historical_lineups WHERE season = ?', [SEASON]);
  }

  // ── 1. allplayers — small file, load fully ────────────────────────────
  console.log('Loading allplayers.csv...');
  const playerMap = {};          // retro_id -> player info

  await streamCSV(FILES.allplayers, row => {
    if (!row.id) return;
    // allplayers has one row per player-season; keep latest / first seen
    if (!playerMap[row.id]) {
      playerMap[row.id] = {
        id:    row.id,
        name:  `${row.first || ''} ${row.last || ''}`.trim(),
        bat:   row.bat   || 'R',
        throw: row.throw || 'R',
        team:  mapTeam(row.team || ''),
        mlb_id: null,
      };
    }
  }); // no season filter — we need all players for name matching

  console.log(`  ${Object.keys(playerMap).length} players loaded`);

  // Match to mlb_id by name
  const dbPlayers = await all('SELECT mlb_id, name FROM players WHERE mlb_id IS NOT NULL');
  const nameIdx = {};
  for (const dp of dbPlayers) {
    nameIdx[dp.name.toLowerCase().replace(/[^a-z]/g,'')] = dp.mlb_id;
  }
  let matched = 0;
  for (const p of Object.values(playerMap)) {
    const key = p.name.toLowerCase().replace(/[^a-z]/g,'');
    if (nameIdx[key]) { p.mlb_id = nameIdx[key]; matched++; }
  }
  console.log(`  ${matched} retro IDs matched to mlb_ids`);

  // ── 2. gameinfo — filter to SEASON ───────────────────────────────────
  console.log('Loading gameinfo.csv...');
  const gameInfoMap = {};

  await streamCSV(FILES.gameinfo, row => {
    if (!row.gid) return;
    gameInfoMap[row.gid] = {
      gid:      row.gid,
      visteam:  mapTeam(row.visteam  || ''),
      hometeam: mapTeam(row.hometeam || ''),
      date:     fmtDate(row.date || ''),
      season:   parseInt(row.season || (row.date||'').slice(0,4)),
    };
  }, SEASON);

  console.log(`  ${Object.keys(gameInfoMap).length} games loaded for ${SEASON}`);

  // ── 3. teamstats — batting order & starting pitcher position ──────────
  console.log('Loading teamstats.csv...');
  const lineupMap  = {};   // gid_team -> [retroId x9]
  const spPosMap   = {};   // gid_team -> retroId of SP (from fielding position 1)

  await streamCSV(FILES.teamstats, row => {
    if (!row.gid || !gameInfoMap[row.gid]) return;
    const team = mapTeam(row.team || '');
    const key  = `${row.gid}_${team}`;

    // Batting order: start_l1..start_l9
    const order = [];
    for (let i = 1; i <= 9; i++) {
      const rid = (row[`start_l${i}`] || '').trim();
      if (rid) order.push(rid);
    }
    if (order.length) lineupMap[key] = order;

    // SP = the player whose fielding position (start_f1..f10) is 1 (pitcher)
    for (let i = 1; i <= 10; i++) {
      const fpos = parseInt(row[`start_f${i}`] || 0);
      if (fpos === 1) {
        const rid = (row[`start_l${i}`] || '').trim();
        if (rid) spPosMap[key] = rid;
        break;
      }
    }
  }, SEASON);

  console.log(`  ${Object.keys(lineupMap).length} lineup orders loaded`);

  // ── 4. pitching — find starter (p_seq=1 or p_gs=1) ───────────────────
  console.log('Loading pitching.csv...');
  const starterMap = {};   // gid_team -> retroId

  await streamCSV(FILES.pitching, row => {
    if (!row.gid || !gameInfoMap[row.gid]) return;
    const team = mapTeam(row.team || '');
    const key  = `${row.gid}_${team}`;
    if (starterMap[key]) return;  // already found

    const seq = parseInt(row.p_seq || 0);
    const gs  = parseInt(row.p_gs  || 0);
    if (seq === 1 || gs === 1) {
      starterMap[key] = (row.id || '').trim();
    }
  }, SEASON);

  console.log(`  ${Object.keys(starterMap).length} starters identified`);

  // ── 5. batting — stream directly into DB ─────────────────────────────
  // Process in batches to avoid building huge arrays
  console.log('Streaming batting.csv into DB...\n');

  let inserted = 0;
  let skipped  = 0;
  let batch    = [];
  const BATCH_SIZE = 500;

  const insertBatch = async (rows) => {
    if (!rows.length) return;
    await run('BEGIN TRANSACTION');
    try {
      for (const r of rows) {
        try {
          await run(
            `INSERT OR IGNORE INTO historical_lineups
              (mlb_id, name, team, opponent, position, batting_order, handedness,
               game_date, season,
               pitcher_mlb_id, pitcher_name, pitcher_handedness,
               games, at_bats, runs, hits, doubles, triples, home_runs,
               rbi, walks, strikeouts, stolen_bases,
               avg, obp, slg, ops, iso)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            r
          );
          inserted++;
        } catch (e) {
          if (!e.message.includes('UNIQUE')) {
            console.error('  Insert error:', e.message.slice(0,80));
          }
          skipped++;
        }
      }
      await run('COMMIT');
    } catch (e) {
      await run('ROLLBACK');
      throw e;
    }
  };

  const processRow = async (bRow) => {
    const gid = bRow.gid;
    if (!gid || !gameInfoMap[gid]) return;

    const game   = gameInfoMap[gid];
    const team   = mapTeam(bRow.team || '');
    const key    = `${gid}_${team}`;
    const oppKey = `${gid}_${team === game.visteam ? game.hometeam : game.visteam}`;
    const opp    = team === game.visteam ? game.hometeam : game.visteam;

    // Only process starting batters: b_lp (lineup position) 1-9
    const lp = parseInt(bRow.b_lp || bRow.b_seq || 99);
    if (lp < 1 || lp > 9) return;

    // Also check it's in the lineup order (skip pinch hitters etc)
    const lineupOrder = lineupMap[key] || [];
    if (lineupOrder.length > 0 && !lineupOrder.includes(bRow.id)) return;

    const retroId = (bRow.id || '').trim();
    const pInfo   = playerMap[retroId] || { name: retroId, bat: null, mlb_id: null };

    // Opposing starter
    const oppSpId  = starterMap[oppKey] || spPosMap[oppKey] || null;
    const oppSpInfo = oppSpId ? (playerMap[oppSpId] || { name: oppSpId, mlb_id: null, throw: null }) : null;

    // Batting stats
    const ab  = parseInt(bRow.b_ab  || 0);
    const h   = parseInt(bRow.b_h   || 0);
    const d2  = parseInt(bRow.b_d   || 0);
    const t3  = parseInt(bRow.b_t   || 0);
    const hr  = parseInt(bRow.b_hr  || 0);
    const rbi = parseInt(bRow.b_rbi || 0);
    const r   = parseInt(bRow.b_r   || 0);
    const bb  = parseInt(bRow.b_w   || 0);
    const k   = parseInt(bRow.b_k   || 0);
    const sb  = parseInt(bRow.b_sb  || 0);
    const sf  = parseInt(bRow.b_sf  || 0);
    const sh  = parseInt(bRow.b_sh  || 0);
    const hbp = parseInt(bRow.b_hbp || 0);
    const pa  = parseInt(bRow.b_pa  || 0) || (ab + bb + hbp + sf + sh);

    const avg = ab > 0 ? +((h / ab).toFixed(3))                            : 0;
    const slg = ab > 0 ? (((h + d2 + 2*t3 + 3*hr) / ab).toFixed(3))*1     : 0;
    const obp = pa > 0 ? (((h + bb + hbp) / pa).toFixed(3))*1              : 0;
    const ops = +(obp + slg).toFixed(3);
    const iso = ab > 0 ? (((d2 + 2*t3 + 3*hr) / ab).toFixed(3))*1         : 0;

    batch.push([
      pInfo.mlb_id || null,
      pInfo.name   || retroId,
      team,
      opp,
      'OF',           // position not available per-row; enrich separately if needed
      lp,
      pInfo.bat    || null,
      game.date,
      game.season,

      oppSpInfo?.mlb_id || null,
      oppSpInfo?.name   || (oppSpId || null),
      oppSpInfo?.throw  || null,

      1, ab, r, h, d2, t3, hr, rbi, bb, k, sb,
      avg, obp, slg, ops, iso,
    ]);
  };

  // Stream batting.csv row-by-row
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(FILES.batting)
      .pipe(csv())
      .on('data', async row => {
        // Season filter
        const rowSeason = parseInt(row.season || (row.date||'').slice(0,4) || 0);
        if (rowSeason && rowSeason !== SEASON) return;

        stream.pause();
        try {
          await processRow(row);
          if (batch.length >= BATCH_SIZE) {
            const toInsert = batch.splice(0, BATCH_SIZE);
            await insertBatch(toInsert);
            process.stdout.write(`\r  ${inserted} rows inserted...`);
          }
        } catch (e) {
          console.error('\nBatch error:', e.message);
        }
        stream.resume();
      })
      .on('end',   resolve)
      .on('error', reject);
  });

  // Flush remaining
  if (batch.length) {
    await insertBatch(batch);
    process.stdout.write(`\r  ${inserted} rows inserted...`);
  }

  console.log(`\n\n=== Import Complete ===`);
  console.log(`  Season   : ${SEASON}`);
  console.log(`  Games    : ${Object.keys(gameInfoMap).length}`);
  console.log(`  Inserted : ${inserted}`);
  console.log(`  Skipped  : ${skipped} (duplicate/error)`);

  db.close();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
