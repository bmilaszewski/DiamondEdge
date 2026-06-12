"""
mlb_predictor.py

MLB Game Outcome Prediction Model
==================================
Predicts probability of home team winning using gradient boosted trees.

ARCHITECTURE:
  1. build_training_data()   - reads Retrosheet game logs + DB stats ? feature matrix
  2. train_model()           - trains GBM, evaluates with time-series CV
  3. predict_today()         - scores today's daily_lineups matchups
  4. save/load model         - persists trained model to disk

FEATURE GROUPS (35 features per team x 2 teams = 70 total + 5 game context):
  A. Starting pitcher quality   (ERA, xwOBA, K%, BB%, whiff%, hard-hit%)
  B. Lineup offensive strength  (weighted OPS by order, team OPS, ISO)
  C. Recent form               (L5/L10/L20 OPS delta vs season)
  D. Pitcher vs pitch type      (best/worst pitch run value, whiff%)
  E. Hitter vs pitch type       (team wOBA vs SP's primary pitches)
  F. Weather context            (temp, wind speed, wind direction bucket)
  G. Park / situation           (home advantage, dome flag)

USAGE:
  python mlb_predictor.py --train          Build and save model from game logs
  python mlb_predictor.py --predict        Score today's matchups
  python mlb_predictor.py --train --predict  Both in sequence
  python mlb_predictor.py --evaluate       Show model metrics only
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
elif sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import argparse
import json
import os
import pickle
import sqlite3
import sys
import warnings
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.metrics import (accuracy_score, brier_score_loss, log_loss,
                              roc_auc_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

DB_PATH         = Path(__file__).parent / "mlb.db"
GAMELOGS_DIR    = Path(__file__).parent / "gamelogs"
MODEL_PATH      = Path(__file__).parent / "mlb_model.pkl"
FEATURES_PATH   = Path(__file__).parent / "mlb_features.json"

# Retrosheet team code ? modern abbreviation
RETRO_TO_MODERN = {
    "ANA": "LAA", "ARI": "AZ",  "ATL": "ATL", "BAL": "BAL", "BOS": "BOS",
    "CHA": "CWS", "CHN": "CHC", "CIN": "CIN", "CLE": "CLE", "COL": "COL",
    "DET": "DET", "FLO": "MIA", "HOU": "HOU", "KCA": "KC",  "LAN": "LAD",
    "MIA": "MIA", "MIL": "MIL", "MIN": "MIN", "NYA": "NYY", "NYN": "NYM",
    "OAK": "ATH", "PHI": "PHI", "PIT": "PIT", "SDN": "SD",  "SEA": "SEA",
    "SFN": "SF",  "SLN": "STL", "TBA": "TB",  "TEX": "TEX", "TOR": "TOR",
    "WAS": "WSH", "MON": "MON", "ALS": "ALS",
}

# Park IDs that are domes or retractable (treat as weather-neutral)
DOME_PARKS = {"STP01", "MIN03", "HOU02", "SEA02", "TOR02",
              "MIA02", "ARL03", "MIL06", "PHO01", "HOU03"}

# Wind direction buckets for Coors/wind parks
WIND_DIR_MAP = {
    "ToLeft": 1, "ToCenter": 2, "ToRight": 3,
    "LeftToRight": 4, "RightToLeft": 5,
    "FromLeft": 6, "FromCenter": 7, "FromRight": 8,
}

# -----------------------------------------------------------------------------
# DB helpers
# -----------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def table_exists(conn, name):
    cur = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)
    )
    return cur.fetchone()[0] > 0


def table_has_rows(conn, name):
    if not table_exists(conn, name):
        return False
    cur = conn.execute(f"SELECT COUNT(*) FROM {name}")
    return cur.fetchone()[0] > 0

# -----------------------------------------------------------------------------
# Feature builders
# -----------------------------------------------------------------------------

def build_pitcher_features(conn, mlb_id, season, prefix="sp"):
    """Pitcher season-level features from savant_pitcher_stats."""
    feats = {}

    if not table_has_rows(conn, "savant_pitcher_stats"):
        return feats

    row = conn.execute("""
        SELECT era, k_percent, bb_percent, whiff_percent,
               hard_hit_percent, barrel_batted_rate,
               xwoba, groundballs_percent, avg_speed_ff
        FROM savant_pitcher_stats
        WHERE mlb_id = ? AND year = ?
    """, (mlb_id, season)).fetchone()

    # Try fallback to previous season
    if not row:
        row = conn.execute("""
            SELECT era, k_percent, bb_percent, whiff_percent,
                   hard_hit_percent, barrel_batted_rate,
                   xwoba, groundballs_percent, avg_speed_ff
            FROM savant_pitcher_stats
            WHERE mlb_id = ?
            ORDER BY year DESC LIMIT 1
        """, (mlb_id,)).fetchone()

    if row:
        feats[f"{prefix}_era"]          = row["era"]
        feats[f"{prefix}_k_pct"]        = row["k_percent"]
        feats[f"{prefix}_bb_pct"]       = row["bb_percent"]
        feats[f"{prefix}_whiff_pct"]    = row["whiff_percent"]
        feats[f"{prefix}_hard_hit"]     = row["hard_hit_percent"]
        feats[f"{prefix}_barrel_rate"]  = row["barrel_batted_rate"]
        feats[f"{prefix}_xwoba"]        = row["xwoba"]
        feats[f"{prefix}_gb_pct"]       = row["groundballs_percent"]

    return feats


def build_pitcher_pitch_features(conn, mlb_id, season, prefix="sp"):
    """Per-pitch-type run value and whiff% for the pitcher."""
    feats = {}

    if not table_has_rows(conn, "pitcher_vs_pitch_type"):
        return feats

    rows = conn.execute("""
        SELECT pitch_type, run_value, whiff_percent, pa, avg_speed
        FROM pitcher_vs_pitch_type
        WHERE mlb_id = ? AND year = ?
        ORDER BY pa DESC
    """, (mlb_id, season)).fetchall()

    if not rows:
        rows = conn.execute("""
            SELECT pitch_type, run_value, whiff_percent, pa, avg_speed
            FROM pitcher_vs_pitch_type
            WHERE mlb_id = ?
            ORDER BY year DESC, pa DESC
        """, (mlb_id,)).fetchall()

    if rows:
        run_vals   = [r["run_value"]    for r in rows if r["run_value"]    is not None]
        whiff_vals = [r["whiff_percent"] for r in rows if r["whiff_percent"] is not None]
        speeds     = [r["avg_speed"]    for r in rows if r["avg_speed"]    is not None]

        feats[f"{prefix}_best_pitch_rv"]   = min(run_vals)   if run_vals   else None
        feats[f"{prefix}_worst_pitch_rv"]  = max(run_vals)   if run_vals   else None
        feats[f"{prefix}_max_whiff"]       = max(whiff_vals) if whiff_vals else None
        feats[f"{prefix}_avg_velo"]        = np.mean(speeds) if speeds     else None
        feats[f"{prefix}_pitch_count"]     = len(rows)

    return feats


def build_lineup_features(conn, team, game_date, season, prefix="off"):
    """Lineup offensive strength - weighted by batting order."""
    feats = {}

    # Order weights: slots 1-4 worth more (more PAs, more run impact)
    order_weights = {1: 1.4, 2: 1.3, 3: 1.2, 4: 1.2,
                     5: 1.0, 6: 1.0, 7: 0.9, 8: 0.85, 9: 0.8}

    rows = conn.execute("""
        SELECT mlb_id, batting_order, ops, avg, obp, slg, iso, strikeouts, walks, at_bats
        FROM daily_lineups
        WHERE team = ? AND game_date = ? AND batting_order > 0
        ORDER BY batting_order
    """, (team, game_date)).fetchall()

    if not rows:
        return feats

    total_w = 0
    w_ops = w_obp = w_slg = w_iso = 0.0
    ab_total = k_total = bb_total = 0

    for r in rows:
        order = r["batting_order"]
        w = order_weights.get(order, 0.9)
        ops = r["ops"] or 0
        obp = r["obp"] or 0
        slg = r["slg"] or 0
        iso = r["iso"] or 0

        w_ops += ops * w
        w_obp += obp * w
        w_slg += slg * w
        w_iso += iso * w
        total_w += w
        ab_total += r["at_bats"] or 0
        k_total  += r["strikeouts"] or 0
        bb_total += r["walks"] or 0

    if total_w > 0:
        feats[f"{prefix}_weighted_ops"] = w_ops / total_w
        feats[f"{prefix}_weighted_obp"] = w_obp / total_w
        feats[f"{prefix}_weighted_slg"] = w_slg / total_w
        feats[f"{prefix}_weighted_iso"] = w_iso / total_w

    if ab_total > 0:
        feats[f"{prefix}_k_rate"]  = k_total  / ab_total
        feats[f"{prefix}_bb_rate"] = bb_total / ab_total

    feats[f"{prefix}_lineup_size"] = len(rows)

    return feats


def build_recent_form_features(conn, team, season, prefix="form"):
    """Team's recent hitting form - L10 OPS vs season OPS delta."""
    feats = {}

    if not table_has_rows(conn, "hitter_recent_stats"):
        return feats

    # Get L10 team average OPS
    row10 = conn.execute("""
        SELECT AVG(ops) as avg_ops, AVG(avg) as avg_avg
        FROM hitter_recent_stats
        WHERE team = ? AND season = ? AND window = 10 AND at_bats >= 3
    """, (team, season)).fetchone()

    row5 = conn.execute("""
        SELECT AVG(ops) as avg_ops
        FROM hitter_recent_stats
        WHERE team = ? AND season = ? AND window = 5 AND at_bats >= 2
    """, (team, season)).fetchone()

    row20 = conn.execute("""
        SELECT AVG(ops) as avg_ops
        FROM hitter_recent_stats
        WHERE team = ? AND season = ? AND window = 20 AND at_bats >= 5
    """, (team, season)).fetchone()

    if row10 and row10["avg_ops"]:
        feats[f"{prefix}_l10_ops"]  = row10["avg_ops"]
        feats[f"{prefix}_l10_avg"]  = row10["avg_avg"]

    if row5 and row5["avg_ops"]:
        feats[f"{prefix}_l5_ops"]   = row5["avg_ops"]

    if row20 and row20["avg_ops"]:
        feats[f"{prefix}_l20_ops"]  = row20["avg_ops"]

    # Hot/cold delta: L10 minus L20 (positive = heating up)
    if (row10 and row10["avg_ops"] and row20 and row20["avg_ops"]):
        feats[f"{prefix}_momentum"] = row10["avg_ops"] - row20["avg_ops"]

    return feats


