/**
 * refreshPredictions.js
 *
 * The ONLY way to refresh existing predictions for today.
 * Runs all three predictors (winners, strikeouts, home runs) with INSERT OR REPLACE,
 * overwriting whatever is in the DB.
 *
 * Usage:
 *   node refreshPredictions.js
 *
 * The server must be running. After saving to DB this script calls the server's
 * internal cache-bust endpoint so the next page load picks up the fresh data.
 */

'use strict';

const path   = require('path');
const http   = require('http');
const https  = require('https');
const { spawn } = require('child_process');
const db     = require('./db');

const SERVER_PORT = 3000;

// ── ESPN team name normalisation (must stay in sync with server.js) ─────────

const ESPN_TEAM_MAP = {
  "Arizona Diamondbacks":"AZ","Atlanta Braves":"ATL","Baltimore Orioles":"BAL",
  "Boston Red Sox":"BOS","Chicago Cubs":"CHC","Chicago White Sox":"CWS",
  "Cincinnati Reds":"CIN","Cleveland Guardians":"CLE","Colorado Rockies":"COL",
  "Detroit Tigers":"DET","Houston Astros":"HOU","Kansas City Royals":"KC",
  "Los Angeles Angels":"LAA","Los Angeles Dodgers":"LAD","Miami Marlins":"MIA",
  "Milwaukee Brewers":"MIL","Minnesota Twins":"MIN","New York Mets":"NYM",
  "New York Yankees":"NYY","Oakland Athletics":"ATH","Philadelphia Phillies":"PHI",
  "Pittsburgh Pirates":"PIT","San Diego Padres":"SD","San Francisco Giants":"SF",
  "Seattle Mariners":"SEA","St. Louis Cardinals":"STL","Tampa Bay Rays":"TB",
  "Texas Rangers":"TEX","Toronto Blue Jays":"TOR","Washington Nationals":"WSH",
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
  const words = n.split(' ');
  for (let i = 1; i < words.length; i++) {
    const sub = words.slice(i).join(' ');
    if (ESPN_TEAM_MAP[sub]) return ESPN_TEAM_MAP[sub];
  }
  if (n.length <= 4 && n === n.toUpperCase()) return n;
  return null;
}

