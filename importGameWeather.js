/**
 * importGameWeather.js
 *
 * Reads all Retrosheet game log files (GL####.TXT) from a folder,
 * cross-references park_coordinates.json for lat/lng, then fetches
 * historical hourly weather from Open-Meteo's free archive API.
 *
 * BATCHING STRATEGY — efficient, not naive:
 *   Instead of one API call per game (tens of thousands),
 *   we group by (park_id, year) and make ONE call per park per season.
 *   That covers every game at that park that year in a single request.
 *   Typical total: ~30 parks × number of seasons = a few hundred calls.
 *
 * FIRST PITCH HOUR:
 *   Day game  (D) → 13:00 local time
 *   Night game (N) → 19:00 local time
 *   (close enough for weather purposes — temp/wind don't shift much
 *    within a ±2hr window around actual first pitch)
 *
 * OUTPUT:
 *   Writes to game_weather table in mlb.db
 *
 * USAGE:
 *   node importGameWeather.js --logs ./gamelogs --coords ./park_coordinates.json --db ./mlb.db
 *
 * OPTIONS:
 *   --logs    Path to folder containing GL####.TXT files  (default: ./gamelogs)
 *   --coords  Path to park_coordinates.json               (default: ./park_coordinates.json)
 *   --db      Path to mlb.db                              (default: ./mlb.db)
 *   --resume  Skip park+year combos already in DB         (default: true)
 */

const fs      = require("fs");
const path    = require("path");
const sqlite3 = require("sqlite3").verbose();

// ---------------------
// CLI Args
// ---------------------

const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith("--")) args[arg.slice(2)] = arr[i + 1];
});

const LOGS_DIR    = path.resolve(args.logs   || "./gamelogs");
const COORDS_PATH = path.resolve(args.coords || "./park_coordinates.json");
const DB_PATH     = path.resolve(args.db     || "./mlb.db");
const RESUME      = args.resume !== "false";

const RATE_LIMIT_MS = 700;   // base delay between requests
const RETRY_WAIT_MS = 65000; // wait 65s on a 429 before retrying
const MAX_RETRIES   = 5;     // give up after this many 429s in a row

// ---------------------
// WMO Weather Code → human readable
// ---------------------

const WMO_CODES = {
  0:  "Clear",
  1:  "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Light showers", 81: "Showers", 82: "Heavy showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ heavy hail",
};

function weatherLabel(code) {
  return WMO_CODES[code] || `Code ${code}`;
}

// Celsius → Fahrenheit
function toF(c) {
  return c === null || c === undefined ? null : parseFloat(((c * 9) / 5 + 32).toFixed(1));
}

// m/s → mph
function toMph(ms) {
  return ms === null || ms === undefined ? null : parseFloat((ms * 2.23694).toFixed(1));
}

// ---------------------
// DB helpers
// ---------------------

function dbRun(db, sql, params = []) {
  return new Promise((res, rej) => {
    db.run(sql, params, function (err) { err ? rej(err) : res(this); });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((res, rej) => {
    db.all(sql, params, (err, rows) => { err ? rej(err) : res(rows); });
  });
}

// ---------------------
// Create game_weather table
// ---------------------

async function createTable(db) {
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS game_weather (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      park_id           TEXT NOT NULL,
      park_name         TEXT,
      game_date         TEXT NOT NULL,   -- YYYYMMDD from game log
      day_night         TEXT,            -- D or N
      hour_sampled      INTEGER,         -- 13 for day, 19 for night

      temperature_f     REAL,
      precipitation_mm  REAL,
      wind_speed_mph    REAL,
      wind_direction    INTEGER,         -- degrees 0-360
      weather_code      INTEGER,         -- WMO code
      weather_condition TEXT,            -- human readable

      lat               REAL,
      lng               REAL,

      UNIQUE (park_id, game_date)
    )
  `);
}

// ---------------------
// Parse game log files
// ---------------------

// Retrosheet game log field indices (0-based):
//   0  = date (YYYYMMDD)
//   1  = game number
//   2  = day of week
//   3  = visiting team
//   6  = home team
//  12  = day/night (D or N)
//  16  = park ID

function parseGameLogs(logsDir) {
  if (!fs.existsSync(logsDir)) {
    console.error(`❌ Logs directory not found: ${logsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(logsDir)
    .filter((f) => /^GL\d{4}\.TXT$/i.test(f))
    .sort();

  if (!files.length) {
    console.error(`❌ No GL####.TXT files found in ${logsDir}`);
    process.exit(1);
  }

  console.log(`📂 Found ${files.length} game log files\n`);

  // Map of "PARKID|YYYY" → array of { date, dayNight }
  const byParkYear = {};

  let totalGames = 0;

  for (const file of files) {
    const filePath = path.join(logsDir, file);
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse CSV — quotes can appear around fields
      const fields = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) { fields.push(cur); cur = ""; }
        else cur += ch;
      }
      fields.push(cur);

      const date     = fields[0]?.trim();   // YYYYMMDD
      const dayNight = fields[12]?.trim();  // D or N
      const parkId   = fields[16]?.trim();  // e.g. BOS07

      if (!date || !parkId || date.length !== 8) continue;

      const year = date.substring(0, 4);
      if (parseInt(year, 10) < 1940) continue;
      const key  = `${parkId}|${year}`;

      if (!byParkYear[key]) byParkYear[key] = [];
      byParkYear[key].push({ date, dayNight: dayNight || "N" });
      totalGames++;
    }
  }

  console.log(`📊 Parsed ${totalGames} games across ${Object.keys(byParkYear).length} park-year combos\n`);
  return byParkYear;
}

// ---------------------
// Open-Meteo fetch for one park + year
// ---------------------

