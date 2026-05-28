const { spawn } = require('child_process');

function run(script) {
  return new Promise((resolve, reject) => {
    console.log(`  ▶ ${script}`);
    const proc = spawn('node', [script], { stdio: 'inherit' });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) { console.log(`  ✓ ${script}`); resolve(); }
      else reject(new Error(`${script} exited ${code}`));
    });
  });
}

function runGroup(scripts, label) {
  console.log(`\n━━ ${label} ━━`);
  return Promise.all(scripts.map(run));
}

(async () => {
  const t0 = Date.now();

  // Group 1: fetch rosters + scrape lineups CSV in parallel (no DB dependency on each other)
  await runGroup(['importMlbRosters.js', 'scrapeDailyLineups.js'], 'Rosters + Lineup scrape');

  // Group 2: import lineups into DB (depends on players table + CSV from group 1)
  await runGroup(['importDailyLineups.js'], 'Import daily lineups');

  // Group 3: all remaining enrichment — all read players/daily_lineups, write to independent tables
  await runGroup([
    'importHitterRecentStats.js',
    'importHitterVsPitcher.js',
    'importPitcherRecentStats.js',
    'importPitcherStats.js',
    'importPlayerStats.js',
    'importRecentStats.js',
    'importPitcherPitchType.js',
    'importHitterVsPitchType.js',
    'importSavantPitcherStats.js',
    'importSavantHitterStats.js',
  ], 'Enrichment (parallel)');

  console.log(`\n✅ All done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(err => { console.error('\n✗', err.message); process.exit(1); });
