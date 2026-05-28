/**
 * One-off: backfill 2026-05-20 and 2026-05-21
 * Reuses helpers from _backfillWeek.js pattern.
 */
'use strict';
const { spawn, execSync } = require('child_process');
const db = require('./db');

const DATES  = ['2026-05-20', '2026-05-21'];
const TODAY  = '2026-05-22';

const run  = (sql,p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){e?rej(e):res(this);}));
const all  = (sql,p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r||[])));
const get1 = (sql,p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));

function spawnPy(args,ms=180000){
  return new Promise((res,rej)=>{
    const proc=spawn('py',args,{stdio:['ignore','pipe','pipe']});
    let out='',err='';
    proc.stdout.on('data',d=>out+=d.toString());
    proc.stderr.on('data',d=>err+=d.toString());
    const t=setTimeout(()=>{proc.kill();rej(new Error('timeout'));},ms);
    proc.on('close',()=>{clearTimeout(t);res(out);});
    proc.on('error',rej);
  });
}

function parseGamePreds(o){
  const l=o.split('\n').find(l=>l.startsWith('PREDSJSON:'));
  if(!l)return[];try{return JSON.parse(l.slice(10));}catch{return[];}
}

function parseSO(output){
  const preds=[];let on=false;
  for(const raw of output.split('\n')){
    const line=raw.trim();
    if(line.includes("TODAY'S STRIKEOUT PREDICTIONS")){on=true;continue;}
    if(!on)continue;
    if(!line||line.includes('PITCHER')||line.includes('---')||line.includes('===')||
       line.includes('──')||line.startsWith('[skip]')||line.startsWith('[warn]')||
       line.startsWith('Date:')||/^\d+ pitchers/.test(line))continue;
    const parts=line.split(/\s{2,}/);if(parts.length<6)continue;
    const num=v=>{if(!v)return null;const n=parseFloat(v.replace('%','').replace('—','').trim());return isNaN(n)?null:n;};
    const lk=num(parts[9]);
    preds.push({pitcher:parts[0],team:parts[1],opponent:parts[2],
      pred_k:num(parts[3]),k_pct:num(parts[5]),whiff_pct:num(parts[6]),
      iz_contact_pct:num(parts[7]),chase_pct:num(parts[8]),
      lineup_iz:num(parts[11]),lineup_chase:num(parts[12]),lineup_bat_speed:num(parts[13]),
      lineup_vuln:lk!=null?(lk-22.5)/22.5:null,
      data_quality:parts[14]||null,exp_k_rate:num(parts[5])!=null?num(parts[5])*0.82:null});
  }
  return preds.filter(p=>p.pred_k!=null);
}

function parseHR(output){
  for(const line of output.split('\n')){
    if(line.startsWith('HRJSON:')){try{return JSON.parse(line.slice(7));}catch{return[];}}
  }
  return[];
}