def build_hitter_vs_pitch_features(conn, team, pitcher_id, season, prefix="hvp"):
    """How this team's lineup fares against the opposing pitcher's pitch mix."""
    feats = {}

    if not table_has_rows(conn, "hitter_vs_pitch_type"):
        return feats
    if not table_has_rows(conn, "pitcher_vs_pitch_type"):
        return feats

    # Get pitcher's top 3 pitch types by usage (from pitcher_vs_pitch_type)
    pitcher_pitches = conn.execute("""
        SELECT pitch_type, pa
        FROM pitcher_vs_pitch_type
        WHERE mlb_id = ? AND year = ?
        ORDER BY pa DESC LIMIT 3
    """, (pitcher_id, season)).fetchall()

    if not pitcher_pitches:
        return feats

    primary_pitch = pitcher_pitches[0]["pitch_type"] if pitcher_pitches else None

    # Get lineup members
    lineup_ids = conn.execute("""
        SELECT mlb_id FROM daily_lineups
        WHERE team = ? AND batting_order > 0
    """, (team,)).fetchall()

    if not lineup_ids:
        return feats

    lineup_id_list = [r["mlb_id"] for r in lineup_ids]

    # Average wOBA of the lineup vs the pitcher's primary pitch type
    for pitch_row in pitcher_pitches[:2]:
        ptype = pitch_row["pitch_type"]
        placeholders = ",".join("?" * len(lineup_id_list))
        params = lineup_id_list + [season, ptype]

        rows = conn.execute(f"""
            SELECT AVG(woba) as avg_woba, AVG(whiff_percent) as avg_whiff
            FROM hitter_vs_pitch_type
            WHERE mlb_id IN ({placeholders}) AND year = ? AND pitch_type = ?
        """, params).fetchone()

        if rows and rows["avg_woba"]:
            feats[f"{prefix}_woba_vs_{ptype.lower()}"]  = rows["avg_woba"]
            feats[f"{prefix}_whiff_vs_{ptype.lower()}"] = rows["avg_whiff"]

    return feats


