"use strict";

/**
 * importBettingOdds.js
 *
 * Fetches today's DraftKings MLB odds + player props from OddsAPI:
 *   - Game odds (h2h, spreads, totals)  → betting_odds table
 *   - Pitcher strikeout K lines          → strikeout_predictions.dk_line
 *   - Batter HR to-homer odds            → homerun_predictions.dk_hr_odds
 *
 * Usage:
 *   node importBettingOdds.js                   (today's date ET)
 *   node importBettingOdds.js --date 2026-05-01 (specific date)
 */

const db    = require("./db");
const fetch = require("node-fetch").default;
const fs    = require("fs");
const path  = require("path");

// ─── API key ──────────────────────────────────────────────────────────────────
const ODDS_API_KEY = (() => {
  for (const name of ["oddsAPI.env", ".env"]) {
    const p = path.join(__dirname, name);
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
    } catch(_) {}
  }
  return process.env.ODDS_API_KEY || null;
})();

if (!ODDS_API_KEY) {
  console.error("No ODDS_API_KEY found in oddsAPI.env or .env");
  process.exit(1);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const dateIdx   = args.indexOf("--date");
const targetDate = dateIdx !== -1
  ? args[dateIdx + 1]
  : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

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

function mlToProb(ml) {
  const n = parseInt(ml);
  if (isNaN(n)) return null;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

function fmtOdds(n) {
  if (n == null) return '';
  return n > 0 ? `+${n}` : String(n);
}

const HEADERS = { "User-Agent": "DiamondEdge/1.0", "Accept": "application/json" };

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Wait for db.js to finish table creation
  await new Promise(r => setTimeout(r, 800));

  console.log(`\nFetching DraftKings odds for ${targetDate}...\n`);

  // ── Step 1: Game odds (h2h, spreads, totals) ─────────────────────────────
  console.log("  Fetching game odds (h2h, spreads, totals)...");
  const oddsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&dateFormat=iso&oddsFormat=american&bookmakers=draftkings`;
  let allGames = [];
  try {
    const res = await fetch(oddsUrl, { headers: HEADERS, timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rem = res.headers.get("x-requests-remaining");
    if (rem) console.log(`  (quota: ${rem} requests remaining this month)`);
    allGames = await res.json();
    if (!Array.isArray(allGames)) throw new Error("Unexpected response");
  } catch(e) {
    console.log(`  ❌ Game odds fetch failed: ${e.message}`);
    allGames = [];
  }

  // Filter to target date and build event ID map
  const todayGames = allGames.filter(g => {
    const etDate = new Date(g.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return etDate === targetDate;
  });
  console.log(`  ${todayGames.length} game(s) found for ${targetDate}`);

  // Save game odds
  const oddRows = [];
  for (const game of todayGames) {
    const homeTeam = norm(game.home_team);
    const awayTeam = norm(game.away_team);
    if (!homeTeam || !awayTeam) continue;
    const commenceTime = new Date(game.commence_time);
    const alreadyStarted = commenceTime <= new Date();
    const gameTimeET = commenceTime.toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
    }) + " ET";

    for (const book of (game.bookmakers || [])) {
      if (!/^draftkings$/i.test(book.key)) continue;
      for (const mkt of (book.markets || [])) {
        if (!["h2h", "spreads", "totals"].includes(mkt.key)) continue;
        const row = {
          game_date: targetDate, home_team: homeTeam, away_team: awayTeam,
          game_number: 1, source: "odds_api", bookmaker: "DraftKings", market: mkt.key,
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: null, over_odds: null, under_odds: null,
          game_time: alreadyStarted ? null : gameTimeET,
        };
        for (const o of (mkt.outcomes || [])) {
          const isHome = norm(o.name) === homeTeam;
          if (mkt.key === "h2h") {
            if (isHome) { row.home_ml = o.price; row.home_prob = mlToProb(o.price); }
            else        { row.away_ml = o.price; row.away_prob = mlToProb(o.price); }
          } else if (mkt.key === "spreads") {
            if (isHome) { row.home_spread = o.point; row.home_spread_odds = o.price; }
            else        { row.away_spread = o.point; row.away_spread_odds = o.price; }
          } else if (mkt.key === "totals") {
            if (o.name === "Over")  { row.total_line = o.point; row.over_odds  = o.price; }
            if (o.name === "Under") { row.total_line = o.point; row.under_odds = o.price; }
          }
        }
        if (mkt.key === "h2h" && row.home_ml != null && row.away_ml != null) {
          if (Math.abs(row.home_ml) > 500 || Math.abs(row.away_ml) > 500) continue;
        }
        if (alreadyStarted) continue; // don't overwrite pregame odds with live lines
        oddRows.push(row);
      }
    }
  }

  if (oddRows.length) {
    await run("BEGIN TRANSACTION");
    let saved = 0;
    for (const r of oddRows) {
      try {
        await run(
          `INSERT OR IGNORE INTO betting_odds
           (game_date,home_team,away_team,game_number,source,bookmaker,market,
            home_ml,away_ml,home_prob,away_prob,
            home_spread,home_spread_odds,away_spread,away_spread_odds,
            total_line,over_odds,under_odds,game_time)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [r.game_date, r.home_team, r.away_team, r.game_number,
           r.source, r.bookmaker, r.market,
           r.home_ml, r.away_ml, r.home_prob, r.away_prob,
           r.home_spread, r.home_spread_odds, r.away_spread, r.away_spread_odds,
           r.total_line, r.over_odds, r.under_odds, r.game_time]
        );
        saved++;
      } catch(_) {}
    }
    await run("COMMIT");
    console.log(`  ✓ ${saved} game odds row(s) saved`);
  } else {
    console.log("  No game odds rows to save");
  }

  // ── Step 2: Player props per event ────────────────────────────────────────
  let kUpdated = 0, hrUpdated = 0;

  for (const game of todayGames) {
    const homeTeam = norm(game.home_team);
    const awayTeam = norm(game.away_team);
    if (!homeTeam || !awayTeam) continue;

    const propsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${game.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=pitcher_strikeouts,batter_home_runs&bookmakers=draftkings&oddsFormat=american`;

    let propsData;
    try {
      const pRes = await fetch(propsUrl, { headers: HEADERS, timeout: 15000 });
      if (!pRes.ok) { console.log(`  ⚠ Props HTTP ${pRes.status} for ${awayTeam}@${homeTeam}`); continue; }
      propsData = await pRes.json();
    } catch(e) {
      console.log(`  ⚠ Props fetch error for ${awayTeam}@${homeTeam}: ${e.message}`);
      continue;
    }

    for (const book of (propsData.bookmakers || [])) {
      if (!/^draftkings$/i.test(book.key)) continue;

      for (const mkt of (book.markets || [])) {

        // ── Pitcher strikeout K lines ──────────────────────────────────────
        if (mkt.key === "pitcher_strikeouts") {
          const kMap = {}; // name → { line, overOdds, underOdds }
          for (const o of (mkt.outcomes || [])) {
            const name = (o.description || "").trim();
            if (!name || o.point == null) continue;
            if (!kMap[name]) kMap[name] = { line: o.point };
            if (o.name === "Over")  kMap[name].overOdds  = o.price;
            if (o.name === "Under") kMap[name].underOdds = o.price;
          }
          for (const [name, vals] of Object.entries(kMap)) {
            const lower = name.toLowerCase();
            // Try exact match first, then last-name fallback
            const preds = await all(
              `SELECT pitcher FROM strikeout_predictions WHERE game_date=? AND LOWER(pitcher)=?`,
              [targetDate, lower]
            );
            let matched = preds.map(r => r.pitcher);
            if (!matched.length) {
              const lastName = lower.split(" ").slice(-1)[0];
              const fallback = await all(
                `SELECT pitcher FROM strikeout_predictions WHERE game_date=? AND LOWER(pitcher) LIKE ?`,
                [targetDate, `% ${lastName}`]
              );
              matched = fallback.map(r => r.pitcher);
            }
            for (const pitcher of matched) {
              await run(
                `UPDATE strikeout_predictions SET dk_line=?, dk_over_odds=?, dk_under_odds=?
                 WHERE game_date=? AND pitcher=?`,
                [vals.line, vals.overOdds ?? null, vals.underOdds ?? null, targetDate, pitcher]
              );
              kUpdated++;
            }
          }
        }

        // ── Batter HR odds ────────────────────────────────────────────────
        if (mkt.key === "batter_home_runs") {
          for (const o of (mkt.outcomes || [])) {
            if (o.name !== "Over") continue; // we only want the "to hit a HR" line
            const name  = (o.description || "").trim();
            const price = o.price;
            if (!name || price == null) continue;
            const lower = name.toLowerCase();
            // Exact match first
            const batters = await all(
              `SELECT batter FROM homerun_predictions WHERE game_date=? AND LOWER(batter)=?`,
              [targetDate, lower]
            );
            let matched = batters.map(r => r.batter);
            if (!matched.length) {
              const lastName = lower.split(" ").slice(-1)[0];
              const fallback = await all(
                `SELECT batter FROM homerun_predictions WHERE game_date=? AND LOWER(batter) LIKE ?`,
                [targetDate, `% ${lastName}`]
              );
              matched = fallback.map(r => r.batter);
            }
            for (const batter of matched) {
              await run(
                `UPDATE homerun_predictions SET dk_hr_odds=? WHERE game_date=? AND batter=?`,
                [price, targetDate, batter]
              );
              hrUpdated++;
            }
          }
        }
      }
    }

    await new Promise(r => setTimeout(r, 300)); // OddsAPI rate limit courtesy
  }

  console.log(`\n  ✓ Pitcher K lines updated: ${kUpdated} pitcher(s)`);
  console.log(`  ✓ Batter HR odds updated:  ${hrUpdated} batter(s)`);
  console.log("\nDone.\n");
  setTimeout(() => process.exit(0), 300);
}

module.exports = {};
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
