"use strict";

/**
 * importBettingOdds.js
 *
 * Fetches MLB pregame odds from ESPN's public odds API (the same data shown
 * on espn.com/mlb/odds, provided by DraftKings and other books).
 *
 * USAGE:
 *   node importBettingOdds.js                   (today's odds)
 *   node importBettingOdds.js --date 2026-04-30 (specific date)
 */

const db    = require("./db");
const fetch = require("node-fetch").default;

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const dateIdx    = args.indexOf("--date");
const targetDate = dateIdx !== -1
  ? args[dateIdx + 1]
  : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
      .format(new Date(Date.now() - 3 * 60 * 60 * 1000));
const dateCompact = targetDate.replace(/-/g, "");

// ─── DB helpers ───────────────────────────────────────────────────────────────
const run = (sql, p = []) => new Promise((res, rej) =>
  db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const all = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, rows) => { e ? rej(e) : res(rows); }));

// ─── Team normalization ───────────────────────────────────────────────────────
const TEAM_MAP = {
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
  "ARI":"AZ","AZ":"AZ","ATL":"ATL","BAL":"BAL","BOS":"BOS","CHC":"CHC",
  "CWS":"CWS","CIN":"CIN","CLE":"CLE","COL":"COL","DET":"DET","HOU":"HOU",
  "KC":"KC","KCR":"KC","LAA":"LAA","LAD":"LAD","MIA":"MIA","MIL":"MIL",
  "MIN":"MIN","NYM":"NYM","NYY":"NYY","OAK":"ATH","PHI":"PHI","PIT":"PIT",
  "SD":"SD","SDP":"SD","SF":"SF","SFG":"SF","SEA":"SEA","STL":"STL",
  "TB":"TB","TBR":"TB","TEX":"TEX","TOR":"TOR","WSH":"WSH","WSN":"WSH",
};
function norm(name) {
  if (!name) return null;
  const n = String(name).trim();
  if (TEAM_MAP[n]) return TEAM_MAP[n];
  const words = n.split(" ");
  for (let i = 1; i < words.length; i++) {
    const sub = words.slice(i).join(" ");
    if (TEAM_MAP[sub]) return TEAM_MAP[sub];
  }
  if (n.length <= 4 && n === n.toUpperCase()) return n;
  return null;
}