async function fetchWeatherForParkYear(parkId, year, lat, lng) {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lng}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&hourly=temperature_2m,precipitation,windspeed_10m,winddirection_10m,weathercode` +
    `&timezone=auto` +
    `&temperature_unit=celsius`;

  // Retry loop — backs off 65s on every 429
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url);

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`HTTP 429: rate limit hit ${MAX_RETRIES} times, giving up`);
      }
      const waitSec = Math.round(RETRY_WAIT_MS / 1000);
      process.stdout.write(`
      waiting ${waitSec}s (rate limited, attempt ${attempt}/${MAX_RETRIES})... `);
      await sleep(RETRY_WAIT_MS);
      process.stdout.write(`retrying -> `);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.substring(0, 120)}`);
    }

    const data = await res.json();

    if (!data.hourly?.time?.length) {
      throw new Error("No hourly data in response");
    }

    const hourlyMap = {};
    const times = data.hourly.time;

    for (let i = 0; i < times.length; i++) {
      const [datePart, timePart] = times[i].split("T");
      const hour = parseInt(timePart.split(":")[0], 10);
      const key  = `${datePart}|${hour}`;

      hourlyMap[key] = {
        temp_c:       data.hourly.temperature_2m[i],
        precip_mm:    data.hourly.precipitation[i],
        wind_ms:      data.hourly.windspeed_10m[i],
        wind_dir:     data.hourly.winddirection_10m[i],
        weather_code: data.hourly.weathercode[i],
      };
    }

    return hourlyMap;
  }
}


// ---------------------
// Format YYYYMMDD → YYYY-MM-DD
// ---------------------

function formatDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// ---------------------
// Sleep
// ---------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------
// Main
// ---------------------

async function run() {
  // Validate inputs
  if (!fs.existsSync(COORDS_PATH)) {
    console.error(`❌ park_coordinates.json not found at: ${COORDS_PATH}`);
    console.error(`   Run geocodeParks.js first.`);
    process.exit(1);
  }

  const coords = JSON.parse(fs.readFileSync(COORDS_PATH, "utf8"));
  console.log(`📍 Loaded coordinates for ${Object.keys(coords).length} parks`);

  // Parse game logs
  const byParkYear = parseGameLogs(LOGS_DIR);
  const parkYearKeys = Object.keys(byParkYear).sort();

  // Open DB
  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) { console.error("❌ Cannot open DB:", err); process.exit(1); }
    console.log(`💾 Connected to ${DB_PATH}\n`);
  });

  await createTable(db);

  // Find already-completed park+year combos if resuming
  let doneSet = new Set();
  if (RESUME) {
    const done = await dbAll(db, `
      SELECT DISTINCT park_id, substr(game_date, 1, 4) AS year
      FROM game_weather
    `);
    done.forEach((r) => doneSet.add(`${r.park_id}|${r.year}`));
    if (doneSet.size) {
      console.log(`⏭️  Resuming — skipping ${doneSet.size} already-completed park-year combos\n`);
    }
  }

  let inserted = 0, skipped = 0, failed = 0;
  const total = parkYearKeys.length;

  for (let i = 0; i < parkYearKeys.length; i++) {
    const key      = parkYearKeys[i];
    const [parkId, year] = key.split("|");
    const games    = byParkYear[key];
    const parkInfo = coords[parkId];

    process.stdout.write(
      `[${String(i + 1).padStart(4)}/${total}] ${parkId} ${year}  (${games.length} games)  → `
    );

    // Skip if already done
    if (RESUME && doneSet.has(key)) {
      console.log("skipped (already imported)");
      skipped++;
      continue;
    }

    // Skip if no coordinates
    if (!parkInfo || parkInfo.lat === null) {
      console.log("⚠️  no coordinates — skipping");
      failed++;
      continue;
    }

    try {
      await sleep(RATE_LIMIT_MS);

      const hourlyMap = await fetchWeatherForParkYear(
        parkId, year, parkInfo.lat, parkInfo.lng
      );

      // Insert a row for each game this park hosted this year
      await dbRun(db, "BEGIN TRANSACTION");

      for (const game of games) {
        const isoDate  = formatDate(game.date);                        // YYYY-MM-DD
        const hour     = game.dayNight === "D" ? 13 : 19;             // first pitch approx
        const wxKey    = `${isoDate}|${hour}`;
        const wx       = hourlyMap[wxKey] || null;

        await dbRun(db, `
          INSERT OR REPLACE INTO game_weather
            (park_id, park_name, game_date, day_night, hour_sampled,
             temperature_f, precipitation_mm, wind_speed_mph, wind_direction,
             weather_code, weather_condition, lat, lng)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          parkId,
          parkInfo.name || null,
          game.date,                                  // keep original YYYYMMDD
          game.dayNight,
          hour,
          wx ? toF(wx.temp_c)    : null,
          wx ? wx.precip_mm      : null,
          wx ? toMph(wx.wind_ms) : null,
          wx ? wx.wind_dir       : null,
          wx ? wx.weather_code   : null,
          wx ? weatherLabel(wx.weather_code) : null,
          parkInfo.lat,
          parkInfo.lng,
        ]);

        inserted++;
      }

      await dbRun(db, "COMMIT");
      console.log(`✔  inserted ${games.length} rows`);

    } catch (err) {
      await dbRun(db, "ROLLBACK").catch(() => {});
      console.log(`❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`
╔══════════════════════════════════════╗
║         Weather Import Complete      ║
╠══════════════════════════════════════╣
║  Games inserted : ${String(inserted).padEnd(18)} ║
║  Park-yrs skipped: ${String(skipped).padEnd(17)} ║
║  Park-yrs failed : ${String(failed).padEnd(17)} ║
╚══════════════════════════════════════╝
  `);

  db.close();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});