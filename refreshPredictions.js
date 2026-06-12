'use strict';

/**
 * refreshPredictions.js
 *
 * Admin script — the only way to force-refresh predictions for today.
 * Runs all three predictors and saves with INSERT OR REPLACE, overwriting
 * whatever is currently in the DB regardless of game state.
 *
 * Usage:
 *   node refreshPredictions.js
 *
 * The server must be running. After saving, calls the internal cache-bust
 * endpoint so the next page load picks up the fresh data immediately.
 */

const path                = require('path');
const http                = require('http');
const { spawn }           = require('child_process');
const db                  = require('./db');
const { generateReason }  = require('./reasonEngine');

const SERVER_PORT = 3000;

// ── helpers ────────────────────────────────────────────────────────────────

function etToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function runPython(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.PYTHON_BIN || 'py', [path.join(__dirname, script), '--predict'], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        console.error(`[${script}] stderr:`, err.slice(0, 500));
        return reject(new Error(`${script} exited ${code}`));
      }
      resolve(out);
    });
  });
}

function runNode(script, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(__dirname, script), ...args], {
      cwd: __dirname,
      env: { ...process.env },
    });
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`${script} exited ${code}`));
      resolve();
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, err => err ? reject(err) : resolve()));
}

function bustCache() {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path: '/api/internal/bust-cache', method: 'POST' },
      res => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', () => {
      console.warn('[refresh] Could not reach server to bust cache — restart the server to see changes.');
      resolve();
    });
    req.end();
  });
}

// ── parse helpers (must match server.js exactly) ───────────────────────────

function parseWinners(raw) {
  for (const line of raw.split('\n')) {
    if (line.startsWith('PREDSJSON:')) {
      try {
        const arr = JSON.parse(line.slice(10));
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (_) {}
    }
  }
  return [];
}

function parseSO(raw) {
  const predictions = [];
  let inPredictions = false;
  for (const raw_line of raw.split('\n')) {
    const line = raw_line.trim();
    if (line.includes("TODAY'S STRIKEOUT PREDICTIONS")) { inPredictions = true; continue; }
    if (!inPredictions) continue;
    if (!line || line.includes('PITCHER') || line.includes('---') ||
        line.includes('===') || line.includes('──') ||
        line.startsWith('[skip]') || line.startsWith('[warn]') ||
        line.startsWith('Date:') || /^\d+ pitchers/.test(line)) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length < 6) continue;
    try {
      const num = v => { if (!v) return null; const n = parseFloat(v.replace('%','').replace('—','').trim()); return isNaN(n) ? null : n; };
      const lk = num(parts[9]);
      const pred = {
        pitcher: parts[0], team: parts[1], opponent: parts[2],
        pred_k: num(parts[3]), k_pct: num(parts[5]),
        whiff_pct: num(parts[6]), iz_contact_pct: num(parts[7]),
        chase_pct: num(parts[8]), lineup_iz: num(parts[11]),
        lineup_chase: num(parts[12]), lineup_bat_speed: num(parts[13]),
        lineup_vuln: lk != null ? (lk - 22.5) / 22.5 : null,
        data_quality: parts[14] || null,
        exp_k_rate: num(parts[5]) != null ? num(parts[5]) * 0.82 : null,
      };
      if (pred.pred_k != null) predictions.push(pred);
    } catch (_) {}
  }
  return predictions;
}

