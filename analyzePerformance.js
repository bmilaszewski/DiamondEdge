"use strict";
const db = require('./db');

const scores = {
'2026-04-27':[{home:'CLE',away:'TB',homeScore:2,awayScore:3},{home:'PIT',away:'STL',homeScore:2,awayScore:4},{home:'TOR',away:'BOS',homeScore:0,awayScore:5},{home:'CHW',away:'LAA',homeScore:8,awayScore:7},{home:'MIN',away:'SEA',homeScore:11,awayScore:4},{home:'TEX',away:'NYY',homeScore:2,awayScore:4},{home:'SD',away:'CHC',homeScore:9,awayScore:7},{home:'LAD',away:'MIA',homeScore:5,awayScore:4}],
'2026-04-28':[{home:'CLE',away:'TB',homeScore:0,awayScore:1},{home:'BAL',away:'HOU',homeScore:5,awayScore:3},{home:'CIN',away:'COL',homeScore:7,awayScore:2},{home:'PHI',away:'SF',homeScore:7,awayScore:0},{home:'PIT',away:'STL',homeScore:7,awayScore:11},{home:'TOR',away:'BOS',homeScore:3,awayScore:0},{home:'NYM',away:'WSH',homeScore:8,awayScore:0},{home:'ATL',away:'DET',homeScore:5,awayScore:2},{home:'CHW',away:'LAA',homeScore:5,awayScore:2},{home:'MIL',away:'ARI',homeScore:13,awayScore:2},{home:'MIN',away:'SEA',homeScore:1,awayScore:7},{home:'TEX',away:'NYY',homeScore:2,awayScore:3},{home:'SD',away:'CHC',homeScore:3,awayScore:8},{home:'ATH',away:'KC',homeScore:1,awayScore:4},{home:'LAD',away:'MIA',homeScore:1,awayScore:2}],
'2026-04-29':[{home:'CLE',away:'TB',homeScore:3,awayScore:1},{home:'CHW',away:'LAA',homeScore:3,awayScore:2},{home:'MIN',away:'SEA',homeScore:3,awayScore:5},{home:'TEX',away:'NYY',homeScore:3,awayScore:0},{home:'TOR',away:'BOS',homeScore:8,awayScore:1},{home:'LAD',away:'MIA',homeScore:2,awayScore:3},{home:'SD',away:'CHC',homeScore:4,awayScore:5},{home:'CIN',away:'COL',homeScore:2,awayScore:13},{home:'PIT',away:'STL',homeScore:4,awayScore:5},{home:'NYM',away:'WSH',homeScore:2,awayScore:14},{home:'ATL',away:'DET',homeScore:4,awayScore:3},{home:'MIL',away:'ARI',homeScore:2,awayScore:6},{home:'ATH',away:'KC',homeScore:5,awayScore:2}],
'2026-04-30':[{home:'ATL',away:'DET',homeScore:2,awayScore:5},{home:'BAL',away:'HOU',homeScore:10,awayScore:3},{home:'PHI',away:'SF',homeScore:3,awayScore:2},{home:'PIT',away:'STL',homeScore:5,awayScore:10},{home:'CIN',away:'COL',homeScore:6,awayScore:4},{home:'NYM',away:'WSH',homeScore:4,awayScore:5},{home:'MIL',away:'ARI',homeScore:13,awayScore:1},{home:'ATH',away:'KC',homeScore:6,awayScore:3},{home:'BAL',away:'HOU',homeScore:5,awayScore:11},{home:'PHI',away:'SF',homeScore:6,awayScore:5},{home:'MIN',away:'TOR',homeScore:7,awayScore:1}],
'2026-05-01':[{home:'CHC',away:'ARI',homeScore:6,awayScore:5},{home:'DET',away:'TEX',homeScore:4,awayScore:5},{home:'PIT',away:'CIN',homeScore:9,awayScore:1},{home:'WSH',away:'MIL',homeScore:1,awayScore:6},{home:'NYY',away:'BAL',homeScore:7,awayScore:2},{home:'BOS',away:'HOU',homeScore:3,awayScore:1},{home:'MIA',away:'PHI',homeScore:5,awayScore:6},{home:'TB',away:'SF',homeScore:3,awayScore:0},{home:'MIN',away:'TOR',homeScore:3,awayScore:7},{home:'STL',away:'LAD',homeScore:7,awayScore:2},{home:'COL',away:'ATL',homeScore:6,awayScore:8},{home:'LAA',away:'NYM',homeScore:3,awayScore:4},{home:'SD',away:'CHW',homeScore:2,awayScore:8},{home:'ATH',away:'CLE',homeScore:5,awayScore:8},{home:'SEA',away:'KC',homeScore:6,awayScore:7}],
'2026-05-02':[{home:'NYY',away:'BAL',homeScore:9,awayScore:4},{home:'MIN',away:'TOR',homeScore:4,awayScore:11},{home:'CHC',away:'ARI',homeScore:2,awayScore:0},{home:'PIT',away:'CIN',homeScore:17,awayScore:7},{home:'WSH',away:'MIL',homeScore:1,awayScore:4},{home:'ATH',away:'CLE',homeScore:6,awayScore:14},{home:'BOS',away:'HOU',homeScore:3,awayScore:6},{home:'MIA',away:'PHI',homeScore:4,awayScore:0},{home:'TB',away:'SF',homeScore:5,awayScore:1},{home:'DET',away:'TEX',homeScore:5,awayScore:1},{home:'STL',away:'LAD',homeScore:3,awayScore:2},{home:'COL',away:'ATL',homeScore:1,awayScore:9},{home:'SD',away:'CHW',homeScore:0,awayScore:4},{home:'LAA',away:'NYM',homeScore:4,awayScore:3},{home:'SEA',away:'KC',homeScore:2,awayScore:3}],
'2026-05-03':[{home:'MIN',away:'TOR',homeScore:4,awayScore:3},{home:'NYY',away:'BAL',homeScore:11,awayScore:3},{home:'PIT',away:'CIN',homeScore:1,awayScore:0},{home:'BOS',away:'HOU',homeScore:1,awayScore:3},{home:'WSH',away:'MIL',homeScore:3,awayScore:2},{home:'MIA',away:'PHI',homeScore:2,awayScore:7},{home:'TB',away:'SF',homeScore:2,awayScore:1},{home:'STL',away:'LAD',homeScore:1,awayScore:4},{home:'CHC',away:'ARI',homeScore:8,awayScore:4},{home:'COL',away:'ATL',homeScore:6,awayScore:11},{home:'ATH',away:'CLE',homeScore:7,awayScore:1},{home:'LAA',away:'NYM',homeScore:1,awayScore:5},{home:'SD',away:'CHW',homeScore:4,awayScore:3},{home:'SEA',away:'KC',homeScore:1,awayScore:4},{home:'DET',away:'TEX',homeScore:7,awayScore:1}],
'2026-05-04':[{home:'COL',away:'NYM',homeScore:2,awayScore:4},{home:'DET',away:'BOS',homeScore:4,awayScore:5},{home:'MIA',away:'PHI',homeScore:0,awayScore:1},{home:'TB',away:'TOR',homeScore:5,awayScore:1},{home:'NYY',away:'BAL',homeScore:12,awayScore:1},{home:'CHC',away:'CIN',homeScore:5,awayScore:4},{home:'KC',away:'CLE',homeScore:6,awayScore:2},{home:'STL',away:'MIL',homeScore:6,awayScore:3},{home:'HOU',away:'LAD',homeScore:3,awayScore:8},{home:'LAA',away:'CHW',homeScore:0,awayScore:6},{home:'SEA',away:'ATL',homeScore:5,awayScore:4},{home:'SF',away:'SD',homeScore:3,awayScore:2}],
'2026-05-05':[{home:'PHI',away:'ATH',homeScore:9,awayScore:1},{home:'MIA',away:'BAL',homeScore:7,awayScore:9},{home:'DET',away:'BOS',homeScore:3,awayScore:10},{home:'TB',away:'TOR',homeScore:4,awayScore:3},{home:'WSH',away:'MIN',homeScore:3,awayScore:11},{home:'NYY',away:'TEX',homeScore:7,awayScore:4},{home:'CHC',away:'CIN',homeScore:3,awayScore:2},{home:'KC',away:'CLE',homeScore:5,awayScore:3},{home:'HOU',away:'LAD',homeScore:2,awayScore:1},{home:'LAA',away:'CHW',homeScore:4,awayScore:3},{home:'SEA',away:'ATL',homeScore:2,awayScore:3},{home:'ARI',away:'PIT',homeScore:9,awayScore:0},{home:'SF',away:'SD',homeScore:5,awayScore:10}],
'2026-05-06':[{home:'TB',away:'TOR',homeScore:3,awayScore:0},{home:'STL',away:'MIL',homeScore:2,awayScore:6},{home:'HOU',away:'LAD',homeScore:2,awayScore:12},{home:'SF',away:'SD',homeScore:1,awayScore:5},{home:'LAA',away:'CHW',homeScore:8,awayScore:2},{home:'SEA',away:'ATL',homeScore:3,awayScore:1},{home:'PHI',away:'ATH',homeScore:6,awayScore:3},{home:'MIA',away:'BAL',homeScore:4,awayScore:7},{home:'DET',away:'BOS',homeScore:0,awayScore:4},{home:'WSH',away:'MIN',homeScore:15,awayScore:2},{home:'NYY',away:'TEX',homeScore:1,awayScore:6},{home:'CHC',away:'CIN',homeScore:7,awayScore:6},{home:'KC',away:'CLE',homeScore:1,awayScore:3},{home:'COL',away:'NYM',homeScore:5,awayScore:10},{home:'ARI',away:'PIT',homeScore:0,awayScore:1}],
'2026-05-07':[{home:'NYY',away:'TEX',homeScore:9,awayScore:2},{home:'WSH',away:'MIN',homeScore:7,awayScore:5},{home:'KC',away:'CLE',homeScore:5,awayScore:8},{home:'CHC',away:'CIN',homeScore:8,awayScore:3},{home:'COL',away:'NYM',homeScore:6,awayScore:2},{home:'ARI',away:'PIT',homeScore:2,awayScore:4},{home:'PHI',away:'ATH',homeScore:1,awayScore:12},{home:'MIA',away:'BAL',homeScore:4,awayScore:3},{home:'BOS',away:'TB',homeScore:4,awayScore:8},{home:'SD',away:'STL',homeScore:1,awayScore:2}],
'2026-05-08':[{home:'CIN',away:'HOU',homeScore:0,awayScore:10},{home:'PHI',away:'COL',homeScore:7,awayScore:9},{home:'BAL',away:'ATH',homeScore:3,awayScore:4},{home:'TOR',away:'LAA',homeScore:2,awayScore:0},{home:'BOS',away:'TB',homeScore:2,awayScore:0},{home:'MIA',away:'WSH',homeScore:2,awayScore:3},{home:'CLE',away:'MIN',homeScore:6,awayScore:4},{home:'KC',away:'DET',homeScore:4,awayScore:3},{home:'MIL',away:'NYY',homeScore:6,awayScore:0},{home:'CHW',away:'SEA',homeScore:8,awayScore:12},{home:'TEX',away:'CHC',homeScore:1,awayScore:7},{home:'ARI',away:'NYM',homeScore:1,awayScore:3},{home:'SD',away:'STL',homeScore:0,awayScore:6},{home:'LAD',away:'ATL',homeScore:3,awayScore:1},{home:'SF',away:'PIT',homeScore:5,awayScore:2}],
'2026-05-09':[{home:'TOR',away:'LAA',homeScore:14,awayScore:1},{home:'BAL',away:'ATH',homeScore:2,awayScore:6},{home:'CIN',away:'HOU',homeScore:3,awayScore:1},{home:'MIA',away:'WSH',homeScore:8,awayScore:7},{home:'PHI',away:'COL',homeScore:9,awayScore:3},{home:'CLE',away:'MIN',homeScore:1,awayScore:2},{home:'TEX',away:'CHC',homeScore:6,awayScore:0},{home:'KC',away:'DET',homeScore:5,awayScore:1},{home:'MIL',away:'NYY',homeScore:4,awayScore:3},{home:'CHW',away:'SEA',homeScore:6,awayScore:1},{home:'ARI',away:'NYM',homeScore:2,awayScore:1},{home:'SD',away:'STL',homeScore:4,awayScore:2},{home:'SF',away:'PIT',homeScore:3,awayScore:13},{home:'LAD',away:'ATL',homeScore:2,awayScore:7}],
'2026-05-10':[{home:'MIA',away:'WSH',homeScore:5,awayScore:2},{home:'BAL',away:'ATH',homeScore:2,awayScore:1},{home:'PHI',away:'COL',homeScore:6,awayScore:0},{home:'BOS',away:'TB',homeScore:1,awayScore:4},{home:'TOR',away:'LAA',homeScore:1,awayScore:6},{home:'CIN',away:'HOU',homeScore:5,awayScore:0},{home:'CLE',away:'MIN',homeScore:4,awayScore:5},{home:'MIL',away:'NYY',homeScore:4,awayScore:3},{home:'CHW',away:'SEA',homeScore:2,awayScore:1},{home:'TEX',away:'CHC',homeScore:3,awayScore:0},{home:'SF',away:'PIT',homeScore:7,awayScore:6},{home:'LAD',away:'ATL',homeScore:2,awayScore:7},{home:'ARI',away:'NYM',homeScore:5,awayScore:1},{home:'SD',away:'STL',homeScore:3,awayScore:2},{home:'KC',away:'DET',homeScore:3,awayScore:6}]
};

