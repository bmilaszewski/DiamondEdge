/**
 * importFangraphsHitterDiscipline.js
 *
 * Fetches hitter plate discipline stats from Fangraphs and stores them in
 * fangraphs_hitter_discipline table.
 *
 * Key columns for strikeout model (match our empirical correlations):
 *   oz_swing_pct    — O-Swing% = Chase% out-of-zone    [r=+0.245 vs K%, R²=0.060]
 *   z_contact_pct   — Z-Contact% = In-zone contact%   [r=-0.834 vs K%, R²=0.695 — DOMINANT]
 *   swstr_pct       — SwStr% = Overall swing-miss%
 *   z_swing_pct     — Z-Swing% = swing rate in zone
 *   o_contact_pct   — O-Contact% = contact on chase swings
 *   contact_pct     — Contact% overall
 *   zone_pct        — Zone% pitched in zone
 *   f_strike_pct    — F-Strike% first pitch strikes
 *
 * Fangraphs type=5 = Plate Discipline leaderboard
 * Their CDN API: https://cdn.fangraphs.com/api/leaders/major-league/data
 *
 * USAGE:
 *   node importFangraphsHitterDiscipline.js              (current season)
 *   node importFangraphsHitterDiscipline.js --year 2024  (specific year)
 *   node importFangraphsHitterDiscipline.js --all        (2015 → current)
 *
 * This table is used by strikeoutPredictorv2.py as the primary source for
 * hitter oz_swing% and z_contact% when savant_hitter_stats is not populated.
 */

"use strict";

const db    = require("./db");
const fetch = require("node-fetch").default;

const CURRENT_SEASON = 2026;
const RATE_MS        = 1200;

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const allYears  = args.includes("--all");
const yearIdx   = args.indexOf("--year");
const yearArg   = yearIdx !== -1 ? args[yearIdx + 1] : null;