async function saveGamePreds(preds,date){
  if(!preds.length)return 0;
  await run('DELETE FROM game_predictions WHERE game_date=?',[date]);
  for(const p of preds)
    await run(`INSERT INTO game_predictions (game_date,game_number,away_team,home_team,pick,confidence,home_prob,away_prob,proj_total,home_sp,away_sp,model_prob,vegas_implied,edge,same_side) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [date,p.game_number||1,p.away,p.home,p.pick,p.confidence,p.home_prob,p.away_prob,p.proj_total,p.home_sp||null,p.away_sp||null,p.model_prob??null,p.vegas_implied??null,p.edge??null,p.same_side!=null?(p.same_side?1:0):null]);
  return preds.length;
}

async function saveSO(preds,date){
  if(!preds.length)return 0;
  await run('DELETE FROM strikeout_predictions WHERE game_date=?',[date]);
  const s=db.prepare(`INSERT INTO strikeout_predictions (game_date,pitcher,team,opponent,pred_k,k_pct,whiff_pct,chase_pct,iz_contact_pct,lineup_iz,lineup_chase,lineup_bat_speed,lineup_vuln,exp_k_rate,data_quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const p of preds)s.run([date,p.pitcher,p.team,p.opponent,p.pred_k??null,p.k_pct??null,p.whiff_pct??null,p.chase_pct??null,p.iz_contact_pct??null,p.lineup_iz??null,p.lineup_chase??null,p.lineup_bat_speed??null,p.lineup_vuln??null,p.exp_k_rate??null,p.data_quality??null]);
  s.finalize();return preds.length;
}

async function saveHR(preds,date){
  if(!preds.length)return 0;
  await run('DELETE FROM homerun_predictions WHERE game_date=?',[date]);
  const s=db.prepare(`INSERT INTO homerun_predictions (game_date,batter,team,vs_pitcher,hr_prob_pa,hr_prob_game,park_factor,weather_factor,batting_order,home_team,opponent,temp_f,wind_mph,weather_cond) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const p of preds)s.run([date,p.batter||p.name,p.team,p.vs_pitcher||null,p.hr_prob_per_pa??p.hr_prob_pa??null,p.hr_prob_per_game??p.hr_prob_game??null,p.park_factor??null,p.weather_factor??null,p.batting_order??null,p.home_team||null,p.opponent||null,p.temp_f??null,p.wind_mph??null,p.weather_cond||null]);
  s.finalize();return preds.length;
}

async function restoreToday(backup){
  if(!backup.length)return;
  await run('DELETE FROM daily_lineups WHERE game_date=?',[TODAY]);
  const cols=Object.keys(backup[0]).filter(c=>c!=='id');
  const ph=cols.map(()=>'?').join(',');
  const s=db.prepare(`INSERT INTO daily_lineups (${cols.join(',')}) VALUES (${ph})`);
  for(const r of backup)s.run(cols.map(c=>r[c]));
  s.finalize();
  console.log(`  Restored ${backup.length} today (${TODAY}) rows to daily_lineups`);
}

async function processDate(date, dlBackup){
  console.log(`\n── ${date} ────────────────────────────────────`);

  console.log(`  [lineups] Scraping...`);
  try{ execSync(`node scrapeDailyLineups.js ${date}`,{stdio:'inherit'}); }
  catch(e){ console.error(`  scrapeDailyLineups failed: ${e.message}`); return; }

  console.log(`  [lineups] Importing → historical_lineups...`);
  try{ execSync(`node importDailyLineups.js --date ${date}`,{stdio:'inherit'}); }
  catch(e){ console.error(`  importDailyLineups failed: ${e.message}`); return; }

  await restoreToday(dlBackup);

  const rows = (await get1('SELECT COUNT(*) as n FROM historical_lineups WHERE game_date=?',[date])).n;
  if(!rows){ console.log(`  ⚠️  0 lineup rows — scrape returned no games, skipping preds`); return; }
  console.log(`  ✅ ${rows} lineup rows saved`);

  process.stdout.write(`  [games] `);
  try{
    const out=await spawnPy(['predictorv4.py','--predict','--date',date]);
    const p=parseGamePreds(out);
    if(p.length){ const n=await saveGamePreds(p,date); console.log(`✅ ${n} game predictions  [${p.map(x=>`${x.away}@${x.home} ${x.pick} ${x.confidence.toFixed(0)}%`).join(', ')}]`); }
    else{ console.log(`⚠️  0 predictions`); console.log(out.slice(-300)); }
  }catch(e){console.log(`❌ ${e.message.slice(0,120)}`);}

  process.stdout.write(`  [SO]    `);
  try{
    const out=await spawnPy(['strikeoutPredictorv2.py','--predict','--date',date]);
    const p=parseSO(out);
    if(p.length){const n=await saveSO(p,date);console.log(`✅ ${n} strikeout predictions`);}
    else{console.log(`⚠️  0 predictions`);}
  }catch(e){console.log(`❌ ${e.message.slice(0,120)}`);}

  process.stdout.write(`  [HR]    `);
  try{
    const out=await spawnPy(['hrPredictor.py','--predict','--date',date]);
    const p=parseHR(out);
    if(p.length){const n=await saveHR(p,date);console.log(`✅ ${n} HR predictions`);}
    else{console.log(`⚠️  0 predictions`);}
  }catch(e){console.log(`❌ ${e.message.slice(0,120)}`);}
}

async function main(){
  console.log('\n══════════════════════════════════════');
  console.log('  Backfilling May 20 & 21');
  console.log('══════════════════════════════════════');

  const dlBackup = await all('SELECT * FROM daily_lineups');
  console.log(`Backed up ${dlBackup.length} daily_lineups rows`);

  for(const date of DATES) await processDate(date, dlBackup);

  console.log('\n── Final counts ───────────────────────');
  for(const date of DATES){
    const lin=(await get1('SELECT COUNT(*) as n FROM historical_lineups WHERE game_date=?',[date])).n;
    const gp =(await get1('SELECT COUNT(*) as n FROM game_predictions WHERE game_date=?',[date])).n;
    const so =(await get1('SELECT COUNT(*) as n FROM strikeout_predictions WHERE game_date=?',[date])).n;
    const hr =(await get1('SELECT COUNT(*) as n FROM homerun_predictions WHERE game_date=?',[date])).n;
    const ok=lin>0&&gp>0&&so>0&&hr>0?'✅':'⚠️';
    console.log(`  ${date} | lin=${lin} gp=${gp} so=${so} hr=${hr} ${ok}`);
  }
  console.log('');
  db.close();
}
main().catch(e=>{console.error('Fatal:',e);db.close();process.exit(1);});
