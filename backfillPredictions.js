"use strict";
/**
 * backfillPredictions.js
 *
 * Reruns predictorv4.py for every date in historical_lineups >= 2026-04-24
 * and overwrites game_predictions with the updated model output.
 *
 * USAGE:
 *   node backfillPredictions.js
 *   node backfillPredictions.js --from 2026-04-28   (start from a specific date)
 */

const { spawn } = require("child_process");
const db = require("./db");

const args    = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const fromDate = fromIdx !== -1 ? args[fromIdx + 1] : "2026-04-24";

const run  = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const all  = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, rows) => { e ? rej(e) : res(rows || []); }));

function runPredictor(date) {
  return new Promise((resolve, reject) => {
    const py = spawn("py", ["predictorv4.py", "--predict", "--date", date]);
    let out = "", err = "";
    py.stdout.on("data", d => out += d.toString());
    py.stderr.on("data", d => err += d.toString());
    py.on("close", code => {
      if (code !== 0 && !out.includes("PREDSJSON:")) {
        reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
      } else {
        resolve(out);
      }
    });
  });
}

function parsePredictions(output) {
  const line = output.split("\n").find(l => l.startsWith("PREDSJSON:"));
  if (!line) return [];
  try {
    return JSON.parse(line.slice("PREDSJSON:".length));
  } catch (_) {
    return [];
  }
}

async function savePredictions(preds) {
  if (!preds.length) return 0;
  const date = preds[0].date;
  await run("BEGIN TRANSACTION");
  await run("DELETE FROM game_predictions WHERE game_date = ?", [date]);
  let n = 0;
  for (const p of preds) {
    await run(
      `INSERT INTO game_predictions
       (game_date, game_number, away_team, home_team, pick, confidence,
        home_prob, away_prob, proj_total, home_sp, away_sp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.date, p.game_number || 1, p.away, p.home, p.pick,
       p.confidence, p.home_prob, p.away_prob, p.proj_total,
       p.home_sp || null, p.away_sp || null]
    );
    n++;
  }
  await run("COMMIT");
  return n;
}

async function main() {
  const rows = await all(
    `SELECT DISTINCT game_date FROM historical_lineups
     WHERE game_date >= ? ORDER BY game_date`,
    [fromDate]
  );
  const dates = rows.map(r => r.game_date);
  console.log(`Backfilling ${dates.length} dates (${dates[0]} → ${dates[dates.length - 1]})...\n`);

  for (const date of dates) {
    process.stdout.write(`  ${date}  `);
    try {
      const output = await runPredictor(date);
      const preds  = parsePredictions(output);
      if (!preds.length) {
        console.log("⚠️  no predictions parsed");
        continue;
      }
      const n = await savePredictions(preds);
      console.log(`✅  ${n} games saved`);
    } catch (e) {
      console.log(`❌  ${e.message.split("\n")[0]}`);
    }
    // Brief pause so SQLite WAL flushes and Python GC can settle
    await new Promise(r => setTimeout(r, 300));
  }

  console.log("\nDone.");
  db.close();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
