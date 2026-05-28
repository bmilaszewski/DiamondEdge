// importTeamMomentum.js
// Calculates winning/losing streaks and momentum indicators

const db = require('./db');

async function importTeamMomentum() {
    console.log('📈 Computing team momentum and streaks...\n');

    // Create table
    await db.run(`
        CREATE TABLE IF NOT EXISTS team_momentum (
            team TEXT,
            game_date TEXT,
            season INTEGER,
            current_streak INTEGER,  -- positive for wins, negative for losses
            streak_type TEXT,  -- 'W' or 'L'
            last_5_wins INTEGER,
            last_10_wins INTEGER,
            last_5_run_diff REAL,
            last_10_run_diff REAL,
            monthly_win_pct REAL,  -- win% in current month
            vs_above_500_pct REAL,  -- win% vs teams above .500
            home_streak INTEGER,   -- streak in home games
            away_streak INTEGER,   -- streak in away games
            PRIMARY KEY (team, game_date)
        )
    `);

    console.log('✅ Table created/verified\n');

    // Get all teams and dates
    const teamDates = await db.all(`
        SELECT DISTINCT season, game_date, home_team as team
        FROM game_results
        WHERE season >= 2010
        ORDER BY team, game_date
    `);

    console.log(`Processing ${teamDates.length} team-date combinations...\n`);

    let processed = 0;

    for (const td of teamDates) {
        try {
            const { team, game_date, season } = td;

            // Get last 20 games
            const recentGames = await db.all(`
                SELECT game_date, home_team, away_team, 
                       home_score, away_score, home_won,
                       SUBSTR(game_date, 6, 2) as month
                FROM game_results
                WHERE game_date < ?
                  AND (home_team = ? OR away_team = ?)
                  AND season = ?
                ORDER BY game_date DESC
                LIMIT 20
            `, [game_date, team, team, season]);

            if (recentGames.length === 0) continue;

            // Calculate streaks
            let currentStreak = 0;
            let streakType = null;
            let homeStreak = 0;
            let awayStreak = 0;
            
            let last5Wins = 0;
            let last10Wins = 0;
            let last5RunDiff = 0;
            let last10RunDiff = 0;

            // Process games in chronological order for streaks
            const gamesChronological = [...recentGames].reverse();
            
            for (let i = 0; i < gamesChronological.length; i++) {
                const g = gamesChronological[i];
                const isHome = g.home_team === team;
                const won = isHome ? g.home_won === 1 : g.home_won === 0;
                const runsFor = isHome ? g.home_score : g.away_score;
                const runsAgainst = isHome ? g.away_score : g.home_score;
                const runDiff = runsFor - runsAgainst;

                // Last 5 stats
                if (i < 5) {
                    if (won) last5Wins++;
                    last5RunDiff += runDiff;
                }

                // Last 10 stats
                if (i < 10) {
                    if (won) last10Wins++;
                    last10RunDiff += runDiff;
                }

                // Current streak (calculated from most recent game)
                if (i === 0) {
                    currentStreak = won ? 1 : -1;
                    streakType = won ? 'W' : 'L';
                } else if (i < 10) {
                    const prevWon = streakType === 'W';
                    if (won === prevWon) {
                        currentStreak += won ? 1 : -1;
                    }
                }

                // Home/away streaks
                if (isHome && i === 0) {
                    homeStreak = won ? 1 : -1;
                } else if (!isHome && i === 0) {
                    awayStreak = won ? 1 : -1;
                }
            }

            // Monthly performance
            const currentMonth = game_date.substring(5, 7);
            const monthGames = await db.all(`
                SELECT home_team, away_team, home_won
                FROM game_results
                WHERE SUBSTR(game_date, 6, 2) = ?
                  AND game_date < ?
                  AND (home_team = ? OR away_team = ?)
                  AND season = ?
            `, [currentMonth, game_date, team, team, season]);

            let monthWins = 0;
            for (const g of monthGames) {
                const isHome = g.home_team === team;
                const won = isHome ? g.home_won === 1 : g.home_won === 0;
                if (won) monthWins++;
            }

            const monthlyWinPct = monthGames.length > 0 ? monthWins / monthGames.length : 0.500;

            // Performance vs teams above .500
            const vsGoodTeams = await db.all(`
                SELECT g.home_team, g.away_team, g.home_won,
                       t.win_pct as opp_win_pct
                FROM game_results g
                JOIN team_records t ON 
                    (CASE WHEN g.home_team = ? THEN g.away_team ELSE g.home_team END) = t.team
                    AND t.game_date < g.game_date
                    AND t.season = g.season
                WHERE g.game_date < ?
                  AND (g.home_team = ? OR g.away_team = ?)
                  AND g.season = ?
                  AND t.win_pct > 0.500
                ORDER BY g.game_date DESC
                LIMIT 20
            `, [team, game_date, team, team, season]);

            let vsGoodWins = 0;
            for (const g of vsGoodTeams) {
                const isHome = g.home_team === team;
                const won = isHome ? g.home_won === 1 : g.home_won === 0;
                if (won) vsGoodWins++;
            }

            const vsAbove500Pct = vsGoodTeams.length > 0 ? vsGoodWins / vsGoodTeams.length : 0.500;

            // Insert data
            await db.run(`
                INSERT OR REPLACE INTO team_momentum 
                (team, game_date, season, current_streak, streak_type,
                 last_5_wins, last_10_wins, last_5_run_diff, last_10_run_diff,
                 monthly_win_pct, vs_above_500_pct, home_streak, away_streak)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                team, game_date, season, currentStreak, streakType,
                last5Wins, last10Wins, last5RunDiff, last10RunDiff,
                monthlyWinPct, vsAbove500Pct, homeStreak, awayStreak
            ]);

            processed++;

            if (processed % 2000 === 0) {
                console.log(`  ... ${processed} team-dates processed`);
            }

        } catch (err) {
            console.error(`Error processing ${td.team} on ${td.game_date}:`, err.message);
        }
    }

    // Process away teams
    const awayTeamDates = await db.all(`
        SELECT DISTINCT season, game_date, away_team as team
        FROM game_results
        WHERE season >= 2010
        ORDER BY team, game_date
    `);

    for (const td of awayTeamDates) {
        try {
            const { team, game_date, season } = td;

            const recentGames = await db.all(`
                SELECT game_date, home_team, away_team, 
                       home_score, away_score, home_won
                FROM game_results
                WHERE game_date < ?
                  AND (home_team = ? OR away_team = ?)
                  AND season = ?
                ORDER BY game_date DESC
                LIMIT 20
            `, [game_date, team, team, season]);

            if (recentGames.length === 0) continue;

            let currentStreak = 0;
            let streakType = null;
            let last5Wins = 0;
            let last10Wins = 0;
            let last5RunDiff = 0;
            let last10RunDiff = 0;

            const gamesChronological = [...recentGames].reverse();
            
            for (let i = 0; i < gamesChronological.length; i++) {
                const g = gamesChronological[i];
                const isHome = g.home_team === team;
                const won = isHome ? g.home_won === 1 : g.home_won === 0;
                const runsFor = isHome ? g.home_score : g.away_score;
                const runsAgainst = isHome ? g.away_score : g.home_score;
                const runDiff = runsFor - runsAgainst;

                if (i < 5) {
                    if (won) last5Wins++;
                    last5RunDiff += runDiff;
                }

                if (i < 10) {
                    if (won) last10Wins++;
                    last10RunDiff += runDiff;
                }

                if (i === 0) {
                    currentStreak = won ? 1 : -1;
                    streakType = won ? 'W' : 'L';
                } else if (i < 10) {
                    const prevWon = streakType === 'W';
                    if (won === prevWon) {
                        currentStreak += won ? 1 : -1;
                    }
                }
            }

            await db.run(`
                INSERT OR IGNORE INTO team_momentum 
                (team, game_date, season, current_streak, streak_type,
                 last_5_wins, last_10_wins, last_5_run_diff, last_10_run_diff,
                 monthly_win_pct, vs_above_500_pct, home_streak, away_streak)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                team, game_date, season, currentStreak, streakType,
                last5Wins, last10Wins, last5RunDiff, last10RunDiff,
                0.500, 0.500, 0, 0
            ]);

            processed++;

            if (processed % 2000 === 0) {
                console.log(`  ... ${processed} team-dates processed`);
            }

        } catch (err) {
            // Silent - may already exist from home games
        }
    }

    console.log(`\n✅ Complete: ${processed} momentum records created`);
    console.log('\n🎉 Team momentum import complete!');
}

// Run if called directly
if (require.main === module) {
    importTeamMomentum()
        .then(() => process.exit(0))
        .catch(err => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
}

module.exports = importTeamMomentum;