function americanToProb(ml) {
  const n = parseInt(ml);
  if (isNaN(n)) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

// ─── ESPN Odds ────────────────────────────────────────────────────────────────
async function fetchEspn() {
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.espn.com",
    "Referer": "https://www.espn.com/mlb/odds",
  };

  let events;
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: HEADERS, timeout: 15000 }
    );
    if (!res.ok) { console.log(`  ❌ Scoreboard HTTP ${res.status}`); return []; }
    events = (await res.json()).events || [];
  } catch (e) { console.log(`  ❌ ${e.message}`); return []; }

  if (!events.length) { console.log("  No games found"); return []; }
  console.log(`  ${events.length} games found, fetching odds...`);

  const rows = [];
  const seenPairs = {};  // tracks game number for doubleheaders

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    const gameId   = event.id;
    const gameDate = (event.date || "").split("T")[0] || targetDate;
    const gameTimeET = event.date
      ? new Date(event.date).toLocaleTimeString("en-US", {
          timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
        }) + " ET"
      : null;

    let homeTeam = null, awayTeam = null;
    for (const c of (comp.competitors || [])) {
      const t = norm(c.team?.displayName || c.team?.name || "") || norm(c.team?.abbreviation || "");
      if (c.homeAway === "home") homeTeam = t;
      else awayTeam = t;
    }
    if (!homeTeam || !awayTeam) continue;

    // Assign game_number before any skip so doubleheader G2 always gets gameNumber=2
    const pairId = awayTeam + "|" + homeTeam;
    seenPairs[pairId] = (seenPairs[pairId] || 0) + 1;
    const gameNumber = seenPairs[pairId];

    // Attempt all games — ESPN serves the closing pregame line even after games
    // complete. The DraftKings-only + ±500 saneML filters below reject any
    // live-adjusted lines. INSERT OR IGNORE protects any odds already in the DB.

    // Fetch odds detail for this event
    let oddsItems = [];
    const oddsRef = comp.odds?.$ref || comp.odds?.ref;
    const oddsUrl = oddsRef ||
      `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${gameId}/competitions/${gameId}/odds`;

    try {
      const ores = await fetch(oddsUrl, { headers: HEADERS, timeout: 10000 });
      if (ores.ok) {
        const odata = await ores.json();
        oddsItems = odata.items || [];
        if (oddsItems.length > 0 && oddsItems[0].$ref) {
          const fetched = [];
          for (const item of oddsItems.slice(0, 8)) {
            try {
              const ir = await fetch(item.$ref, { headers: HEADERS, timeout: 8000 });
              if (ir.ok) fetched.push(await ir.json());
            } catch (_) {}
            await new Promise(r => setTimeout(r, 100));
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

      // Only accept DraftKings pregame odds — reject other books and live-labeled lines
      if (!/^draftkings$/i.test(bookmaker)) continue;

      const homeML = parseInt(odds.homeTeamOdds?.moneyLine ?? odds.homeTeamOdds?.price ?? "");
      const awayML = parseInt(odds.awayTeamOdds?.moneyLine ?? odds.awayTeamOdds?.price ?? "");
      const total  = parseFloat(odds.overUnder ?? odds.total ?? "");
      const spread = parseFloat(odds.spread ?? odds.homeTeamOdds?.pointSpread ?? "");

      // Sanity check: pregame MLB moneylines are always within ±500.
      // Live in-game lines frequently exceed this when a team is winning big.
      const saneML = !isNaN(homeML) && !isNaN(awayML)
        && Math.abs(homeML) >= 100 && Math.abs(awayML) >= 100
        && Math.abs(homeML) <= 500 && Math.abs(awayML) <= 500;

      // All three markets are gated on saneML — if the ML is live-adjusted, the
      // spread and total from the same provider are also unreliable.
      if (!saneML) continue;

      rows.push({
        game_date: gameDate, home_team: homeTeam, away_team: awayTeam, game_number: gameNumber,
        source: "espn", bookmaker, market: "h2h",
        home_ml: homeML, away_ml: awayML,
        home_prob: americanToProb(homeML), away_prob: americanToProb(awayML),
        home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
        total_line: null, over_odds: null, under_odds: null, game_time: gameTimeET,
      });

      if (!isNaN(spread)) {
        const hso = parseInt(odds.homeTeamOdds?.spreadOdds ?? odds.homeTeamOdds?.handicapOdds ?? "-110");
        const aso = parseInt(odds.awayTeamOdds?.spreadOdds ?? odds.awayTeamOdds?.handicapOdds ?? "-110");
        rows.push({
          game_date: gameDate, home_team: homeTeam, away_team: awayTeam, game_number: gameNumber,
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
          game_date: gameDate, home_team: homeTeam, away_team: awayTeam, game_number: gameNumber,
          source: "espn", bookmaker, market: "totals",
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: total, over_odds: isNaN(oo) ? -110 : oo, under_odds: isNaN(uo) ? -110 : uo,
          game_time: gameTimeET,
        });
      }
    }

    await new Promise(r => setTimeout(r, 200));
  }

  const withOdds = rows.filter(r => r.home_ml || r.total_line).length;
  console.log(`  ✓ ${withOdds} rows from ${new Set(rows.map(r => r.bookmaker)).size} books`);
  return rows;
}

// ─── Upsert ───────────────────────────────────────────────────────────────────
async function upsertOdds(rows) {
  if (!rows.length) return 0;
  await run("BEGIN TRANSACTION");
  let n = 0;
  for (const r of rows) {
    try {
      await run(`INSERT OR IGNORE INTO betting_odds (
        game_date, home_team, away_team, game_number, source, bookmaker, market,
        home_ml, away_ml, home_prob, away_prob,
        home_spread, home_spread_odds, away_spread, away_spread_odds,
        total_line, over_odds, under_odds, game_time
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        r.game_date, r.home_team, r.away_team, r.game_number || 1,
        r.source, r.bookmaker, r.market,
        r.home_ml, r.away_ml, r.home_prob, r.away_prob,
        r.home_spread, r.home_spread_odds, r.away_spread, r.away_spread_odds,
        r.total_line, r.over_odds, r.under_odds, r.game_time ?? null,
      ]);
      n++;
    } catch (_) {}
  }
  await run("COMMIT");
  return n;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Importing ESPN odds for ${targetDate}...`);
  const rows = await fetchEspn();
  if (!rows.length) {
    console.log("No odds data retrieved.");
    process.exit(0);
  }
  const inserted = await upsertOdds(rows);
  console.log(`✅ ${inserted} rows saved to betting_odds`);
  process.exit(0);
}

module.exports = {};
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