def build_weather_features(conn, park_id, game_date, prefix="wx"):
    """Weather conditions at game time."""
    feats = {}
    feats[f"{prefix}_is_dome"] = 1 if park_id in DOME_PARKS else 0

    if not table_has_rows(conn, "game_weather"):
        return feats

    row = conn.execute("""
        SELECT temperature_f, precipitation_mm, wind_speed_mph, wind_direction
        FROM game_weather
        WHERE park_id = ? AND game_date = ?
    """, (park_id, game_date)).fetchone()

    if row:
        feats[f"{prefix}_temp_f"]     = row["temperature_f"]
        feats[f"{prefix}_precip_mm"]  = row["precipitation_mm"]
        feats[f"{prefix}_wind_mph"]   = row["wind_speed_mph"]

    return feats


# -----------------------------------------------------------------------------
# Retrosheet game log parser
# -----------------------------------------------------------------------------

# Retrosheet game log field indices
GL_DATE      = 0
GL_AWAY_TEAM = 3
GL_HOME_TEAM = 6
GL_AWAY_SCORE= 9
GL_HOME_SCORE= 10
GL_PARK_ID   = 16
GL_DAY_NIGHT = 12
GL_AWAY_SP   = 101   # visiting starting pitcher ID (Retrosheet ID)
GL_HOME_SP   = 103   # home starting pitcher ID

