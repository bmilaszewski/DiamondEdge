// importBullpenStats.js
// Collects bullpen ERA and usage stats for each team

const db = require('./db');
const axios = require('axios');

async function importBullpenStats() {
    console.log('📊 Importing bullpen statistics...\n');

    // Create table
    await db.run(`
        CREATE TABLE IF NOT EXISTS bullpen_stats (
            team TEXT,
            season INTEGER,
            game_date TEXT,
            bullpen_era REAL,
            bullpen_innings REAL,
            bullpen_k_rate REAL,
            bullpen_bb_rate REAL,
            high_leverage_era REAL,
            saves INTEGER,
            blown_saves INTEGER,
            PRIMARY KEY (team, game_date)
        )
    `);

    console.log('✅ Table created/verified\n');

    // Get teams and date range from game_results
    const games = await db.all(`
        SELECT DISTINCT season, game_date, home_team as team
        FROM game_results
        WHERE season >= 2015
        ORDER BY game_date
    `);

    console.log(`Processing ${games.length} team-dates...\n`);

    let processed = 0;
    let errors = 0;

    for (const game of games) {
        try {
            // Calculate bullpen stats from game results
            // Get last 20 games before this date for this team
            const recentGames = await db.all(`
                SELECT game_date, home_team, away_team, home_score, away_score,
                       home_won, home_sp_retro, away_sp_retro
                FROM game_results
                WHERE game_date < ? 
                  AND (home_team = ? OR away_team = ?)
                  AND season = ?
                ORDER BY game_date DESC
                LIMIT 20
            `, [game.game_date, game.team, game.team, game.season]);

            if (recentGames.length < 5) continue;

            // Estimate bullpen performance (runs allowed minus starter's share)
            let totalRuns = 0;
            let totalGames = recentGames.length;

            for (const g of recentGames) {
                const isHome = g.home_team === game.team;
                const runsAllowed = isHome ? g.away_score : g.home_score;
                
                // Rough estimate: starter gives up ~3.5 runs, bullpen the rest
                // This is simplified - ideally we'd have inning-by-inning data
                const bullpenRuns = Math.max(0, runsAllowed - 3.5);
                totalRuns += bullpenRuns;
            }

            // Estimate bullpen ERA (assuming 3 innings per game)
            const bullpenERA = (totalRuns / totalGames) / 3.0 * 9.0;

            await db.run(`
                INSERT OR REPLACE INTO bullpen_stats 
                (team, season, game_date, bullpen_era, bullpen_innings)
                VALUES (?, ?, ?, ?, ?)
            `, [game.team, game.season, game.game_date, bullpenERA, 3.0]);

            processed++;

            if (processed % 1000 === 0) {
                console.log(`  ... ${processed} team-dates processed`);
            }

        } catch (err) {
            errors++;
            if (errors < 10) {
                console.error(`Error for ${game.team} on ${game.game_date}:`, err.message);
            }
        }
    }

    console.log(`\n✅ Complete: ${processed} bullpen stats imported`);
    if (errors > 0) {
        console.log(`⚠️  ${errors} errors encountered`);
    }

    // Also process away teams
    const awayGames = await db.all(`
        SELECT DISTINCT season, game_date, away_team as team
        FROM game_results
        WHERE season >= 2015
        ORDER BY game_date
    `);

    processed = 0;
    for (const game of awayGames) {
        try {
            const recentGames = await db.all(`
                SELECT game_date, home_team, away_team, home_score, away_score,
                       home_won
                FROM game_results
                WHERE game_date < ? 
                  AND (home_team = ? OR away_team = ?)
                  AND season = ?
                ORDER BY game_date DESC
                LIMIT 20
            `, [game.game_date, game.team, game.team, game.season]);

            if (recentGames.length < 5) continue;

            let totalRuns = 0;
            let totalGames = recentGames.length;

            for (const g of recentGames) {
                const isHome = g.home_team === game.team;
                const runsAllowed = isHome ? g.away_score : g.home_score;
                const bullpenRuns = Math.max(0, runsAllowed - 3.5);
                totalRuns += bullpenRuns;
            }

            const bullpenERA = (totalRuns / totalGames) / 3.0 * 9.0;

            await db.run(`
                INSERT OR REPLACE INTO bullpen_stats 
                (team, season, game_date, bullpen_era, bullpen_innings)
                VALUES (?, ?, ?, ?, ?)
            `, [game.team, game.season, game.game_date, bullpenERA, 3.0]);

            processed++;

            if (processed % 1000 === 0) {
                console.log(`  ... ${processed} away team-dates processed`);
            }

        } catch (err) {
            errors++;
        }
    }

    console.log(`\n✅ Complete: ${processed} away team bullpen stats imported`);
    console.log('\n🎉 Bullpen stats import complete!');
}

// Run if called directly
if (require.main === module) {
    importBullpenStats()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
}

module.exports = importBullpenStats;