/**
 * Backfill strikeout + homerun predictions for 2026-04-24
 * using historical_lineups data already in the DB.
 *
 * Steps:
 *  1. Copy 2026-04-24 rows from historical_lineups → daily_lineups
 *  2. Run strikeoutPredictorv2.py --predict, parse, save to strikeout_predictions
 *  3. Run hrPredictor.py --predict, parse, save to homerun_predictions
 *  4. Remove the temporary 2026-04-24 rows from daily_lineups
 */

const db     = require('./db');
const { spawn } = require('child_process');

const TARGET_DATE = '2026-04-24';

function runPy(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('py', [script, '--predict']);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${script} exited ${code}: ${err}`));
      else resolve(out);
    });
  });
}

function parseStrikeouts(output) {
  const predictions = [];
  let inPredictions = false;
  for (const line of output.split('\n')) {
    if (line.includes("TODAY'S STRIKEOUT PREDICTIONS")) { inPredictions = true; continue; }
    if (!inPredictions) continue;
    if (line.includes('PITCHER') || line.includes('───') || line.includes('---') ||
        line.includes('===') || line.trim() === '') continue;
    const full = line.match(
      /^\s{2}(.{4,28})\s+(\w{2,4})\s+(\w{2,4})\s+([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%\s+([\d.—\-]+)\s+([+\-]?[\d.]+)\s+(\S+)/
    );
    if (full) {
      const bs = full[11] === '—' ? null : parseFloat(full[11]);
      predictions.push({
        pitcher: full[1].trim(), team: full[2].trim(), opponent: full[3].trim(),
        pred_k: parseFloat(full[4]), k_pct: parseFloat(full[5]),
        whiff_pct: parseFloat(full[6]), chase_pct: parseFloat(full[7]),
        iz_contact_pct: parseFloat(full[8]), lineup_iz: parseFloat(full[9]),
        lineup_chase: parseFloat(full[10]), lineup_bat_speed: isNaN(bs) ? null : bs,
        lineup_vuln: parseFloat(full[12]), data_quality: full[13].trim(),
        exp_k_rate: parseFloat(full[6]) * 0.82,
      });
      continue;
    }
    const simple = line.match(/^\s{2}(.{4,28})\s+(\w{2,4})\s+(\w{2,4})\s+([\d.]+)\s+([\d.]+)%/);
    if (simple) {
      predictions.push({
        pitcher: simple[1].trim(), team: simple[2].trim(), opponent: simple[3].trim(),
        pred_k: parseFloat(simple[4]), k_pct: parseFloat(simple[5]),
        whiff_pct: null, chase_pct: null, iz_contact_pct: null,
        lineup_iz: null, lineup_chase: null, lineup_bat_speed: null,
        lineup_vuln: null, exp_k_rate: null, data_quality: null,
      });
    }
  }
  return predictions;
}

function parseHomeruns(output) {
  const predictions = [];
  let inPredictions = false;
  for (const line of output.split('\n')) {
    if (line.includes("TODAY'S HOME RUN PREDICTIONS")) { inPredictions = true; continue; }
    if (!inPredictions) continue;
    if (line.includes('BATTER') || line.includes('---') || line.includes('===') ||
        line.includes('Showing') || line.trim() === '') continue;
    const match = line.match(/\s+(.+?)\s{2,}(\w{2,4})\s+vs\s+(.+?)\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
    if (match) {
      predictions.push({
        batter: match[1].trim(), team: match[2].trim(), vs_pitcher: match[3].trim(),
        hr_prob_pa: parseFloat(match[4]), hr_prob_game: parseFloat(match[5]),
        park_factor: parseFloat(match[6]), weather_factor: parseFloat(match[7]),
      });
    }
  }
  return predictions;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, err => err ? reject(err) : resolve())
  );
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []))
  );
}

async function main() {
  console.log(`\nBackfilling predictions for ${TARGET_DATE}...\n`);

  // 1. Copy historical lineups into daily_lineups
  console.log('Step 1: Copying historical_lineups → daily_lineups...');
  await dbRun(`DELETE FROM daily_lineups WHERE game_date = ?`, [TARGET_DATE]);
  await dbRun(`
    INSERT INTO daily_lineups
      (mlb_id,name,team,opponent,position,batting_order,handedness,game_date,season,
       pitcher_mlb_id,pitcher_name,pitcher_handedness,
       games,at_bats,runs,hits,doubles,triples,home_runs,rbi,walks,strikeouts,
       stolen_bases,avg,obp,slg,ops,iso,is_home)
    SELECT
      mlb_id,name,team,opponent,position,batting_order,handedness,game_date,season,
      pitcher_mlb_id,pitcher_name,pitcher_handedness,
      games,at_bats,runs,hits,doubles,triples,home_runs,rbi,walks,strikeouts,
      stolen_bases,avg,obp,slg,ops,iso,is_home
    FROM historical_lineups WHERE game_date = ?
  `, [TARGET_DATE]);
  const copied = await dbAll(`SELECT COUNT(*) as c FROM daily_lineups WHERE game_date = ?`, [TARGET_DATE]);
  console.log(`  Copied ${copied[0].c} rows.\n`);

  // 2. Run strikeout predictor
  console.log('Step 2: Running strikeout predictor...');
  let skOut;
  try {
    skOut = await runPy('strikeoutPredictorv2.py');
  } catch(e) {
    console.error('  Strikeout predictor failed:', e.message);
    skOut = '';
  }
  const strikeouts = parseStrikeouts(skOut);
  console.log(`  Parsed ${strikeouts.length} strikeout predictions.`);

  if (strikeouts.length) {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO strikeout_predictions
       (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
        iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const p of strikeouts) {
      stmt.run([TARGET_DATE, p.pitcher, p.team, p.opponent, p.pred_k, p.k_pct,
                p.whiff_pct??null, p.chase_pct??null, p.iz_contact_pct??null,
                p.lineup_iz??null, p.lineup_chase??null, p.lineup_bat_speed??null,
                p.lineup_vuln??null, p.exp_k_rate??null, p.data_quality??null]);
    }
    stmt.finalize();
    console.log(`  Saved ${strikeouts.length} strikeout predictions to DB.\n`);
  } else {
    console.log('  No strikeout predictions to save.\n');
    console.log('  Raw output:\n', skOut.slice(0, 500));
  }

  // 3. Run homerun predictor
  console.log('Step 3: Running homerun predictor...');
  let hrOut;
  try {
    hrOut = await runPy('hrPredictor.py');
  } catch(e) {
    console.error('  Homerun predictor failed:', e.message);
    hrOut = '';
  }
  const homeruns = parseHomeruns(hrOut);
  console.log(`  Parsed ${homeruns.length} homerun predictions.`);

  if (homeruns.length) {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO homerun_predictions
       (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const p of homeruns) {
      stmt.run([TARGET_DATE, p.batter, p.team, p.vs_pitcher??null,
                p.hr_prob_pa??null, p.hr_prob_game??null,
                p.park_factor??null, p.weather_factor??null]);
    }
    stmt.finalize();
    console.log(`  Saved ${homeruns.length} homerun predictions to DB.\n`);
  } else {
    console.log('  No homerun predictions to save.\n');
    console.log('  Raw output:\n', hrOut.slice(0, 500));
  }

  // 4. Clean up daily_lineups
  console.log('Step 4: Cleaning up daily_lineups...');
  await dbRun(`DELETE FROM daily_lineups WHERE game_date = ?`, [TARGET_DATE]);
  console.log('  Done.\n');

  console.log('Backfill complete.');
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