function getYears() {
  if (yearArg)   return [parseInt(yearArg, 10)];
  if (allYears) {
    const yrs = [];
    for (let y = 2015; y <= CURRENT_SEASON; y++) yrs.push(y);
    return yrs;
  }
  return [CURRENT_SEASON];
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS fangraphs_hitter_discipline (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mlb_id          INTEGER,              -- may be null until cross-referenced
    fg_id           TEXT,                 -- Fangraphs player ID
    name            TEXT NOT NULL,
    team            TEXT,
    season          INTEGER NOT NULL,
    pa              INTEGER,
    -- Plate discipline (our primary K-model features)
    oz_swing_pct    REAL,   -- O-Swing%: chase rate  [r=+0.245 vs K%, R²=0.060]
    z_contact_pct   REAL,   -- Z-Contact%: zone contact% [r=-0.834 vs K², R²=0.695]
    swstr_pct       REAL,   -- SwStr%: swing-miss rate
    o_contact_pct   REAL,   -- O-Contact%: contact on chase swings
    contact_pct     REAL,   -- Contact% overall
    z_swing_pct     REAL,   -- Z-Swing%: swing rate in zone
    swing_pct       REAL,   -- Swing% overall
    zone_pct        REAL,   -- Zone%: % pitches in strike zone
    f_strike_pct    REAL,   -- F-Strike%: first-pitch strike rate
    -- Strikeout / walk rates for cross-check
    k_pct           REAL,
    bb_pct          REAL,
    UNIQUE(fg_id, season)
  )
`;

// ─── Fangraphs team name → our abbreviation ───────────────────────────────────
// Fangraphs uses team names; we normalize to match daily_lineups
const FG_TEAM_MAP = {
  "ARI":"AZ","ATL":"ATL","BAL":"BAL","BOS":"BOS","CHC":"CHC","CHW":"CWS",
  "CIN":"CIN","CLE":"CLE","COL":"COL","DET":"DET","HOU":"HOU","KCR":"KC",
  "LAA":"LAA","LAD":"LAD","MIA":"MIA","MIL":"MIL","MIN":"MIN","NYM":"NYM",
  "NYY":"NYY","OAK":"ATH","ATH":"ATH","PHI":"PHI","PIT":"PIT","SDP":"SD",
  "SEA":"SEA","SFG":"SF","STL":"STL","TBR":"TB","TEX":"TEX","TOR":"TOR",
  "WSN":"WSH",
  // Full names Fangraphs sometimes uses
  "Diamondbacks":"AZ","Braves":"ATL","Orioles":"BAL","Red Sox":"BOS",
  "Cubs":"CHC","White Sox":"CWS","Reds":"CIN","Guardians":"CLE",
  "Rockies":"COL","Tigers":"DET","Astros":"HOU","Royals":"KC",
  "Angels":"LAA","Dodgers":"LAD","Marlins":"MIA","Brewers":"MIL",
  "Twins":"MIN","Mets":"NYM","Yankees":"NYY","Athletics":"ATH",
  "Phillies":"PHI","Pirates":"PIT","Padres":"SD","Mariners":"SEA",
  "Giants":"SF","Cardinals":"STL","Rays":"TB","Rangers":"TEX",
  "Blue Jays":"TOR","Nationals":"WSH",
};

function normalizeTeam(t) {
  if (!t) return null;
  return FG_TEAM_MAP[t.trim()] || t.trim();
}

// ─── Parse float safely ───────────────────────────────────────────────────────
function pct(v) {
  if (v == null || v === "" || v === "-") return null;
  // Fangraphs returns decimals like 0.312 for 31.2%, or sometimes "31.2%"
  const s = String(v).replace("%", "").trim();
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  // If value looks like it's already a percentage (>1), convert to decimal
  // Fangraphs API returns decimals: 0.312 = 31.2%
  return n;
}

function num(v) {
  if (v == null || v === "" || v === "-") return null;
  const n = parseFloat(String(v).replace(",", ""));
  return isNaN(n) ? null : n;
}

// ─── Fetch one year from Fangraphs ────────────────────────────────────────────
async function fetchYear(year) {
  // Fangraphs CDN API — plate discipline stats (type=5)
  // This is the same endpoint their website uses; publicly accessible
  const url = new URL("https://fangraphs.com/api/leaders/major-league/data");
  url.searchParams.set("age", "");
  url.searchParams.set("pos", "all");
  url.searchParams.set("stats", "bat");
  url.searchParams.set("lg", "all");
  url.searchParams.set("qual", "30");          // min 30 PA
  url.searchParams.set("season", year);
  url.searchParams.set("season1", year);
  url.searchParams.set("startdate", "");
  url.searchParams.set("enddate", "");
  url.searchParams.set("month", "0");
  url.searchParams.set("hand", "");
  url.searchParams.set("team", "0");
  url.searchParams.set("pageitems", "500");
  url.searchParams.set("pagenum", "1");
  url.searchParams.set("ind", "0");
  url.searchParams.set("rost", "0");
  url.searchParams.set("players", "");
  url.searchParams.set("type", "5");           // 5 = Plate Discipline
  url.searchParams.set("postseason", "");
  url.searchParams.set("sortdir", "default");
  url.searchParams.set("sortstat", "OSwing");

  process.stdout.write(`  ${year}  fetching Fangraphs discipline... `);

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": "https://www.fangraphs.com/leaders/major-league",
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 25000,
    });
  } catch (e) {
    console.log(`❌ network: ${e.message}`);
    return [];
  }

  if (!res.ok) {
    // Try the legacy leaders endpoint if CDN fails
    if (res.status === 403 || res.status === 404) {
      return await fetchYearLegacy(year);
    }
    console.log(`❌ HTTP ${res.status}`);
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.log(`❌ JSON parse error: ${e.message}`);
    return [];
  }

  // Fangraphs returns { data: [...], count: N } or just an array
  const rows = Array.isArray(data) ? data : (data.data || []);
  if (!rows.length) {
    console.log("⚠️  no data returned");
    return [];
  }

  console.log(`${rows.length} hitters found`);
  return rows;
}

// ─── Fallback: Fangraphs standard leaders CSV export ─────────────────────────
async function fetchYearLegacy(year) {
  // Standard Fangraphs CSV export — backup if CDN API is blocked
  const url = `https://www.fangraphs.com/leaders/major-league?pos=all&stats=bat&lg=all&qual=30&type=5&season=${year}&season1=${year}&ind=0&team=0&pageitems=500&pagenum=1&csv=1`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/csv, text/html, */*",
      },
      timeout: 20000,
    });
  } catch (e) {
    console.log(`❌ legacy CSV network: ${e.message}`);
    return [];
  }

  if (!res.ok) {
    console.log(`❌ legacy CSV HTTP ${res.status}`);
    return [];
  }

  const text = await res.text();
  const lines = text.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) {
    console.log("⚠️  empty CSV response");
    return [];
  }

  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim());
  const rows = lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.replace(/"/g, "").trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });

  console.log(`${rows.length} hitters from legacy CSV`);
  return rows;
}

