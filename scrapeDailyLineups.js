const axios = require("axios");
const { createObjectCsvWriter } = require("csv-writer");
const path = require("path");

const OUTPUT_FILE = path.join(__dirname, "dailyLineups.csv");

// -----------------------------
// Local Date
// -----------------------------
function getLocalDate() {
  const dateArg = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
    || (() => { const i = process.argv.indexOf('--date'); return i !== -1 ? process.argv[i+1] : null; })();
  if (dateArg) return dateArg;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// -----------------------------
// Handedness Cache
// -----------------------------
const handednessCache = {};

async function getHandedness(playerId) {
  if (!playerId) return { bat: "", pitch: "" };

  if (handednessCache[playerId]) {
    return handednessCache[playerId];
  }

  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${playerId}`;
    const res = await axios.get(url);

    const person = res.data.people?.[0];

    if (!person) {
      return { bat: "", pitch: "" };
    }

    const result = {
      bat: person.batSide?.code || "",
      pitch: person.pitchHand?.code || ""
    };

    handednessCache[playerId] = result;
    return result;

  } catch (err) {
    return { bat: "", pitch: "" };
  }
}

// -----------------------------
// Schedule
// -----------------------------
async function getSchedule(date) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
  const res = await axios.get(url);
  return res.data.dates?.[0]?.games || [];
}

// -----------------------------
// Live Feed
// -----------------------------
async function getGameFeed(gamePk) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
  const res = await axios.get(url);
  return res.data;
}

// -----------------------------
// Extract Hitters
// -----------------------------
async function processHitters(teamData, teamAbbr, opponentAbbr, date, rows, isHome = false) {
  const players = teamData.players || {};

  const starters = Object.values(players)
    .filter(p =>
      p.battingOrder &&
      !p.gameStatus?.isSubstitute
    )
    .sort((a, b) => parseInt(a.battingOrder) - parseInt(b.battingOrder));

  if (!starters.length) return;

  const hitters = starters.slice(0, 9);

  for (let i = 0; i < hitters.length; i++) {
    const player = hitters[i];
    const handed = await getHandedness(player.person.id);

    rows.push({
      game_date: date,
      team: teamAbbr,
      opponent: opponentAbbr,
      batting_order: i + 1,
      name: player.person.fullName,
      position: player.position?.abbreviation || "",
      handedness: handed.bat,
      is_home: isHome ? 1 : 0
    });
  }
}

// -----------------------------
// Extract Starting Pitcher from Boxscore
// Fallback when probablePitchers is not set
// -----------------------------
function getBoxscoreStarter(teamData) {
  const players = teamData.players || {};
  const pitcherIds = teamData.pitchers || [];

  for (const id of pitcherIds) {
    const player = players[`ID${id}`];
    if (!player) continue;

    const pitching = player.stats?.pitching;

    // Starter = gamesStarted is 1, or first pitcher listed if no gamesStarted field
    if (pitching?.gamesStarted === 1 || pitcherIds[0] === id) {
      return {
        id:       player.person?.id,
        fullName: player.person?.fullName,
      };
    }
  }

  return null;
}

// -----------------------------
// Resolve Starting Pitcher
// Tries probablePitchers first, falls back to boxscore starter
// -----------------------------
async function resolveStartingPitcher(probable, teamData, teamAbbr, opponentAbbr, date, rows, isHome = false) {
  let pitcher = probable || getBoxscoreStarter(teamData);

  if (!pitcher) {
    console.log(`  ⚠️  No SP found for ${teamAbbr}`);
    return;
  }

  const handed = await getHandedness(pitcher.id);

  rows.push({
    game_date:     date,
    team:          teamAbbr,
    opponent:      opponentAbbr,
    batting_order: 0,
    name:          pitcher.fullName,
    position:      "SP",
    handedness:    handed.pitch,
    source:        probable ? "probable" : "boxscore",
    is_home:       isHome ? 1 : 0,
  });
}

// -----------------------------
// Fetch Lineups
// -----------------------------
async function fetchLineups(date) {
  console.log(`📥 Fetching MLB lineups for ${date}`);

  const games = await getSchedule(date);
  const rows = [];

  if (!games.length) {
    console.log("⚠️ No games found for this date.");
    return rows;
  }

  for (const game of games) {
    try {
      const feed = await getGameFeed(game.gamePk);

      const awayTeam = feed.gameData.teams.away.abbreviation;
      const homeTeam = feed.gameData.teams.home.abbreviation;

      const awayBoxscore = feed.liveData.boxscore.teams.away;
      const homeBoxscore = feed.liveData.boxscore.teams.home;

      // 🔹 Hitters from boxscore
      await processHitters(awayBoxscore, awayTeam, homeTeam, date, rows, false);
      await processHitters(homeBoxscore, homeTeam, awayTeam, date, rows, true);

      // 🔹 Starting Pitchers — probablePitchers first, boxscore fallback
      const awayProbable = feed.gameData.probablePitchers?.away || null;
      const homeProbable = feed.gameData.probablePitchers?.home || null;

      await resolveStartingPitcher(awayProbable, awayBoxscore, awayTeam, homeTeam, date, rows, false);
      await resolveStartingPitcher(homeProbable, homeBoxscore, homeTeam, awayTeam, date, rows, true);

    } catch (err) {
      console.log(`⚠️ Could not process game ${game.gamePk}: ${err.message}`);
    }
  }

  return rows;
}

// -----------------------------
// Save CSV
// -----------------------------
async function saveCSV(rows) {
  if (!rows.length) {
    console.log("⚠️ No lineups available.");
    return;
  }

  const csvWriter = createObjectCsvWriter({
    path: OUTPUT_FILE,
    header: [
      { id: "game_date",     title: "game_date" },
      { id: "team",          title: "team" },
      { id: "opponent",      title: "opponent" },
      { id: "batting_order", title: "batting_order" },
      { id: "name",          title: "name" },
      { id: "handedness",    title: "handedness" },
      { id: "position",      title: "position" },
      { id: "source",        title: "source" },
      { id: "is_home",       title: "is_home" },
    ],
  });

  await csvWriter.writeRecords(rows);
  console.log(`✅ Saved ${rows.length} lineup rows to dailyLineups.csv`);
}

// -----------------------------
// MAIN
// -----------------------------
async function main() {
  try {
    const date = getLocalDate();
    const rows = await fetchLineups(date);
    // 🔥 Group and sort by team
    const grouped = {};

    for (const row of rows) {
      if (!grouped[row.team]) {
        grouped[row.team] = [];
      }
      grouped[row.team].push(row);
    }

    const sortedRows = [];

    for (const team of Object.keys(grouped)) {
      grouped[team]
        .sort((a, b) => {
          // push 0 (pitcher) to end
          if (a.batting_order === 0) return 1;
          if (b.batting_order === 0) return -1;
          return a.batting_order - b.batting_order;
        })
        .forEach(r => sortedRows.push(r));
    }

    await saveCSV(sortedRows);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

main();