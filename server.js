require("dotenv").config();
const express  = require("express");
const path     = require("path");
const db       = require("./db");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");

// ── Odds fetching (OddsAPI primary, ESPN fallback) ────────
let nodeFetch = null;
try { nodeFetch = require("node-fetch").default; } catch (_) {}

// Load Odds API key from oddsAPI.env or .env
const ODDS_API_KEY = (() => {
  const fs = require("fs"), path2 = require("path");
  for (const name of ["oddsAPI.env", ".env"]) {
    const p = path2.join(__dirname, name);
    try {
      if (fs.existsSync(p)) {
        for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
          const eq = line.indexOf("=");
          if (eq > 0) {
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
            if (k === "ODDS_API_KEY" && v) return v;
          }
        }
      }
    } catch (_) {}
  }
  return process.env.ODDS_API_KEY || null;
})();

// Ensure betting_odds table exists (importBettingOdds.js also creates it, but
// the server needs it present before any query or auto-fetch attempt).
const BETTING_ODDS_DDL = `
  CREATE TABLE IF NOT EXISTS betting_odds (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    game_date        TEXT NOT NULL,
    home_team        TEXT NOT NULL,
    away_team        TEXT NOT NULL,
    game_number      INTEGER DEFAULT 1,
    source           TEXT NOT NULL,
    bookmaker        TEXT,
    market           TEXT NOT NULL,
    home_ml          INTEGER,
    away_ml          INTEGER,
    home_prob        REAL,
    away_prob        REAL,
    home_spread      REAL,
    home_spread_odds INTEGER,
    away_spread      REAL,
    away_spread_odds INTEGER,
    total_line       REAL,
    over_odds        INTEGER,
    under_odds       INTEGER,
    game_time        TEXT,
    fetched_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(game_date, game_number, home_team, away_team, source, bookmaker, market)
  )`;
db.run(BETTING_ODDS_DDL, err => {
  if (err) console.error("[betting_odds table]", err.message);
  // Add game_time column to existing tables that predate this field
  else db.run(`ALTER TABLE betting_odds ADD COLUMN game_time TEXT`, () => {});
});

// Add columns to homerun_predictions for game-grouped display
for (const col of [
  'batting_order INTEGER', 'home_team TEXT', 'opponent TEXT',
  'temp_f REAL', 'wind_mph REAL', 'weather_cond TEXT'
]) {
  db.run(`ALTER TABLE homerun_predictions ADD COLUMN ${col}`, () => {});
}

db.run(`CREATE TABLE IF NOT EXISTS game_predictions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date   TEXT NOT NULL,
  game_number INTEGER DEFAULT 1,
  away_team   TEXT NOT NULL,
  home_team   TEXT NOT NULL,
  pick        TEXT NOT NULL,
  confidence  REAL,
  home_prob   REAL,
  away_prob   REAL,
  proj_total  REAL,
  home_sp     TEXT,
  away_sp     TEXT,
  reason      TEXT,
  saved_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(game_date, game_number, away_team, home_team)
)`, err => { if (err) console.error("[game_predictions table]", err.message); });
// Safe migration for existing DBs that predate the reason column
db.run(`ALTER TABLE game_predictions ADD COLUMN reason TEXT`, () => {});

db.run(`CREATE TABLE IF NOT EXISTS game_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date     TEXT NOT NULL,
  home_team     TEXT NOT NULL,
  away_team     TEXT NOT NULL,
  game_number   INTEGER DEFAULT 1,
  espn_event_id TEXT,
  game_time     TEXT,
  home_sp_name  TEXT,
  away_sp_name  TEXT,
  fetched_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(game_date, home_team, away_team, game_number)
)`, err => { if (err) console.error("[game_schedule table]", err.message); });

db.run(`CREATE TABLE IF NOT EXISTS strikeout_predictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date       TEXT NOT NULL,
  pitcher         TEXT NOT NULL,
  team            TEXT NOT NULL,
  opponent        TEXT NOT NULL,
  pred_k          REAL,
  k_pct           REAL,
  whiff_pct       REAL,
  chase_pct       REAL,
  iz_contact_pct  REAL,
  lineup_iz       REAL,
  lineup_chase    REAL,
  lineup_bat_speed REAL,
  lineup_vuln     REAL,
  exp_k_rate      REAL,
  data_quality    TEXT,
  saved_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(game_date, pitcher, team)
)`, err => { if (err) console.error("[strikeout_predictions table]", err.message); });

db.run(`CREATE TABLE IF NOT EXISTS homerun_predictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_date       TEXT NOT NULL,
  batter          TEXT NOT NULL,
  team            TEXT NOT NULL,
  vs_pitcher      TEXT,
  hr_prob_pa      REAL,
  hr_prob_game    REAL,
  park_factor     REAL,
  weather_factor  REAL,
  saved_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(game_date, batter, team)
)`, err => { if (err) console.error("[homerun_predictions table]", err.message); });

