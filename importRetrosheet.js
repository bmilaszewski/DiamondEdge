/**
 * importRetrosheet.js
 *
 * Streams Retrosheet CSV files into SQLite tables.
 * Only imports 2015+ data to keep the DB manageable.
 *
 * Files consumed (must be in project root):
 *   gameinfo.csv   — game metadata (date, teams, weather, runs)
 *   batting.csv    — per-game per-player batting lines
 *   pitching.csv   — per-game per-pitcher lines
 *   allplayers.csv — Retrosheet player directory (for name→mlb_id mapping)
 *
 * Usage:
 *   node importRetrosheet.js                  (all files, 2015+)
 *   node importRetrosheet.js --from 2020      (2020+ only)
 *   node importRetrosheet.js --file gameinfo  (one file only)
 *   node importRetrosheet.js --file batting
 *   node importRetrosheet.js --file pitching
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const rl     = require("readline");
const db     = require("./db");

const ROOT   = __dirname;
const args   = process.argv.slice(2);
const fromYr = parseInt(args[args.indexOf("--from") + 1] || "2015");
const fileArg = args[args.indexOf("--file") + 1] || "all";

const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, rows) => { e ? rej(e) : res(rows); }));
const get = (sql, p = []) => new Promise((res, rej) =>
  db.get(sql, p, (e, row) => { e ? rej(e) : res(row); }));

// ── Retrosheet team abbreviation → MLB abbreviation ───────────────────────────
const RS_TEAM = {
  ARI:"AZ",AZ:"AZ",ATL:"ATL",BAL:"BAL",BOS:"BOS",CHN:"CHC",CHA:"CWS",
  CIN:"CIN",CLE:"CLE",COL:"COL",DET:"DET",HOU:"HOU",KCA:"KC",ANA:"LAA",
  LAA:"LAA",LAN:"LAD",FLO:"MIA",MIA:"MIA",MIL:"MIL",MIN:"MIN",NYN:"NYM",
  NYA:"NYY",OAK:"ATH",PHI:"PHI",PIT:"PIT",SDN:"SD",SFN:"SF",SEA:"SEA",
  SLN:"STL",TBA:"TB",TEX:"TEX",TOR:"TOR",WAS:"WSH",MON:"WSH",
};
function normTeam(t) { return RS_TEAM[t] || t || null; }

// Extract season from a Retrosheet date field like "20230415" or gid like "ARI20230415"
function seasonFromDate(d) {
  const s = String(d || "");
  const m = s.match(/(\d{4})\d{4}$/);
  return m ? parseInt(m[1]) : null;
}

// ── Schema ────────────────────────────────────────────────────────────────────
const DDL = {
  rs_game_log: `
    CREATE TABLE IF NOT EXISTS rs_game_log (
      gid          TEXT PRIMARY KEY,
      season       INTEGER,
      game_date    TEXT,
      vis_team     TEXT,
      home_team    TEXT,
      vis_runs     INTEGER,
      home_runs    INTEGER,
      innings      INTEGER,
      attendance   INTEGER,
      temp         INTEGER,
      wind_dir     TEXT,
      wind_speed   INTEGER,
      sky          TEXT,
      field_cond   TEXT,
      precip       TEXT
    )`,

  rs_batting: `
    CREATE TABLE IF NOT EXISTS rs_batting (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      gid           TEXT NOT NULL,
      retro_id      TEXT NOT NULL,
      mlb_id        INTEGER,
      team          TEXT,
      season        INTEGER,
      game_date     TEXT,
      pa            INTEGER,
      ab            INTEGER,
      r             INTEGER,
      h             INTEGER,
      d             INTEGER,
      t             INTEGER,
      hr            INTEGER,
      rbi           INTEGER,
      bb            INTEGER,
      k             INTEGER,
      sb            INTEGER,
      cs            INTEGER,
      hbp           INTEGER,
      UNIQUE(gid, retro_id)
    )`,

  rs_pitching: `
    CREATE TABLE IF NOT EXISTS rs_pitching (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      gid           TEXT NOT NULL,
      retro_id      TEXT NOT NULL,
      mlb_id        INTEGER,
      team          TEXT,
      season        INTEGER,
      game_date     TEXT,
      ipouts        INTEGER,
      bfp           INTEGER,
      h             INTEGER,
      r             INTEGER,
      er            INTEGER,
      bb            INTEGER,
      k             INTEGER,
      hr            INTEGER,
      gs            INTEGER,
      win           INTEGER,
      loss          INTEGER,
      save          INTEGER,
      UNIQUE(gid, retro_id)
    )`,

  rs_players: `
    CREATE TABLE IF NOT EXISTS rs_players (
      retro_id   TEXT PRIMARY KEY,
      last_name  TEXT,
      first_name TEXT,
      bat_hand   TEXT,
      throw_hand TEXT,
      mlb_id     INTEGER
    )`,
};

// ── Player ID cache: retro_id → mlb_id ────────────────────────────────────────
let retroToMlb = null;
async function buildPlayerMap() {
  if (retroToMlb) return;
  retroToMlb = {};
  const rows = await all("SELECT retro_id, mlb_id FROM rs_players WHERE mlb_id IS NOT NULL");
  for (const r of rows) retroToMlb[r.retro_id] = r.mlb_id;
}

// ── allplayers.csv → rs_players ───────────────────────────────────────────────
async function importPlayers() {
  const file = path.join(ROOT, "allplayers.csv");
  if (!fs.existsSync(file)) { console.log("  allplayers.csv not found, skipping"); return; }

  await run(DDL.rs_players);
  // Try to join with existing players table by name
  const playersByName = {};
  const dbPlayers = await all("SELECT mlb_id, name FROM players");
  for (const p of dbPlayers) {
    const k = p.name?.toLowerCase().replace(/[^a-z ]/g, "").trim();
    if (k) playersByName[k] = p.mlb_id;
  }

  const stream = fs.createReadStream(file, "utf8");
  const liner  = rl.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null, inserted = 0, total = 0;

  await run("BEGIN TRANSACTION");
  for await (const line of liner) {
    if (!header) { header = line.split(","); continue; }
    const cols = line.split(",");
    const retro_id  = cols[0]?.trim();
    const last_name = cols[1]?.trim();
    const first_name= cols[2]?.trim();
    const bat       = cols[3]?.trim();
    const thr       = cols[4]?.trim();
    if (!retro_id) continue;

    // Try name match to get mlb_id
    const fullName = `${first_name} ${last_name}`.toLowerCase().replace(/[^a-z ]/g,"").trim();
    const mlb_id = playersByName[fullName] || null;

    try {
      await run(
        "INSERT OR IGNORE INTO rs_players (retro_id,last_name,first_name,bat_hand,throw_hand,mlb_id) VALUES (?,?,?,?,?,?)",
        [retro_id, last_name, first_name, bat, thr, mlb_id]
      );
      inserted++;
    } catch (_) {}
    total++;
  }
  await run("COMMIT");
  console.log(`  ✓ rs_players: ${inserted.toLocaleString()} / ${total.toLocaleString()} rows`);
}

// ── CSV streaming helper ───────────────────────────────────────────────────────
async function streamCSV(file, onRow, onDone) {
  if (!fs.existsSync(file)) { console.log(`  ${path.basename(file)} not found, skipping`); return; }
  const stream = fs.createReadStream(file, "utf8");
  const liner  = rl.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  for await (const line of liner) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!header) {
      header = trimmed.split(",").map(h => h.trim().replace(/^"|"$/g, ""));
      continue;
    }
    const cols = trimmed.split(",");
    const row  = {};
    header.forEach((h, i) => { row[h] = (cols[i] || "").trim().replace(/^"|"$/g, ""); });
    await onRow(row);
  }
  if (onDone) await onDone();
}

// ── gameinfo.csv → rs_game_log ────────────────────────────────────────────────
async function importGameInfo() {
  await run(DDL.rs_game_log);
  console.log("  Streaming gameinfo.csv …");

  const BATCH = 500;
  let buf = [], total = 0, skipped = 0;

  const flush = async () => {
    await run("BEGIN TRANSACTION");
    for (const r of buf) {
      try {
        await run(`INSERT OR REPLACE INTO rs_game_log
          (gid,season,game_date,vis_team,home_team,vis_runs,home_runs,innings,attendance,temp,wind_dir,wind_speed,sky,field_cond,precip)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.gid, r.season, r.game_date, r.vis_team, r.home_team,
           r.vis_runs, r.home_runs, r.innings,
           r.attendance, r.temp, r.wind_dir, r.wind_speed,
           r.sky, r.field_cond, r.precip]);
      } catch (_) {}
    }
    await run("COMMIT");
    total += buf.length;
    buf = [];
    if (total % 10000 === 0) process.stdout.write(`\r    ${total.toLocaleString()} games…`);
  };

  await streamCSV(path.join(ROOT, "gameinfo.csv"), async (row) => {
    const season = parseInt(row.season || row.date?.slice(0,4) || 0);
    if (season < fromYr) { skipped++; return; }

    const gid      = row.gid;
    const dateStr  = String(row.date || "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    buf.push({
      gid,
      season,
      game_date:  dateStr,
      vis_team:   normTeam(row.visteam),
      home_team:  normTeam(row.hometeam),
      vis_runs:   parseInt(row.vruns) || 0,
      home_runs:  parseInt(row.hruns) || 0,
      innings:    parseInt(row.innings) || 9,
      attendance: parseInt(row.attendance) || null,
      temp:       parseInt(row.temp) || null,
      wind_dir:   row.winddir || null,
      wind_speed: parseInt(row.windspeed) || null,
      sky:        row.sky || null,
      field_cond: row.fieldcond || null,
      precip:     row.precip || null,
    });
    if (buf.length >= BATCH) await flush();
  }, flush);

  console.log(`\n  ✓ rs_game_log: ${total.toLocaleString()} games (skipped ${skipped.toLocaleString()} pre-${fromYr})`);
}

// ── batting.csv → rs_batting ──────────────────────────────────────────────────
async function importBatting() {
  await run(DDL.rs_batting);
  await buildPlayerMap();
  console.log("  Streaming batting.csv …");

  const BATCH = 2000;
  let buf = [], total = 0, skipped = 0;

  const flush = async () => {
    await run("BEGIN TRANSACTION");
    for (const r of buf) {
      try {
        await run(`INSERT OR IGNORE INTO rs_batting
          (gid,retro_id,mlb_id,team,season,game_date,pa,ab,r,h,d,t,hr,rbi,bb,k,sb,cs,hbp)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.gid, r.retro_id, r.mlb_id, r.team, r.season, r.game_date,
           r.pa, r.ab, r.r, r.h, r.d, r.t, r.hr, r.rbi,
           r.bb, r.k, r.sb, r.cs, r.hbp]);
      } catch (_) {}
    }
    await run("COMMIT");
    total += buf.length;
    buf = [];
    if (total % 50000 === 0) process.stdout.write(`\r    ${total.toLocaleString()} batting rows…`);
  };

  await streamCSV(path.join(ROOT, "batting.csv"), async (row) => {
    if (row.stattype !== "value") return; // skip 'official' duplicates
    const season = seasonFromDate(row.date) || parseInt(row.gid?.slice(-8,  -4));
    if (!season || season < fromYr) { skipped++; return; }
    if (!row.gid || !row.id) return;

    const dateStr = String(row.date || "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    buf.push({
      gid:      row.gid,
      retro_id: row.id,
      mlb_id:   retroToMlb[row.id] || null,
      team:     normTeam(row.team),
      season,
      game_date: dateStr,
      pa:   parseInt(row.b_pa)  || 0,
      ab:   parseInt(row.b_ab)  || 0,
      r:    parseInt(row.b_r)   || 0,
      h:    parseInt(row.b_h)   || 0,
      d:    parseInt(row.b_d)   || 0,
      t:    parseInt(row.b_t)   || 0,
      hr:   parseInt(row.b_hr)  || 0,
      rbi:  parseInt(row.b_rbi) || 0,
      bb:   parseInt(row.b_w)   || 0,
      k:    parseInt(row.b_k)   || 0,
      sb:   parseInt(row.b_sb)  || 0,
      cs:   parseInt(row.b_cs)  || 0,
      hbp:  parseInt(row.b_hbp) || 0,
    });
    if (buf.length >= BATCH) await flush();
  }, flush);

  console.log(`\n  ✓ rs_batting: ${total.toLocaleString()} rows (skipped ${skipped.toLocaleString()} pre-${fromYr})`);
}

// ── pitching.csv → rs_pitching ────────────────────────────────────────────────
async function importPitching() {
  await run(DDL.rs_pitching);
  await buildPlayerMap();
  console.log("  Streaming pitching.csv …");

  const BATCH = 2000;
  let buf = [], total = 0, skipped = 0;

  const flush = async () => {
    await run("BEGIN TRANSACTION");
    for (const r of buf) {
      try {
        await run(`INSERT OR IGNORE INTO rs_pitching
          (gid,retro_id,mlb_id,team,season,game_date,ipouts,bfp,h,r,er,bb,k,hr,gs,win,loss,save)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.gid, r.retro_id, r.mlb_id, r.team, r.season, r.game_date,
           r.ipouts, r.bfp, r.h, r.r, r.er, r.bb, r.k, r.hr,
           r.gs, r.win, r.loss, r.save]);
      } catch (_) {}
    }
    await run("COMMIT");
    total += buf.length;
    buf = [];
    if (total % 20000 === 0) process.stdout.write(`\r    ${total.toLocaleString()} pitching rows…`);
  };

  await streamCSV(path.join(ROOT, "pitching.csv"), async (row) => {
    if (row.stattype !== "value") return;
    const season = seasonFromDate(row.date) || parseInt(row.gid?.slice(-8, -4));
    if (!season || season < fromYr) { skipped++; return; }
    if (!row.gid || !row.id) return;

    const dateStr = String(row.date || "").replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
    buf.push({
      gid:      row.gid,
      retro_id: row.id,
      mlb_id:   retroToMlb[row.id] || null,
      team:     normTeam(row.team),
      season,
      game_date: dateStr,
      ipouts: parseInt(row.p_ipouts) || 0,
      bfp:    parseInt(row.p_bfp)   || 0,
      h:      parseInt(row.p_h)     || 0,
      r:      parseInt(row.p_r)     || 0,
      er:     parseInt(row.p_er)    || 0,
      bb:     parseInt(row.p_w)     || 0,
      k:      parseInt(row.p_k)     || 0,
      hr:     parseInt(row.p_hr)    || 0,
      gs:     parseInt(row.p_gs)    || 0,
      win:    row.wp === row.id ? 1 : 0,
      loss:   row.lp === row.id ? 1 : 0,
      save:   row.save === row.id ? 1 : 0,
    });
    if (buf.length >= BATCH) await flush();
  }, flush);

  console.log(`\n  ✓ rs_pitching: ${total.toLocaleString()} rows (skipped ${skipped.toLocaleString()} pre-${fromYr})`);
}

// ── Enrich historical_lineups with Retrosheet game outcomes ───────────────────
async function enrichHistoricalLineups() {
  console.log("  Enriching historical_lineups with Retrosheet batting stats …");
  const updated = await run(`
    UPDATE historical_lineups
    SET home_runs = COALESCE(home_runs, rs.hr),
        hits      = COALESCE(hits, rs.h),
        at_bats   = COALESCE(at_bats, rs.ab)
    FROM rs_batting rs
    WHERE historical_lineups.mlb_id   = rs.mlb_id
      AND historical_lineups.game_date = rs.game_date
      AND historical_lineups.mlb_id IS NOT NULL
      AND rs.mlb_id IS NOT NULL
  `);
  console.log(`  ✓ Enriched ${updated.changes || 0} historical_lineups rows`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  DiamondEdge — Retrosheet Import");
  console.log(`  From year : ${fromYr}`);
  console.log(`  File      : ${fileArg}`);
  console.log("═══════════════════════════════════════════════\n");

  const runAll = fileArg === "all";

  if (runAll || fileArg === "players")  await importPlayers();
  if (runAll || fileArg === "gameinfo") await importGameInfo();
  if (runAll || fileArg === "batting")  await importBatting();
  if (runAll || fileArg === "pitching") await importPitching();
  if (runAll)                           await enrichHistoricalLineups();

  console.log("\n✅ Retrosheet import complete.");
  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
