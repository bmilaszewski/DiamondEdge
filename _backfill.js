/**
 * _backfill.js  —  re-run predictorv4.py for a range of past dates and
 * replace game_predictions rows with the filtered (≥58% conf) picks.
 *
 * Usage:
 *   node _backfill.js 2026-05-05 2026-05-11
 */
const db     = require('./db');
const { spawn } = require('child_process');

db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');

function run(sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
}

function spawnPredictor(date) {
  return new Promise((res, rej) => {
    const proc = spawn('py', ['predictorv4.py', '--predict', '--date', date]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', () => {});
    proc.on('close', () => res(out));
    proc.on('error', rej);
  });
}

function parsePREDSJSON(output) {
  for (const line of output.split('\n')) {
    if (line.startsWith('PREDSJSON:')) {
      try { return JSON.parse(line.slice(10)); } catch (_) {}
    }
  }
  return [];
}

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start + 'T12:00:00Z');
  const last = new Date(end + 'T12:00:00Z');
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

async function main() {
  const [startDate, endDate] = process.argv.slice(2);
  if (!startDate || !endDate) {
    console.error('Usage: node _backfill.js YYYY-MM-DD YYYY-MM-DD');
    process.exit(1);
  }

  const dates = dateRange(startDate, endDate);
  console.log(`\nBackfilling ${dates.length} date(s): ${startDate} → ${endDate}\n`);

  for (const date of dates) {
    process.stdout.write(`  ${date}  running predictor...`);
    const output = await spawnPredictor(date);
    const preds = parsePREDSJSON(output);

    if (!preds.length) {
      console.log('  → 0 picks (no games or no lineup data)');
      continue;
    }

    // Delete existing predictions for this date and replace with filtered set
    await run('DELETE FROM game_predictions WHERE game_date = ?', [date]);

    for (const p of preds) {
      await run(
        `INSERT INTO game_predictions
         (game_date, game_number, away_team, home_team, pick, confidence,
          home_prob, away_prob, proj_total, home_sp, away_sp,
          model_prob, vegas_implied, edge, same_side)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [date, p.game_number || 1, p.away, p.home, p.pick,
         p.confidence, p.home_prob, p.away_prob, p.proj_total,
         p.home_sp || null, p.away_sp || null,
         p.model_prob ?? null, p.vegas_implied ?? null,
         p.edge ?? null,
         p.same_side != null ? (p.same_side ? 1 : 0) : null]
      );
    }

    console.log(`  → ${preds.length} pick(s): ${preds.map(p => `${p.away}@${p.home} ${p.pick} ${p.confidence.toFixed(0)}%`).join(', ')}`);
  }

  // Show final tally vs actuals
  console.log('\n--- Results vs actuals ---');
  const rows = await new Promise((res, rej) => db.all(`
    SELECT p.game_date, p.away_team, p.home_team, p.pick, p.confidence,
           p.edge, p.same_side, r.home_won
    FROM game_predictions p
    LEFT JOIN game_results r
      ON r.game_date = p.game_date
      AND r.home_team = p.home_team AND r.away_team = p.away_team
    WHERE p.game_date BETWEEN ? AND ?
    ORDER BY p.game_date, p.confidence DESC
  `, [startDate, endDate], (e, r) => e ? rej(e) : res(r)));

  let w = 0, l = 0, pend = 0;
  for (const r of rows) {
    if (r.home_won == null) { pend++; continue; }
    const correct = r.home_won ? r.pick === r.home_team : r.pick === r.away_team;
    if (correct) w++; else l++;
  }
  const pct = w + l > 0 ? ((w / (w + l)) * 100).toFixed(1) + '%' : 'n/a';
  console.log(`\nFiltered record ${startDate}–${endDate}: ${w}-${l} (${pct})  |  pending: ${pend}`);
  console.log(`Total picks surfaced: ${rows.length}`);

  db.close();
}

main().catch(e => { console.error(e); db.close(); process.exit(1); });
