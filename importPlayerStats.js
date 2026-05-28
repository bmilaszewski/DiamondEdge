const db = require("./db");

const SEASON = 2026;

async function getStats(mlbId) {
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=season&group=hitting&season=${SEASON}`
  );
  const data = await res.json();
  return data.stats[0]?.splits[0]?.stat;
}

async function importStats() {
  db.serialize(() => {
    db.all("SELECT * FROM players WHERE position != 'P'", async (err, players) => {
      if (err) throw err;

      for (const player of players) {
        const stats = await getStats(player.mlb_id);
        if (!stats) continue;

        db.run(
          `
          INSERT OR REPLACE INTO player_stats
          (mlb_id, name, team, position, season, games, avg, obp, slg, ops, hr, rbi)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            player.mlb_id,
            player.name,
            player.team,
            player.position,
            SEASON,
            stats.gamesPlayed,
            stats.avg,
            stats.obp,
            stats.slg,
            stats.ops,
            stats.homeRuns,
            stats.rbi,
          ]
        );

        console.log(`Imported hitter stats for ${player.name}`);
      }

      console.log("✅ Hitter stats import complete");
    });
  });
}

importStats();
