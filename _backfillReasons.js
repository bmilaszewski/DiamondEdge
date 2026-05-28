// _backfillReasons.js — Generate template-based pick reasons for all
// game_predictions that don't have one yet. No API key required.
//
// Usage:  node _backfillReasons.js

const db = require('./db');
const { generateReason } = require('./reasonEngine');

function runSql(sql, params = []) {
  return new Promise((res, rej) =>
    db.run(sql, params, function(e) { e ? rej(e) : res(this); })
  );
}

async function main() {
  const rows = await new Promise((res, rej) =>
    db.all(
      `SELECT game_date, game_number, away_team, home_team, pick, confidence,
              home_prob, away_prob, proj_total, home_sp, away_sp,
              model_prob, vegas_implied, edge, same_side
       FROM game_predictions
       WHERE reason IS NULL
       ORDER BY game_date DESC, confidence DESC`,
      [], (e, r) => e ? rej(e) : res(r || [])
    )
  );

  if (!rows.length) {
    console.log('All predictions already have reasons.');
    db.close();
    return;
  }

  console.log(`\nGenerating reasons for ${rows.length} prediction(s)...\n`);

  let done = 0, failed = 0;
  for (const p of rows) {
    const label = `${p.game_date}  ${p.away_team}@${p.home_team}`;
    process.stdout.write(`  ${label}  ...`);
    try {
      const reason = generateReason(p);
      if (reason) {
        await runSql(
          `UPDATE game_predictions SET reason = ?
           WHERE game_date = ? AND away_team = ? AND home_team = ? AND game_number = ?`,
          [reason, p.game_date, p.away_team, p.home_team, p.game_number]
        );
        console.log(' ✓');
        done++;
      } else {
        console.log(' (no output)');
        failed++;
      }
    } catch (e) {
      console.log(` ✗ ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${done} saved, ${failed} failed.\n`);
  db.close();
}

main().catch(e => { console.error(e); db.close(); process.exit(1); });
