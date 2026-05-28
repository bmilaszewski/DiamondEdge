/**
 * _backfillWeek.js — Backfill any dates in the last 7 days that are missing
 * lineups, odds, or predictions. Handles game/SO/HR for each gap date.
 *
 * Usage: node _backfillWeek.js
 */
'use strict';
const { spawn, execSync } = require('child_process');
const db = require('./db');

const TODAY = '2026-05-22';

// ── DB helpers ────────────────────────────────────────────────────────────────
const run  = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e?rej(e):res(this); }));
const all  = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,r) => e?rej(e):res(r||[])));
const get1 = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r) => e?rej(e):res(r)));

function spawnPy(args, timeoutMs=180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('py', args, { stdio: ['ignore','pipe','pipe'] });
    let out='', err='';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`Timeout after ${timeoutMs}ms`)); }, timeoutMs);
    proc.on('close', () => { clearTimeout(timer); resolve(out); });
    proc.on('error', reject);
  });
}

// ── Parsers ───────────────────────────────────────────────────────────────────
function parseGamePreds(output) {
  const line = output.split('\n').find(l => l.startsWith('PREDSJSON:'));
  if (!line) return [];
  try { return JSON.parse(line.slice(10)); } catch { return []; }
}

function parseSO(output) {
  const predictions = [];
  let inPredictions = false;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.includes("TODAY'S STRIKEOUT PREDICTIONS")) { inPredictions = true; continue; }
    if (!inPredictions) continue;
    if (!line || line.includes('PITCHER') || line.includes('---') || line.includes('===') ||
        line.includes('──') || line.startsWith('[skip]') || line.startsWith('[warn]') ||
        line.startsWith('Date:') || /^\d+ pitchers/.test(line)) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length < 6) continue;
    const num = v => { if (!v) return null; const n=parseFloat(v.replace('%','').replace('—','').trim()); return isNaN(n)?null:n; };
    const lk = num(parts[9]);
    const lineup_vuln = lk != null ? (lk - 22.5) / 22.5 : null;
    const p = {
      pitcher: parts[0], team: parts[1], opponent: parts[2],
      pred_k: num(parts[3]), k_pct: num(parts[5]), whiff_pct: num(parts[6]),
      iz_contact_pct: num(parts[7]), chase_pct: num(parts[8]),
      lineup_iz: num(parts[11]), lineup_chase: num(parts[12]),
      lineup_bat_speed: num(parts[13]), lineup_vuln,
      data_quality: parts[14] || null,
      exp_k_rate: num(parts[5]) != null ? num(parts[5]) * 0.82 : null,
    };
    if (p.pred_k != null) predictions.push(p);
  }
  return predictions;
}

function parseHR(output) {
  for (const line of output.split('\n')) {
    if (line.startsWith('HRJSON:')) {
      try { return JSON.parse(line.slice(7)); } catch { return []; }
    }
  }
  return [];
}

