"use strict";
const db  = require("./db");
const fetch = require("node-fetch").default;

const normA = t => ({ AZ:'ARI',KCR:'KC',TBR:'TB',SDP:'SD',SFG:'SF',WSN:'WSH' }[t] || t);

async function fetchEspnScores(date) {
  const compact = date.replace(/-/g,'');
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${compact}&limit=30`,
    { headers: { 'User-Agent':'Debug/1.0' }, timeout: 12000 });
  if (!res.ok) return {};
  const events = (await res.json()).events || [];
  const scores = {};
  const seen = {};
  for (const e of events) {
    const comp = (e.competitions||[])[0]; if (!comp) continue;
    let ht='',at='',hs=null,as=null;
    for (const c of (comp.competitors||[])) {
      const abbr = c.team?.abbreviation?.toUpperCase()||'';
      const sc = c.score != null ? parseInt(c.score) : null;
      if (c.homeAway==='home') { ht=abbr; hs=sc; } else { at=abbr; as=sc; }
    }
    if (!ht||!at) continue;
    const pair = at+'|'+ht; seen[pair]=(seen[pair]||0)+1;
    const key = at+'@'+ht+(seen[pair]>1?':'+seen[pair]:'');
    const state = comp.status?.type?.state||'pre';
    scores[key] = { state, home_score: hs, away_score: as };
  }
  return scores;
}

// Week bounds
const now = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
const dow = now.getDay();
const sun = new Date(now); sun.setDate(now.getDate()-dow); sun.setHours(0,0,0,0);
const sat = new Date(sun); sat.setDate(sun.getDate()+6);
const fmt = d => d.toLocaleDateString('en-CA');
const weekStart = fmt(sun), weekEnd = fmt(sat);
console.log(`Week: ${weekStart} – ${weekEnd}\n`);

db.all(`SELECT game_date, away_team AS away, home_team AS home, game_number, pick, confidence, home_prob, away_prob
        FROM game_predictions WHERE game_date BETWEEN ? AND ? ORDER BY game_date`,
  [weekStart, weekEnd], async (e, preds) => {

  db.all(`SELECT game_date, home_team, away_team, game_number, home_ml, away_ml, source
          FROM betting_odds
          WHERE game_date BETWEEN ? AND ? AND market='h2h'
            AND LOWER(bookmaker)='draftkings'
            AND home_ml IS NOT NULL AND ABS(home_ml)<=1500
            AND (away_ml IS NULL OR ABS(away_ml)<=1500)
          ORDER BY CASE source WHEN 'odds_api' THEN 0 ELSE 1 END`,
    [weekStart, weekEnd], async (e2, odds) => {

    // Build bestML (odds_api first)
    const bestML = {};
    for (const r of odds) {
      const sfx = (r.game_number||1)>1?':'+r.game_number:'';
      const hk = r.game_date+'|'+normA(r.home_team)+sfx;
      const ak = r.game_date+'|'+normA(r.away_team)+sfx;
      if (r.home_ml!=null && bestML[hk]==null) bestML[hk]=r.home_ml;
      if (r.away_ml!=null && bestML[ak]==null) bestML[ak]=r.away_ml;
    }

    // Fetch scores for each date
    const dates = [...new Set(preds.map(p=>p.game_date))];
    const scoresByDate = {};
    for (const date of dates) {
      const espn = await fetchEspnScores(date);
      // Normalize keys using normA
      const map = {};
      for (const [key,s] of Object.entries(espn)) {
        if (s.state!=='post'||s.home_score==null) continue;
        const atIdx=key.indexOf('@'), colIdx=key.lastIndexOf(':');
        const hasSfx=colIdx>atIdx;
        const sfx=hasSfx?key.slice(colIdx):'';
        const base=hasSfx?key.slice(0,colIdx):key;
        const [ra,rh]=base.split('@');
        map[normA(ra)+'@'+normA(rh)+sfx]={home_score:s.home_score,away_score:s.away_score};
      }
      scoresByDate[date]=map;
    }

    // Per-prediction computation
    let allW=0,allL=0,allPL=0,allPend=0;
    let evW=0,evL=0,evPL=0,evPend=0;

    for (const p of preds) {
      const sfx=(p.game_number||1)>1?':'+p.game_number:'';
      const na=normA(p.away),nh=normA(p.home),np=normA(p.pick);
      const sm=scoresByDate[p.game_date]||{};
      const fwdKey=na+'@'+nh+sfx, revKey=nh+'@'+na+sfx;
      const result=sm[fwdKey]||sm[revKey];
      const flipped=!sm[fwdKey]&&!!sm[revKey];

      const pickKey=p.game_date+'|'+np+sfx;
      const pickML=bestML[pickKey]??null;
      const impl=pickML!=null?(pickML>0?100/(pickML+100):Math.abs(pickML)/(Math.abs(pickML)+100))*100:null;
      const payout=pickML!=null?(pickML>0?pickML/100:100/Math.abs(pickML)):0.909;
      const edge=impl!=null?p.confidence-impl:null;
      const isEV=edge!=null&&edge>0;

      if (!result) {
        allPend++; if(isEV) evPend++;
        console.log(`  ${p.game_date} ${p.away}@${p.home} pick=${p.pick} ML=${pickML} edge=${edge?.toFixed(1)} isEV=${isEV} → PENDING`);
        continue;
      }
      const hs=flipped?result.away_score:result.home_score;
      const as=flipped?result.home_score:result.away_score;
      if (hs===as) { console.log(`  ${p.game_date} ${p.away}@${p.home} → TIE`); continue; }
      const correct=(np===nh)===(hs>as);
      if(correct){allW++;allPL+=payout;}else{allL++;allPL-=1;}
      if(isEV){if(correct){evW++;evPL+=payout;}else{evL++;evPL-=1;}}
      console.log(`  ${p.game_date} ${p.away}@${p.home} pick=${p.pick} ML=${pickML} edge=${edge?.toFixed(1)} isEV=${isEV} score=${hs}-${as} flipped=${flipped} → ${correct?'WIN':'LOSS'} (${isEV?'+EV':'-EV'})`);
    }

    console.log(`\nServer weekly: allW=${allW} allL=${allL} allPL=${allPL.toFixed(2)} evW=${evW} evL=${evL} evPL=${evPL.toFixed(2)} pending=${evPend}`);

    // Also check confidence vs home_prob/away_prob consistency
    console.log('\nChecking conf vs home_prob/away_prob consistency:');
    for (const p of preds) {
      const pickIsHome = normA(p.pick)===normA(p.home);
      const modelProb = pickIsHome ? (p.home_prob||null) : (p.away_prob||null);
      if (modelProb==null) { console.log(`  ${p.game_date} ${p.away}@${p.home} pick=${p.pick}: home_prob=${p.home_prob} away_prob=${p.away_prob} conf=${p.confidence} → MISSING PROB`); continue; }
      const diff = Math.abs(modelProb - p.confidence);
      if (diff > 0.5) console.log(`  ${p.game_date} ${p.away}@${p.home} pick=${p.pick}: conf=${p.confidence} pickProb=${modelProb} DIFF=${diff.toFixed(2)}`);
    }

    db.close();
  });
});
