const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./mlb.db", (err) => {
  if (err) {
    console.error("Error opening database", err);
  } else {
    console.log("Connected to SQLite database");
  }
});

// WAL mode lets multiple readers (and one writer) work concurrently.
// busyTimeout makes writers wait up to 8s instead of failing immediately.
db.configure("busyTimeout", 8000);
db.run("PRAGMA journal_mode=WAL");

// Serialize guarantees order of table creation
db.serialize(() => {
  /* -------------------- CORE TABLES -------------------- */

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER UNIQUE,
      name TEXT,
      team TEXT,
      position TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS player_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER,
      name TEXT,
      team TEXT,
      position TEXT,
      season INTEGER,
      games INTEGER,
      avg REAL,
      obp REAL,
      slg REAL,
      ops REAL,
      hr INTEGER,
      rbi INTEGER,
      UNIQUE (mlb_id, season)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pitcher_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER,
      name TEXT,
      team TEXT,
      position TEXT,
      season INTEGER,
      games INTEGER,
      games_started INTEGER,
      innings_pitched REAL,
      wins INTEGER,
      losses INTEGER,
      era REAL,
      whip REAL,
      strikeouts INTEGER,
      walks INTEGER,
      home_runs INTEGER,
      UNIQUE (mlb_id, season)
    )
  `);

  /* -------------------- RECENT HITTER STATS -------------------- */
  // Last 5 / 10 / 20 games (derived from MLB game logs)

  db.run(`
    CREATE TABLE IF NOT EXISTS hitter_recent_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER NOT NULL,
      name TEXT,
      team TEXT,
      position TEXT,
      season INTEGER NOT NULL,
      window INTEGER NOT NULL,
      games INTEGER,
      at_bats INTEGER,
      hits INTEGER,
      walks INTEGER,
      strikeouts INTEGER,
      home_runs INTEGER,
      avg REAL,
      obp REAL,
      slg REAL,
      ops REAL,
      iso REAL,
      groundout_airout REAL,
      UNIQUE (mlb_id, season, window)
    )
  `);

  /* -------------------- RECENT PITCHER STATS -------------------- */

  db.run(`
    CREATE TABLE IF NOT EXISTS pitcher_recent_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER NOT NULL,
      name TEXT,
      team TEXT,
      position TEXT,
      season INTEGER NOT NULL,
      window INTEGER NOT NULL,
      games INTEGER,
      games_started INTEGER,
      innings_pitched REAL,
      wins INTEGER,
      losses INTEGER,
      era REAL,
      whip REAL,
      strikeouts INTEGER,
      walks INTEGER,
      home_runs INTEGER,
      UNIQUE (mlb_id, season, window)
    )
  `);

  /* -------------------- DAILY LINEUPS -------------------- */
  // Includes opponent team + opposing SP for matchup lookups

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      team TEXT NOT NULL,
      opponent TEXT,
      position TEXT,
      batting_order INTEGER NOT NULL,
      handedness TEXT,
      game_date TEXT NOT NULL,
      season INTEGER NOT NULL,

      -- Opposing starting pitcher (populated after all rows are inserted)
      pitcher_mlb_id INTEGER,
      pitcher_name TEXT,
      pitcher_handedness TEXT,

      -- Season stats at time of lineup
      games INTEGER,
      at_bats INTEGER,
      runs INTEGER,
      hits INTEGER,
      doubles INTEGER,
      triples INTEGER,
      home_runs INTEGER,
      rbi INTEGER,
      walks INTEGER,
      strikeouts INTEGER,
      stolen_bases INTEGER,

      avg REAL,
      obp REAL,
      slg REAL,
      ops REAL,
      iso REAL,

      is_home INTEGER DEFAULT NULL,

      UNIQUE (mlb_id, game_date)
    )
  `);

  /* -------------------- HITTER VS PITCHER -------------------- */
  // Career head-to-head stats for each hitter vs their day's opposing SP

  db.run(`
    CREATE TABLE IF NOT EXISTS hitter_vs_pitcher (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hitter_mlb_id INTEGER NOT NULL,
      hitter_name TEXT NOT NULL,
      hitter_team TEXT NOT NULL,
      pitcher_mlb_id INTEGER NOT NULL,
      pitcher_name TEXT NOT NULL,
      pitcher_team TEXT NOT NULL,
      game_date TEXT NOT NULL,
      season INTEGER NOT NULL,

      -- Career head-to-head totals (all time, not just current season)
      at_bats INTEGER,
      hits INTEGER,
      doubles INTEGER,
      triples INTEGER,
      home_runs INTEGER,
      rbi INTEGER,
      walks INTEGER,
      strikeouts INTEGER,
      total_bases INTEGER,

      avg REAL,
      obp REAL,
      slg REAL,
      ops REAL,

      UNIQUE (hitter_mlb_id, pitcher_mlb_id, game_date)
    )
  `);

  /* -------------------- PITCHER PITCH TYPE -------------------- */
  // Pitch mix for each Pitcher — one row per pitcher per pitch type
 
  db.run(`
    CREATE TABLE IF NOT EXISTS pitcher_pitch_type (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id           INTEGER NOT NULL,
      name             TEXT,
      year             INTEGER NOT NULL,
      pitch_type       TEXT NOT NULL,   -- FF, SL, CH, CU, SI, FC, ST, FS
      pitch_name       TEXT,
 
      pitches          INTEGER,         -- total pitches thrown
      pa               INTEGER,         -- plate appearances
      ba               REAL,            -- batting average against
      slg              REAL,            -- slugging against
      woba             REAL,            -- wOBA against
      xwoba            REAL,            -- expected wOBA against
      whiff_percent    REAL,            -- swing and miss %
      put_away_percent REAL,            -- out% with 2 strikes
      run_value        REAL,            -- run value (per pitch, negative = good for pitcher)
 
      avg_speed        REAL,            -- average velocity (mph)
      avg_spin         INTEGER,         -- average spin rate (rpm)
 
      UNIQUE (mlb_id, year, pitch_type)
    )
  `);

  /* -------------------- SAVANT PITCHER STATS -------------------- */
  // Historical + current season Statcast/Savant data per pitcher per year
  // Source: Baseball Savant custom leaderboard CSV (2015-present)
 
  db.run(`
    CREATE TABLE IF NOT EXISTS savant_pitcher_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER NOT NULL,
      name TEXT,
      season INTEGER NOT NULL,
      player_age INTEGER,
      pitch_hand TEXT,
 
      -- Traditional
      games INTEGER,
      innings_pitched TEXT,
      pa INTEGER,
      strikeouts INTEGER,
      walks INTEGER,
      k_percent REAL,
      bb_percent REAL,
      era REAL,
      batting_avg_against REAL,
      home_run INTEGER,
      babip REAL,
      quality_start INTEGER,
 
      -- Expected stats (Statcast)
      xba REAL,
      xslg REAL,
      woba REAL,
      xwoba REAL,
      xobp REAL,
      xiso REAL,
      wobacon REAL,
      xwobacon REAL,
      xbadiff REAL,
      xslgdiff REAL,
      wobadiff REAL,
 
      -- Batted ball
      exit_velocity_avg REAL,
      launch_angle_avg REAL,
      sweet_spot_percent REAL,
      barrel INTEGER,
      barrel_batted_rate REAL,
      hard_hit_percent REAL,
      groundballs_percent REAL,
      flyballs_percent REAL,
      linedrives_percent REAL,
      popups_percent REAL,
 
      -- Plate discipline
      whiff_percent REAL,
      swing_percent REAL,
      z_swing_percent REAL,
      z_swing_miss_percent REAL,
      oz_swing_percent REAL,
      oz_swing_miss_percent REAL,
      iz_contact_percent REAL,
      f_strike_percent REAL,
      meatball_percent REAL,
      meatball_swing_percent REAL,
 
      -- Pitch counts by type
      pitch_count INTEGER,
      pitch_count_fastball INTEGER,
      pitch_count_breaking INTEGER,
      pitch_count_offspeed INTEGER,
 
      -- Fastball (FF)
      ff_count TEXT,
      ff_avg_speed REAL,
      ff_avg_spin INTEGER,
      ff_avg_break_x REAL,
      ff_avg_break_z REAL,
      ff_avg_break_z_induced REAL,
 
      -- Slider (SL)
      sl_count TEXT,
      sl_avg_speed REAL,
      sl_avg_spin INTEGER,
      sl_avg_break_x REAL,
      sl_avg_break_z REAL,
      sl_avg_break_z_induced REAL,
 
      -- Changeup (CH)
      ch_count TEXT,
      ch_avg_speed REAL,
      ch_avg_spin INTEGER,
      ch_avg_break_x REAL,
      ch_avg_break_z REAL,
      ch_avg_break_z_induced REAL,
 
      -- Curveball (CU)
      cu_count TEXT,
      cu_avg_speed REAL,
      cu_avg_spin INTEGER,
      cu_avg_break_x REAL,
      cu_avg_break_z REAL,
      cu_avg_break_z_induced REAL,
 
      -- Sinker (SI)
      si_count TEXT,
      si_avg_speed REAL,
      si_avg_spin INTEGER,
      si_avg_break_x REAL,
      si_avg_break_z REAL,
      si_avg_break_z_induced REAL,
 
      -- Cutter (FC)
      fc_count TEXT,
      fc_avg_speed REAL,
      fc_avg_spin INTEGER,
      fc_avg_break_x REAL,
      fc_avg_break_z REAL,
      fc_avg_break_z_induced REAL,
 
      -- Sweeper (ST)
      st_count TEXT,
      st_avg_speed REAL,
      st_avg_spin INTEGER,
      st_avg_break_x REAL,
      st_avg_break_z REAL,
      st_avg_break_z_induced REAL,
 
      -- Splitter (FS)
      fs_count TEXT,
      fs_avg_speed REAL,
      fs_avg_spin INTEGER,
      fs_avg_break_x REAL,
      fs_avg_break_z REAL,
      fs_avg_break_z_induced REAL,
 
      -- Pitch group aggregates
      fastball_avg_speed REAL,
      fastball_avg_spin INTEGER,
      breaking_avg_speed REAL,
      breaking_avg_spin INTEGER,
      offspeed_avg_speed REAL,
      offspeed_avg_spin INTEGER,
 
      UNIQUE (mlb_id, season)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS hitter_vs_pitch_type (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id           INTEGER NOT NULL,
      name             TEXT,
      year             INTEGER NOT NULL,
      pitch_type       TEXT NOT NULL,   -- FF, SL, CH, CU, SI, FC, ST, FS
      pitch_name       TEXT,            -- Four-Seam Fastball, Slider, etc.
 
      pitches          INTEGER,         -- total pitches seen
      pa               INTEGER,         -- plate appearances
      ba               REAL,            -- batting average
      slg              REAL,            -- slugging
      woba             REAL,            -- wOBA
      xwoba            REAL,            -- expected wOBA
      whiff_percent    REAL,            -- swing and miss %
      put_away_percent REAL,            -- out% with 2 strikes
      run_value        REAL,            -- run value (per pitch)
 
      UNIQUE (mlb_id, year, pitch_type)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS historical_lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mlb_id INTEGER,
      name TEXT,
      team TEXT,
      opponent TEXT,
      position TEXT,
      batting_order INTEGER,
      handedness TEXT,
      game_date TEXT,
      season INTEGER,
      pitcher_mlb_id INTEGER,
      pitcher_name TEXT,
      pitcher_handedness TEXT,
      games INTEGER,
      at_bats INTEGER,
      runs INTEGER,
      hits INTEGER,
      doubles INTEGER,
      triples INTEGER,
      home_runs INTEGER,
      rbi INTEGER,
      walks INTEGER,
      strikeouts INTEGER,
      stolen_bases INTEGER,
      avg REAL,
      obp REAL,
      slg REAL,
      ops REAL,
      iso REAL
    );
  `);

  // Add is_home column to existing DBs that don't have it yet (safe no-op if already exists)
  db.run(`ALTER TABLE daily_lineups ADD COLUMN is_home INTEGER DEFAULT NULL`, () => {});

  console.log("All tables ready.");
});

module.exports = db;