// ── Savers ────────────────────────────────────────────────────────────────────
async function saveGamePreds(preds, date) {
  if (!preds.length) return 0;
  await run('DELETE FROM game_predictions WHERE game_date = ?', [date]);
  let n = 0;
  for (const p of preds) {
    await run(
      `INSERT INTO game_predictions
       (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,
        proj_total,home_sp,away_sp,model_prob,vegas_implied,edge,same_side)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [date, p.game_number||1, p.away, p.home, p.pick,
       p.confidence, p.home_prob, p.away_prob, p.proj_total,
       p.home_sp||null, p.away_sp||null,
       p.model_prob??null, p.vegas_implied??null,
       p.edge??null, p.same_side!=null?(p.same_side?1:0):null]
    );
    n++;
  }
  return n;
}

async function saveSO(preds, date) {
  if (!preds.length) return 0;
  await run('DELETE FROM strikeout_predictions WHERE game_date = ?', [date]);
  const stmt = db.prepare(
    `INSERT INTO strikeout_predictions
     (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
      iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let n=0;
  for (const p of preds) {
    stmt.run([date,p.pitcher,p.team,p.opponent,
      p.pred_k??null,p.k_pct??null,p.whiff_pct??null,p.chase_pct??null,
      p.iz_contact_pct??null,p.lineup_iz??null,p.lineup_chase??null,
      p.lineup_bat_speed??null,p.lineup_vuln??null,p.exp_k_rate??null,
      p.data_quality??null]);
    n++;
  }
  stmt.finalize();
  return n;
}

async function saveHR(preds, date) {
  if (!preds.length) return 0;
  await run('DELETE FROM homerun_predictions WHERE game_date = ?', [date]);
  const stmt = db.prepare(
    `INSERT INTO homerun_predictions
     (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,
      park_factor,weather_factor,batting_order,home_team,opponent,
      temp_f,wind_mph,weather_cond)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let n=0;
  for (const p of preds) {
    stmt.run([date,
      p.batter||p.name, p.team, p.vs_pitcher||null,
      p.hr_prob_per_pa??p.hr_prob_pa??null,
      p.hr_prob_per_game??p.hr_prob_game??null,
      p.park_factor??null, p.weather_factor??null,
      p.batting_order??null, p.home_team||null, p.opponent||null,
      p.temp_f??null, p.wind_mph??null, p.weather_cond||null]);
    n++;
  }
  stmt.finalize();
  return n;
}

// ── Determine what needs backfilling ─────────────────────────────────────────
async function audit() {
  const dates = [];
  for (let i = 7; i >= 1; i--) {
    const d = new Date(TODAY + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const result = [];
  for (const date of dates) {
    const lin  = await get1('SELECT COUNT(*) as n FROM historical_lineups      WHERE game_date=?', [date]);
    const odds = await get1('SELECT COUNT(*) as n FROM betting_odds            WHERE game_date=?', [date]);
    const gp   = await get1('SELECT COUNT(*) as n FROM game_predictions        WHERE game_date=?', [date]);
    const so   = await get1('SELECT COUNT(*) as n FROM strikeout_predictions   WHERE game_date=?', [date]);
    const hr   = await get1('SELECT COUNT(*) as n FROM homerun_predictions     WHERE game_date=?', [date]);
    // Check if HR rows are missing home_team (May 16 issue)
    const hrBad = hr.n > 0
      ? await get1('SELECT COUNT(*) as n FROM homerun_predictions WHERE game_date=? AND home_team IS NULL', [date])
      : { n: 0 };

    const needsLineups = lin.n === 0;
    // Only skip if we've confirmed no games: lineups were scraped and returned 0
    // (i.e. lin > 0 means we tried and found nothing, lin = 0 means untried).
    // Never skip based on missing odds alone — odds may simply not have been imported.
    const hasGames = true; // always attempt; lineup scrape will short-circuit if no games
    const needsPreds = gp.n === 0 || so.n === 0 || hr.n === 0 || hrBad.n > 0;

    result.push({ date, lin: lin.n, odds: odds.n, gp: gp.n, so: so.n, hr: hr.n,
                  hrBad: hrBad.n, needsLineups, needsPreds, hasGames });
  }
  return result;
}

// ── Process one date ──────────────────────────────────────────────────────────
async function processDate(info, dlBackup) {
  const { date, needsLineups, needsPreds } = info;
  console.log(`\n  ── ${date} ──────────────────────────────────`);
  console.log(`     lineups=${info.lin}  odds=${info.odds}  game_preds=${info.gp}  so=${info.so}  hr=${info.hr}${info.hrBad>0?' (HR missing home_team)':''}`);

  // ── Lineups ─────────────────────────────────────────────────────────────
  if (needsLineups) {
    console.log(`  [lineups] Scraping...`);
    try {
      execSync(`node scrapeDailyLineups.js ${date}`, { stdio: 'inherit' });
    } catch(e) {
      console.error(`  [lineups] scrapeDailyLineups failed: ${e.message}`);
      return;
    }
    console.log(`  [lineups] Importing → historical_lineups...`);
    try {
      execSync(`node importDailyLineups.js --date ${date}`, { stdio: 'inherit' });
    } catch(e) {
      console.error(`  [lineups] importDailyLineups failed: ${e.message}`);
      return;
    }
    // Restore today's daily_lineups (importDailyLineups wipes the whole table)
    await restoreDailyLineups(dlBackup);

    const check = await get1('SELECT COUNT(*) as n FROM historical_lineups WHERE game_date=?', [date]);
    if (!check.n) { console.log(`  [lineups] ⚠️  Still 0 rows — no games that day, skipping predictions`); return; }
    console.log(`  [lineups] ✅ ${check.n} rows saved`);
  }

  if (!needsPreds && info.hrBad === 0) { console.log(`  All predictions already present, skipping.`); return; }

  // ── Game winner predictions ──────────────────────────────────────────────
  if (info.gp === 0 || needsLineups) {
    process.stdout.write(`  [games] Running predictor... `);
    try {
      const out = await spawnPy(['predictorv4.py', '--predict', '--date', date]);
      const preds = parseGamePreds(out);
      if (preds.length) {
        const n = await saveGamePreds(preds, date);
        console.log(`✅ ${n} saved  [${preds.map(p=>`${p.away}@${p.home} ${p.pick} ${p.confidence.toFixed(0)}%`).join(', ')}]`);
      } else {
        console.log(`⚠️  0 predictions`);
        console.log(out.slice(-300));
      }
    } catch(e) { console.log(`❌ ${e.message.slice(0,120)}`); }
  } else {
    console.log(`  [games] ${info.gp} already saved, skipping.`);
  }

  // ── Strikeout predictions ────────────────────────────────────────────────
  if (info.so === 0 || needsLineups) {
    process.stdout.write(`  [SO]    Running predictor... `);
    try {
      const out = await spawnPy(['strikeoutPredictorv2.py', '--predict', '--date', date]);
      const preds = parseSO(out);
      if (preds.length) {
        const n = await saveSO(preds, date);
        console.log(`✅ ${n} saved`);
      } else {
        console.log(`⚠️  0 predictions`);
        console.log(out.slice(-200));
      }
    } catch(e) { console.log(`❌ ${e.message.slice(0,120)}`); }
  } else {
    console.log(`  [SO]    ${info.so} already saved, skipping.`);
  }

  // ── HR predictions ───────────────────────────────────────────────────────
  if (info.hr === 0 || info.hrBad > 0 || needsLineups) {
    process.stdout.write(`  [HR]    Running predictor... `);
    try {
      const out = await spawnPy(['hrPredictor.py', '--predict', '--date', date]);
      const preds = parseHR(out);
      if (preds.length) {
        const n = await saveHR(preds, date);
        console.log(`✅ ${n} saved`);
      } else {
        console.log(`⚠️  0 predictions`);
        console.log(out.slice(-200));
      }
    } catch(e) { console.log(`❌ ${e.message.slice(0,120)}`); }
  } else {
    console.log(`  [HR]    ${info.hr} already saved, skipping.`);
  }
}

// ── daily_lineups backup / restore ────────────────────────────────────────────
async function backupDailyLineups() {
  const rows = await all('SELECT * FROM daily_lineups');
  console.log(`  Backed up ${rows.length} daily_lineups rows`);
  return rows;
}

async function restoreDailyLineups(backup) {
  if (!backup.length) return;
  // Only restore rows for TODAY — leave whatever importDailyLineups wrote for other dates
  const todayRows = backup.filter(r => r.game_date === TODAY);
  if (!todayRows.length) return;
  await run('DELETE FROM daily_lineups WHERE game_date = ?', [TODAY]);
  const cols = Object.keys(todayRows[0]).filter(c => c !== 'id');
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT INTO daily_lineups (${cols.join(',')}) VALUES (${placeholders})`);
  for (const row of todayRows) stmt.run(cols.map(c => row[c]));
  stmt.finalize();
  console.log(`  Restored ${todayRows.length} rows for ${TODAY} in daily_lineups`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Week Backfill — Last 7 days before ' + TODAY);
  console.log('══════════════════════════════════════════════════\n');

  const plan = await audit();

  console.log('Audit:');
  console.log('  Date       | lin  | odds | game | so  | hr  | action');
  console.log('  -----------|------|------|------|-----|-----|--------');
  for (const d of plan) {
    const action = (!d.needsLineups && !d.needsPreds && d.hrBad===0) ? 'ok' : `BACKFILL${d.needsLineups?' lineups':''}${d.needsPreds?' preds':''}${d.hrBad>0?' HR-fix':''}`;
    console.log(`  ${d.date} | ${String(d.lin).padStart(4)} | ${String(d.odds).padStart(4)} | ${String(d.gp).padStart(4)} | ${String(d.so).padStart(3)} | ${String(d.hr).padStart(3)} | ${action}`);
  }

  const toProcess = plan.filter(d => d.needsLineups || d.needsPreds || d.hrBad > 0);
  if (!toProcess.length) {
    console.log('\n✅ All dates are complete — nothing to backfill.');
    db.close();
    return;
  }

  console.log(`\nProcessing ${toProcess.length} date(s)...\n`);
  const dlBackup = await backupDailyLineups();

  for (const info of toProcess) {
    await processDate(info, dlBackup);
    // Small pause between dates to let SQLite WAL flush
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log('  Done. Final counts:');
  console.log('══════════════════════════════════════════════════');
  const finalPlan = await audit();
  console.log('  Date       | lin  | odds | game | so  | hr');
  console.log('  -----------|------|------|------|-----|-----');
  for (const d of finalPlan) {
    const ok = d.hasGames ? (d.lin>0&&d.gp>0&&d.so>0&&d.hr>0&&d.hrBad===0?'✅':'⚠️ ') : '--';
    console.log(`  ${d.date} | ${String(d.lin).padStart(4)} | ${String(d.odds).padStart(4)} | ${String(d.gp).padStart(4)} | ${String(d.so).padStart(3)} | ${String(d.hr).padStart(3)}  ${ok}`);
  }
  console.log('');
  db.close();
}

main().catch(e => { console.error('Fatal:', e); db.close(); process.exit(1); });