const normMap = {CHW:'CWS'};
function norm(t){ return normMap[t]||t; }

const scoreLookup = {};
for (const [date, games] of Object.entries(scores)) {
  for (const g of games) {
    const h = norm(g.home), a = norm(g.away);
    const key = date+'|'+[h,a].sort().join('|');
    scoreLookup[key] = { homeWon: g.homeScore > g.awayScore, home: h, away: a, homeScore: g.homeScore, awayScore: g.awayScore };
  }
}

db.all(
  `SELECT game_date,away_team,home_team,pick,confidence,home_prob,away_prob,home_sp,away_sp
   FROM game_predictions WHERE game_date>='2026-04-27' AND game_date<='2026-05-10' ORDER BY game_date,confidence DESC`,
  [], (err, preds) => {
    if (err) { console.error(err); db.close(); return; }

    const results = [];
    const unmatched = [];
    for (const p of preds) {
      const key = p.game_date+'|'+[p.home_team,p.away_team].sort().join('|');
      const sc = scoreLookup[key];
      if (!sc) { unmatched.push(p.game_date+' '+p.away_team+'@'+p.home_team); continue; }
      const pickIsHome = p.pick === p.home_team;
      const correct = pickIsHome === sc.homeWon;
      results.push({...p, correct, homeScore:sc.homeScore, awayScore:sc.awayScore, homeWon:sc.homeWon});
    }

    // ── Overall ──────────────────────────────────────────────────────────────
    const W = results.filter(r=>r.correct).length;
    const L = results.filter(r=>!r.correct).length;
    const pct = (W/(W+L)*100).toFixed(1);
    console.log('=== OVERALL ===');
    console.log(`${W}-${L}  (${pct}%)  from ${results.length} resolved picks`);
    if (unmatched.length) console.log('  unmatched:', unmatched.join(', '));

    // ── By confidence tier ───────────────────────────────────────────────────
    console.log('\n=== BY CONFIDENCE TIER ===');
    const tiers = [
      ['≥80% (strong)',   r => r.confidence >= 80],
      ['70-80%',          r => r.confidence >= 70 && r.confidence < 80],
      ['60-70%',          r => r.confidence >= 60 && r.confidence < 70],
      ['55-60%',          r => r.confidence >= 55 && r.confidence < 60],
      ['<55% (coin flip)',r => r.confidence <  55],
    ];
    for (const [label, fn] of tiers) {
      const t = results.filter(fn);
      if (!t.length) continue;
      const w = t.filter(r=>r.correct).length;
      console.log(`  ${label.padEnd(22)} ${w}-${t.length-w}  (${(w/t.length*100).toFixed(1)}%)`);
    }

    // ── By date ──────────────────────────────────────────────────────────────
    console.log('\n=== BY DATE ===');
    const byDate = {};
    for (const r of results) {
      byDate[r.game_date] = byDate[r.game_date] || {w:0,l:0};
      r.correct ? byDate[r.game_date].w++ : byDate[r.game_date].l++;
    }
    for (const [d,v] of Object.entries(byDate).sort()) {
      const tot=v.w+v.l;
      const bar = '█'.repeat(v.w) + '░'.repeat(v.l);
      console.log(`  ${d}  ${v.w}-${v.l}  (${(v.w/tot*100).toFixed(0)}%)  ${bar}`);
    }

    // ── Home vs Away picks ───────────────────────────────────────────────────
    console.log('\n=== HOME vs AWAY PICKS ===');
    const homePicks = results.filter(r=>r.pick===r.home_team);
    const awayPicks = results.filter(r=>r.pick===r.away_team);
    const hW = homePicks.filter(r=>r.correct).length;
    const aW = awayPicks.filter(r=>r.correct).length;
    console.log(`  Home picks: ${hW}-${homePicks.length-hW}  (${homePicks.length?(hW/homePicks.length*100).toFixed(1):'-'}%)  of ${homePicks.length}`);
    console.log(`  Away picks: ${aW}-${awayPicks.length-aW}  (${awayPicks.length?(aW/awayPicks.length*100).toFixed(1):'-'}%)  of ${awayPicks.length}`);

    // ── Most-picked teams ────────────────────────────────────────────────────
    console.log('\n=== MOST-PICKED TEAMS (≥3 times) ===');
    const byTeam = {};
    for (const r of results) {
      byTeam[r.pick] = byTeam[r.pick] || {w:0,l:0};
      r.correct ? byTeam[r.pick].w++ : byTeam[r.pick].l++;
    }
    Object.entries(byTeam)
      .filter(([,v])=>v.w+v.l>=3)
      .sort((a,b)=>(b[1].w/(b[1].w+b[1].l))-(a[1].w/(a[1].w+a[1].l)))
      .forEach(([team,v])=>{
        const tot=v.w+v.l;
        console.log(`  ${team.padEnd(4)}  ${v.w}-${v.l}  (${(v.w/tot*100).toFixed(0)}%)  picked ${tot}x`);
      });

    // ── High-confidence misses (≥65%, wrong) ─────────────────────────────────
    console.log('\n=== HIGH-CONFIDENCE MISSES (≥65%) ===');
    results
      .filter(r=>!r.correct && r.confidence>=65)
      .sort((a,b)=>b.confidence-a.confidence)
      .forEach(r=>{
        const actual = r.homeWon ? r.home_team : r.away_team;
        console.log(`  ${r.game_date}  picked ${r.pick} ${r.confidence.toFixed(1)}%  actual: ${actual}  [${r.away_team}${r.awayScore}@${r.home_team}${r.homeScore}]  SP: ${r.away_sp||'?'} vs ${r.home_sp||'?'}`);
      });

    // ── Repeated matchup losses ───────────────────────────────────────────────
    console.log('\n=== REPEATED MATCHUP LOSSES (same series) ===');
    const byMatchup = {};
    for (const r of results) {
      const mk = [r.away_team,r.home_team].sort().join('|');
      byMatchup[mk] = byMatchup[mk] || [];
      byMatchup[mk].push(r);
    }
    for (const [mk, games] of Object.entries(byMatchup)) {
      if (games.length < 2) continue;
      const losses = games.filter(r=>!r.correct);
      if (losses.length < 2) continue;
      console.log(`  ${mk}: ${games.filter(r=>r.correct).length}W-${losses.length}L across ${games.length} games`);
      for (const r of losses)
        console.log(`    ${r.game_date}  picked ${r.pick} (${r.confidence.toFixed(0)}%)  actual winner: ${r.homeWon?r.home_team:r.away_team}`);
    }

    // ── Blowout losses (≥5 runs wrong) ──────────────────────────────────────
    console.log('\n=== BLOWOUT LOSSES (≥5-run margin, model wrong) ===');
    results
      .filter(r=>!r.correct && Math.abs(r.homeScore-r.awayScore)>=5)
      .sort((a,b)=>Math.abs(b.homeScore-b.awayScore)-Math.abs(a.homeScore-a.awayScore))
      .forEach(r=>{
        const margin = Math.abs(r.homeScore-r.awayScore);
        const actual = r.homeWon ? r.home_team : r.away_team;
        console.log(`  ${r.game_date}  picked ${r.pick} (${r.confidence.toFixed(0)}%)  actual: ${actual} by ${margin}  [${r.away_team}${r.awayScore}@${r.home_team}${r.homeScore}]`);
      });

    // ── Specific teams the model systematically over/under-rates ─────────────
    console.log('\n=== TEAM OUTCOMES vs MODEL PICKS ===');
    // For each team, how often were they the ACTUAL winner vs how often were they PICKED
    const teamActual = {}, teamPicked = {};
    for (const r of results) {
      const winner = r.homeWon ? r.home_team : r.away_team;
      teamActual[winner] = (teamActual[winner]||0)+1;
      teamPicked[r.pick] = (teamPicked[r.pick]||0)+1;
    }
    // Teams the model over-picked (picked more than they won)
    console.log('  Over-picked (model liked them more than results warranted):');
    const allTeams = [...new Set([...Object.keys(teamActual),...Object.keys(teamPicked)])];
    allTeams
      .map(t=>({t, actual:teamActual[t]||0, picked:teamPicked[t]||0, diff:(teamPicked[t]||0)-(teamActual[t]||0)}))
      .filter(x=>x.diff>=3)
      .sort((a,b)=>b.diff-a.diff)
      .forEach(x=>console.log(`    ${x.t.padEnd(4)}  picked ${x.picked}x  won ${x.actual}x  (over by ${x.diff})`));
    console.log('  Under-picked (model undervalued them):');
    allTeams
      .map(t=>({t, actual:teamActual[t]||0, picked:teamPicked[t]||0, diff:(teamActual[t]||0)-(teamPicked[t]||0)}))
      .filter(x=>x.diff>=3)
      .sort((a,b)=>b.diff-a.diff)
      .forEach(x=>console.log(`    ${x.t.padEnd(4)}  won ${x.actual}x  picked ${x.picked}x  (under by ${x.diff})`));

    db.close();
  }
);