def parse_gamelog_line(line):
    """Parse one Retrosheet game log CSV line ? dict."""
    fields = []
    cur = ""
    in_q = False
    for ch in line:
        if ch == '"':
            in_q = not in_q
        elif ch == ',' and not in_q:
            fields.append(cur.strip())
            cur = ""
        else:
            cur += ch
    fields.append(cur.strip())

    if len(fields) < 12:
        return None

    try:
        away_score = int(fields[GL_AWAY_SCORE]) if fields[GL_AWAY_SCORE] else None
        home_score = int(fields[GL_HOME_SCORE]) if fields[GL_HOME_SCORE] else None
    except (ValueError, IndexError):
        return None

    if away_score is None or home_score is None:
        return None

    return {
        "date":       fields[GL_DATE],         # YYYYMMDD
        "away_team":  fields[GL_AWAY_TEAM],
        "home_team":  fields[GL_HOME_TEAM],
        "away_score": away_score,
        "home_score": home_score,
        "park_id":    fields[GL_PARK_ID] if len(fields) > GL_PARK_ID else "",
        "day_night":  fields[GL_DAY_NIGHT] if len(fields) > GL_DAY_NIGHT else "N",
        "home_won":   1 if home_score > away_score else 0,
    }


def load_gamelogs(start_year=2015):
    """Load all Retrosheet game logs from gamelogs/ directory."""
    if not GAMELOGS_DIR.exists():
        print(f"[WARN]  Gamelogs directory not found: {GAMELOGS_DIR}")
        print("   Download Retrosheet game logs and place GL####.TXT files there.")
        return []

    games = []
    files = sorted(GAMELOGS_DIR.glob("GL[0-9]*.TXT"))
    print(f"? Found {len(files)} game log files")

    for fpath in files:
        year = int(fpath.stem[2:6])
        if year < start_year:
            continue

        with open(fpath, encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                game = parse_gamelog_line(line)
                if game:
                    game["year"] = year
                    games.append(game)

    print(f"[OK] Loaded {len(games)} games ({start_year}-present)")
    return games


# -----------------------------------------------------------------------------
# Feature matrix builder
# -----------------------------------------------------------------------------

def build_feature_row(conn, game):
    """Build one feature row from a game record."""
    feats = {}
    year  = game["year"]
    date  = game["date"]            # YYYYMMDD
    iso_date = f"{date[:4]}-{date[4:6]}-{date[6:8]}"

    home = RETRO_TO_MODERN.get(game["home_team"], game["home_team"])
    away = RETRO_TO_MODERN.get(game["away_team"], game["away_team"])

    feats["game_date"] = iso_date
    feats["home_team"] = home
    feats["away_team"] = away
    feats["home_won"]  = game["home_won"]
    feats["year"]      = year

    # Context
    feats["is_day_game"] = 1 if game.get("day_night") == "D" else 0

    # Weather
    feats.update(build_weather_features(conn, game.get("park_id", ""), iso_date))

    # Home team features
    feats.update(build_lineup_features(conn, home, iso_date, year, prefix="home_off"))
    feats.update(build_recent_form_features(conn, home, year, prefix="home_form"))

    # Away team features
    feats.update(build_lineup_features(conn, away, iso_date, year, prefix="away_off"))
    feats.update(build_recent_form_features(conn, away, year, prefix="away_form"))

    # NOTE: Pitcher IDs from Retrosheet are Retro IDs not MLBAM IDs.
    # We'd need a crosswalk table for pitcher features from historical logs.
    # For current-season predictions we use daily_lineups.pitcher_mlb_id directly.

    return feats


def build_training_data():
    """Build training DataFrame from game logs + DB stats."""
    print("\n" + "="*60)
    print("  BUILDING TRAINING DATA")
    print("="*60 + "\n")

    games = load_gamelogs(start_year=2017)

    if not games:
        print("[ERROR] No game log data found. Cannot build training data.")
        print("   Run: node importGameWeather.js after placing GL####.TXT files in ./gamelogs/")
        sys.exit(1)

    conn = get_db()
    rows = []
    total = len(games)

    print(f"? Building features for {total} games...\n")

    for idx, game in enumerate(games):
        if idx % 1000 == 0:
            print(f"   {idx:5}/{total} ({idx/total*100:.0f}%)...")

        try:
            row = build_feature_row(conn, game)
            rows.append(row)
        except Exception as e:
            pass  # skip malformed rows silently

    conn.close()

    df = pd.DataFrame(rows)
    print(f"\n[OK] Feature matrix: {df.shape[0]} games x {df.shape[1]} columns")
    print(f"   Target distribution: {df['home_won'].mean():.3f} home win rate")

    # Drop metadata columns before training
    meta_cols = ["game_date", "home_team", "away_team", "home_won", "year"]
    feature_cols = [c for c in df.columns if c not in meta_cols]

    print(f"   Feature columns: {len(feature_cols)}")
    print(f"   Missing value rates:")
    missing = df[feature_cols].isnull().mean()
    for col, rate in missing[missing > 0.3].items():
        print(f"     {col}: {rate:.0%} missing")

    return df, feature_cols


# -----------------------------------------------------------------------------
# Model training
# -----------------------------------------------------------------------------

def train_model(df, feature_cols):
    """Train gradient boosted model with time-series cross-validation."""
    print("\n" + "="*60)
    print("  TRAINING MODEL")
    print("="*60 + "\n")

    X = df[feature_cols].values
    y = df["home_won"].values
    years = df["year"].values

    # Time-series split: train on past, evaluate on future
    # This is critical for sports - no future data leakage
    tscv = TimeSeriesSplit(n_splits=4)

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler",  StandardScaler()),
        ("model",   GradientBoostingClassifier(
            n_estimators=300,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            min_samples_leaf=20,
            random_state=42,
        )),
    ])

    # Cross-validate
    print(">> Time-series cross-validation:")
    cv_aucs    = []
    cv_briers  = []
    cv_accs    = []

    year_sorted = np.argsort(years)
    X_sorted = X[year_sorted]
    y_sorted = y[year_sorted]

    for fold, (train_idx, test_idx) in enumerate(tscv.split(X_sorted)):
        X_train, X_test = X_sorted[train_idx], X_sorted[test_idx]
        y_train, y_test = y_sorted[train_idx], y_sorted[test_idx]

        pipeline.fit(X_train, y_train)
        probs = pipeline.predict_proba(X_test)[:, 1]
        preds = (probs >= 0.5).astype(int)

        auc    = roc_auc_score(y_test, probs)
        brier  = brier_score_loss(y_test, probs)
        acc    = accuracy_score(y_test, preds)

        cv_aucs.append(auc)
        cv_briers.append(brier)
        cv_accs.append(acc)

        print(f"   Fold {fold+1}: AUC={auc:.3f}  Brier={brier:.3f}  Acc={acc:.3f}")

    print(f"\n   Mean AUC   : {np.mean(cv_aucs):.3f} +/- {np.std(cv_aucs):.3f}")
    print(f"   Mean Brier : {np.mean(cv_briers):.3f} +/- {np.std(cv_briers):.3f}")
    print(f"   Mean Acc   : {np.mean(cv_accs):.3f} +/- {np.std(cv_accs):.3f}")

    # Train final model on all data
    print("\n-> Training final model on full dataset...")
    pipeline.fit(X_sorted, y_sorted)

    # Feature importance
    model = pipeline.named_steps["model"]
    importances = model.feature_importances_
    feat_imp = sorted(zip(feature_cols, importances), key=lambda x: -x[1])

    print("\n? Top 20 most important features:")
    for feat, imp in feat_imp[:20]:
        bar = "?" * int(imp * 300)
        print(f"   {feat:<40} {imp:.4f}  {bar}")

    # Save model and feature list
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(pipeline, f)
    with open(FEATURES_PATH, "w") as f:
        json.dump({
            "feature_cols": feature_cols,
            "trained_at": datetime.now().isoformat(),
            "n_games": len(df),
            "cv_auc_mean": float(np.mean(cv_aucs)),
            "cv_acc_mean": float(np.mean(cv_accs)),
        }, f, indent=2)

    print(f"\n[OK] Model saved to {MODEL_PATH}")
    print(f"   Feature list saved to {FEATURES_PATH}")

    return pipeline, feature_cols