// ─── Map Fangraphs row to DB params ──────────────────────────────────────────
function rowToParams(r, year) {
  // Fangraphs field names vary — try multiple aliases
  const name   = (r.PlayerName || r.Name || r.name || "").trim();
  const fgId   = String(r.playerid || r.PlayerId || r.xMLBId || r.fg_id || "").trim();
  const team   = normalizeTeam(r.Team || r.team || r.teamid || "");
  const pa     = parseInt(r.PA || r.pa || 0);

  // Plate discipline columns — Fangraphs API returns decimals (0.312 = 31.2%)
  // Convert: multiply by 100 to store as percentage values matching Savant format
  const toPercent = v => {
    const n = pct(v);
    if (n === null) return null;
    // If already >1, it's already a percentage; otherwise multiply by 100
    return n > 1 ? n : n * 100;
  };

  return [
    null,                                    // mlb_id (populated later via cross-ref)
    fgId || null,
    name || null,
    team || null,
    year,
    pa,
    // O-Swing% = chase rate
    toPercent(r["O-Swing%"] || r.OSwing || r.o_swing || r["O_Swing%"]),
    // Z-Contact% = in-zone contact% (key feature R²=0.695 vs K%)
    toPercent(r["Z-Contact%"] || r.ZContact || r.z_contact || r["Z_Contact%"]),
    // SwStr% = swing-miss rate
    toPercent(r["SwStr%"] || r.SwStr || r.swstr || r.swstrpct),
    // O-Contact%
    toPercent(r["O-Contact%"] || r.OContact || r.o_contact),
    // Contact%
    toPercent(r["Contact%"] || r.Contact || r.contact),
    // Z-Swing%
    toPercent(r["Z-Swing%"] || r.ZSwing || r.z_swing),
    // Swing%
    toPercent(r["Swing%"] || r.Swing || r.swing),
    // Zone%
    toPercent(r["Zone%"] || r.Zone || r.zone),
    // F-Strike%
    toPercent(r["F-Strike%"] || r.FStrike || r.f_strike),
    // K% and BB% for cross-checking
    toPercent(r["K%"] || r.SO || r.kpct),
    toPercent(r["BB%"] || r.BB || r.bbpct),
  ];
}

// ─── Cross-reference FG names with mlb_id from players table ─────────────────
async function crossRefMlbIds() {
  console.log("\n  Cross-referencing Fangraphs names with mlb_id from players table...");

  return new Promise((resolve, reject) => {
    db.run(`
      UPDATE fangraphs_hitter_discipline AS f
      SET mlb_id = (
        SELECT p.mlb_id FROM players p
        WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(f.name))
        LIMIT 1
      )
      WHERE f.mlb_id IS NULL
    `, [], function(err) {
      if (err) { reject(err); return; }
      console.log(`  Updated ${this.changes} mlb_id cross-references`);
      resolve(this.changes);
    });
  });
}

// ─── Import one year ──────────────────────────────────────────────────────────
async function importYear(year) {
  const rows = await fetchYear(year);
  if (!rows.length) return 0;

  await run("DELETE FROM fangraphs_hitter_discipline WHERE season = ?", [year]);
  await run("BEGIN TRANSACTION");

  let inserted = 0, failed = 0;
  for (const row of rows) {
    const params = rowToParams(row, year);
    const name = params[2];
    if (!name) continue;

    try {
      await run(`
        INSERT OR REPLACE INTO fangraphs_hitter_discipline (
          mlb_id, fg_id, name, team, season, pa,
          oz_swing_pct, z_contact_pct, swstr_pct, o_contact_pct,
          contact_pct, z_swing_pct, swing_pct, zone_pct, f_strike_pct,
          k_pct, bb_pct
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, params);
      inserted++;
    } catch (e) {
      if (!e.message.includes("UNIQUE")) {
        failed++;
      }
    }
  }

  await run("COMMIT");
  process.stdout.write(`→ ${inserted} rows inserted`);
  if (failed) process.stdout.write(`, ${failed} failed`);
  console.log();
  return inserted;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const years = getYears();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Fangraphs Hitter Plate Discipline Import");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Years: ${years.join(", ")}`);
  console.log(`  Columns: O-Swing% (chase), Z-Contact% (zone contact), SwStr%`);
  console.log(`  Source: cdn.fangraphs.com (public API, no key needed)`);
  console.log();

  await run(CREATE_TABLE);
  console.log("✓ fangraphs_hitter_discipline table ready\n");

  let total = 0;
  for (let i = 0; i < years.length; i++) {
    total += await importYear(years[i]);
    if (i < years.length - 1) await sleep(RATE_MS);
  }

  if (total > 0) {
    await crossRefMlbIds();
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  Complete — ${total} total hitter-season rows`);
  console.log(`\n  Next steps:`);
  console.log(`  1. python strikeoutPredictorv2.py --train  (retrain with real chase%)`);
  console.log(`  2. Add to runAll.js: node importFangraphsHitterDiscipline.js`);

  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });