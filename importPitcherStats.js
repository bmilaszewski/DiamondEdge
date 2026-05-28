const db = require("./db");

const SEASON = 2026;

async function getPitchingStats(mlbId) {
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=season&group=pitching&season=${SEASON}`
  );
  const data = await res.json();
  return data.stats[0]?.splits[0]?.stat;
}

async function importPitchingStats() {
  db.serialize(() => {
    db.all("SELECT * FROM players WHERE position = 'P'", async (err, pitchers) => {
      if (err) throw err;

      for (const pitcher of pitchers) {
        const stats = await getPitchingStats(pitcher.mlb_id);
        if (!stats) continue;

        db.run(
          `
          INSERT OR REPLACE INTO pitcher_stats
          (mlb_id, name, team, position, season, games, games_started, innings_pitched,
           wins, losses, era, whip, strikeouts, walks, home_runs)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            pitcher.mlb_id,
            pitcher.name,
            pitcher.team,
            pitcher.position,
            SEASON,
            stats.gamesPitched,
            stats.gamesStarted,
            parseFloat(stats.inningsPitched),
            stats.wins,
            stats.losses,
            stats.era,
            stats.whip,
            stats.strikeOuts,
            stats.baseOnBalls,
            stats.homeRuns,
          ]
        );

        console.log(`Imported pitcher stats for ${pitcher.name}`);
      }

      console.log("✅ Pitcher stats import complete");
    });
  });
}

importPitchingStats();