# -----------------------------------------------------------------------------
# Today's predictions
# -----------------------------------------------------------------------------

def get_todays_matchups(conn):
    """Get today's games from daily_lineups."""
    today = datetime.now().strftime("%Y-%m-%d")

    matchups = conn.execute("""
        SELECT DISTINCT
            dl.team       AS home_team,
            dl.opponent   AS away_team,
            dl.game_date,
            dl.season,
            dl.pitcher_mlb_id   AS home_sp_id,
            dl.pitcher_name     AS home_sp_name
        FROM daily_lineups dl
        WHERE dl.game_date = ?
          AND dl.batting_order > 0
    """, (today,)).fetchall()

    if not matchups:
        # Fallback to most recent date
        latest = conn.execute("""
            SELECT MAX(game_date) FROM daily_lineups WHERE batting_order > 0
        """).fetchone()[0]
        if latest:
            matchups = conn.execute("""
                SELECT DISTINCT
                    dl.team       AS home_team,
                    dl.opponent   AS away_team,
                    dl.game_date,
                    dl.season,
                    dl.pitcher_mlb_id   AS home_sp_id,
                    dl.pitcher_name     AS home_sp_name
                FROM daily_lineups dl
                WHERE dl.game_date = ?
                  AND dl.batting_order > 0
            """, (latest,)).fetchall()

    return matchups


