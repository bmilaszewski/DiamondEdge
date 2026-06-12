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
const http  = require("http");
const fetch = require("node-fetch").default;
const fs    = require("fs");
const path  = require("path");

const SERVER_PORT = 3000;
function bustCache() {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: "127.0.0.1", port: SERVER_PORT, path: "/api/internal/bust-cache", method: "POST" },
      res => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", () => resolve()); // server might not be running — that's fine
    req.end();
  });
}

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
const args       = process.argv.slice(2);
const dateIdx    = args.indexOf("--date");
const targetDate = dateIdx !== -1
  ? args[dateIdx + 1]
  : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const propsOnly  = args.includes("--props-only"); // skip OddsAPI game odds, ESPN props only

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

const HEADERS     = { "User-Agent": "DiamondEdge/1.0", "Accept": "application/json" };
const ESPN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://www.espn.com",
  "Referer": "https://www.espn.com/mlb/odds",
};

// ─── ESPN game odds (DraftKings only) ────────────────────────────────────────
// Reads directly from comp.odds inline array — no extra API calls needed.
async function fetchEspnOdds() {
  const dateCompact = targetDate.replace(/-/g, "");
  let events;
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: ESPN_HEADERS, timeout: 15000 }
    );
    if (!res.ok) { console.log(`  ❌ ESPN scoreboard HTTP ${res.status}`); return []; }
    events = (await res.json()).events || [];
  } catch(e) { console.log(`  ❌ ESPN fetch error: ${e.message}`); return []; }

  if (!events.length) { console.log("  No ESPN games found"); return []; }

  const rows = [];
  const seenPairs = {};

  for (const event of events) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    const gameState = comp.status?.type?.state;
    if (gameState === "post") continue;

    let homeTeam = null, awayTeam = null;
    for (const c of (comp.competitors || [])) {
      const t = norm(c.team?.displayName || c.team?.name || "") || norm(c.team?.abbreviation || "");
      if (c.homeAway === "home") homeTeam = t;
      else awayTeam = t;
    }
    if (!homeTeam || !awayTeam) continue;

    const pairId = awayTeam + "|" + homeTeam;
    seenPairs[pairId] = (seenPairs[pairId] || 0) + 1;
    const gameNumber = seenPairs[pairId];

    const gameTimeET = event.date
      ? new Date(event.date).toLocaleTimeString("en-US", {
          timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
        }) + " ET"
      : null;

    // comp.odds is an inline array of bookmaker objects (no $ref traversal needed)
    const oddsArr = Array.isArray(comp.odds) ? comp.odds : [];
    for (const odds of oddsArr) {
      if (!/^draftkings$/i.test(odds.provider?.name || "")) continue;

      // Moneyline — ESPN uses odds.moneyline.{home,away}.close.odds (American string)
      const homeMLStr = odds.moneyline?.home?.close?.odds ?? odds.homeTeamOdds?.moneyLine;
      const awayMLStr = odds.moneyline?.away?.close?.odds ?? odds.awayTeamOdds?.moneyLine;
      const homeML = parseInt(homeMLStr ?? "");
      const awayML = parseInt(awayMLStr ?? "");
      const saneML = !isNaN(homeML) && !isNaN(awayML)
        && Math.abs(homeML) >= 100 && Math.abs(homeML) <= 500
        && Math.abs(awayML) >= 100 && Math.abs(awayML) <= 500;

      if (saneML) {
        rows.push({
          game_date: targetDate, home_team: homeTeam, away_team: awayTeam, game_number: gameNumber,
          source: "espn", bookmaker: "DraftKings", market: "h2h",
          home_ml: homeML, away_ml: awayML, home_prob: mlToProb(homeML), away_prob: mlToProb(awayML),
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: null, over_odds: null, under_odds: null, game_time: gameTimeET,
        });
      }

      // Run line (point spread)
      const hSpreadLine = parseFloat(odds.pointSpread?.home?.close?.line ?? odds.spread ?? "");
      const hSpreadOdds = parseInt(odds.pointSpread?.home?.close?.odds ?? "-110");
      const aSpreadOdds = parseInt(odds.pointSpread?.away?.close?.odds ?? "-110");
      if (!isNaN(hSpreadLine)) {
        rows.push({
          game_date: targetDate, home_team: homeTeam, away_team: awayTeam, game_number: gameNumber,
          source: "espn", bookmaker: "DraftKings", market: "spreads",
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: hSpreadLine, home_spread_odds: isNaN(hSpreadOdds) ? -110 : hSpreadOdds,
          away_spread: -hSpreadLine, away_spread_odds: isNaN(aSpreadOdds) ? -110 : aSpreadOdds,
          total_line: null, over_odds: null, under_odds: null, game_time: gameTimeET,
        });
      }

      // Total (over/under)
      const totalLine = parseFloat(
        (odds.total?.over?.close?.line ?? "").replace(/[ou]/gi, "") ||
        (odds.overUnder ?? "")
      );
      const overOdds  = parseInt(odds.total?.over?.close?.odds  ?? odds.overOdds  ?? "-110");
      const underOdds = parseInt(odds.total?.under?.close?.odds ?? odds.underOdds ?? "-110");
      if (!isNaN(totalLine) && totalLine > 0) {
        rows.push({
          game_date: targetDate, home_team: homeTeam, away_team: awayTeam, game_number: gameNumber,
          source: "espn", bookmaker: "DraftKings", market: "totals",
          home_ml: null, away_ml: null, home_prob: null, away_prob: null,
          home_spread: null, home_spread_odds: null, away_spread: null, away_spread_odds: null,
          total_line: totalLine, over_odds: isNaN(overOdds) ? -110 : overOdds,
          under_odds: isNaN(underOdds) ? -110 : underOdds, game_time: gameTimeET,
        });
      }
    }
  }

  console.log(`  ${events.length} ESPN games → ${rows.length} DK odds row(s)`);
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Wait for db.js to finish table creation
  await new Promise(r => setTimeout(r, 800));

  console.log(`\nFetching DraftKings odds for ${targetDate}...\n`);

  // ── Step 1: Game odds (h2h, spreads, totals) ─────────────────────────────
  // Skipped when --props-only is passed (e.g. from automatic server refreshes).
  // Try OddsAPI first; fall back to ESPN when quota is exhausted.
  if (!propsOnly) {
  console.log("  Fetching game odds (h2h, spreads, totals)...");
  const oddsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h,spreads,totals&dateFormat=iso&oddsFormat=american&bookmakers=draftkings`;
  let allGames = [];
  let oddsApiAvailable = false;
  try {
    const res = await fetch(oddsUrl, { headers: HEADERS, timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rem = res.headers.get("x-requests-remaining");
    if (rem) console.log(`  (quota: ${rem} requests remaining this month)`);
    allGames = await res.json();
    if (!Array.isArray(allGames)) throw new Error("Unexpected response");
    oddsApiAvailable = true;
  } catch(e) {
    console.log(`  ⚠ OddsAPI unavailable (${e.message}) — falling back to ESPN`);
  }

  // If OddsAPI had no data, fetch game odds from ESPN instead
  if (!oddsApiAvailable || !allGames.length) {
    const espnRows = await fetchEspnOdds();
    if (espnRows.length) {
      await run("BEGIN TRANSACTION");
      let saved = 0;
      for (const r of espnRows) {
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
      console.log(`  ✓ ${saved} ESPN game odds row(s) saved`);
    }
  }

  // Filter to target date from the upcoming-games odds response
  const todayGames = allGames.filter(g => {
    const etDate = new Date(g.commence_time).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return etDate === targetDate;
  });
  console.log(`  ${todayGames.length} upcoming game(s) from odds endpoint for ${targetDate}`);

  // Also fetch ALL events for today (including in-progress/finished) via the events endpoint.
  // The /odds endpoint only returns upcoming games, so once games start it returns nothing.
  // The /events endpoint always returns all games for a date range.
  let allEventIds = new Map(todayGames.map(g => [g.id, g])); // id → game object
  try {
    // ET is UTC-4 in summer; cover the full ET calendar day with a UTC window
    const from = `${targetDate}T05:00:00Z`;       // ~1am ET
    const nextDate = new Date(new Date(targetDate).getTime() + 86400000)
      .toISOString().slice(0, 10);
    const to   = `${nextDate}T05:00:00Z`;
    const eventsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${ODDS_API_KEY}&dateFormat=iso&commenceTimeFrom=${from}&commenceTimeTo=${to}`;
    const evRes = await fetch(eventsUrl, { headers: HEADERS, timeout: 15000 });
    if (evRes.ok) {
      const events = await evRes.json();
      const rem = evRes.headers.get("x-requests-remaining");
      if (rem) console.log(`  (quota after events fetch: ${rem})`);
      let added = 0;
      for (const ev of (Array.isArray(events) ? events : [])) {
        if (!allEventIds.has(ev.id)) {
          allEventIds.set(ev.id, ev);
          added++;
        }
      }
      if (added) console.log(`  +${added} game(s) from events endpoint (in-progress/finished)`);
    }
  } catch(e) {
    console.log(`  ⚠ Events endpoint error: ${e.message}`);
  }

  const allTodayGames = Array.from(allEventIds.values());
  console.log(`  ${allTodayGames.length} total game(s) for ${targetDate}`);

  // Save game odds (only upcoming games have bookmaker odds)
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
  } else {
    console.log("  Skipping game odds (--props-only mode)");
  }

  // ── Step 2: Player props via ESPN propBets (DraftKings, no quota) ────────────
  console.log("\n  Fetching DK player props via ESPN...");
  let kUpdated = 0, hrUpdated = 0;

  // Get ESPN scoreboard to get ESPN event IDs and team IDs
  const dateCompact = targetDate.replace(/-/g, "");
  let espnEvents = [];
  try {
    const sbRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`,
      { headers: ESPN_HEADERS, timeout: 12000 }
    );
    if (sbRes.ok) espnEvents = ((await sbRes.json()).events || []);
  } catch(e) { console.log(`  ⚠ ESPN scoreboard error: ${e.message}`); }

  for (const event of espnEvents) {
    const comp = (event.competitions || [])[0];
    if (!comp) continue;

    // Build athlete ID → fullName map from both team rosters
    const athleteMap = {};
    for (const competitor of (comp.competitors || [])) {
      const teamId = competitor.team?.id;
      if (!teamId) continue;
      try {
        const rRes = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${teamId}/roster`,
          { headers: ESPN_HEADERS, timeout: 8000 }
        );
        if (!rRes.ok) continue;
        const rData = await rRes.json();
        for (const group of (rData.athletes || [])) {
          for (const athlete of (group.items || [])) {
            if (athlete.id && athlete.fullName) athleteMap[athlete.id] = athlete.fullName;
          }
        }
      } catch(_) {}
      await new Promise(r => setTimeout(r, 80));
    }

    // Fetch propBets for this event (provider 100 = DraftKings)
    let propItems = [];
    try {
      const pbBase = `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${event.id}/competitions/${event.id}/odds/100/propBets`;
      const p1 = await fetch(`${pbBase}?limit=300&lang=en&region=us`, { headers: ESPN_HEADERS, timeout: 10000 });
      if (!p1.ok) { await new Promise(r => setTimeout(r, 200)); continue; }
      const p1Data = await p1.json();
      propItems = p1Data.items || [];
      if ((p1Data.count || 0) > 300) {
        const p2 = await fetch(`${pbBase}?limit=300&page=2&lang=en&region=us`, { headers: ESPN_HEADERS, timeout: 10000 });
        if (p2.ok) propItems = propItems.concat((await p2.json()).items || []);
      }
    } catch(e) { await new Promise(r => setTimeout(r, 200)); continue; }

    // Strip accents so "Rodón" matches "Rodon", etc.
    const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

    // Helper: match athlete name to DB rows
    const matchAndRun = async (name, table, col, sql, params) => {
      const norm = stripAccents(name).toLowerCase();
      // Fetch all names for today and match after stripping accents on both sides
      const candidates = await all(`SELECT ${col} FROM ${table} WHERE game_date=?`, [targetDate]);
      let rows = candidates.filter(r => stripAccents(r[col]).toLowerCase() === norm);
      if (!rows.length) {
        const last = norm.split(' ').slice(-1)[0];
        rows = candidates.filter(r => stripAccents(r[col]).toLowerCase().endsWith(' ' + last));
      }
      for (const row of rows) await run(sql, [...params, row[col]]);
      return rows.length;
    };

    // Pitcher K lines — Total Strikeouts (type.name="Total Strikeouts")
    // ESPN returns pairs: [Over, Under] per athlete in order
    const kByAthlete = {};
    for (const item of propItems.filter(i => i.type?.name === "Total Strikeouts")) {
      const id = item.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
      if (!id) continue;
      (kByAthlete[id] = kByAthlete[id] || []).push(item);
    }
    for (const [id, items] of Object.entries(kByAthlete)) {
      const name = athleteMap[id];
      if (!name) continue;
      const line      = parseFloat(items[0]?.odds?.total?.value);
      const overOdds  = parseInt(items[0]?.odds?.american?.value);
      const underOdds = parseInt(items[1]?.odds?.american?.value);
      if (isNaN(line)) continue;
      kUpdated += await matchAndRun(name, "strikeout_predictions", "pitcher",
        `UPDATE strikeout_predictions SET dk_line=?, dk_over_odds=?, dk_under_odds=? WHERE game_date=? AND pitcher=?`,
        [line, isNaN(overOdds) ? null : overOdds, isNaN(underOdds) ? null : underOdds, targetDate]
      );
    }

    // Batter HR odds — Home Runs Milestones 1+ (to hit at least 1 HR)
    for (const item of propItems.filter(i => i.type?.name === "Home Runs Milestones" && i.current?.target?.displayValue === "1+")) {
      const id   = item.athlete?.$ref?.match(/athletes\/(\d+)/)?.[1];
      const name = athleteMap[id];
      if (!name) continue;
      const hrOdds = parseInt(item.odds?.american?.value);
      if (isNaN(hrOdds)) continue;
      hrUpdated += await matchAndRun(name, "homerun_predictions", "batter",
        `UPDATE homerun_predictions SET dk_hr_odds=? WHERE game_date=? AND batter=?`,
        [hrOdds, targetDate]
      );
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n  ✓ Pitcher K lines updated: ${kUpdated} pitcher(s)`);
  console.log(`  ✓ Batter HR odds updated:  ${hrUpdated} batter(s)`);

  process.stdout.write("\n  Clearing server caches...       ");
  await bustCache();
  console.log("done");

  console.log("\nDone.\n");
  setTimeout(() => process.exit(0), 300);
}

module.exports = {};
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