// Fetch which games have started or finished from ESPN.
// Returns { startedKeys: Set<'AWAY@HOME[:N]'>, startedTeams: Set<abbrev> }
function fetchStartedGames(date) {
  return new Promise(resolve => {
    const dateCompact = date.replace(/-/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateCompact}&limit=30`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const eventsRaw = JSON.parse(body).events || [];
          const events = eventsRaw.sort((a, b) =>
            (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0)
          );
          const inProgressKeys  = new Set(); // 'in' state only
          const finishedKeys    = new Set(); // 'post' state only
          const inProgressTeams = new Set();
          const finishedTeams   = new Set();
          const seenPairs = {};
          for (const event of events) {
            const comp = (event.competitions || [])[0];
            if (!comp) continue;
            const state = comp.status?.type?.state || 'pre';
            if (state === 'pre') continue;
            let homeTeam = null, awayTeam = null;
            for (const c of (comp.competitors || [])) {
              const t = normTeam(c.team?.displayName || c.team?.name || '') || normTeam(c.team?.abbreviation || '');
              if (c.homeAway === 'home') homeTeam = t;
              else awayTeam = t;
            }
            if (!homeTeam || !awayTeam) continue;
            const pairId = awayTeam + '|' + homeTeam;
            seenPairs[pairId] = (seenPairs[pairId] || 0) + 1;
            const gn  = seenPairs[pairId];
            const key = awayTeam + '@' + homeTeam + (gn > 1 ? ':' + gn : '');
            if (state === 'in') {
              inProgressKeys.add(key);
              inProgressTeams.add(homeTeam);
              inProgressTeams.add(awayTeam);
            } else {
              finishedKeys.add(key);
              finishedTeams.add(homeTeam);
              finishedTeams.add(awayTeam);
            }
          }
          resolve({ inProgressKeys, finishedKeys, inProgressTeams, finishedTeams });
        } catch (_) {
          resolve({ inProgressKeys: new Set(), finishedKeys: new Set(), inProgressTeams: new Set(), finishedTeams: new Set() });
        }
      });
    }).on('error', () => resolve({ inProgressKeys: new Set(), finishedKeys: new Set(), inProgressTeams: new Set(), finishedTeams: new Set() }));
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function etToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function runPython(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('py', [path.join(__dirname, script), '--predict'], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        console.error(`[${script}] stderr:`, err.slice(0, 500));
        return reject(new Error(`${script} exited ${code}`));
      }
      resolve(out);
    });
  });
}

function bustCache() {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path: '/api/internal/bust-cache', method: 'POST' },
      res => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', () => {
      console.warn('[refresh] Could not reach server to bust cache — restart the server to see changes.');
      resolve();
    });
    req.end();
  });
}

// ── parse helpers (must match server.js exactly) ───────────────────────────

function parseWinners(raw) {
  for (const line of raw.split('\n')) {
    if (line.startsWith('PREDSJSON:')) {
      try {
        const arr = JSON.parse(line.slice(10));
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (_) {}
    }
  }
  return [];
}

function parseSO(raw) {
  const predictions = [];
  let inPredictions = false;
  for (const raw_line of raw.split('\n')) {
    const line = raw_line.trim();
    if (line.includes("TODAY'S STRIKEOUT PREDICTIONS")) { inPredictions = true; continue; }
    if (!inPredictions) continue;
    if (!line || line.includes('PITCHER') || line.includes('---') ||
        line.includes('===') || line.includes('──') ||
        line.startsWith('[skip]') || line.startsWith('[warn]') ||
        line.startsWith('Date:') || /^\d+ pitchers/.test(line)) continue;
    const parts = line.split(/\s{2,}/);
    if (parts.length < 6) continue;
    try {
      const num = v => { if (!v) return null; const n = parseFloat(v.replace('%','').replace('—','').trim()); return isNaN(n) ? null : n; };
      const lk = num(parts[9]);
      const pred = {
        pitcher: parts[0], team: parts[1], opponent: parts[2],
        pred_k: num(parts[3]), k_pct: num(parts[5]),
        whiff_pct: num(parts[6]), iz_contact_pct: num(parts[7]),
        chase_pct: num(parts[8]), lineup_iz: num(parts[11]),
        lineup_chase: num(parts[12]), lineup_bat_speed: num(parts[13]),
        lineup_vuln: lk != null ? (lk - 22.5) / 22.5 : null,
        data_quality: parts[14] || null,
        exp_k_rate: num(parts[5]) != null ? num(parts[5]) * 0.82 : null,
      };
      if (pred.pred_k != null) predictions.push(pred);
    } catch (_) {}
  }
  return predictions;
}

function parseHR(raw) {
  for (const line of raw.split('\n')) {
    if (line.startsWith('HRJSON:')) {
      try {
        const arr = JSON.parse(line.slice(7));
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (_) {}
    }
  }
  return [];
}

// home/away flip using betting_odds as ground truth
async function applyFlip(preds, date) {
  if (!preds.length) return;
  const rows = await new Promise(resolve =>
    db.all(
      `SELECT away_team, home_team FROM betting_odds
       WHERE game_date=? AND market='h2h' AND home_ml IS NOT NULL`,
      [date], (e, r) => resolve(r || [])
    )
  );
  const oddsHome = {};
  for (const r of rows) {
    const canon = [r.away_team, r.home_team].sort().join('|');
    if (!oddsHome[canon]) oddsHome[canon] = r.home_team;
  }
  for (const p of preds) {
    const canon = [p.away, p.home].sort().join('|');
    const correctHome = oddsHome[canon];
    if (correctHome && correctHome !== p.home) {
      [p.away, p.home]           = [p.home, p.away];
      [p.home_prob, p.away_prob] = [p.away_prob, p.home_prob];
      [p.home_sp,   p.away_sp]   = [p.away_sp,   p.home_sp];
    }
  }
}

// ── save functions ─────────────────────────────────────────────────────────

async function saveWinners(preds, date, inProgressKeys, finishedKeys) {
  if (!preds.length) return 0;
  await applyFlip(preds, date);
  const stmtReplace = db.prepare(
    `INSERT OR REPLACE INTO game_predictions
     (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,
      proj_total,home_sp,away_sp,model_prob,vegas_implied,edge,same_side,reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,
       (SELECT reason FROM game_predictions
        WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?))`
  );
  const stmtIgnore = db.prepare(
    `INSERT OR IGNORE INTO game_predictions
     (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,
      proj_total,home_sp,away_sp,model_prob,vegas_implied,edge,same_side)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?)`
  );
  let updated = 0, preserved = 0;
  for (const p of preds) {
    const gn      = p.game_number || 1;
    const key     = p.away + '@' + p.home + (gn > 1 ? ':' + gn : '');
    const inProgress = inProgressKeys.has(key);
    const finished   = finishedKeys.has(key);

    if (!inProgress && !finished) {
      // Pre-game: safe to remove stale opposite-direction row and replace in full
      db.run(
        'DELETE FROM game_predictions WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?',
        [date, gn, p.home, p.away]
      );
      stmtReplace.run([
        date, gn, p.away, p.home, p.pick, p.confidence,
        p.home_prob, p.away_prob, p.proj_total, p.home_sp || null, p.away_sp || null,
        p.model_prob ?? null, p.vegas_implied ?? null, p.edge ?? null,
        p.same_side != null ? (p.same_side ? 1 : 0) : null,
        date, gn, p.away, p.home,
      ]);
      updated++;
    } else if (inProgress) {
      // In-progress: model has seen live odds and is score-biased.
      // Ensure a row exists (OR IGNORE), then only update pitcher names —
      // pick, probabilities, and odds-derived fields stay frozen at pre-game values.
      stmtIgnore.run([
        date, gn, p.away, p.home, p.pick, p.confidence,
        p.home_prob, p.away_prob, p.proj_total, p.home_sp || null, p.away_sp || null,
        p.model_prob ?? null, p.vegas_implied ?? null, p.edge ?? null,
        p.same_side != null ? (p.same_side ? 1 : 0) : null,
      ]);
      db.run(
        `UPDATE game_predictions SET home_sp = COALESCE(?, home_sp), away_sp = COALESCE(?, away_sp)
         WHERE game_date=? AND game_number=? AND away_team=? AND home_team=?`,
        [p.home_sp || null, p.away_sp || null, date, gn, p.away, p.home]
      );
      preserved++;
    } else {
      // Finished: fully frozen, don't touch anything
      stmtIgnore.run([
        date, gn, p.away, p.home, p.pick, p.confidence,
        p.home_prob, p.away_prob, p.proj_total, p.home_sp || null, p.away_sp || null,
        p.model_prob ?? null, p.vegas_implied ?? null, p.edge ?? null,
        p.same_side != null ? (p.same_side ? 1 : 0) : null,
      ]);
      preserved++;
    }
  }
  stmtReplace.finalize();
  stmtIgnore.finalize();
  if (preserved) process.stdout.write(`${updated} updated, ${preserved} locked  `);
  return updated + preserved;
}

async function saveSO(preds, date, inProgressTeams, finishedTeams) {
  if (!preds.length) return 0;
  const stmtReplace = db.prepare(
    `INSERT OR REPLACE INTO strikeout_predictions
     (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
      iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const stmtIgnore = db.prepare(
    `INSERT OR IGNORE INTO strikeout_predictions
     (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,
      iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let updated = 0, preserved = 0;
  for (const p of preds) {
    const vals = [
      date, p.pitcher, p.team, p.opponent, p.pred_k, p.k_pct,
      p.whiff_pct || null, p.chase_pct || null, p.iz_contact_pct || null,
      p.lineup_iz || null, p.lineup_chase || null, p.lineup_bat_speed || null,
      p.lineup_vuln || null, p.exp_k_rate || null, p.data_quality || null,
    ];
    if (finishedTeams.has(p.team) || inProgressTeams.has(p.team)) { stmtIgnore.run(vals); preserved++; }
    else { stmtReplace.run(vals); updated++; }
  }
  stmtReplace.finalize();
  stmtIgnore.finalize();
  if (preserved) process.stdout.write(`${updated} updated, ${preserved} locked  `);
  return updated + preserved;
}

async function saveHR(preds, date, inProgressTeams, finishedTeams) {
  if (!preds.length) return 0;
  const stmtReplace = db.prepare(
    `INSERT OR REPLACE INTO homerun_predictions
     (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor,
      batting_order,home_team,opponent,temp_f,wind_mph,weather_cond)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const stmtIgnore = db.prepare(
    `INSERT OR IGNORE INTO homerun_predictions
     (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor,
      batting_order,home_team,opponent,temp_f,wind_mph,weather_cond)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let updated = 0, preserved = 0;
  for (const p of preds) {
    const vals = [
      date, p.batter, p.team, p.vs_pitcher || null,
      p.hr_prob_per_pa ?? p.hr_prob_pa ?? null,
      p.hr_prob_per_game ?? p.hr_prob_game ?? null,
      p.park_factor || null, p.weather_factor || null,
      p.batting_order || null, p.home_team || null, p.opponent || null,
      p.temp_f || null, p.wind_mph || null, p.weather_cond || null,
    ];
    if (finishedTeams.has(p.team) || inProgressTeams.has(p.team)) { stmtIgnore.run(vals); preserved++; }
    else { stmtReplace.run(vals); updated++; }
  }
  stmtReplace.finalize();
  stmtIgnore.finalize();
  if (preserved) process.stdout.write(`${updated} updated, ${preserved} locked  `);
  return updated + preserved;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const today = etToday();
  console.log(`\nRefreshing all predictions for ${today}...\n`);

  // Check game states so we can protect picks appropriately:
  //   in-progress → update SP names only, freeze pick/probabilities (model sees live odds)
  //   finished    → fully frozen, no changes at all
  const { inProgressKeys, finishedKeys, inProgressTeams, finishedTeams } = await fetchStartedGames(today);
  const notes = [];
  if (inProgressKeys.size) notes.push(`${inProgressKeys.size} in progress (picks frozen)`);
  if (finishedKeys.size)   notes.push(`${finishedKeys.size} finished (fully frozen)`);
  if (notes.length) console.log(`  (${notes.join(', ')})\n`);

  // Winners
  process.stdout.write('  Running winner predictor...     ');
  try {
    const raw   = await runPython('predictorv4.py');
    const preds = parseWinners(raw);
    const n     = await saveWinners(preds, today, inProgressKeys, finishedKeys);
    console.log(`${n} game(s) saved`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  // Strikeouts
  process.stdout.write('  Running strikeout predictor...  ');
  try {
    const raw   = await runPython('strikeoutPredictorv2.py');
    const preds = parseSO(raw);
    const n     = await saveSO(preds, today, inProgressTeams, finishedTeams);
    console.log(`${n} pitcher(s) saved`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  // Home runs
  process.stdout.write('  Running home run predictor...   ');
  try {
    const raw   = await runPython('hrPredictor.py');
    const preds = parseHR(raw);
    const n     = await saveHR(preds, today, inProgressTeams, finishedTeams);
    console.log(`${n} batter(s) saved`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
  }

  // Bust server caches so next page load reads fresh DB data
  process.stdout.write('\n  Clearing server caches...       ');
  await bustCache();
  console.log('done');

  console.log('\nDone. Refresh the page to see updated predictions.\n');
  setTimeout(() => process.exit(0), 500);
}

// Wait for db.js to finish table creation before running
setTimeout(main, 800);