def build_prediction_row(conn, matchup, feature_cols):
    """Build a feature row for one today's matchup."""
    home = matchup["home_team"]
    away = matchup["away_team"] or matchup["home_team"]  # fallback
    date = matchup["game_date"]
    season = matchup["season"]

    feats = {"is_day_game": 0, "wx_is_dome": 0}

    # Home team
    feats.update(build_lineup_features(conn, home, date, season, prefix="home_off"))
    feats.update(build_recent_form_features(conn, home, season, prefix="home_form"))

    # Away team
    if away and away != home:
        feats.update(build_lineup_features(conn, away, date, season, prefix="away_off"))
        feats.update(build_recent_form_features(conn, away, season, prefix="away_form"))

    # Starting pitcher features (home team's opposing pitcher = away SP)
    away_sp_row = conn.execute("""
        SELECT DISTINCT pitcher_mlb_id, pitcher_name
        FROM daily_lineups
        WHERE team = ? AND game_date = ? AND pitcher_mlb_id IS NOT NULL
        LIMIT 1
    """, (away, date)).fetchone()

    if away_sp_row and away_sp_row["pitcher_mlb_id"]:
        sp_id = away_sp_row["pitcher_mlb_id"]
        feats.update(build_pitcher_features(conn, sp_id, season, prefix="home_sp"))
        feats.update(build_pitcher_pitch_features(conn, sp_id, season, prefix="home_sp"))
        feats.update(build_hitter_vs_pitch_features(conn, home, sp_id, season, prefix="home_hvp"))

    # Same for home SP vs away lineup
    home_sp_row = conn.execute("""
        SELECT DISTINCT pitcher_mlb_id, pitcher_name
        FROM daily_lineups
        WHERE team = ? AND game_date = ? AND pitcher_mlb_id IS NOT NULL
        LIMIT 1
    """, (home, date)).fetchone()

    if home_sp_row and home_sp_row["pitcher_mlb_id"]:
        sp_id = home_sp_row["pitcher_mlb_id"]
        feats.update(build_pitcher_features(conn, sp_id, season, prefix="away_sp"))
        feats.update(build_pitcher_pitch_features(conn, sp_id, season, prefix="away_sp"))
        feats.update(build_hitter_vs_pitch_features(conn, away, sp_id, season, prefix="away_hvp"))

    # Align to training feature columns - fill missing with NaN
    row = {col: feats.get(col, np.nan) for col in feature_cols}
    return row


