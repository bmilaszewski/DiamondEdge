const db = require("./db");

const SEASON = 2026;

async function getTeams() {
  const res = await fetch(
    "https://statsapi.mlb.com/api/v1/teams?sportId=1"
  );
  const data = await res.json();
  return data.teams;
}

async function getRoster(teamId, rosterType) {
  const res = await fetch(
    `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?season=${SEASON}&rosterType=${rosterType}`
  );
  const data = await res.json();
  return data.roster || [];
}

async function importRosters() {
  const teams = await getTeams();

  for (const team of teams) {
    console.log(`Importing ${team.name}`);

    // Get both rosters
    const roster40 = await getRoster(team.id, "40Man");
    const nonRoster = await getRoster(team.id, "nonRosterInvitees");

    // Combine them
    const fullRoster = [...roster40, ...nonRoster];

    for (const player of fullRoster) {
      db.run(
        `INSERT INTO players (mlb_id, name, team, position)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(mlb_id) DO UPDATE SET
           name     = excluded.name,
           team     = excluded.team,
           position = excluded.position`,
        [
          player.person.id,
          player.person.fullName,
          team.abbreviation,
          player.position?.abbreviation || null
        ]
      );
    }
  }

  console.log("✅ Spring Training rosters imported (40-man + NRI)");
}

importRosters();