const ESPN_TEAM_MAP = {
  "Arizona Diamondbacks":"AZ","Atlanta Braves":"ATL","Baltimore Orioles":"BAL",
  "Boston Red Sox":"BOS","Chicago Cubs":"CHC","Chicago White Sox":"CWS",
  "Cincinnati Reds":"CIN","Cleveland Guardians":"CLE","Colorado Rockies":"COL",
  "Detroit Tigers":"DET","Houston Astros":"HOU","Kansas City Royals":"KC",
  "Los Angeles Angels":"LAA","Los Angeles Dodgers":"LAD","Miami Marlins":"MIA",
  "Milwaukee Brewers":"MIL","Minnesota Twins":"MIN","New York Mets":"NYM",
  "New York Yankees":"NYY","Oakland Athletics":"ATH","Athletics":"ATH",
  "Philadelphia Phillies":"PHI","Pittsburgh Pirates":"PIT","San Diego Padres":"SD",
  "San Francisco Giants":"SF","Seattle Mariners":"SEA","St. Louis Cardinals":"STL",
  "Tampa Bay Rays":"TB","Texas Rangers":"TEX","Toronto Blue Jays":"TOR",
  "Washington Nationals":"WSH",
  "Diamondbacks":"AZ","Braves":"ATL","Orioles":"BAL","Red Sox":"BOS","Cubs":"CHC",
  "White Sox":"CWS","Reds":"CIN","Guardians":"CLE","Rockies":"COL","Tigers":"DET",
  "Astros":"HOU","Royals":"KC","Angels":"LAA","Dodgers":"LAD","Marlins":"MIA",
  "Brewers":"MIL","Twins":"MIN","Mets":"NYM","Yankees":"NYY","Phillies":"PHI",
  "Pirates":"PIT","Padres":"SD","Giants":"SF","Mariners":"SEA","Cardinals":"STL",
  "Rays":"TB","Rangers":"TEX","Blue Jays":"TOR","Nationals":"WSH",
  "ARI":"ARI","AZ":"ARI","ATL":"ATL","BAL":"BAL","BOS":"BOS","CHC":"CHC",
  "CWS":"CWS","CIN":"CIN","CLE":"CLE","COL":"COL","DET":"DET","HOU":"HOU",
  "KC":"KC","KCR":"KC","LAA":"LAA","LAD":"LAD","MIA":"MIA","MIL":"MIL",
  "MIN":"MIN","NYM":"NYM","NYY":"NYY","OAK":"ATH","PHI":"PHI","PIT":"PIT",
  "SD":"SD","SDP":"SD","SF":"SF","SFG":"SF","SEA":"SEA","STL":"STL",
  "TB":"TB","TBR":"TB","TEX":"TEX","TOR":"TOR","WSH":"WSH","WSN":"WSH",
};
function normTeam(name) {
  if (!name) return null;
  const n = String(name).trim();
  if (ESPN_TEAM_MAP[n]) return ESPN_TEAM_MAP[n];
  const words = n.split(" ");
  for (let i = 1; i < words.length; i++) {
    const sub = words.slice(i).join(" ");
    if (ESPN_TEAM_MAP[sub]) return ESPN_TEAM_MAP[sub];
  }
  if (n.length <= 4 && n === n.toUpperCase()) return n;
  return null;
}
function mlToProb(ml) {
  const n = parseInt(ml);
  if (isNaN(n)) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

const espnFetchCache   = {};  // date → timestamp (10-min cooldown)
const oddsApiCache     = {};  // date → timestamp (10-min cooldown)
const scheduleFetchCache = {}; // date → timestamp (10-min cooldown)

// ── OddsAPI fetch ─────────────────────────────────────────
async function fetchOddsApiForDate(date, skipGames = new Set()) {
  if (!nodeFetch || !ODDS_API_KEY) return 0;
  const now = Date.now();
  if (oddsApiCache[date] && now - oddsApiCache[date] < 10 * 60 * 1000) return 0;

  let games;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&dateFormat=iso&oddsFormat=american`;
    const res = await nodeFetch(url, { headers: { "User-Agent": "DiamondEdge/1.0" }, timeout: 20000 });
    if (!res.ok) { console.log(`[OddsAPI] HTTP ${res.status}`); return 0; }
    const rem = res.headers.get("x-requests-remaining");
    if (rem) console.log(`[OddsAPI] quota left: ${rem}/month`);
    games = await res.json();
    if (!Array.isArray(games)) return 0;
  } catch (e) { console.log(`[OddsAPI] error: ${e.message}`); return 0; }

  const rows = [];
  for (const game of games) {
    // Use the game's actual ET date — store future dates too so they're ready when needed
    const gameETDate = new Date(game.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    const homeTeam = normTeam(game.home_team);
    const awayTeam = normTeam(game.away_team);
    if (!homeTeam || !awayTeam) continue;

    // Skip games already in-progress or completed — their lines may be live in-game odds
    if (skipGames.has(awayTeam + "@" + homeTeam) || skipGames.has(homeTeam + "@" + awayTeam)) continue;

    // Also skip based on commence_time — if the game has already started, don't store lines
    const commenceTime = game.commence_time ? new Date(game.commence_time) : null;
    if (commenceTime && commenceTime <= new Date()) continue;

    const gameTimeET = game.commence_time
      ? new Date(game.commence_time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET'
      : null;

    for (const book of (game.bookmakers || [])) {
      if (!/^draftkings$/i.test(book.title || book.key)) continue;
      for (const mkt of (book.markets || [])) {
        const row = {
          game_date: gameETDate, home_team: homeTeam, away_team: awayTeam,
          game_number: 1,
          source: "odds_api", bookmaker: book.title || book.key, market: mkt.key,
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: null, over_odds: null, under_odds: null, game_time: gameTimeET,
        };
        for (const o of (mkt.outcomes || [])) {
          const isHome = normTeam(o.name) === homeTeam;
          if (mkt.key === "h2h") {
            const ml = parseInt(o.price);
            if (isHome) { row.home_ml = ml; row.home_prob = mlToProb(ml); }
            else        { row.away_ml = ml; row.away_prob = mlToProb(ml); }
          } else if (mkt.key === "spreads") {
            if (isHome) { row.home_spread = o.point; row.home_spread_odds = parseInt(o.price); }
            else        { row.away_spread = o.point; row.away_spread_odds = parseInt(o.price); }
          } else if (mkt.key === "totals") {
            if (o.name === "Over")  { row.total_line = o.point; row.over_odds  = parseInt(o.price); }
            if (o.name === "Under") { row.total_line = o.point; row.under_odds = parseInt(o.price); }
          }
        }
        // Reject h2h rows with out-of-range ML — anything beyond ±500 is a live in-game line
        if (row.market === "h2h" && row.home_ml != null && row.away_ml != null) {
          if (Math.abs(row.home_ml) > 500 || Math.abs(row.away_ml) > 500) continue;
        }
        rows.push(row);
      }
    }
  }

  if (!rows.length) return 0;
  const dateGroups = rows.reduce((m, r) => { m[r.game_date] = (m[r.game_date] || 0) + 1; return m; }, {});
  console.log(`[OddsAPI] rows by date: ${JSON.stringify(dateGroups)}`);

  return new Promise(resolve => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      let inserted = 0;
      // INSERT with ON CONFLICT upsert: protect existing odds values (moneylines,
      // spreads, totals) with OR IGNORE, but always update game_time if we have one —
      // so a re-fetch corrects a stale start time without wiping pregame lines.
      const stmt = db.prepare(`INSERT INTO betting_odds (
        game_date,home_team,away_team,game_number,source,bookmaker,market,
        home_ml,away_ml,home_prob,away_prob,
        home_spread,home_spread_odds,away_spread,away_spread_odds,
        total_line,over_odds,under_odds,game_time
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(game_date,game_number,home_team,away_team,source,bookmaker,market)
      DO UPDATE SET game_time = excluded.game_time
        WHERE excluded.game_time IS NOT NULL`);
      for (const r of rows) {
        stmt.run([
          r.game_date, r.home_team, r.away_team, r.game_number || 1, r.source, r.bookmaker, r.market,
          r.home_ml, r.away_ml, r.home_prob, r.away_prob,
          r.home_spread, r.home_spread_odds, r.away_spread, r.away_spread_odds,
          r.total_line, r.over_odds, r.under_odds, r.game_time ?? null,
        ], function(err) { if (!err) inserted++; });
      }
      stmt.finalize();
      db.run("COMMIT", () => {
        if (inserted > 0) oddsApiCache[date] = Date.now();
        console.log(`[OddsAPI] saved ${inserted} rows for ${date}`);
        resolve(inserted);
      });
    });
  });
}

// skipGames: Set of "away@home" keys already covered by a better source
async function fetchEspnOddsForDate(date, skipGames = new Set()) {
  if (!nodeFetch) return 0;
  const now = Date.now();
  if (espnFetchCache[date] && now - espnFetchCache[date] < 10 * 60 * 1000) return 0;

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.espn.com",
    "Referer": "https://www.espn.com/mlb/odds",
  };
  const dateCompact = date.replace(/-/g, "");

  let events;
  try {
    const res = await nodeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: HEADERS, timeout: 15000 }
    );
    if (!res.ok) return 0;
    const rawEvts = (await res.json()).events || [];
    // Sort by start time so doubleheader game 1 always gets gameNum=1
    events = rawEvts.sort((a, b) =>
      (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0)
    );
  } catch (_) { return 0; }

  if (!events.length) return 0;
  console.log(`[ESPN odds] ${events.length} games on ${date}, fetching pregame lines…`);

  const rows = [];
  const seenPairs = {};

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    let homeTeam = null, awayTeam = null;
    for (const c of (comp.competitors || [])) {
      const t = normTeam(c.team?.displayName || c.team?.name || "") || normTeam(c.team?.abbreviation || "");
      if (c.homeAway === "home") homeTeam = t;
      else awayTeam = t;
    }
    if (!homeTeam || !awayTeam) continue;

    // Always count this pair toward game number — even if we skip it below.
    // This ensures game 2 of a doubleheader gets gameNum=2 even when game 1 is
    // post/in and gets skipped before the seenPairs update.
    const pairId = awayTeam + '|' + homeTeam;
    seenPairs[pairId] = (seenPairs[pairId] || 0) + 1;
    const gameNum = seenPairs[pairId];

    // Skip completed games — pregame odds are gone
    // Live games ("in"): still attempt — ESPN sometimes serves the pregame closing
    // line alongside live-adjusted ones. DraftKings-only + ±500 saneML below rejects
    // the live-adjusted values. INSERT OR IGNORE protects existing pregame odds.
    const gameState = comp.status?.type?.state || event.status?.type?.state;
    if (gameState === "post") continue;

    const gameId     = event.id;
    const gameDate   = date;
    const gameTimeET = event.date
      ? new Date(event.date).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET'
      : null;

    // Skip if OddsAPI already has this game (either orientation).
    // For game 2 of a doubleheader, always attempt ESPN (Odds API won't have it).
    if (gameNum === 1 && (skipGames.has(awayTeam + "@" + homeTeam) || skipGames.has(homeTeam + "@" + awayTeam))) continue;

    let oddsItems = [];
    const oddsUrl = comp.odds?.$ref || comp.odds?.ref ||
      `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${gameId}/competitions/${gameId}/odds`;

    try {
      const ores = await nodeFetch(oddsUrl, { headers: HEADERS, timeout: 10000 });
      if (ores.ok) {
        const odata = await ores.json();
        oddsItems = odata.items || [];
        if (oddsItems.length > 0 && oddsItems[0].$ref) {
          const fetched = [];
          for (const item of oddsItems.slice(0, 8)) {
            try {
              const ir = await nodeFetch(item.$ref, { headers: HEADERS, timeout: 8000 });
              if (ir.ok) fetched.push(await ir.json());
            } catch (_) {}
            await new Promise(r => setTimeout(r, 80));
          }
          oddsItems = fetched;
        }
      }
    } catch (_) {}

    if (!oddsItems.length && comp.odds && !comp.odds.$ref)
      oddsItems = Array.isArray(comp.odds) ? comp.odds : [comp.odds];

    for (const odds of oddsItems) {
      if (!odds || typeof odds !== "object") continue;
      const bookmaker = odds.provider?.name || odds.provider?.abbreviation || "ESPN";

      // Only accept DraftKings pregame odds — reject all other books and any live lines
      if (!/^draftkings$/i.test(bookmaker)) continue;

      // Use closing pregame moneyline only — never fall through to the live moneyLine field
      const homeMLRaw = odds.homeTeamOdds?.close?.moneyLine?.american
        ?? odds.homeTeamOdds?.moneyLine
        ?? odds.homeTeamOdds?.price;
      const awayMLRaw = odds.awayTeamOdds?.close?.moneyLine?.american
        ?? odds.awayTeamOdds?.moneyLine
        ?? odds.awayTeamOdds?.price;

      const homeML = parseInt(homeMLRaw ?? "");
      const awayML = parseInt(awayMLRaw ?? "");
      const total  = parseFloat(odds.overUnder ?? odds.total ?? "");
      const spread = parseFloat(odds.spread ?? odds.homeTeamOdds?.pointSpread ?? "");

      // Sanity check: pregame MLB moneylines are always within ±500
      const saneML = !isNaN(homeML) && !isNaN(awayML)
        && Math.abs(homeML) >= 100 && Math.abs(awayML) >= 100
        && Math.abs(homeML) <= 500 && Math.abs(awayML) <= 500;
      if (saneML) {
        rows.push({
          game_date: gameDate, home_team: homeTeam, away_team: awayTeam,
          game_number: gameNum,
          source: "espn", bookmaker, market: "h2h",
          home_ml: homeML, away_ml: awayML,
          home_prob: mlToProb(homeML), away_prob: mlToProb(awayML),
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: null, over_odds: null, under_odds: null, game_time: gameTimeET,
        });
      }
      if (!isNaN(spread)) {
        const hso = parseInt(odds.homeTeamOdds?.spreadOdds ?? odds.homeTeamOdds?.handicapOdds ?? "-110");
        const aso = parseInt(odds.awayTeamOdds?.spreadOdds ?? odds.awayTeamOdds?.handicapOdds ?? "-110");
        rows.push({
          game_date: gameDate, home_team: homeTeam, away_team: awayTeam,
          game_number: gameNum,
          source: "espn", bookmaker, market: "spreads",
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: spread, home_spread_odds: isNaN(hso) ? -110 : hso,
          away_spread: -spread, away_spread_odds: isNaN(aso) ? -110 : aso,
          total_line: null, over_odds: null, under_odds: null, game_time: gameTimeET,
        });
      }
      if (!isNaN(total) && total > 0) {
        const oo = parseInt(odds.overOdds ?? odds.overPrice ?? "-110");
        const uo = parseInt(odds.underOdds ?? odds.underPrice ?? "-110");
        rows.push({
          game_date: gameDate, home_team: homeTeam, away_team: awayTeam,
          game_number: gameNum,
          source: "espn", bookmaker, market: "totals",
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: total, over_odds: isNaN(oo) ? -110 : oo, under_odds: isNaN(uo) ? -110 : uo,
          game_time: gameTimeET,
        });
      }
    }

    await new Promise(r => setTimeout(r, 150));
  }

  if (!rows.length) return 0;

  return new Promise(resolve => {
    db.serialize(() => {
      db.run("BEGIN TRANSACTION");
      let inserted = 0;
      const stmt = db.prepare(`INSERT INTO betting_odds (
        game_date,home_team,away_team,game_number,source,bookmaker,market,
        home_ml,away_ml,home_prob,away_prob,
        home_spread,home_spread_odds,away_spread,away_spread_odds,
        total_line,over_odds,under_odds,game_time
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(game_date,game_number,home_team,away_team,source,bookmaker,market)
      DO UPDATE SET game_time = excluded.game_time
        WHERE excluded.game_time IS NOT NULL`);
      for (const r of rows) {
        stmt.run([
          r.game_date, r.home_team, r.away_team, r.game_number || 1, r.source, r.bookmaker, r.market,
          r.home_ml, r.away_ml, r.home_prob, r.away_prob,
          r.home_spread, r.home_spread_odds, r.away_spread, r.away_spread_odds,
          r.total_line, r.over_odds, r.under_odds, r.game_time ?? null,
        ], function(err) { if (!err) inserted++; });
      }
      stmt.finalize();
      db.run("COMMIT", () => {
        espnFetchCache[date] = Date.now(); // always cache, even when 0 rows (all games live/post)
        console.log(`[ESPN odds] saved ${inserted} rows for ${date}`);
        resolve(inserted);
      });
    });
  });
}

// Short-lived cache for ESPN scores — refreshes every 10s so 5s client polls
// don't hammer ESPN on every request.
const _espnLiveCache = {};  // date → { data, ts }
const ESPN_LIVE_TTL  = 10 * 1000;  // 10 seconds

// Fetch live/final scores + in-progress situation from ESPN scoreboard.
// Returns { 'AWAY@HOME': { state, detail, home_score, away_score, home_won,
//           inning, inning_half, balls, strikes, outs,
//           on_first, on_second, on_third, batter, pitcher } }
async function fetchEspnScores(date) {
  const now = Date.now();
  const cached = _espnLiveCache[date];
  if (cached && (now - cached.ts) < ESPN_LIVE_TTL) return cached.data;
  if (!nodeFetch) return {};
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
  };
  const dateCompact = date.replace(/-/g, "");
  try {
    const res = await nodeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: HEADERS, timeout: 12000 }
    );
    if (!res.ok) return {};
    const eventsRaw = (await res.json()).events || [];
    // Sort by start time so doubleheader game 1 (earlier) always gets gameNum=1,
    // regardless of the order ESPN returns events (live games first, etc.)
    const events = eventsRaw.sort((a, b) =>
      (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0)
    );
    const scores = {};
    const seenPairs = {};
    for (const event of events) {
      const comp = (event.competitions || [])[0];
      if (!comp) continue;
      let homeTeam = null, awayTeam = null, homeScore = null, awayScore = null;
      for (const c of (comp.competitors || [])) {
        const t = normTeam(c.team?.displayName || c.team?.name || '') || normTeam(c.team?.abbreviation || '');
        const sc = c.score != null ? parseInt(c.score) : null;
        if (c.homeAway === 'home') { homeTeam = t; homeScore = sc; }
        else { awayTeam = t; awayScore = sc; }
      }
      if (!homeTeam || !awayTeam) continue;
      const pairId = awayTeam + '|' + homeTeam;
      seenPairs[pairId] = (seenPairs[pairId] || 0) + 1;
      const gameNum = seenPairs[pairId];
      const key = awayTeam + '@' + homeTeam + (gameNum > 1 ? ':' + gameNum : '');
      const state     = comp.status?.type?.state || 'pre';
      const detail    = comp.status?.type?.shortDetail || null;
      const shortDet  = detail || '';
      const inning    = comp.status?.period || null;
      const inningHalf = shortDet.toLowerCase().startsWith('bot') ? 'bot'
                       : shortDet.toLowerCase().startsWith('top') ? 'top' : null;
      const sit = comp.situation || null;
      const gameTimeET = event.date
        ? new Date(event.date).toLocaleTimeString('en-US', {
            timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'
          }) + ' ET'
        : null;
      scores[key] = {
        state,
        detail,
        game_number: gameNum,
        game_time:   gameTimeET,
        home_score:  state !== 'pre' ? homeScore : null,
        away_score:  state !== 'pre' ? awayScore : null,
        home_won:    state === 'post' && homeScore != null && awayScore != null
                       ? (homeScore > awayScore ? 1 : 0) : null,
        inning,
        inning_half: inningHalf,
        balls:       sit?.balls    ?? null,
        strikes:     sit?.strikes  ?? null,
        outs:        sit?.outs     ?? null,
        on_first:    sit?.onFirst  || false,
        on_second:   sit?.onSecond || false,
        on_third:    sit?.onThird  || false,
        batter:      sit?.batter?.athlete?.displayName  || sit?.batter?.athlete?.fullName  || null,
        pitcher:     sit?.pitcher?.athlete?.displayName || sit?.pitcher?.athlete?.fullName || null,
      };
    }
    _espnLiveCache[date] = { data: scores, ts: Date.now() };
    return scores;
  } catch (_) { return {}; }
}

// Fetch today's MLB schedule from ESPN and store in game_schedule table.
// Runs at most once per 10 minutes per date (cached). Also fetches probable
// pitchers per event so Python can use them for doubleheader game 2.
async function fetchAndCacheSchedule(date) {
  if (!nodeFetch) return;
  const now = Date.now();
  if (scheduleFetchCache[date] && now - scheduleFetchCache[date] < 10 * 60 * 1000) return;

  const dateCompact = date.replace(/-/g, '');
  let events = [];
  try {
    const res = await nodeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 10000 }
    );
    if (!res.ok) return;
    const raw = (await res.json()).events || [];
    // Sort by start time so doubleheader game 1 always gets gameNum=1
    events = raw.sort((a, b) =>
      (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0)
    );
  } catch { return; }

  const seenPairs = {};
  const items = [];

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;
    let homeTeam = null, awayTeam = null;
    let homeSP = null, awaySP = null;

    for (const c of (comp.competitors || [])) {
      const abbr = ESPN_TEAM_MAP[(c.team?.displayName || '').trim()]
                   || c.team?.abbreviation?.toUpperCase();
      if (!abbr) continue;

      // Probable pitcher is in competitor.probables[] with name="probableStartingPitcher"
      const probEntry = (c.probables || []).find(p => p.name === 'probableStartingPitcher');
      const spName = probEntry?.athlete?.fullName || probEntry?.athlete?.displayName || null;

      if (c.homeAway === 'home') { homeTeam = abbr; homeSP = spName; }
      else                       { awayTeam = abbr; awaySP = spName; }
    }
    if (!homeTeam || !awayTeam) continue;

    const pairId = awayTeam + '|' + homeTeam;
    seenPairs[pairId] = (seenPairs[pairId] || 0) + 1;
    const gameNum = seenPairs[pairId];

    let gameTimeET = null;
    try {
      const d = new Date(event.date);
      gameTimeET = d.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
      });
    } catch (_) {}

    items.push({ gameDate: date, homeTeam, awayTeam, gameNum, eventId: event.id, gameTimeET,
                 homeSP, awaySP });
  }

  // Upsert all items into game_schedule
  db.serialize(() => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO game_schedule
        (game_date, home_team, away_team, game_number, espn_event_id, game_time, home_sp_name, away_sp_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of items) {
      stmt.run([it.gameDate, it.homeTeam, it.awayTeam, it.gameNum,
                it.eventId || null, it.gameTimeET || null,
                it.homeSP || null, it.awaySP || null]);
    }
    stmt.finalize(() => {
      scheduleFetchCache[date] = Date.now();
      console.log(`[schedule] ${items.length} game(s) for ${date} (DH: ${items.filter(i=>i.gameNum>1).length})`);
    });
  });
}

const JWT_SECRET = process.env.JWT_SECRET || "diamondedge-dev-secret-change-in-prod";
const JWT_EXPIRY = "7d";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Users table created on startup
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    DEFAULT (datetime('now')),
    last_login    TEXT
  )
`, err => {
  if (err) console.error("users table error:", err.message);
  else console.log("users table ready");
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid or expired token" }); }
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); }));
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, display_name, password } = req.body;
    if (!email || !display_name || !password)
      return res.status(400).json({ error: "email, display_name, and password are required" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Invalid email address" });
    const existing = await dbGet("SELECT id FROM users WHERE email = ?", [email.toLowerCase()]);
    if (existing)
      return res.status(409).json({ error: "An account with that email already exists" });
    const hash = await bcrypt.hash(password, 12);
    const result = await dbRun(
      "INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)",
      [email.toLowerCase(), display_name.trim(), hash]
    );
    const token = jwt.sign(
      { id: result.lastID, email: email.toLowerCase(), name: display_name.trim() },
      JWT_SECRET, { expiresIn: JWT_EXPIRY }
    );
    res.json({ token, user: { id: result.lastID, email: email.toLowerCase(), name: display_name.trim() } });
  } catch (err) { console.error("[register]", err); res.status(500).json({ error: "Registration failed" }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });
    const user = await dbGet(
      "SELECT id, email, display_name, password_hash FROM users WHERE email = ?",
      [email.toLowerCase()]
    );
    if (!user)
      return res.status(401).json({ error: "No account found with that email" });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.status(401).json({ error: "Incorrect password" });
    await dbRun("UPDATE users SET last_login = datetime('now') WHERE id = ?", [user.id]);
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.display_name },
      JWT_SECRET, { expiresIn: JWT_EXPIRY }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.display_name } });
  } catch (err) { console.error("[login]", err); res.status(500).json({ error: "Login failed" }); }
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ── Pitcher Leaderboard ──────────────────────────────────
// GET /api/pitchers/leaderboard?stat=k_percent&min_games=3&limit=60
app.get("/api/pitchers/leaderboard", (req, res) => {
  const ALLOWED = ["k_percent","era","whiff_percent","bb_percent","xwoba",
                   "hard_hit_percent","barrel_batted_rate","iz_contact_percent",
                   "exit_velocity_avg","oz_swing_percent","games"];
  const stat      = ALLOWED.includes(req.query.stat) ? req.query.stat : "k_percent";
  const minGames  = Math.max(1, parseInt(req.query.min_games) || 3);
  const limit     = Math.min(100, parseInt(req.query.limit) || 60);
  const season    = parseInt(req.query.season) || 2026;

  db.all(`
    SELECT s.mlb_id, s.name, p.team, p.position,
           s.season, s.games, s.innings_pitched,
           s.era, s.k_percent, s.bb_percent,
           s.whiff_percent, s.oz_swing_percent, s.iz_contact_percent,
           s.barrel_batted_rate, s.hard_hit_percent, s.exit_velocity_avg,
           s.xwoba, s.woba, s.strikeouts, s.walks,
           s.ff_avg_speed as fastball_velo,
           s.pitch_hand
    FROM savant_pitcher_stats s
    LEFT JOIN players p ON s.mlb_id = p.mlb_id
    WHERE s.season = ?
      AND s.games >= ?
      AND s.${stat} IS NOT NULL
    ORDER BY s.${stat} ${stat === "era" || stat === "bb_percent" ||
      stat === "hard_hit_percent" || stat === "barrel_batted_rate" ||
      stat === "exit_velocity_avg" ? "ASC" : "DESC"}
    LIMIT ?
  `, [season, minGames, limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// ── Betting Odds ─────────────────────────────────────────
// GET /api/odds/:date  — consensus + per-book odds for all games
// GET /api/odds/today  — shortcut for today
// Returns today's date in US Eastern time (handles EDT/EST and DST automatically).
// MLB games are organized by Eastern calendar date, not UTC.
function etToday() {
  // Shift back 3 h so midnight–2:59 AM ET still resolves to the previous calendar day,
  // keeping late-night games on the same date they started.
  return new Date(Date.now() - 3 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Lightweight version counter — bumped when lineups or predictions change.
// The client polls this every 60s and re-renders when either value changes.
const dataVersion = { lineup: Date.now(), predictions: Date.now() };

// Set to a non-zero timestamp when lineups are refreshed. The predictions
// endpoint checks this to decide whether to bypass the DB cache and re-run
// the model (with INSERT OR IGNORE so existing picks aren't overwritten).
let lineupsChangedAt = 0;
app.get("/api/data-version", (req, res) => res.json(dataVersion));

app.get("/api/odds/:date", async (req, res) => {
  const date = req.params.date === "today" ? etToday() : req.params.date;

  const queryOdds = () => new Promise(resolve =>
    db.all(`
      SELECT home_team, away_team, game_number, market, bookmaker, source,
             home_ml, away_ml, home_prob, away_prob,
             home_spread, home_spread_odds, away_spread, away_spread_odds,
             total_line, over_odds, under_odds, game_time
      FROM betting_odds
      WHERE game_date = ? AND LOWER(bookmaker) = 'draftkings'
      ORDER BY home_team, away_team, game_number, market,
               CASE source WHEN 'odds_api' THEN 0 WHEN 'espn' THEN 1 ELSE 2 END
    `, [date], (err, rows) => resolve(err ? [] : (rows || [])))
  );

  try {
    let allRows = await queryOdds();
    const isPastDate = date < etToday();

    // Fetch live game states first — needed to guard both Odds API and ESPN imports.
    // Pre-warm the schedule cache in parallel (Python will query it later).
    const [liveScores] = await Promise.all([
      fetchEspnScores(date),
      fetchAndCacheSchedule(date).catch(() => {}),
    ]);
    const liveKeys   = new Set(
      Object.entries(liveScores)
        .filter(([, s]) => s.state === 'in')
        .map(([k]) => k)
    );
    // Games already started (live) or finished (post) — skip for Odds API import
    const startedKeys = new Set(
      Object.entries(liveScores)
        .filter(([, s]) => s.state === 'in' || s.state === 'post')
        .map(([k]) => k)
    );

    // Step 1: OddsAPI — primary source (multi-book, rate-limited 500/month)
    // Only fetch if we have no odds_api rows yet for this date.
    // Pass startedKeys so live/finished games are skipped — their lines may be live odds.
    if (!allRows.some(r => r.source === "odds_api")) {
      await fetchOddsApiForDate(date, startedKeys);
      allRows = await queryOdds();
    }

    // Step 2: ESPN — always fetch for today so pregame lines are available for
    // live games (ESPN keeps the original pregame line even after first pitch).
    // Pass the OddsAPI set only for pre-game games; live games always get ESPN.
    const oddsApiPreGame = new Set(
      allRows
        .filter(r => r.source === "odds_api" && !liveKeys.has(r.away_team + "@" + r.home_team))
        .map(r => r.away_team + "@" + r.home_team)
    );
    const espnAdded = await fetchEspnOddsForDate(date, oddsApiPreGame);
    if (espnAdded > 0) allRows = await queryOdds();

    // If game_schedule has more games than cached predictions (e.g. doubleheader detected
    // after predictions were already cached), invalidate the predictions cache so Python
    // reruns and produces all games including game 2.
    if (date === etToday() && predictionsCache.winners.date === date) {
      const schedCount = await new Promise(resolve =>
        db.get(`SELECT COUNT(*) as n FROM game_schedule WHERE game_date = ?`, [date],
               (e, r) => resolve(r?.n || 0))
      );
      const predCount = await new Promise(resolve =>
        db.get(`SELECT COUNT(*) as n FROM game_predictions WHERE game_date = ?`, [date],
               (e, r) => resolve(r?.n || 0))
      );
      if (schedCount > predCount) {
        console.log(`[predictions] Invalidating cache — schedule has ${schedCount} games, predictions has ${predCount}`);
        predictionsCache.winners = { data: null, date: null };
      }
    }

    // Group by game
    const gamesMap = {};
    for (const row of allRows) {
      const key = row.away_team + "@" + row.home_team + ((row.game_number || 1) > 1 ? ':' + row.game_number : '');
      if (!gamesMap[key]) {
        gamesMap[key] = {
          home: row.home_team, away: row.away_team,
          game_number: row.game_number || 1,
          h2h: null, spreads: null, totals: null,
          books: [], game_time: null
        };
      }
      const g = gamesMap[key];
      if (!g.game_time && row.game_time) g.game_time = row.game_time;

      // For games that have started (live) or finished (post), only ESPN holds the
      // original pregame closing line. Exclude Odds API rows — they may reflect live
      // in-game odds if the Odds API was called after first pitch.
      // Exception: past dates — all stored odds were captured as pregame lines.
      const gameStarted = !isPastDate && (liveKeys.has(key) || liveScores[key]?.state === 'post');
      const rowIsPregame = !gameStarted || row.source === 'espn';

      // Track this book's lines (pregame rows only for live/finished games today)
      if (rowIsPregame) {
        const existing = g.books.find(b => b.bookmaker === row.bookmaker);
        if (!existing) {
          g.books.push({
            bookmaker: row.bookmaker,
            source:    row.source,
            home_ml:   row.market === "h2h"     ? row.home_ml  : null,
            away_ml:   row.market === "h2h"     ? row.away_ml  : null,
            home_spread: row.market === "spreads" ? row.home_spread : null,
            home_spread_odds: row.market === "spreads" ? row.home_spread_odds : null,
            away_spread: row.market === "spreads" ? row.away_spread : null,
            total_line: row.market === "totals" ? row.total_line : null,
            over_odds:  row.market === "totals" ? row.over_odds : null,
            under_odds: row.market === "totals" ? row.under_odds : null,
          });
        } else {
          if (row.market === "h2h")     { existing.home_ml = row.home_ml; existing.away_ml = row.away_ml; }
          if (row.market === "spreads") { existing.home_spread = row.home_spread; existing.home_spread_odds = row.home_spread_odds; existing.away_spread = row.away_spread; }
          if (row.market === "totals")  { existing.total_line = row.total_line; existing.over_odds = row.over_odds; existing.under_odds = row.under_odds; }
        }
      }

      // Build consensus (average across books — exclude live in-game lines).
      const noLive      = r => !/live/i.test(r.bookmaker||'');
      const saneML      = r => Math.abs(r.home_ml||0) <= 500 && Math.abs(r.away_ml||0) <= 500;
      const pregameOnly = r => !gameStarted || r.source === 'espn'; // gameStarted already false for past dates
      const sameGame    = r => r.away_team===row.away_team && r.home_team===row.home_team && (r.game_number||1)===(row.game_number||1);
      const h2hRows    = allRows.filter(r => sameGame(r) && r.market==="h2h"     && r.home_ml        && noLive(r) && saneML(r) && pregameOnly(r));
      const spreadRows = allRows.filter(r => sameGame(r) && r.market==="spreads" && r.home_spread!=null && noLive(r) && pregameOnly(r));
      const totalRows  = allRows.filter(r => sameGame(r) && r.market==="totals"  && r.total_line      && noLive(r) && pregameOnly(r));

      if (h2hRows.length) {
        g.h2h = {
          home_ml:    Math.round(h2hRows.reduce((s,r)=>s+r.home_ml,0)/h2hRows.length),
          away_ml:    Math.round(h2hRows.reduce((s,r)=>s+r.away_ml,0)/h2hRows.length),
          home_prob:  h2hRows.reduce((s,r)=>s+(r.home_prob||0),0)/h2hRows.length,
          away_prob:  h2hRows.reduce((s,r)=>s+(r.away_prob||0),0)/h2hRows.length,
          book_count: h2hRows.length,
        };
      }
      if (spreadRows.length) {
        g.spreads = {
          home_spread: spreadRows[0].home_spread,
          home_spread_odds: Math.round(spreadRows.reduce((s,r)=>s+(r.home_spread_odds|| -110),0)/spreadRows.length),
          book_count: spreadRows.length,
        };
      }
      if (totalRows.length) {
        const lines = totalRows.map(r=>r.total_line);
        g.totals = {
          total_line: Math.round(lines.reduce((a,b)=>a+b,0)/lines.length * 10) / 10,
          over_odds:  Math.round(totalRows.reduce((s,r)=>s+(r.over_odds|| -110),0)/totalRows.length),
          under_odds: Math.round(totalRows.reduce((s,r)=>s+(r.under_odds|| -110),0)/totalRows.length),
          book_count: totalRows.length,
        };
      }
    }

    // Inject any game_schedule entries not already in gamesMap (e.g. doubleheader game 2
    // with no betting_odds row). Ensures the card and game_time appear in the UI.
    await new Promise(resolve => db.all(
      `SELECT home_team, away_team, game_number, game_time
       FROM game_schedule WHERE game_date = ? ORDER BY game_number`,
      [date], (e, rows) => {
        for (const r of (rows || [])) {
          const key = r.away_team + '@' + r.home_team + (r.game_number > 1 ? ':' + r.game_number : '');
          if (!gamesMap[key]) {
            gamesMap[key] = { home: r.home_team, away: r.away_team,
              game_number: r.game_number, h2h: null, spreads: null, totals: null,
              books: [], game_time: r.game_time || null };
          } else if (!gamesMap[key].game_time && r.game_time) {
            gamesMap[key].game_time = r.game_time;
          }
        }
        resolve();
      }
    ));

    // Dedup: if ESPN reported the same game as OddsAPI (same home team, same game_number),
    // keep the OddsAPI entry. But do NOT dedup different game numbers (doubleheaders).
    const homeToKeys = {};
    for (const key of Object.keys(gamesMap)) {
      const home = key.split('@')[1]?.split(':')[0];
      if (!home) continue;
      if (!homeToKeys[home]) homeToKeys[home] = [];
      homeToKeys[home].push(key);
    }
    for (const keys of Object.values(homeToKeys)) {
      if (keys.length <= 1) continue;
      // Group by game_number — only dedup within the same game number
      const byGameNum = {};
      for (const k of keys) {
        const gn = gamesMap[k]?.game_number || 1;
        if (!byGameNum[gn]) byGameNum[gn] = [];
        byGameNum[gn].push(k);
      }
      for (const sameGameKeys of Object.values(byGameNum)) {
        if (sameGameKeys.length <= 1) continue;
        const apiKey = sameGameKeys.find(k => gamesMap[k].books.some(b => b.source === 'odds_api'));
        if (apiKey) {
          for (const k of sameGameKeys) { if (k !== apiKey) delete gamesMap[k]; }
        }
      }
    }

    res.json({ date, games: Object.values(gamesMap) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Historical games + pregame odds ─────────────────────
app.get("/api/historical/:date", (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });

  const isToday = date === etToday();
  const lineupTable = isToday ? "daily_lineups" : "historical_lineups";

  // Run three parallel queries
  const q1 = new Promise(resolve => db.all(
    `SELECT game_date, home_team, away_team, home_score, away_score, home_won, park_id
     FROM game_results WHERE game_date = ? ORDER BY home_team`,
    [date], (e, r) => resolve(e ? [] : (r || []))
  ));

  const q2 = new Promise(resolve => db.all(
    `SELECT home_team, away_team, game_number, market, bookmaker, source,
            home_ml, away_ml, home_spread, home_spread_odds,
            total_line, over_odds, under_odds, game_time
     FROM betting_odds WHERE game_date = ? AND LOWER(bookmaker) = 'draftkings'
     ORDER BY home_team, away_team, game_number, market,
              CASE source WHEN 'odds_api' THEN 0 WHEN 'espn' THEN 1 ELSE 2 END`,
    [date], (e, r) => resolve(e ? [] : (r || []))
  ));

  const q3 = new Promise(resolve => db.all(
    `SELECT mlb_id, name, team, opponent, batting_order, position, handedness,
            pitcher_name, pitcher_handedness, avg, obp, slg, ops, home_runs, is_home
     FROM ${lineupTable}
     WHERE game_date = ? AND batting_order BETWEEN 1 AND 9
     ORDER BY team, batting_order`,
    [date], (e, r) => resolve(e ? [] : (r || []))
  ));

  // Fetch live/final scores from ESPN for dates beyond the game_results coverage (pre-2026)
  const q4 = date >= '2025-10-01' ? fetchEspnScores(date) : Promise.resolve({});

  Promise.all([q1, q2, q3, q4]).then(([resultRows, oddsRows, lineupRows, liveScores]) => {
    // Build odds lookup
    const oddsMap = {};
    for (const row of oddsRows) {
      const key = row.away_team + '@' + row.home_team + ((row.game_number || 1) > 1 ? ':' + row.game_number : '');
      if (!oddsMap[key]) oddsMap[key] = { h2h: null, totals: null, books: [], game_time: null, game_number: row.game_number || 1 };
      const g = oddsMap[key];
      if (!g.game_time && row.game_time) g.game_time = row.game_time;
      const sane = row.market !== 'h2h'
        || (Math.abs(row.home_ml || 0) <= 1500 && Math.abs(row.away_ml || 0) <= 1500);
      if (!sane) continue;
      const ex = g.books.find(b => b.bookmaker === row.bookmaker);
      if (!ex) {
        g.books.push({
          bookmaker: row.bookmaker, source: row.source,
          home_ml: row.market === 'h2h' ? row.home_ml : null,
          away_ml: row.market === 'h2h' ? row.away_ml : null,
          total_line: row.market === 'totals' ? row.total_line : null,
        });
      } else {
        if (row.market === 'h2h')    { ex.home_ml = row.home_ml; ex.away_ml = row.away_ml; }
        if (row.market === 'totals') { ex.total_line = row.total_line; }
      }
      // Only accept h2h lines within sane pregame range (>±1500 = live in-game lines)
      if (row.market === 'h2h' && !g.h2h && row.home_ml
          && Math.abs(row.home_ml) <= 1500 && Math.abs(row.away_ml || 0) <= 1500)
        g.h2h = { home_ml: row.home_ml, away_ml: row.away_ml };
      if (row.market === 'totals' && !g.totals && row.total_line)
        g.totals = { total_line: row.total_line, over_odds: row.over_odds, under_odds: row.under_odds };
    }

    // Dedup: if ESPN reported the same game as OddsAPI (same home team, same game_number),
    // keep the OddsAPI entry. But do NOT dedup different game numbers (doubleheaders).
    const homeToKeys = {};
    for (const key of Object.keys(oddsMap)) {
      const home = key.split('@')[1]?.split(':')[0];
      if (!home) continue;
      if (!homeToKeys[home]) homeToKeys[home] = [];
      homeToKeys[home].push(key);
    }
    for (const keys of Object.values(homeToKeys)) {
      if (keys.length <= 1) continue;
      // Group by game_number — only dedup within the same game number
      const byGameNum = {};
      for (const k of keys) {
        const gn = oddsMap[k]?.game_number || 1;
        if (!byGameNum[gn]) byGameNum[gn] = [];
        byGameNum[gn].push(k);
      }
      for (const sameGameKeys of Object.values(byGameNum)) {
        if (sameGameKeys.length <= 1) continue;
        const apiKey = sameGameKeys.find(k => oddsMap[k].books.some(b => b.source === 'odds_api'));
        if (apiKey) {
          for (const k of sameGameKeys) { if (k !== apiKey) delete oddsMap[k]; }
        }
      }
    }

    // Dedup reversed-team pairs: some sources swap home/away for the same game,
    // producing both "MIL@WSH" and "WSH@MIL" in oddsMap. Collapse them, preferring
    // the odds_api entry (more reliable direction); otherwise keep the one with more books.
    {
      const pairsSeen = {};
      for (const key of Object.keys(oddsMap)) {
        const atPos  = key.indexOf('@');
        const colPos = key.lastIndexOf(':');
        const hasSfx = colPos > atPos;
        const suffix = hasSfx ? key.slice(colPos) : '';
        const base   = hasSfx ? key.slice(0, colPos) : key;
        const [away, home] = base.split('@');
        const canonical = [away, home].sort().join('+') + suffix;
        if (!pairsSeen[canonical]) {
          pairsSeen[canonical] = key;
        } else {
          const prev = pairsSeen[canonical];
          const prevHasApi = oddsMap[prev]?.books.some(b => b.source === 'odds_api');
          const curHasApi  = oddsMap[key]?.books.some(b => b.source === 'odds_api');
          if (prevHasApi && !curHasApi) {
            delete oddsMap[key];
          } else if (!prevHasApi && curHasApi) {
            delete oddsMap[prev];
            pairsSeen[canonical] = key;
          } else {
            const prevBooks = oddsMap[prev]?.books.length || 0;
            const curBooks  = oddsMap[key]?.books.length || 0;
            if (curBooks > prevBooks) { delete oddsMap[prev]; pairsSeen[canonical] = key; }
            else                      { delete oddsMap[key]; }
          }
        }
      }
    }

    // Assign game_number to result rows for doubleheaders.
    // game_results has no game_number column; assign in occurrence order (game 1 → game 2).
    // The null check is future-safe if the column is ever added to the table.
    const _rPairCnt = {};
    for (const row of resultRows) {
      const pk = row.away_team + '@' + row.home_team;
      _rPairCnt[pk] = (_rPairCnt[pk] || 0) + 1;
      if (row.game_number == null) row.game_number = _rPairCnt[pk];
    }

    // Build games list — use game_results where available, fill from betting_odds/ESPN otherwise
    const resultSet = new Set(resultRows.map(g => g.away_team + '@' + g.home_team));
    const oddsGames = [];
    // Seed coveredKeys with all result rows — including suffixed keys for doubleheader game 2,
    // so the liveScores loop below doesn't add a duplicate entry for a completed game 2.
    const coveredKeys = new Set(resultSet);
    for (const row of resultRows) {
      if ((row.game_number || 1) > 1) {
        coveredKeys.add(row.away_team + '@' + row.home_team + ':' + row.game_number);
      }
    }
    for (const key of Object.keys(oddsMap)) {
      const colonPos = key.lastIndexOf(':');
      const baseKey  = colonPos > key.indexOf('@') ? key.slice(0, colonPos) : key;
      const gameNum  = colonPos > key.indexOf('@') ? parseInt(key.slice(colonPos + 1)) : 1;
      // For a doubleheader: game 1 base key may be in resultSet (game completed), but
      // game 2 (suffixed key) needs its own check against coveredKeys.
      const alreadyInResults = coveredKeys.has(key) || (gameNum === 1 && resultSet.has(baseKey));
      if (!alreadyInResults) {
        const [away, home] = baseKey.split('@');
        oddsGames.push({ game_date: date, home_team: home, away_team: away,
                         game_number: gameNum,
                         home_score: null, away_score: null, home_won: null, park_id: null });
        coveredKeys.add(key);
        coveredKeys.add(baseKey);
      }
    }
    // Also add any ESPN-scored games not yet covered (e.g. games with no stored odds).
    // For game 2 of a doubleheader (key="SF@PHI:2"), check only the exact suffixed key —
    // NOT the baseKey — so game 2 isn't blocked just because game 1 ("SF@PHI") is covered.
    for (const key of Object.keys(liveScores)) {
      const colonPos = key.lastIndexOf(':');
      const hasGameSuffix = colonPos > key.indexOf('@');
      const baseKey = hasGameSuffix ? key.slice(0, colonPos) : key;
      const alreadyCovered = coveredKeys.has(key) || (!hasGameSuffix && coveredKeys.has(baseKey));
      if (!alreadyCovered) {
        const gameNum = hasGameSuffix ? parseInt(key.slice(colonPos + 1)) : 1;
        const [away, home] = baseKey.split('@');
        oddsGames.push({ game_date: date, home_team: home, away_team: away,
                         game_number: gameNum,
                         home_score: null, away_score: null, home_won: null, park_id: null });
        coveredKeys.add(key);
        coveredKeys.add(baseKey);
      }
    }
    const allGames = [...resultRows, ...oddsGames].sort((a, b) =>
      (a.home_team || '').localeCompare(b.home_team || ''));

    // Build lineups lookup: "TEAM" → [players in batting order]
    const lineupMap = {};
    for (const p of lineupRows) {
      if (!lineupMap[p.team]) lineupMap[p.team] = [];
      lineupMap[p.team].push(p);
    }

    res.json({
      date,
      games: allGames.map(g => {
        const gameNum    = g.game_number || 1;
        const gameSuffix = gameNum > 1 ? ':' + gameNum : '';
        const od   = oddsMap[g.away_team + '@' + g.home_team + gameSuffix] || null;
        const live = liveScores[g.away_team + '@' + g.home_team + gameSuffix] || null;
        const home_score  = live?.home_score ?? g.home_score;
        const away_score  = live?.away_score ?? g.away_score;
        const home_won    = live?.home_won   ?? g.home_won;
        const game_state  = live?.state  || (g.home_score != null ? 'post' : 'pre');
        const game_detail = live?.detail || null;
        const situation   = live?.state === 'in' ? {
          inning:      live.inning,
          inning_half: live.inning_half,
          balls:       live.balls,
          strikes:     live.strikes,
          outs:        live.outs,
          on_first:    live.on_first,
          on_second:   live.on_second,
          on_third:    live.on_third,
          batter:      live.batter,
          pitcher:     live.pitcher,
        } : null;
        return {
          ...g,
          game_number: gameNum,
          home_score,
          away_score,
          home_won,
          game_state,
          game_detail,
          situation,
          game_time:   od?.game_time || live?.game_time || null,
          odds:        od,
          home_lineup: lineupMap[g.home_team] || [],
          away_lineup: lineupMap[g.away_team] || [],
        };
      }),
    });
  }).catch(err => res.status(500).json({ error: err.message }));
});

// ── Players ──────────────────────────────────────────────
app.get("/api/players", (req, res) => {
  const { team, position, search } = req.query;
  let sql = "SELECT * FROM players WHERE 1=1";
  const params = [];
  if (team)     { sql += " AND team = ?";           params.push(team); }
  if (position) { sql += " AND position = ?";       params.push(position); }
  if (search)   { sql += " AND name LIKE ?";        params.push(`%${search}%`); }
  sql += " ORDER BY team, name";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/api/players/:mlb_id", (req, res) => {
  db.get("SELECT * FROM players WHERE mlb_id = ?", [req.params.mlb_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

// ── Daily Lineups ─────────────────────────────────────────
app.get("/api/lineups", (req, res) => {
  const { team, date } = req.query;
  let sql = `
    SELECT dl.*, p.mlb_id as player_mlb_id
    FROM daily_lineups dl
    LEFT JOIN players p ON dl.mlb_id = p.mlb_id
    WHERE dl.batting_order > 0
  `;
  const params = [];
  if (team) { sql += " AND dl.team = ?"; params.push(team); }
  if (date) { sql += " AND dl.game_date = ?"; params.push(date); }
  sql += " ORDER BY dl.team, dl.batting_order";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/api/lineups/dates", (req, res) => {
  db.all("SELECT DISTINCT game_date FROM daily_lineups ORDER BY game_date DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.game_date));
  });
});

app.get("/api/lineups/teams", (req, res) => {
  const { date } = req.query;
  let sql = "SELECT DISTINCT team FROM daily_lineups";
  const params = [];
  if (date) { sql += " WHERE game_date = ?"; params.push(date); }
  sql += " ORDER BY team";
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.team));
  });
});

// ── Hitter Recent Stats ───────────────────────────────────
app.get("/api/hitter-recent", (req, res) => {
  const { window = 10, team, sortBy = "ops", order = "desc", limit = 100 } = req.query;
  let sql = `
    SELECT h.*, p.position as player_position
    FROM hitter_recent_stats h
    LEFT JOIN players p ON h.mlb_id = p.mlb_id
    WHERE h.window = ?
  `;
  const params = [parseInt(window)];
  if (team) { sql += " AND h.team = ?"; params.push(team); }
  const allowedCols = ["ops","avg","obp","slg","iso","home_runs","strikeouts","walks","at_bats"];
  const col = allowedCols.includes(sortBy) ? sortBy : "ops";
  const dir = order === "asc" ? "ASC" : "DESC";
  sql += ` ORDER BY h.${col} ${dir} LIMIT ?`;
  params.push(parseInt(limit));
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ── Team list ─────────────────────────────────────────────
app.get("/api/teams", (req, res) => {
  db.all("SELECT DISTINCT team FROM players ORDER BY team", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.team));
  });
});

// ── Hitter vs Pitch Type ─────────────────────────────────
app.get("/api/hitter-vs-pitch", (req, res) => {
  const { pitch_type, year, team } = req.query;

  let sql = `
    SELECT h.*, p.team
    FROM hitter_vs_pitch_type h
    LEFT JOIN players p 
      ON CAST(h.mlb_id AS TEXT) = CAST(p.mlb_id AS TEXT)
  `;

  const where = [];
  const params = [];

  if (pitch_type) {
    where.push("TRIM(h.pitch_type) = ?");
    params.push(pitch_type);
  }

  if (year) {
    where.push("CAST(TRIM(h.year) AS INTEGER) = ?");
    params.push(year);
  }

  if (team) {
    where.push("p.team = ?");
    params.push(team);
  }

  if (where.length) {
    sql += " WHERE " + where.join(" AND ");
  }

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ── Leaderboard (hitter recent, cross-table) ──────────────
app.get("/api/leaderboard", (req, res) => {
  const { window = 10, stat = "ops", limit = 50, team } = req.query;
  const allowedStats = ["ops","avg","obp","slg","iso","home_runs","at_bats","strikeouts","walks","exit_velocity_avg"];
  const isEV = stat === "exit_velocity_avg";
  const col = allowedStats.includes(stat) ? stat : "ops";
  let sql = `
    SELECT h.mlb_id, h.name, h.team, h.position, h.window,
           h.ops, h.avg, h.obp, h.slg, h.iso,
           h.home_runs, h.at_bats, h.hits, h.strikeouts, h.walks, h.games,
           s.exit_velocity_avg
    FROM hitter_recent_stats h
    LEFT JOIN savant_hitter_stats s ON h.mlb_id = s.mlb_id AND s.season = 2026
    WHERE h.window = ? AND h.at_bats >= 5
  `;
  const params = [parseInt(window)];
  if (team) { sql += " AND h.team = ?"; params.push(team); }
  sql += isEV
    ? ` ORDER BY s.exit_velocity_avg DESC LIMIT ?`
    : ` ORDER BY h.${col} DESC LIMIT ?`;
  params.push(parseInt(limit));
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/api/leaderboard/season", (req, res) => {
  const { stat = "ops", limit = 100, season = 2026 } = req.query;
  const allowedStats = ["ops","batting_avg","slg_percent","obp","home_runs","strikeouts","walks","barrel_batted_rate","hard_hit_percent","exit_velocity_avg","whiff_percent","xwoba","bat_speed","pa"];
  const col = allowedStats.includes(stat) ? stat : "ops";
  const yr = parseInt(season);
  db.all(
    `SELECT s.mlb_id, s.name, p.team, p.position,
            s.pa, s.ab, s.ops,
            s.batting_avg AS avg, s.obp, s.slg_percent AS slg,
            (s.slg_percent - s.batting_avg) AS iso,
            s.home_runs, s.strikeouts, s.walks,
            s.exit_velocity_avg, s.barrel_batted_rate, s.hard_hit_percent,
            s.whiff_percent, s.xwoba, s.bat_speed
     FROM savant_hitter_stats s
     LEFT JOIN player_stats p ON s.mlb_id = p.mlb_id AND p.season = ?
     WHERE s.season = ? AND s.pa >= 30
     ORDER BY s.${col} DESC
     LIMIT ?`,
    [yr, yr, parseInt(limit)],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json((rows || []).map(r => ({ ...r, at_bats: r.ab })));
    }
  );
});

// ── Predictions API ───────────────────────────────────────
const { spawn } = require('child_process');
const fs = require('fs');

// Cache for predictions (refresh every hour)
// Cache keyed by ET date — persists for the full day, resets after 3am ET rollover
let predictionsCache = {
  winners:   { data: null, date: null },
  strikeouts: { data: null, date: null },
  homeruns:  { data: null, date: null }
};

function runPythonPredictor(scriptName) {
  return new Promise((resolve, reject) => {
    const python = spawn('py', [scriptName, '--predict']);
    let output = '';
    let errorOutput = '';
    
    python.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script failed: ${errorOutput}`));
      } else {
        resolve(output);
      }
    });
  });
}

function parseWinnerPredictions(output) {
  // Primary: parse PREDSJSON line emitted by predictorv4.py (has model_prob/edge/etc.)
  for (const line of output.split('\n')) {
    if (line.startsWith('PREDSJSON:')) {
      try {
        const arr = JSON.parse(line.slice(10));
        if (Array.isArray(arr) && arr.length) {
          const pairCount = {};
          return arr.map(p => {
            const pairKey = `${p.away}|${p.home}`;
            pairCount[pairKey] = (pairCount[pairKey] || 0) + 1;
            return {
              away:         p.away,
              home:         p.home,
              home_prob:    p.home_prob,
              away_prob:    p.away_prob,
              pick:         p.pick,
              confidence:   p.confidence,
              proj_total:   p.proj_total,
              home_sp:      p.home_sp || null,
              away_sp:      p.away_sp || null,
              game_number:  p.game_number || pairCount[pairKey],
              model_prob:      p.model_prob    ?? null,
              vegas_implied:   p.vegas_implied ?? null,
              edge:            p.edge          ?? null,
              same_side:       p.same_side     ?? null,
              home_era:        p.home_era      ?? null,
              away_era:        p.away_era      ?? null,
              home_sp_era_l5:  p.home_sp_era_l5 ?? null,
              away_sp_era_l5:  p.away_sp_era_l5 ?? null,
              home_rdiff_30:   p.home_rdiff_30 ?? null,
              away_rdiff_30:   p.away_rdiff_30 ?? null,
              home_wpct_30:    p.home_wpct_30  ?? null,
              away_wpct_30:    p.away_wpct_30  ?? null,
              home_lineup_ops: p.home_lineup_ops ?? null,
              away_lineup_ops: p.away_lineup_ops ?? null,
              home_win_streak:  p.home_win_streak  ?? 0,
              away_win_streak:  p.away_win_streak  ?? 0,
              home_loss_streak: p.home_loss_streak ?? 0,
              away_loss_streak: p.away_loss_streak ?? 0,
            };
          });
        }
      } catch (_) {}
    }
  }

  // Fallback: parse table format (no model_prob/edge)
  const lines = output.split('\n');
  const predictions = [];
  let inPredictions = false;

  for (const line of lines) {
    if (line.includes("TODAY'S PREDICTIONS")) { inPredictions = true; continue; }
    if (!inPredictions) continue;
    if (line.includes('MATCHUP') || line.includes('---') || line.includes('===') || line.includes('───') || line.trim() === '') continue;

    // New format (with SP names):
    // "   COL @ HOU    45.2%  54.8% HOU    <  54.8%   8.3  Gerrit Cole           Luis Castillo         3.20/4.10"
    // Old format (no SP names):
    // "   COL @ HOU    45.2%  54.8% HOU    <  54.8%   8.3"
    const m = line.match(
      /^\s+(\w+)\s*@\s*(\w+)\s+([\d.]+)%\s+([\d.]+)%\s+(\w+)\s*[<>]\s+([\d.]+)%\s+([\d.]+)/
    );
    if (m) {
      const pred = {
        away:       m[1].trim(),
        home:       m[2].trim(),
        home_prob:  parseFloat(m[3]),
        away_prob:  parseFloat(m[4]),
        pick:       m[5].trim(),
        confidence: parseFloat(m[6]),
        proj_total: parseFloat(m[7]),
        home_sp:    null,
        away_sp:    null,
      };

      // Extract SP names from after the run total.
      // m[0] already includes leading whitespace (regex starts with ^\s+),
      // so line.slice(m[0].length) correctly positions us right after the match.
      // Do NOT add extra leading-space offset — that was the old indexOf bug.
      const afterTotal = line.slice(m[0].length).trim();
      // Format after total: "  Home SP Name        Away SP Name        ERA/ERA"
      const spMatch = afterTotal.match(/^(.{3,24}?)\s{2,}(.{3,24}?)\s{2,}[\d.]+\/[\d.]+/);
      if (spMatch) {
        pred.home_sp = spMatch[1].trim() || null;
        pred.away_sp = spMatch[2].trim() || null;
      } else {
        // Fallback: split on 2+ spaces, skip tokens that look like numbers
        const parts = afterTotal.split(/\s{2,}/);
        const spParts = parts.filter(p => p.length > 2 && !/^[\d.]+/.test(p));
        if (spParts.length >= 2) {
          pred.home_sp = spParts[0].trim() || null;
          pred.away_sp = spParts[1].trim() || null;
        } else if (spParts.length === 1) {
          pred.home_sp = spParts[0].trim() || null;
        }
      }

      if (!isNaN(pred.proj_total) && pred.proj_total > 0) {
        predictions.push(pred);
      }
    }
  }

  // Dedup by first occurrence: if predictor emits both "COL@PHI" and "PHI@COL"
  // (home/away confusion), keep the first one seen per canonical pair.
  // Direction is fixed later in the endpoint using betting_odds as ground truth.
  const canonSeen = new Set();
  const deduped = [];
  for (const p of predictions) {
    const canon = [p.away, p.home].sort().join('|');
    if (!canonSeen.has(canon)) { canonSeen.add(canon); deduped.push(p); }
  }

  // Assign game_number by counting duplicate away@home pairs (doubleheader support).
  // Python prints games in order, so the first occurrence is game 1, second is game 2.
  const pairCount = {};
  for (const p of deduped) {
    const pairKey = p.away + '|' + p.home;
    pairCount[pairKey] = (pairCount[pairKey] || 0) + 1;
    p.game_number = pairCount[pairKey];
  }

  return deduped;
}

function parseStrikeoutPredictions(output) {
  const lines = output.split('\n');
  const predictions = [];
  let inPredictions = false;

  for (let raw of lines) {
    const line = raw.trim();

    if (line.includes("TODAY'S STRIKEOUT PREDICTIONS")) {
      inPredictions = true;
      continue;
    }

    if (!inPredictions) continue;

    if (
      line === "" ||
      line.includes("PITCHER") ||
      line.includes("---") ||
      line.includes("===") ||
      line.includes("──") ||
      line.startsWith("[skip]") ||
      line.startsWith("[warn]") ||
      line.startsWith("Date:") ||
      /^\d+ pitchers/.test(line)
    ) continue;

    // Split on 2+ spaces (this is key)
    const parts = line.split(/\s{2,}/);

    // v3.1 columns:
    // [0]pitcher [1]team [2]opp [3]MDL_K [4]FML_K [5]P-K% [6]P-WHIFF
    // [7]P-IZ [8]P-CHASE [9]L-K% [10]L-WHIFF [11]L-IZ [12]L-CHASE [13]L-BS [14]SAV
    if (parts.length < 6) continue;

    try {
      const pitcher = parts[0];
      const team = parts[1];
      const opponent = parts[2];

      const num = v => {
        if (!v) return null;
        const cleaned = v.replace('%', '').replace('—', '').trim();
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
      };

      const lk = num(parts[9]);
      const LG_K_PCT = 22.5;
      const lineup_vuln = lk != null ? (lk - LG_K_PCT) / LG_K_PCT : null;

      const prediction = {
        pitcher,
        team,
        opponent,
        pred_k:          num(parts[3]),   // MDL K
        k_pct:           num(parts[5]),   // P-K%
        whiff_pct:       num(parts[6]),   // P-WHIFF
        iz_contact_pct:  num(parts[7]),   // P-IZ
        chase_pct:       num(parts[8]),   // P-CHASE
        lineup_iz:       num(parts[11]),  // L-IZ
        lineup_chase:    num(parts[12]),  // L-CHASE
        lineup_bat_speed:num(parts[13]),  // L-BS
        lineup_vuln,                      // derived from L-K% vs league avg
        data_quality:    parts[14] || null,
        exp_k_rate:      num(parts[5]) != null ? num(parts[5]) * 0.82 : null
      };

      if (prediction.pred_k != null) {
        predictions.push(prediction);
      }

    } catch (e) {
      // skip bad lines silently
    }
  }

  return predictions;
}

function parseHomerunPredictions(output) {
  // Primary: JSON line emitted by hrPredictor.py
  for (const line of output.split('\n')) {
    if (line.startsWith('HRJSON:')) {
      try { return JSON.parse(line.slice(7)); } catch (_) {}
    }
  }
  // Fallback: old regex format
  const predictions = [];
  let inPredictions = false;
  for (const line of output.split('\n')) {
    if (line.includes("TODAY'S HOME RUN PREDICTIONS")) { inPredictions = true; continue; }
    if (inPredictions && (line.includes('BATTER') || line.includes('---') || line.includes('===') || line.includes('Showing') || line.trim() === '')) continue;
    if (inPredictions && line.trim()) {
      const match = line.match(/\s+(.+?)\s{2,}(\w{2,4})\s+vs\s+(.+?)\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
      if (match) {
        predictions.push({
          batter: match[1].trim(), team: match[2].trim(), vs_pitcher: match[3].trim(),
          hr_prob_pa: parseFloat(match[4]), hr_prob_game: parseFloat(match[5]),
          park_factor: parseFloat(match[6]), weather_factor: parseFloat(match[7])
        });
      }
    }
  }
  return predictions;
}

// Group a flat hrPredictor prediction list into per-game objects
function groupHomeruns(flat) {
  const games = new Map();
  for (const p of flat) {
    const homeTeam = p.home_team || p.team;
    const awayTeam = p.team !== homeTeam ? p.team : (p.opponent || '?');
    const key = `${homeTeam}|${awayTeam}`;
    if (!games.has(key)) {
      games.set(key, {
        home: homeTeam, away: awayTeam,
        park: p.park_id || '?',
        park_factor: p.park_factor || 1,
        temp_f: typeof p.temp_f === 'number' ? p.temp_f : null,
        wind_mph: typeof p.wind_mph === 'number' ? p.wind_mph : null,
        weather_cond: p.weather_cond || '',
        away_sp: null, home_sp: null,
        away_lineup: [], home_lineup: []
      });
    }
    const g = games.get(key);
    const batter = {
      batting_order: p.batting_order || 0,
      batter: p.batter, hr_prob_game: p.hr_prob_per_game ?? p.hr_prob_game,
      hr_prob_pa: p.hr_prob_per_pa ?? p.hr_prob_pa,
      park_factor: p.park_factor, weather_factor: p.weather_factor,
      dk_hr_odds: p.dk_hr_odds ?? null,
    };
    if (p.team === homeTeam) {
      g.home_lineup.push(batter);
      if (!g.away_sp) g.away_sp = p.vs_pitcher || null;
    } else {
      g.away_lineup.push(batter);
      if (!g.home_sp) g.home_sp = p.vs_pitcher || null;
    }
  }
  for (const g of games.values()) {
    g.away_lineup.sort((a, b) => a.batting_order - b.batting_order);
    g.home_lineup.sort((a, b) => a.batting_order - b.batting_order);
  }
  return Array.from(games.values());
}

// Returns a Set of canonical "AWAY|HOME" (sorted) pairs whose lineups are fully
// confirmed for the given date — both teams must have >= 8 batters in daily_lineups.
// daily_lineups only stores hitter rows (importDailyLineups.js filters out pitchers),
// so we count batting_order > 0 rows, not position = 'SP'.
// Returns an empty Set when no hitter data exists (lineups not yet posted), which
// causes all predictions to be filtered until real lineups arrive.
async function getReadyGamePairs(date) {
  const table = date === etToday() ? 'daily_lineups' : 'historical_lineups';
  const rows = await new Promise(resolve =>
    db.all(
      `SELECT team, opponent, COUNT(*) AS hitters
       FROM ${table} WHERE game_date = ? AND batting_order > 0
       GROUP BY team, opponent`,
      [date], (err, r) => resolve(err ? [] : (r || []))
    )
  );

  const statusByTeam = {};
  for (const r of rows) statusByTeam[r.team] = r;

  const ready = new Set();
  for (const r of rows) {
    const opp = statusByTeam[r.opponent];
    if (opp && r.hitters >= 8 && opp.hitters >= 8) {
      ready.add([r.team, r.opponent].sort().join('|'));
    }
  }
  return ready;
}

// Deletes DB predictions for today's games that don't yet have confirmed lineups.
// Safe to call after each lineup refresh — preserves picks for in-progress/finished
// games (which always have full lineups) and only removes pre-mature predictions.
async function purgeUnreadyPredictions(date) {
  const ready = await getReadyGamePairs(date);
  const existing = await new Promise(resolve =>
    db.all('SELECT away_team, home_team FROM game_predictions WHERE game_date = ?',
      [date], (err, r) => resolve(err ? [] : (r || [])))
  );
  for (const ep of existing) {
    const canon = [ep.away_team, ep.home_team].sort().join('|');
    if (!ready.has(canon)) {
      db.run('DELETE FROM game_predictions WHERE game_date=? AND away_team=? AND home_team=?',
        [date, ep.away_team, ep.home_team]);
    }
  }
}

// Fix home/away direction using betting_odds as ground truth.
// Mutates the array in-place. Used by both the request handler and the background runner.
async function applyHomeAwayFlip(preds, date) {
  if (!preds.length) return preds;
  const oddsRows = await new Promise(resolve =>
    db.all(
      `SELECT away_team, home_team FROM betting_odds
       WHERE game_date=? AND market='h2h' AND home_ml IS NOT NULL`,
      [date], (e, r) => resolve(r || [])
    )
  );
  const oddsHome = {};
  for (const r of oddsRows) {
    const canon = [r.away_team, r.home_team].sort().join('|');
    if (!oddsHome[canon]) oddsHome[canon] = r.home_team;
  }
  for (const p of preds) {
    const canon = [p.away, p.home].sort().join('|');
    const correctHome = oddsHome[canon];
    if (correctHome && correctHome !== p.home) {
      [p.away, p.home]                     = [p.home, p.away];
      [p.home_prob, p.away_prob]           = [p.away_prob, p.home_prob];
      [p.home_sp, p.away_sp]               = [p.away_sp, p.home_sp];
      [p.home_era, p.away_era]             = [p.away_era, p.home_era];
      [p.home_sp_era_l5, p.away_sp_era_l5] = [p.away_sp_era_l5, p.home_sp_era_l5];
      [p.home_rdiff_30, p.away_rdiff_30]   = [p.away_rdiff_30, p.home_rdiff_30];
      [p.home_rdiff_15, p.away_rdiff_15]   = [p.away_rdiff_15, p.home_rdiff_15];
      [p.home_wpct_30, p.away_wpct_30]     = [p.away_wpct_30, p.home_wpct_30];
      [p.home_lineup_ops, p.away_lineup_ops] = [p.away_lineup_ops, p.home_lineup_ops];
      [p.home_win_streak, p.away_win_streak] = [p.away_win_streak, p.home_win_streak];
      [p.home_loss_streak, p.away_loss_streak] = [p.away_loss_streak, p.home_loss_streak];
      [p.home_ewm_rdiff, p.away_ewm_rdiff] = [p.away_ewm_rdiff, p.home_ewm_rdiff];
      [p.home_wpct_trend, p.away_wpct_trend] = [p.away_wpct_trend, p.home_wpct_trend];
    }
  }
  return preds;
}

// Override away_sp / home_sp in a predictions array with current game_schedule data.
// Called before every response so stale predictor-saved SP names are never shown.
// Mutates the array in-place and returns it.
async function enrichWithScheduleSP(preds, date) {
  if (!preds.length) return preds;
  const schedRows = await new Promise(resolve =>
    db.all(
      `SELECT away_team, home_team, game_number, away_sp_name, home_sp_name
       FROM game_schedule WHERE game_date = ?`,
      [date], (e, r) => resolve(e ? [] : (r || []))
    )
  );
  if (!schedRows.length) return preds;
  const spMap = {};
  for (const r of schedRows) {
    const key = r.away_team + '|' + r.home_team + '|' + (r.game_number || 1);
    spMap[key] = { away_sp: r.away_sp_name, home_sp: r.home_sp_name };
  }
  for (const p of preds) {
    const key = p.away + '|' + p.home + '|' + (p.game_number || 1);
    const s = spMap[key];
    if (s) {
      if (s.away_sp) p.away_sp = s.away_sp;
      if (s.home_sp) p.home_sp = s.home_sp;
    }
  }
  return preds;
}

app.get("/api/predictions/winners", async (req, res) => {
  try {
    const today = etToday();
    const reqDate = req.query.date || today;
    const isPast = reqDate < today;
    // Past dates: serve from DB only, never re-run the model
    if (isPast) {
      const saved = await new Promise(resolve =>
        db.all(
          `SELECT away_team AS away, home_team AS home, pick, confidence,
                  game_number, home_prob, away_prob, proj_total, home_sp, away_sp,
                  model_prob, vegas_implied, edge, same_side, reason
           FROM game_predictions WHERE game_date = ? ORDER BY confidence DESC`,
          [reqDate], (err, rows) => resolve(err ? [] : (rows || []))
        )
      );
      return res.json(saved);
    }

    // 1. Memory cache
    if (predictionsCache.winners.data && predictionsCache.winners.date === today) {
      return res.json(predictionsCache.winners.data);
    }

    // 2. DB — if predictions exist for today, serve them.
    //    Predictions are only re-run by refreshPredictions.js; the server never
    //    re-runs the model once predictions exist for the day.
    const savedWinners = await new Promise(resolve =>
      db.all(
        `SELECT away_team AS away, home_team AS home, pick, confidence,
                game_number, home_prob, away_prob, proj_total, home_sp, away_sp,
                model_prob, vegas_implied, edge, same_side, reason
         FROM game_predictions WHERE game_date = ? ORDER BY confidence DESC`,
        [today], (err, rows) => resolve(err ? [] : (rows || []))
      )
    );
    if (savedWinners.length) {
      await enrichWithScheduleSP(savedWinners, today);
      predictionsCache.winners = { data: savedWinners, date: today };
      return res.json(savedWinners);
    }

    // 3. No predictions yet today — run the model for the first time.
    await fetchAndCacheSchedule(today).catch(() => {});
    const output = await runPythonPredictor('predictorv4.py');
    const predictions = parseWinnerPredictions(output);

    await applyHomeAwayFlip(predictions, today);

    // Only save predictions for games where both teams have ≥8 confirmed batters.
    const readyPairs = await getReadyGamePairs(today);
    const readyPredictions = predictions.filter(p =>
      readyPairs.has([p.away, p.home].sort().join('|'))
    );

    if (!readyPredictions.length) {
      return res.json([]);
    }

    // First run of the day — save with INSERT OR IGNORE (never overwrite).
    try {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO game_predictions
         (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,proj_total,home_sp,away_sp,
          model_prob,vegas_implied,edge,same_side)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?)`
      );
      for (const p of readyPredictions) {
        const gn = p.game_number || 1;
        db.run('DELETE FROM game_predictions WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?',
          [today, gn, p.home, p.away]);
        stmt.run([today, gn, p.away, p.home, p.pick, p.confidence,
                  p.home_prob, p.away_prob, p.proj_total, p.home_sp || null, p.away_sp || null,
                  p.model_prob ?? null, p.vegas_implied ?? null, p.edge ?? null,
                  p.same_side != null ? (p.same_side ? 1 : 0) : null]);
      }
      stmt.finalize();
    } catch (saveErr) {
      console.error('[save predictions]', saveErr.message);
    }

    generatePickReasons(readyPredictions, today).catch(() => {});

    await enrichWithScheduleSP(readyPredictions, today);
    predictionsCache.winners = { data: readyPredictions, date: today };
    res.json(readyPredictions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/predictions/strikeouts", async (req, res) => {
  try {
    const today    = etToday();
    const reqDate  = req.query.date || today;
    const isPast   = reqDate < today;

    // Past dates: only serve from DB, never re-run the model
    if (isPast) {
      const saved = await new Promise(resolve =>
        db.all(
          `SELECT pitcher, team, opponent, pred_k, k_pct, whiff_pct, chase_pct,
                  iz_contact_pct, lineup_iz, lineup_chase, lineup_bat_speed,
                  lineup_vuln, exp_k_rate, data_quality, dk_line, dk_over_odds, dk_under_odds
           FROM strikeout_predictions WHERE game_date = ? ORDER BY pred_k DESC`,
          [reqDate], (err, rows) => resolve(err ? [] : (rows || []))
        )
      );
      return res.json(saved);
    }

    // 1. Memory cache
    if (predictionsCache.strikeouts.data && predictionsCache.strikeouts.date === today) {
      return res.json(predictionsCache.strikeouts.data);
    }

    // 2. DB — serve existing predictions without re-running the model.
    const savedSO = await new Promise(resolve =>
      db.all(
        `SELECT pitcher, team, opponent, pred_k, k_pct, whiff_pct, chase_pct,
                iz_contact_pct, lineup_iz, lineup_chase, lineup_bat_speed,
                lineup_vuln, exp_k_rate, data_quality, dk_line, dk_over_odds, dk_under_odds
         FROM strikeout_predictions WHERE game_date = ? ORDER BY pred_k DESC`,
        [today], (err, rows) => resolve(err ? [] : (rows || []))
      )
    );
    if (savedSO.length) {
      predictionsCache.strikeouts = { data: savedSO, date: today };
      return res.json(savedSO);
    }

    // 3. No predictions yet today — run the model for the first time.
    const output = await runPythonPredictor('strikeoutPredictorv2.py');
    const predictions = parseStrikeoutPredictions(output);

    if (!predictions.length) { return res.json([]); }

    try {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO strikeout_predictions
         (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
          iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const p of predictions) {
        stmt.run([today, p.pitcher, p.team, p.opponent, p.pred_k, p.k_pct,
                  p.whiff_pct||null, p.chase_pct||null, p.iz_contact_pct||null,
                  p.lineup_iz||null, p.lineup_chase||null, p.lineup_bat_speed||null,
                  p.lineup_vuln||null, p.exp_k_rate||null, p.data_quality||null]);
      }
      stmt.finalize();
    } catch (saveErr) { console.error('[save strikeouts]', saveErr.message); }

    predictionsCache.strikeouts = { data: predictions, date: today };
    res.json(predictions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/predictions/homeruns", async (req, res) => {
  try {
    const today    = etToday();
    const reqDate  = req.query.date || today;
    const isPast   = reqDate < today;

    const dbCols = `batter, team, vs_pitcher, hr_prob_pa, hr_prob_game, park_factor,
                    weather_factor, batting_order, home_team, opponent, temp_f, wind_mph, weather_cond,
                    dk_hr_odds`;

    // Past dates: only serve from DB, never re-run the model
    if (isPast) {
      const saved = await new Promise(resolve =>
        db.all(`SELECT ${dbCols} FROM homerun_predictions WHERE game_date = ?`, [reqDate],
          (err, rows) => resolve(err ? [] : (rows || [])))
      );
      return res.json(groupHomeruns(saved));
    }

    // 1. Memory cache
    if (predictionsCache.homeruns.data && predictionsCache.homeruns.date === today) {
      return res.json(predictionsCache.homeruns.data);
    }

    // 2. DB — serve existing predictions without re-running the model.
    const savedHR = await new Promise(resolve =>
      db.all(`SELECT ${dbCols} FROM homerun_predictions WHERE game_date = ?`, [today],
        (err, rows) => resolve(err ? [] : (rows || [])))
    );
    if (savedHR.length) {
      const grouped = groupHomeruns(savedHR);
      predictionsCache.homeruns = { data: grouped, date: today };
      return res.json(grouped);
    }

    // 3. No predictions yet today — run the model for the first time.
    const output = await runPythonPredictor('hrPredictor.py');
    const flat   = parseHomerunPredictions(output);

    if (!flat.length) { return res.json([]); }

    try {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO homerun_predictions
         (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor,
          batting_order,home_team,opponent,temp_f,wind_mph,weather_cond)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const p of flat) {
        stmt.run([today, p.batter, p.team, p.vs_pitcher||null,
                  p.hr_prob_per_pa ?? p.hr_prob_pa ?? null,
                  p.hr_prob_per_game ?? p.hr_prob_game ?? null,
                  p.park_factor||null, p.weather_factor||null,
                  p.batting_order||null, p.home_team||null, p.opponent||null,
                  p.temp_f||null, p.wind_mph||null, p.weather_cond||null]);
      }
      stmt.finalize();
    } catch (saveErr) { console.error('[save homeruns]', saveErr.message); }

    const grouped = groupHomeruns(flat);
    predictionsCache.homeruns = { data: grouped, date: today };
    res.json(grouped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (DK pitcher K lines and batter HR odds are fetched by importBettingOdds.js)
async function _unused_fetchPitcherKProps(date) {
  if (!nodeFetch) return;
  const dateCompact = date.replace(/-/g, '');
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://www.espn.com",
    "Referer": "https://www.espn.com/mlb/odds",
  };

  let events;
  try {
    const res = await nodeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: HEADERS, timeout: 12000 }
    );
    if (!res.ok) return;
    events = (await res.json()).events || [];
  } catch(_) { return; }

  const propLines = {}; // normalized pitcher name → { line, overOdds, underOdds }

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;
    const oddsUrl = comp.odds?.$ref ||
      `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${event.id}/competitions/${event.id}/odds`;
    try {
      const ores = await nodeFetch(oddsUrl, { headers: HEADERS, timeout: 8000 });
      if (!ores.ok) continue;
      const odata = await ores.json();
      const providerRefs = (odata.items || []).map(i => i.$ref || (typeof i === 'string' ? i : null)).filter(Boolean);

      for (const pUrl of providerRefs.slice(0, 8)) {
        try {
          const pr = await nodeFetch(pUrl, { headers: HEADERS, timeout: 8000 });
          if (!pr.ok) continue;
          const pdata = await pr.json();
          if (!/draftkings/i.test(pdata.provider?.name || '')) continue;

          const propsRef = pdata.props?.$ref || pdata.playerProps?.$ref;
          if (!propsRef) continue;

          const propRes = await nodeFetch(`${propsRef}?limit=300`, { headers: HEADERS, timeout: 10000 });
          if (!propRes.ok) continue;
          const propData = await propRes.json();

          for (const item of (propData.items || [])) {
            const typeName = (item.type?.name || item.typeName || item.name || '').toLowerCase();
            if (!typeName.includes('strikeout') && !typeName.includes(' k ') && typeName !== 'pitcher ks') continue;
            const athleteName = (item.athlete?.displayName || item.athlete?.fullName || '').trim();
            if (!athleteName) continue;
            const line = parseFloat(item.overUnder ?? item.total ?? '');
            if (isNaN(line)) continue;
            const oo = parseInt(item.overOdds ?? item.over?.price ?? '');
            const uo = parseInt(item.underOdds ?? item.under?.price ?? '');
            propLines[athleteName.toLowerCase()] = {
              line, overOdds: isNaN(oo) ? null : oo, underOdds: isNaN(uo) ? null : uo,
            };
          }
          await new Promise(r => setTimeout(r, 100));
          break; // found DraftKings, stop scanning providers for this game
        } catch(_) {}
      }
    } catch(_) {}
    await new Promise(r => setTimeout(r, 200));
  }

  if (!Object.keys(propLines).length) {
    console.log(`[K props] No DK pitcher K lines found for ${date}`);
    return;
  }

  const preds = await new Promise(resolve =>
    db.all('SELECT pitcher FROM strikeout_predictions WHERE game_date = ?', [date],
      (e, r) => resolve(e ? [] : (r || [])))
  );

  let updated = 0;
  for (const pred of preds) {
    const lower = pred.pitcher.toLowerCase();
    let match = propLines[lower];
    if (!match) {
      const lastName = lower.split(' ').slice(-1)[0];
      const found = Object.entries(propLines).find(([k]) => k.endsWith(' ' + lastName));
      if (found) match = found[1];
    }
    if (!match) continue;
    db.run(
      `UPDATE strikeout_predictions SET dk_line = ?, dk_over_odds = ?, dk_under_odds = ?
       WHERE game_date = ? AND pitcher = ?`,
      [match.line, match.overOdds, match.underOdds, date, pred.pitcher]
    );
    updated++;
  }
  if (updated) {
    predictionsCache.strikeouts = { data: null, date: null };
    console.log(`[K props] Updated ${updated} pitcher K lines for ${date}`);
  }
}

// Live SO tracker — returns pitcher-name → { ks, gameState } using MLB Stats API boxscores
app.get("/api/live/strikeouts", async (req, res) => {
  const date = req.query.date || etToday();
  try {
    const schedR = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`);
    if (!schedR.ok) return res.json({});
    const games = ((await schedR.json()).dates || []).flatMap(d => d.games || []);
    if (!games.length) return res.json({});

    const result = {};
    await Promise.all(games.map(async game => {
      if ((game.status?.abstractGameState || 'Preview') === 'Preview') return;
      const gameState = game.status?.abstractGameState === 'Final' ? 'Final' : 'Live';
      try {
        const bsR = await fetch(`https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`);
        if (!bsR.ok) return;
        const bs = await bsR.json();
        for (const side of ['home', 'away']) {
          const starterIds = bs.teams?.[side]?.pitchers || [];
          if (!starterIds.length) continue;
          const starter = bs.teams[side].players[`ID${starterIds[0]}`];
          if (!starter) continue;
          const name = starter.person?.fullName;
          const ks   = starter.stats?.pitching?.strikeOuts ?? 0;
          if (name) result[name] = { ks, gameState };
        }
      } catch(_) {}
    }));

    res.json(result);
  } catch(e) { res.json({}); }
});

// Live HR tracker — fetches per-game boxscores and returns player-name → { hrs, gameState }
app.get("/api/live/homeruns", async (req, res) => {
  const date = req.query.date || new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  try {
    // Step 1: get game list with status
    const schedR = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`);
    if (!schedR.ok) return res.json({});
    const schedData = await schedR.json();
    const games = (schedData.dates || []).flatMap(d => d.games || []);
    if (!games.length) return res.json({});

    // Step 2: fetch all boxscores in parallel (skip Preview games — no batting data yet)
    const hrs = {};
    await Promise.all(games.map(async (game) => {
      const gameState = game.status?.abstractGameState || "Preview";
      if (gameState === "Preview") return; // no data yet
      try {
        const bsR = await fetch(`https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`);
        if (!bsR.ok) return;
        const bs = await bsR.json();
        for (const side of ["home", "away"]) {
          for (const player of Object.values(bs.teams?.[side]?.players || {})) {
            const name = player.person?.fullName;
            const hrCount = player.stats?.batting?.homeRuns ?? 0;
            if (name) hrs[name] = { hrs: hrCount, gameState };
          }
        }
      } catch (_) {}
    }));

    res.json(hrs);
  } catch (e) {
    res.json({});
  }
});

// Retrieve persisted predictions for any past date — must be registered AFTER specific named routes
app.get("/api/predictions/:date", (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date" });
  db.all(
    `SELECT away_team AS away, home_team AS home, pick, confidence,
            game_number, home_prob, away_prob, proj_total, home_sp, away_sp
     FROM game_predictions WHERE game_date = ? ORDER BY confidence DESC`,
    [date],
    (err, rows) => res.json(err ? [] : (rows || []))
  );
});


// ── AI Chat endpoint ─────────────────────────────────────────────────────
//
// Uses Ollama by default (free, local, no API key needed).
//
// SETUP (one-time, takes 2 minutes):
//   1. Download Ollama from https://ollama.com  (free Windows installer)
//   2. Open a terminal and run:  ollama pull llama3.2
//   3. Ollama runs automatically in the background on port 11434
//
// That's it. No accounts, no API keys, no rate limits, no cost.
//
// Optional overrides via environment variables:
//   OLLAMA_MODEL=mistral         (any model you've pulled with `ollama pull`)
//   OLLAMA_URL=http://localhost:11434  (if Ollama runs on another machine)
//   ANTHROPIC_API_KEY=sk-...     (fallback to Claude if Ollama is not running)
//
// ─────────────────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

const MLB_SYSTEM_PROMPT = `You are an MLB baseball analytics assistant embedded in a sports prediction dashboard.
Answer questions about baseball statistics, Statcast metrics, and the prediction models.

Key knowledge areas:
- Statcast: xwOBA (expected weighted on-base average), barrel% (elite contact quality),
  exit velocity, launch angle, whiff% (swing-and-miss rate), chase% (out-of-zone swing rate)
- Pitching: ERA, xERA, FIP, WHIP, K%, BB%, hard-hit%, how they predict run totals
- Run total prediction: SP career ERA -> runs per start, combined lineup OPS, park run factors
  (Coors Field +28% runs, Petco Park -4%), temperature (+0.5 runs per 10F above 70F),
  wind blowing out (more runs), wind blowing in (fewer runs)
- Park factors: normalized run multiplier. Coors=1.28, Fenway=1.11, Petco=0.96, Oracle=0.96
- Lineup quality: rolling OPS (on-base + slugging) from last 20 games used as offensive strength
- Elo ratings: team strength on 1200-1800 scale, updated after every game result
- Win probability model: gradient boosting using Elo diff, SP xwOBA, lineup OPS, recent form
- Home run prediction: barrel%, hard-hit%, ISO (isolated power), pitcher barrel rate allowed
- Strikeout prediction: pitcher whiff%, chase%, put-away%, per-pitch-type matchups vs lineup

Be concise, accurate, and data-focused. Give specific numbers when helpful.
When asked about a specific player or today's games, tell the user to check the predictions tabs.`;

// ── Ollama (local, free, no key) ────────────────────────────────────────
function callOllama(messages) {
  return new Promise((resolve, reject) => {
    // Format chat history for Ollama
    const prompt = messages.map(m =>
      m.role === 'user' ? `User: ${m.content}` : `Assistant: ${m.content}`
    ).join('\n') + '\nAssistant:';

    const body = JSON.stringify({
      model:  OLLAMA_MODEL,
      prompt: MLB_SYSTEM_PROMPT + '\n\n' + prompt,
      stream: false,
      options: {
        temperature:    0.7,
        num_predict:    400,   // max tokens to generate
        top_p:          0.9,
        repeat_penalty: 1.1,
      }
    });

    const url    = new URL(OLLAMA_URL + '/api/generate');
    const isHttps = url.protocol === 'https:';
    const lib    = isHttps ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error('Ollama: ' + json.error));
          resolve((json.response || '').trim());
        } catch (e) {
          reject(new Error('Ollama response parse error: ' + e.message));
        }
      });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Ollama timeout after 30s. Is Ollama running? Try: ollama serve'));
    });

    req.on('error', e => {
      if (e.code === 'ECONNREFUSED') {
        reject(new Error('Ollama not running. Start it with: ollama serve  (or open the Ollama app)'));
      } else {
        reject(e);
      }
    });

    req.write(body);
    req.end();
  });
}

// ── Anthropic Claude (optional fallback if ANTHROPIC_API_KEY is set) ─────
function callAnthropic(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system:     MLB_SYSTEM_PROMPT,
      messages:   messages.map(m => ({ role: m.role, content: m.content }))
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content?.[0]?.text || 'No response');
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main dispatcher ───────────────────────────────────────────────────────
async function callChatAPI(messages) {
  // Try Ollama first (local, free, no key)
  try {
    return await callOllama(messages);
  } catch (ollamaErr) {
    console.log('[chat] Ollama unavailable:', ollamaErr.message);

    // If Anthropic key is set, fall back to that
    if (process.env.ANTHROPIC_API_KEY) {
      console.log('[chat] Falling back to Anthropic Claude');
      return await callAnthropic(messages);
    }

    // Surface the Ollama error to the user with setup instructions
    if (ollamaErr.message.includes('not running') || ollamaErr.message.includes('ECONNREFUSED')) {
      throw new Error(
        'Ollama is not running. ' +
        'Setup: (1) Download Ollama from https://ollama.com, ' +
        '(2) run "ollama pull llama3.2" in a terminal, ' +
        '(3) restart this server.'
      );
    }
    throw ollamaErr;
  }
}

// ── Health check endpoint ────────────────────────────────────────────────
app.get('/api/chat/status', async (req, res) => {
  try {
    const url  = new URL(OLLAMA_URL + '/api/tags');
    const lib  = url.protocol === 'https:' ? https : http;
    const data = await new Promise((resolve, reject) => {
      const r = lib.get({ hostname: url.hostname, port: url.port || 11434, path: url.pathname }, resp => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => resolve(d));
      });
      r.setTimeout(3000, () => { r.destroy(); reject(new Error('timeout')); });
      r.on('error', reject);
    });
    const json   = JSON.parse(data);
    const models = (json.models || []).map(m => m.name);
    const ready  = models.some(m => m.includes(OLLAMA_MODEL.split(':')[0]));
    res.json({
      provider:    'ollama',
      running:     true,
      model:       OLLAMA_MODEL,
      model_ready: ready,
      available_models: models
    });
  } catch (e) {
    const hasFallback = !!process.env.ANTHROPIC_API_KEY;
    res.json({
      provider:    hasFallback ? 'anthropic' : 'none',
      running:     false,
      error:       e.message,
      setup:       'Download Ollama from https://ollama.com then run: ollama pull llama3.2'
    });
  }
});