def predict_today(pipeline=None, feature_cols=None):
    """Score today's matchups and print predictions."""
    print("\n" + "="*60)
    print("  TODAY'S PREDICTIONS")
    print("="*60 + "\n")

    # Load model if not provided
    if pipeline is None:
        if not MODEL_PATH.exists():
            print("[ERROR] No trained model found. Run with --train first.")
            sys.exit(1)
        with open(MODEL_PATH, "rb") as f:
            pipeline = pickle.load(f)
        with open(FEATURES_PATH) as f:
            meta = json.load(f)
            feature_cols = meta["feature_cols"]
            print(f"   Model trained: {meta['trained_at'][:10]}")
            print(f"   Training AUC:  {meta.get('cv_auc_mean', 'N/A')}")
            print(f"   Training Acc:  {meta.get('cv_acc_mean', 'N/A')}\n")

    conn = get_db()
    matchups = get_todays_matchups(conn)

    if not matchups:
        print("[WARN]  No lineup data found for today.")
        print("   Run: node scrapeDailyLineups.js && node importDailyLineups.js")
        conn.close()
        return

    date = matchups[0]["game_date"]
    print(f"Date: {date}\n")

    # Deduplicate - daily_lineups has multiple rows per team
    seen = set()
    unique_matchups = []
    for m in matchups:
        key = (m["home_team"], m["away_team"] or "")
        if key not in seen:
            seen.add(key)
            unique_matchups.append(m)

    results = []

    for matchup in unique_matchups:
        home = matchup["home_team"]
        away = matchup["away_team"] or "???"

        try:
            row = build_prediction_row(conn, matchup, feature_cols)
            X = np.array([[row[col] for col in feature_cols]])
            prob_home = pipeline.predict_proba(X)[0][1]
            prob_away = 1.0 - prob_home

            results.append({
                "home":      home,
                "away":      away,
                "home_prob": prob_home,
                "away_prob": prob_away,
                "pick":      home if prob_home >= 0.5 else away,
                "confidence": max(prob_home, prob_away),
            })
        except Exception as e:
            results.append({
                "home": home, "away": away,
                "home_prob": None, "error": str(e),
            })

    conn.close()

    # Print results sorted by confidence
    results.sort(key=lambda x: -(x.get("confidence") or 0))

    print(f"{'MATCHUP':<25} {'HOME WIN%':>9} {'AWAY WIN%':>9}  {'PICK':<8}  {'CONF':>6}")
    print("-" * 65)

    for r in results:
        if r.get("home_prob") is None:
            print(f"  {r['away']:<3} @ {r['home']:<3}  [WARN]  insufficient data")
            continue

        matchup_str = f"{r['away']} @ {r['home']}"
        conf_str    = f"{r['confidence']*100:.0f}%"
        home_str    = f"{r['home_prob']*100:.1f}%"
        away_str    = f"{r['away_prob']*100:.1f}%"
        pick_mark   = "<" if r["pick"] == r["home"] else ">"

        print(f"  {matchup_str:<23} {home_str:>9} {away_str:>9}  "
              f"{r['pick']:<8} {pick_mark}  {conf_str:>5}")

    print()