function parseHR(raw) {
  for (const line of raw.split('\n')) {
    if (line.startsWith('HRJSON:')) {
      try {
        const arr = JSON.parse(line.slice(7));
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (_) {}
    }
  }
  return [];
}

// home/away flip using betting_odds as ground truth
async function applyFlip(preds, date) {
  if (!preds.length) return;
  const rows = await new Promise(resolve =>
    db.all(
      `SELECT away_team, home_team FROM betting_odds
       WHERE game_date=? AND market='h2h' AND home_ml IS NOT NULL`,
      [date], (e, r) => resolve(r || [])
    )
  );
  const oddsHome = {};
  for (const r of rows) {
    const canon = [r.away_team, r.home_team].sort().join('|');
    if (!oddsHome[canon]) oddsHome[canon] = r.home_team;
  }
  for (const p of preds) {
    const canon = [p.away, p.home].sort().join('|');
    const correctHome = oddsHome[canon];
    if (correctHome && correctHome !== p.home) {
      [p.away, p.home]                       = [p.home, p.away];
      [p.home_prob, p.away_prob]             = [p.away_prob, p.home_prob];
      [p.home_sp, p.away_sp]                 = [p.away_sp, p.home_sp];
      [p.home_era, p.away_era]               = [p.away_era, p.home_era];
      [p.home_sp_era_l5, p.away_sp_era_l5]   = [p.away_sp_era_l5, p.home_sp_era_l5];
      [p.home_rdiff_30, p.away_rdiff_30]     = [p.away_rdiff_30, p.home_rdiff_30];
      [p.home_rdiff_15, p.away_rdiff_15]     = [p.away_rdiff_15, p.home_rdiff_15];
      [p.home_wpct_30, p.away_wpct_30]       = [p.away_wpct_30, p.home_wpct_30];
      [p.home_lineup_ops, p.away_lineup_ops] = [p.away_lineup_ops, p.home_lineup_ops];
      [p.home_win_streak, p.away_win_streak] = [p.away_win_streak, p.home_win_streak];
      [p.home_loss_streak, p.away_loss_streak] = [p.away_loss_streak, p.home_loss_streak];
      [p.home_ewm_rdiff, p.away_ewm_rdiff]   = [p.away_ewm_rdiff, p.home_ewm_rdiff];
      [p.home_wpct_trend, p.away_wpct_trend] = [p.away_wpct_trend, p.home_wpct_trend];
    }
  }
}

// ── save functions ─────────────────────────────────────────────────────────

function getReadyPairs(date) {
  return new Promise(resolve =>
    db.all(
      `SELECT team, opponent, COUNT(*) AS hitters
       FROM daily_lineups WHERE game_date=? AND batting_order > 0
       GROUP BY team, opponent`,
      [date], (e, rows) => {
        const byTeam = {};
        for (const r of (rows || [])) byTeam[r.team] = r;
        const ready = new Set();
        for (const r of (rows || [])) {
          const opp = byTeam[r.opponent];
          if (opp && r.hitters >= 8 && opp.hitters >= 8)
            ready.add([r.team, r.opponent].sort().join('|'));
        }
        resolve(ready);
      }
    )
  );
}

function saveWinners(preds, date) {
  if (!preds.length) return Promise.resolve(0);
  return applyFlip(preds, date).then(async () => {
    const readyPairs = await getReadyPairs(date);
    const ready = preds.filter(p => readyPairs.has([p.away, p.home].sort().join('|')));
    if (!ready.length) {
      console.log('  (no games with confirmed lineups for both teams — skipping save)');
      return 0;
    }
    if (ready.length < preds.length) {
      process.stdout.write(`  (${preds.length - ready.length} skipped — lineups not confirmed)  `);
    }
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO game_predictions
           (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,
            proj_total,home_sp,away_sp,model_prob,vegas_implied,edge,same_side,reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,
             (SELECT reason FROM game_predictions
              WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?))`
        );
        for (const p of ready) {
          const gn = p.game_number || 1;
          db.run(
            'DELETE FROM game_predictions WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?',
            [date, gn, p.home, p.away]
          );
          stmt.run([
            date, gn, p.away, p.home, p.pick, p.confidence,
            p.home_prob, p.away_prob, p.proj_total, p.home_sp || null, p.away_sp || null,
            p.model_prob ?? null, p.vegas_implied ?? null, p.edge ?? null,
            p.same_side != null ? (p.same_side ? 1 : 0) : null,
            date, gn, p.away, p.home,
          ]);
        }
        stmt.finalize(err => err ? reject(err) : resolve(ready.length));
      });
    });
  });
}

async function saveSO(preds, date) {
  if (!preds.length) return 0;
  const readyPairs = await getReadyPairs(date);
  const ready = preds.filter(p => readyPairs.has([p.team, p.opponent].sort().join('|')));
  if (!ready.length) {
    process.stdout.write('  (no games with confirmed lineups — skipping save)  ');
    return 0;
  }
  if (ready.length < preds.length) {
    process.stdout.write(`  (${preds.length - ready.length} skipped — lineups not confirmed)  `);
  }
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO strikeout_predictions
         (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
          iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality,
          dk_line,dk_over_odds,dk_under_odds)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
           (SELECT dk_line      FROM strikeout_predictions WHERE game_date=? AND pitcher=? AND team=?),
           (SELECT dk_over_odds FROM strikeout_predictions WHERE game_date=? AND pitcher=? AND team=?),
           (SELECT dk_under_odds FROM strikeout_predictions WHERE game_date=? AND pitcher=? AND team=?))`
      );
      for (const p of ready) {
        stmt.run([
          date, p.pitcher, p.team, p.opponent, p.pred_k, p.k_pct,
          p.whiff_pct || null, p.chase_pct || null, p.iz_contact_pct || null,
          p.lineup_iz || null, p.lineup_chase || null, p.lineup_bat_speed || null,
          p.lineup_vuln || null, p.exp_k_rate || null, p.data_quality || null,
          date, p.pitcher, p.team,
          date, p.pitcher, p.team,
          date, p.pitcher, p.team,
        ]);
      }
      stmt.finalize(err => err ? reject(err) : resolve(ready.length));
    });
  });
}

function saveHR(preds, date) {
  if (!preds.length) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO homerun_predictions
         (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor,
          batting_order,home_team,opponent,temp_f,wind_mph,weather_cond,dk_hr_odds)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,
           (SELECT dk_hr_odds FROM homerun_predictions WHERE game_date=? AND batter=? AND team=?))`
      );
      for (const p of preds) {
        stmt.run([
          date, p.batter, p.team, p.vs_pitcher || null,
          p.hr_prob_per_pa ?? p.hr_prob_pa ?? null,
          p.hr_prob_per_game ?? p.hr_prob_game ?? null,
          p.park_factor || null, p.weather_factor || null,
          p.batting_order || null, p.home_team || null, p.opponent || null,
          p.temp_f || null, p.wind_mph || null, p.weather_cond || null,
          date, p.batter, p.team,
        ]);
      }
      stmt.finalize(err => err ? reject(err) : resolve(preds.length));
    });
  });
}

function saveReasons(preds, date) {
  if (!preds.length) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let saved = 0;
      for (const p of preds) {
        // Ensure game_date is set so the reason seed hash is stable
        p.game_date = date;
        const reason = generateReason(p);
        if (!reason) continue;
        db.run(
          `UPDATE game_predictions SET reason = ?
           WHERE game_date = ? AND away_team = ? AND home_team = ? AND game_number = ?`,
          [reason, date, p.away, p.home, p.game_number || 1],
          function(err) { if (!err && this.changes > 0) saved++; }
        );
      }
      // Use a no-op run at the end so we can hook its callback as a flush point
      db.run('SELECT 1', [], err => err ? reject(err) : resolve(saved));
    });
  });
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const today = etToday();
  console.log(`\nRefreshing all predictions for ${today}...\n`);

  process.stdout.write('  Clearing today\'s predictions...  ');
  await dbRun('DELETE FROM game_predictions     WHERE game_date=?', [today]);
  await dbRun('DELETE FROM strikeout_predictions WHERE game_date=?', [today]);
  await dbRun('DELETE FROM homerun_predictions   WHERE game_date=?', [today]);
  console.log('done');

  process.stdout.write('  Running winner predictor...     ');
  try {
    const raw   = await runPython('predictorv4.py');
    const preds = parseWinners(raw);
    const n     = await saveWinners(preds, today);
    const r     = await saveReasons(preds, today);
    console.log(`${n} game(s) saved, ${r} reason(s) written`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  process.stdout.write('  Running strikeout predictor...  ');
  try {
    const raw   = await runPython('strikeoutPredictorv2.py');
    const preds = parseSO(raw);
    const n     = await saveSO(preds, today);
    console.log(`${n} pitcher(s) saved`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  process.stdout.write('  Running home run predictor...   ');
  try {
    const raw   = await runPython('hrPredictor.py');
    const preds = parseHR(raw);
    const n     = await saveHR(preds, today);
    console.log(`${n} batter(s) saved`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  process.stdout.write('\n  Importing ESPN player props...   ');
  try {
    await runNode('importBettingOdds.js', ['--props-only']);
    console.log('done');
  } catch (e) {
    console.log(`FAILED — ${e.message} (continuing anyway)`);
  }

  process.stdout.write('  Clearing server caches...       ');
  await bustCache();
  console.log('done');

  console.log('\nDone. Refresh the page to see updated predictions.\n');
  setTimeout(() => process.exit(0), 500);
}

setTimeout(main, 800);