// ── Chat endpoint ─────────────────────────────────────────────────────────
app.post('/api/chat', express.json(), async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const reply = await callChatAPI(messages.slice(-12));  // keep last 12 turns
    res.json({ reply });
  } catch (err) {
    console.error('[chat] Error:', err.message);
    res.status(503).json({ error: err.message });
  }
});


// ── Weekly Unit Tracker ──────────────────────────────────────────────────────
app.get("/api/units/weekly", async (req, res) => {
  try {
    const reqDate = req.query.date || etToday();
    const today   = etToday();

    // Week bounds Sunday–Saturday
    const d = new Date(reqDate + 'T12:00:00');
    const dow = d.getDay();
    const sun = new Date(d); sun.setDate(d.getDate() - dow);
    const sat = new Date(sun); sat.setDate(sun.getDate() + 6);
    const fmt = dt => dt.toISOString().slice(0, 10);
    const weekStart = fmt(sun), weekEnd = fmt(sat);
    const cap = weekEnd < today ? weekEnd : today;

    // ATH is NOT remapped to OAK — fetchEspnScores + betting_odds both use 'ATH' for Oakland.
    // AZ IS remapped to ARI because predictions use 'AZ' but ESPN and odds tables use 'ARI'.
    const normA = t => ({ AZ:'ARI', KCR:'KC', TBR:'TB', SDP:'SD', SFG:'SF', WSN:'WSH' }[t] || t);

    const preds = await new Promise(resolve =>
      db.all(
        `SELECT game_date, away_team AS away, home_team AS home, game_number,
                pick, confidence
         FROM game_predictions WHERE game_date BETWEEN ? AND ?
         ORDER BY game_date`,
        [weekStart, cap], (e, rows) => resolve(e ? [] : (rows || []))
      )
    );

    if (!preds.length) return res.json({ week_start: weekStart, week_end: weekEnd, all: null, ev: null });

    // Fetch DraftKings pre-game h2h odds. Filter out live in-game lines (|ML| > 1500).
    // Order odds_api first — it is the authoritative DK source; ESPN is the fallback.
    const allOddsRows = await new Promise(resolve =>
      db.all(
        `SELECT game_date, home_team, away_team, game_number, home_ml, away_ml, source
         FROM betting_odds
         WHERE game_date BETWEEN ? AND ? AND market = 'h2h'
           AND LOWER(bookmaker) = 'draftkings'
           AND home_ml IS NOT NULL AND ABS(home_ml) <= 1500
           AND (away_ml IS NULL OR ABS(away_ml) <= 1500)
         ORDER BY CASE source WHEN 'odds_api' THEN 0 ELSE 1 END`,
        [weekStart, cap], (e, rows) => resolve(e ? [] : (rows || []))
      )
    );

    // DK ML lookup keyed by 'date|team[:N]'.
    // First row for each team wins (odds_api rows come first, ESPN only fills gaps).
    const bestML = {};
    for (const r of allOddsRows) {
      const suffix = (r.game_number || 1) > 1 ? ':' + r.game_number : '';
      const hk = r.game_date + '|' + normA(r.home_team) + suffix;
      const ak = r.game_date + '|' + normA(r.away_team) + suffix;
      if (r.home_ml != null && bestML[hk] == null) bestML[hk] = r.home_ml;
      if (r.away_ml != null && bestML[ak] == null) bestML[ak] = r.away_ml;
    }

    // Fetch final scores for each date in the week
    const uniqueDates = [...new Set(preds.map(p => p.game_date))];
    const scoresByDate = {};
    await Promise.all(uniqueDates.map(async date => {
      if (date <= '2025-09-28') {
        const rows = await new Promise(resolve =>
          db.all(`SELECT away_team, home_team, home_score, away_score FROM game_results WHERE game_date = ?`,
                 [date], (e, r) => resolve(e ? [] : (r || [])))
        );
        const map = {}, cnt = {};
        for (const r of rows) {
          const pk = normA(r.away_team) + '@' + normA(r.home_team);
          cnt[pk] = (cnt[pk] || 0) + 1;
          const suf = cnt[pk] > 1 ? ':' + cnt[pk] : '';
          map[pk + suf] = { home_score: r.home_score, away_score: r.away_score };
        }
        scoresByDate[date] = map;
      } else {
        const espn = await fetchEspnScores(date);
        const map = {};
        for (const [key, s] of Object.entries(espn)) {
          if (s.state !== 'post' || s.home_score == null) continue;
          // Normalize team abbreviations to match prediction team names.
          // fetchEspnScores uses normTeam which maps "Arizona Diamondbacks"→"AZ",
          // but predictions use "AZ" which normA maps to "ARI". Apply normA to align.
          const atIdx  = key.indexOf('@');
          const colIdx = key.lastIndexOf(':');
          const hasSfx = colIdx > atIdx;
          const suffix  = hasSfx ? key.slice(colIdx) : '';
          const base    = hasSfx ? key.slice(0, colIdx) : key;
          const [rawAway, rawHome] = base.split('@');
          const normKey = normA(rawAway) + '@' + normA(rawHome) + suffix;
          map[normKey] = { home_score: s.home_score, away_score: s.away_score };
        }
        scoresByDate[date] = map;
      }
    }));

    let allW=0, allL=0, allPL=0, allPend=0;
    let evW=0,  evL=0,  evPL=0,  evPend=0;

    for (const p of preds) {
      const suffix = (p.game_number || 1) > 1 ? ':' + p.game_number : '';
      const na = normA(p.away), nh = normA(p.home), np = normA(p.pick);
      const sm = scoresByDate[p.game_date] || {};

      const fwdKey = na + '@' + nh + suffix;
      const revKey = nh + '@' + na + suffix;
      const result  = sm[fwdKey] || sm[revKey];
      const flipped = !sm[fwdKey] && !!sm[revKey];

      // Look up best ML for the picked team across all bookmakers
      const pickKey = p.game_date + '|' + np + suffix;
      const pickML  = bestML[pickKey] ?? null;
      const impl    = pickML != null
        ? (pickML > 0 ? 100 / (pickML + 100) : Math.abs(pickML) / (Math.abs(pickML) + 100)) * 100
        : null;
      const payout  = pickML != null
        ? (pickML > 0 ? pickML / 100 : 100 / Math.abs(pickML))
        : 0.909;
      const edge  = impl != null ? p.confidence - impl : null;
      const isEV  = edge != null && edge > 0;

      if (!result) {
        allPend++;
        if (isEV) evPend++;
        continue;
      }

      const hs = flipped ? result.away_score : result.home_score;
      const as = flipped ? result.home_score : result.away_score;
      if (hs === as) continue;

      const correct = (np === nh) === (hs > as);
      if (correct) { allW++; allPL += payout; } else { allL++; allPL -= 1; }
      if (isEV) { if (correct) { evW++; evPL += payout; } else { evL++; evPL -= 1; } }
    }

    res.json({
      week_start: weekStart,
      week_end:   weekEnd,
      all: { wins: allW, losses: allL, units: Math.round(allPL * 100) / 100, pending: allPend },
      ev:  { wins: evW,  losses: evL,  units: Math.round(evPL * 100) / 100,  pending: evPend  },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Internal endpoint for refreshPredictions.js to bust caches after writing new DB data.
// Restricted to localhost — external callers receive 403.
app.post('/api/internal/bust-cache', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  predictionsCache.winners    = { data: null, date: null };
  predictionsCache.strikeouts = { data: null, date: null };
  predictionsCache.homeruns   = { data: null, date: null };
  dataVersion.predictions = Date.now();
  console.log('[refresh] Prediction caches cleared by refreshPredictions.js');
  res.json({ ok: true });
});

app.listen(3000, () => {
  console.log("⚾  MLB Dashboard running → http://localhost:3000");
  // Only purge stale predictions at startup if lineups are already imported for today.
  // Skip if daily_lineups is empty — runAll.js will import them shortly and purge after.
  (async () => {
    const today = etToday();
    const lineupCount = await new Promise(resolve =>
      db.get('SELECT COUNT(*) AS n FROM daily_lineups WHERE game_date=?', [today],
        (e,r) => resolve(r?.n || 0))
    );
    if (lineupCount > 0) {
      purgeUnreadyPredictions(today).catch(e =>
        console.log('[startup] purge warning:', e.message));
    } else {
      console.log('[startup] No lineups for today yet — skipping startup purge');
    }
  })();
  // Run the full data pipeline in background on startup — fetches rosters,
  // scrapes lineups, imports them, and enriches all stat tables.
  // Runs silently; the server remains fully responsive while it works.
  setTimeout(() => {
    console.log('[startup] Running runAll.js in background…');
    const proc = spawn('node', ['runAll.js'], { cwd: __dirname, stdio: 'pipe' });
    proc.stdout?.on('data', d => process.stdout.write('[runAll] ' + d));
    proc.stderr?.on('data', d => process.stdout.write('[runAll] ' + d));
    proc.on('error', e => console.log('[runAll] spawn error:', e.message));
    proc.on('close', code => {
      console.log(`[runAll] Finished (exit ${code})`);
      if (code === 0) {
        dataVersion.lineup = Date.now();
        runAndSavePredictions().catch(e =>
          console.log('[runAll] auto-predict error:', e.message));
      }
    });
  }, 2000); // 2s delay so the server finishes binding before heavy I/O starts

});

const { generateReason } = require('./reasonEngine');

// Generate and persist pick reasons.
// force=true regenerates even when a reason already exists (e.g. after ?refresh=1
// so stat-driven reasons replace old template-based ones).
async function generatePickReasons(predictions, gameDate, force = false) {
  if (!predictions.length) return;

  let done = new Set();
  if (!force) {
    const existing = await new Promise(resolve =>
      db.all(`SELECT away_team, home_team, game_number FROM game_predictions
              WHERE game_date = ? AND reason IS NOT NULL`,
        [gameDate], (e, r) => resolve(e ? [] : (r || [])))
    );
    done = new Set(existing.map(r => `${r.away_team}|${r.home_team}|${r.game_number}`));
  }

  let saved = 0;
  for (const p of predictions) {
    const key = `${p.away}|${p.home}|${p.game_number || 1}`;
    if (done.has(key)) continue;
    try {
      const reason = generateReason(p);
      if (reason) {
        await new Promise(resolve =>
          db.run(`UPDATE game_predictions SET reason = ?
                  WHERE game_date = ? AND away_team = ? AND home_team = ? AND game_number = ?`,
            [reason, gameDate, p.away, p.home, p.game_number || 1], resolve)
        );
        saved++;
      }
    } catch (e) {
      console.log(`[reason] ${p.away}@${p.home} error:`, e.message);
    }
  }
  // Bust the memory cache so next page load re-queries the DB with reasons included
  if (saved > 0) {
    predictionsCache.winners = { data: null, date: null };
    console.log(`[reason] ${saved} reason(s) saved — cache cleared`);
  }
}

// Run SO + HR predictors and save results to DB. Called after each lineup refresh
// so predictions are always ready without waiting for a frontend request.
async function runAndSavePredictions() {
  const today = etToday();
  try {
    // Winner predictions
    const winOutput = await runPythonPredictor('predictorv4.py');
    const winPreds  = parseWinnerPredictions(winOutput);
    if (winPreds.length) {
      await applyHomeAwayFlip(winPreds, today);
      // Only save games where both teams have ≥8 confirmed batters
      const readyPairs = await getReadyGamePairs(today);
      const readyWin = winPreds.filter(p => readyPairs.has([p.away, p.home].sort().join('|')));
      if (readyWin.length) {
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO game_predictions
           (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,proj_total,home_sp,away_sp,
            model_prob,vegas_implied,edge,same_side)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?)`
        );
        for (const p of readyWin) {
          const gn = p.game_number || 1;
          db.run('DELETE FROM game_predictions WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?',
            [today, gn, p.home, p.away]);
          stmt.run([today, gn, p.away, p.home, p.pick, p.confidence,
                    p.home_prob, p.away_prob, p.proj_total, p.home_sp||null, p.away_sp||null,
                    p.model_prob??null, p.vegas_implied??null, p.edge??null,
                    p.same_side != null ? (p.same_side ? 1 : 0) : null]);
        }
        stmt.finalize();
        predictionsCache.winners = { data: null, date: null };
        dataVersion.predictions = Date.now();
        console.log(`[auto-predict] Winners: ${readyWin.length}/${winPreds.length} game(s) saved (lineup-ready)`);
        generatePickReasons(readyWin, today).catch(e =>
          console.log('[auto-predict] reasons error:', e.message));
      }
    }
  } catch (e) { console.log('[auto-predict] Winners error:', e.message); }

  try {
    // Strikeout predictions
    const soOutput = await runPythonPredictor('strikeoutPredictorv2.py');
    const soPreds = parseStrikeoutPredictions(soOutput);
    if (soPreds.length) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO strikeout_predictions
         (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
          iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const p of soPreds) {
        stmt.run([today, p.pitcher, p.team, p.opponent, p.pred_k, p.k_pct,
                  p.whiff_pct||null, p.chase_pct||null, p.iz_contact_pct||null,
                  p.lineup_iz||null, p.lineup_chase||null, p.lineup_bat_speed||null,
                  p.lineup_vuln||null, p.exp_k_rate||null, p.data_quality||null]);
      }
      stmt.finalize();
      predictionsCache.strikeouts = { data: null, date: null };
      console.log(`[auto-predict] Strikeouts: ${soPreds.length} pitcher(s) saved`);
    }
  } catch (e) { console.log('[auto-predict] Strikeouts error:', e.message); }

  try {
    // Homerun predictions
    const hrOutput = await runPythonPredictor('hrPredictor.py');
    const hrFlat = parseHomerunPredictions(hrOutput);
    if (hrFlat.length) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO homerun_predictions
         (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor,
          batting_order,home_team,opponent,temp_f,wind_mph,weather_cond)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const p of hrFlat) {
        stmt.run([today, p.batter, p.team, p.vs_pitcher||null,
                  p.hr_prob_per_pa??p.hr_prob_pa??null, p.hr_prob_per_game??p.hr_prob_game??null,
                  p.park_factor||null, p.weather_factor||null,
                  p.batting_order||null, p.home_team||null, p.opponent||null,
                  p.temp_f||null, p.wind_mph||null, p.weather_cond||null]);
      }
      stmt.finalize();
      predictionsCache.homeruns = { data: null, date: null };
      console.log(`[auto-predict] Homeruns: ${hrFlat.length} batter(s) saved`);
    }
  } catch (e) { console.log('[auto-predict] Homeruns error:', e.message); }
}

// Passive lineup refresh — keeps daily_lineups current while the server runs.
// Scrapes MLB lineup data then imports it to the DB every 30 minutes.
// Runs sequentially: scrape first, import only if scrape exits cleanly.
function runLineupRefresh() {
  console.log('[lineups] Starting scheduled refresh…');
  const scrape = spawn('node', ['scrapeDailyLineups.js'], { cwd: __dirname, stdio: 'pipe' });
  scrape.on('error', e => console.log('[lineups] Scrape error:', e.message));
  scrape.on('close', code => {
    if (code === 0) {
      const imp = spawn('node', ['importDailyLineups.js'], { cwd: __dirname, stdio: 'pipe' });
      imp.on('error', e => console.log('[lineups] Import error:', e.message));
      imp.on('close', c2 => {
        console.log(`[lineups] Refresh complete (import exit ${c2})`);
        dataVersion.lineup = Date.now();
        // Run all three predictors automatically so predictions are always
        // up-to-date without waiting for a frontend request.
        runAndSavePredictions().catch(e =>
          console.log('[lineups] auto-predict error:', e.message));
      });
    } else {
      console.log(`[lineups] Scrape failed (exit ${code}), skipping import`);
    }
  });
}

setTimeout(runLineupRefresh,  30 * 1000);          // first run 30s after startup
setInterval(runLineupRefresh, 30 * 60 * 1000);     // then every 30 minutes