# -----------------------------------------------------------------------------
# Data readiness check
# -----------------------------------------------------------------------------

def check_data_readiness():
    """Report what data is available and what's missing."""
    print("\n" + "="*60)
    print("  DATA READINESS CHECK")
    print("="*60 + "\n")

    conn = get_db()

    checks = [
        ("Game logs (Retrosheet)",       GAMELOGS_DIR.exists() and any(GAMELOGS_DIR.glob("GL*.TXT")),
         "Download from retrosheet.org ? gamelogs/ folder"),
        ("hitter_recent_stats",          table_has_rows(conn, "hitter_recent_stats"),
         "node importHitterRecentStats.js"),
        ("player_stats",                 table_has_rows(conn, "player_stats"),
         "node importPlayerStats.js"),
        ("savant_pitcher_stats",         table_has_rows(conn, "savant_pitcher_stats"),
         "node importSavantPitcherStats.js"),
        ("pitcher_pitch_type",        table_has_rows(conn, "pitcher_pitch_type"),
         "node importPitcherPitchType.js --all"),
        ("hitter_vs_pitch_type",         table_has_rows(conn, "hitter_vs_pitch_type"),
         "node importHitterVsPitchType.js --all"),
        ("game_weather",                 table_has_rows(conn, "game_weather"),
         "node geocodeParks.js && node importGameWeather.js"),
        ("daily_lineups (today)",        table_has_rows(conn, "daily_lineups"),
         "node scrapeDailyLineups.js && node importDailyLineups.js"),
    ]

    conn.close()

    ready = 0
    for name, status, fix in checks:
        icon = "[OK]" if status else "[ERROR]"
        print(f"  {icon}  {name}")
        if not status:
            print(f"       ? {fix}")
        else:
            ready += 1

    print(f"\n  {ready}/{len(checks)} data sources ready")

    if ready < 4:
        print("\n  [WARN]  Model will have limited accuracy with sparse data.")
        print("     Minimum recommended: game logs + hitter_recent_stats + savant_pitcher_stats")


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="MLB Game Outcome Predictor")
    parser.add_argument("--train",    action="store_true", help="Train model from game logs")
    parser.add_argument("--predict",  action="store_true", help="Predict today's games")
    parser.add_argument("--check",    action="store_true", help="Check data readiness")
    parser.add_argument("--evaluate", action="store_true", help="Show model metrics")
    args = parser.parse_args()

    if not any(vars(args).values()):
        check_data_readiness()
        print()
        parser.print_help()
        return

    if args.check:
        check_data_readiness()

    pipeline    = None
    feature_cols = None

    if args.train:
        df, feature_cols = build_training_data()
        pipeline, feature_cols = train_model(df, feature_cols)

    if args.predict:
        predict_today(pipeline, feature_cols)

    if args.evaluate and not args.train:
        if MODEL_PATH.exists():
            with open(FEATURES_PATH) as f:
                meta = json.load(f)
            print("\n>> Saved model metrics:")
            print(f"   Trained:     {meta.get('trained_at', 'unknown')[:10]}")
            print(f"   Games used:  {meta.get('n_games', 'unknown')}")
            print(f"   CV AUC:      {meta.get('cv_auc_mean', 'N/A')}")
            print(f"   CV Accuracy: {meta.get('cv_acc_mean', 'N/A')}")
        else:
            print("[ERROR] No trained model found. Run with --train first.")


if __name__ == "__main__":
    main()