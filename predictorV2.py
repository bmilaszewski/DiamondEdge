"""
mlb_predictor_v2.py

MLB Game Outcome Prediction - Full Production Model
=====================================================
Upgrades over v1:
  1. Pythagorean win% + rolling team records (from game_results)
  2. Platoon splits (LHH vs RHP, RHH vs LHP) from lineup handedness
  3. Park factors (run environment context)
  4. Rest days + travel (fatigue model)
  5. Umpire K%/BB% tendencies
  6. Full pitcher Statcast (xwOBA, whiff%, barrel rate, pitch mix)
  7. Hitter vs pitch type matchup features
  8. Pitcher vs pitch type features
  9. Bullpen context (team ERA from recent non-SP innings)
 10. Ensemble model: GBM + Logistic Regression stacked
 11. Probability calibration (Isotonic Regression)
 12. Separate run total model (for over/under)
 13. Rolling Elo ratings

USAGE:
  python mlb_predictor_v2.py --train
  python mlb_predictor_v2.py --predict
  python mlb_predictor_v2.py --train --predict
  python mlb_predictor_v2.py --check
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
elif sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import argparse
import json
import pickle
import sqlite3
import sys
import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import (GradientBoostingClassifier,
                               GradientBoostingRegressor,
                               VotingClassifier)
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (accuracy_score, brier_score_loss,
                              log_loss, mean_absolute_error, roc_auc_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

DB_PATH       = Path(__file__).parent / "mlb.db"
MODEL_PATH    = Path(__file__).parent / "mlb_model_v2.pkl"
ELO_PATH      = Path(__file__).parent / "elo_ratings.json"
FEATURES_PATH = Path(__file__).parent / "mlb_features_v2.json"

DOME_PARKS = {"STP01", "MIN03", "HOU02", "SEA02", "TOR02",
              "MIA02", "ARL03", "MIL06", "PHO01", "HOU03"}

# -----------------------------------------------------------------------------
# DB
# -----------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = lambda cursor, row: {
        col[0]: row[idx] for idx, col in enumerate(cursor.description)
    }
    return conn

def tbl(conn, name):
    cur = conn.execute(
        "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?",
        (name,)
    )
    row = cur.fetchone()
    if not row or row["cnt"] == 0:
        return False

    cur = conn.execute(f"SELECT COUNT(*) as cnt FROM {name}")
    row = cur.fetchone()
    return row["cnt"] > 0

def q(conn, sql, params=()):
    return conn.execute(sql, params).fetchall()

def q1(conn, sql, params=()):
    r = conn.execute(sql, params).fetchone()
    return r

# -----------------------------------------------------------------------------
# Elo ratings
# -----------------------------------------------------------------------------

def compute_elo_ratings(conn):
    """
    Compute rolling Elo ratings for every team.
    K=20 (standard for sports with ~162 games/season).
    Season reset: regress 1/3 toward 1500 at start of each season.
    Returns dict: {team: {game_date: elo_before_game}}
    """
    print("   Computing Elo ratings...")

    if not tbl(conn, "game_results"):
        return {}

    games = q(conn, """
        SELECT game_date, season, home_team, away_team, home_won
        FROM game_results
        ORDER BY game_date, home_team
    """)

    ratings = {}   # team ? current Elo
    history = {}   # (team, game_date) ? Elo before game
    K = 20
    HOME_ADV = 35  # Elo home advantage points (~54% win rate)
    prev_season = None

    for g in games:
        home, away = g["home_team"], g["away_team"]
        season = g["season"]

        # Initialize new teams
        if home not in ratings: ratings[home] = 1500
        if away not in ratings: ratings[away] = 1500

        # Season reset: regress toward mean
        if season != prev_season and prev_season is not None:
            for team in list(ratings):
                ratings[team] = ratings[team] * 0.67 + 1500 * 0.33
            prev_season = season
        elif prev_season is None:
            prev_season = season

        # Record pre-game Elo
        key_home = (home, g["game_date"])
        key_away = (away, g["game_date"])
        history[key_home] = ratings[home]
        history[key_away] = ratings[away]

        # Expected win prob (home gets advantage)
        exp_home = 1 / (1 + 10 ** ((ratings[away] - ratings[home] - HOME_ADV) / 400))
        actual_home = g["home_won"]

        # Update
        delta = K * (actual_home - exp_home)
        ratings[home] += delta
        ratings[away] -= delta

    # Save to file for inspection
    with open(ELO_PATH, "w") as f:
        json.dump({f"{t}": v for t, v in ratings.items()}, f, indent=2)

    print(f"   [OK] Elo computed for {len(ratings)} teams")
    return history

# -----------------------------------------------------------------------------
# Feature builders
# -----------------------------------------------------------------------------

def safe(v, default=None):
    """Return v or default if None/NaN."""
    if v is None: return default
    try:
        f = float(v)
        return default if np.isnan(f) else f
    except (TypeError, ValueError):
        return default


def get_team_record(conn, team, game_date, season, prefix):
    """Pythagorean win%, L10/L20 form, season record."""
    feats = {}
    if not tbl(conn, "team_records"):
        return feats

    # Use the year from game_date for lookup - daily_lineups.season may lag
    lookup_season = int(game_date[:4]) if game_date else season

    row = q1(conn, """
        SELECT wins, losses, win_pct, pythag_wpct,
               runs_scored, runs_allowed, run_diff_total,
               l10_wins, l10_run_diff, l20_wins, l20_run_diff
        FROM team_records
        WHERE team = ? AND game_date < ? AND season = ?
        ORDER BY game_date DESC LIMIT 1
    """, (team, game_date, lookup_season))

    # Fallback: try previous season (works for start-of-season predictions)
    if not row:
        row = q1(conn, """
            SELECT wins, losses, win_pct, pythag_wpct,
                   runs_scored, runs_allowed, run_diff_total,
                   l10_wins, l10_run_diff, l20_wins, l20_run_diff
            FROM team_records
            WHERE team = ?
            ORDER BY game_date DESC LIMIT 1
        """, (team,))

    if row:
        g = (row["wins"] or 0) + (row["losses"] or 0)
        feats[f"{prefix}_win_pct"]      = safe(row["win_pct"],      0.500)
        feats[f"{prefix}_pythag_wpct"]  = safe(row["pythag_wpct"],  0.500)
        feats[f"{prefix}_rpg"]          = safe(row["runs_scored"], 0) / max(g, 1)
        feats[f"{prefix}_rapg"]         = safe(row["runs_allowed"],0) / max(g, 1)
        feats[f"{prefix}_run_diff_pg"]  = safe(row["run_diff_total"],0) / max(g, 1)
        feats[f"{prefix}_l10_wins"]     = safe(row["l10_wins"],     5)
        feats[f"{prefix}_l10_run_diff"] = safe(row["l10_run_diff"], 0)
        feats[f"{prefix}_l20_wins"]     = safe(row["l20_wins"],    10)
        feats[f"{prefix}_games_played"] = g
    return feats


def get_pitcher_features(conn, sp_retro, sp_mlb, season, prefix):
    """
    Pitcher quality from savant_pitcher_stats.
    Falls back through: current season ? last season ? career avg.
    """
    feats = {}

    # Resolve MLBAM ID if we only have retro ID
    if not sp_mlb and sp_retro and tbl(conn, "retro_to_mlbam"):
        row = q1(conn, "SELECT mlb_id FROM retro_to_mlbam WHERE retro_id = ?", (sp_retro,))
        if row: sp_mlb = row["mlb_id"]

    if not sp_mlb or not tbl(conn, "savant_pitcher_stats"):
        return feats

    # Try current season first, then prior seasons
    for yr in [season, season-1, season-2]:
        row = q1(conn, """
            SELECT era, k_percent, bb_percent, whiff_percent,
                   hard_hit_percent, barrel_batted_rate, xwoba,
                   groundballs_percent, exit_velocity_avg,
                   ff_avg_speed, ff_count, sl_avg_speed, sl_count,
                   z_swing_miss_percent, oz_swing_percent, f_strike_percent
            FROM savant_pitcher_stats
            WHERE mlb_id = ? AND year = ?
        """, (sp_mlb, yr))
        if row: break

    if row:
        feats[f"{prefix}_era"]         = safe(row["era"])
        feats[f"{prefix}_k_pct"]       = safe(row["k_percent"])
        feats[f"{prefix}_bb_pct"]      = safe(row["bb_percent"])
        feats[f"{prefix}_whiff_pct"]   = safe(row["whiff_percent"])
        feats[f"{prefix}_hard_hit"]    = safe(row["hard_hit_percent"])
        feats[f"{prefix}_barrel_rate"] = safe(row["barrel_batted_rate"])
        feats[f"{prefix}_xwoba"]       = safe(row["xwoba"])
        feats[f"{prefix}_gb_pct"]      = safe(row["groundballs_percent"])
        feats[f"{prefix}_exit_velo"]   = safe(row["exit_velocity_avg"])
        feats[f"{prefix}_ff_speed"]    = safe(row["ff_avg_speed"])
        feats[f"{prefix}_f_strike"]    = safe(row["f_strike_percent"])
        feats[f"{prefix}_oz_swing"]    = safe(row["oz_swing_percent"])

    # Pitch mix features from pitcher_vs_pitch_type
    if tbl(conn, "pitcher_vs_pitch_type") and sp_mlb:
        rows = q(conn, """
            SELECT pitch_type, run_value, whiff_percent, pa, avg_speed
            FROM pitcher_vs_pitch_type
            WHERE mlb_id = ? AND year = ?
            ORDER BY pa DESC LIMIT 4
        """, (sp_mlb, season))

        if not rows:
            rows = q(conn, """
                SELECT pitch_type, run_value, whiff_percent, pa, avg_speed
                FROM pitcher_vs_pitch_type
                WHERE mlb_id = ?
                ORDER BY year DESC, pa DESC LIMIT 4
            """, (sp_mlb,))

        if rows:
            rvs    = [safe(r["run_value"])    for r in rows if r["run_value"]    is not None]
            whiffs = [safe(r["whiff_percent"]) for r in rows if r["whiff_percent"] is not None]
            feats[f"{prefix}_best_pitch_rv"]  = min(rvs)   if rvs    else None
            feats[f"{prefix}_worst_pitch_rv"] = max(rvs)   if rvs    else None
            feats[f"{prefix}_max_whiff"]      = max(whiffs) if whiffs else None
            feats[f"{prefix}_pitch_variety"]  = len(rows)

    return feats


def get_lineup_features(conn, team, game_date, season, sp_hand, prefix):
    """
    Lineup offensive features with platoon splits.
    sp_hand = handedness of opposing SP ('L' or 'R').
    """
    feats = {}

    rows = q(conn, """
        SELECT mlb_id, batting_order, ops, avg, obp, slg, iso,
               strikeouts, walks, at_bats, handedness, position
        FROM daily_lineups
        WHERE team = ? AND game_date = ? AND batting_order > 0
        ORDER BY batting_order
    """, (team, game_date))

    if not rows:
        return feats

    order_w = {1:1.4,2:1.3,3:1.2,4:1.2,5:1.0,6:1.0,7:0.9,8:0.85,9:0.8}

    total_w = w_ops = w_obp = w_slg = w_iso = 0.0
    ab = k = bb = 0
    lhh_count = rhh_count = 0

    for r in rows:
        w   = order_w.get(r["batting_order"], 0.9)
        ops = safe(r["ops"],  0)
        obp = safe(r["obp"],  0)
        slg = safe(r["slg"],  0)
        iso = safe(r["iso"],  0)

        w_ops += ops * w;  w_obp += obp * w
        w_slg += slg * w;  w_iso += iso * w
        total_w += w
        ab += safe(r["at_bats"],    0)
        k  += safe(r["strikeouts"], 0)
        bb += safe(r["walks"],      0)

        hand = (r["handedness"] or "").upper()
        if hand == "L": lhh_count += 1
        elif hand == "R": rhh_count += 1

    if total_w > 0:
        feats[f"{prefix}_w_ops"] = w_ops / total_w
        feats[f"{prefix}_w_obp"] = w_obp / total_w
        feats[f"{prefix}_w_slg"] = w_slg / total_w
        feats[f"{prefix}_w_iso"] = w_iso / total_w

    if ab > 0:
        feats[f"{prefix}_k_rate"]  = k / ab
        feats[f"{prefix}_bb_rate"] = bb / ab

    # Platoon composition vs opposing pitcher hand
    n = len(rows)
    feats[f"{prefix}_lhh_pct"] = lhh_count / max(n, 1)
    feats[f"{prefix}_rhh_pct"] = rhh_count / max(n, 1)

    # Platoon advantage: LHH vs RHP is favored, RHH vs LHP is favored
    if sp_hand == "R":
        feats[f"{prefix}_platoon_adv"] = lhh_count / max(n, 1)
    elif sp_hand == "L":
        feats[f"{prefix}_platoon_adv"] = rhh_count / max(n, 1)
    else:
        feats[f"{prefix}_platoon_adv"] = 0.5

    feats[f"{prefix}_lineup_size"] = n

    # Hitter vs pitch type features (how lineup hits primary pitch types)
    if tbl(conn, "hitter_vs_pitch_type") and n > 0:
        mlb_ids = [r["mlb_id"] for r in rows]
        placeholders = ",".join("?" * len(mlb_ids))

        for pitch_type in ["FF", "SL", "CH"]:
            params = mlb_ids + [season, pitch_type]
            agg = q1(conn, f"""
                SELECT AVG(woba) as avg_woba, AVG(whiff_percent) as avg_whiff,
                       COUNT(*) as n
                FROM hitter_vs_pitch_type
                WHERE mlb_id IN ({placeholders}) AND year = ? AND pitch_type = ?
            """, params)

            if agg and agg["n"] and agg["n"] > 2:
                pt = pitch_type.lower()
                feats[f"{prefix}_woba_vs_{pt}"] = safe(agg["avg_woba"])
                feats[f"{prefix}_whiff_vs_{pt}"] = safe(agg["avg_whiff"])

    return feats


def get_recent_form(conn, team, season, prefix):
    """L5/L10/L20 OPS from hitter_recent_stats."""
    feats = {}
    if not tbl(conn, "hitter_recent_stats"):
        return feats

    for w in [5, 10, 20]:
        row = q1(conn, """
            SELECT AVG(ops) as avg_ops, AVG(avg) as avg_avg,
                   AVG(home_runs) as avg_hr, AVG(walks) as avg_bb
            FROM hitter_recent_stats
            WHERE team = ? AND season = ? AND window = ? AND at_bats >= ?
        """, (team, season, w, 2 if w <= 5 else 5))

        if row and row["avg_ops"] is not None:
            feats[f"{prefix}_l{w}_ops"] = safe(row["avg_ops"])
            feats[f"{prefix}_l{w}_avg"] = safe(row["avg_avg"])

    # Momentum: L10 vs L20 delta
    l10 = feats.get(f"{prefix}_l10_ops")
    l20 = feats.get(f"{prefix}_l20_ops")
    if l10 is not None and l20 is not None:
        feats[f"{prefix}_momentum"] = l10 - l20

    return feats


def get_park_features(conn, park_id, season):
    """Park run factor and dome flag."""
    feats = {}
    feats["park_is_dome"] = 1 if park_id in DOME_PARKS else 0

    if park_id and tbl(conn, "park_factors"):
        row = q1(conn, """
            SELECT run_factor FROM park_factors
            WHERE park_id = ? AND season <= ?
            ORDER BY season DESC LIMIT 1
        """, (park_id, season))
        if row:
            feats["park_run_factor"] = safe(row["run_factor"], 100.0)

    return feats


def get_weather_features(conn, park_id, game_date):
    """Weather from game_weather table."""
    feats = {}
    if not park_id or not tbl(conn, "game_weather"):
        return feats

    row = q1(conn, """
        SELECT temperature_f, precipitation_mm, wind_speed_mph, wind_direction
        FROM game_weather
        WHERE park_id = ? AND game_date = ?
    """, (park_id, game_date))

    if row:
        temp = safe(row["temperature_f"])
        wind = safe(row["wind_speed_mph"])
        feats["wx_temp_f"]    = temp
        feats["wx_wind_mph"]  = wind
        feats["wx_precip_mm"] = safe(row["precipitation_mm"], 0)

        # Wind direction relative to hitter (blowing out = more HRs)
        wd = row["wind_direction"] or ""
        feats["wx_wind_out"] = 1 if wd in ("ToLeft", "ToCenter", "ToRight") else 0

        # Temperature effect on HR (warm = more HRs)
        feats["wx_temp_above_70"] = 1 if (temp or 0) >= 70 else 0

    return feats


def get_rest_travel(conn, team, game_date, prefix):
    """Rest days and travel from team_rest_travel."""
    feats = {}
    if not tbl(conn, "team_rest_travel"):
        return feats

    row = q1(conn, """
        SELECT rest_days, travel_flag, is_home, prev_was_home
        FROM team_rest_travel
        WHERE team = ? AND game_date = ?
    """, (team, game_date))

    if row:
        feats[f"{prefix}_rest_days"]   = safe(row["rest_days"], 1)
        feats[f"{prefix}_travel_flag"] = safe(row["travel_flag"], 0)
        feats[f"{prefix}_b2b"]         = 1 if (row["rest_days"] or 1) == 0 else 0

    return feats


def get_umpire_features(conn, umpire_name, season):
    """Umpire K/BB tendencies."""
    feats = {}
    if not umpire_name or not tbl(conn, "umpire_tendencies"):
        return feats

    row = q1(conn, """
        SELECT k_rate_delta, bb_rate_delta
        FROM umpire_tendencies
        WHERE umpire_name = ? AND season = ?
    """, (umpire_name, season))

    if row:
        feats["ump_k_delta"]  = safe(row["k_rate_delta"],  0)
        feats["ump_bb_delta"] = safe(row["bb_rate_delta"], 0)

    return feats


# -----------------------------------------------------------------------------
# Training data builder
# -----------------------------------------------------------------------------

def build_training_data(elo_history):
    """
    Join game_results with all feature tables ? training DataFrame.
    One row per game, target = home_won.
    """
    print("\n" + "="*60)
    print("  BUILDING TRAINING DATA")
    print("="*60)

    conn = get_db()

    if not tbl(conn, "game_results"):
        print("[ERROR] game_results is empty. Run importGameResults.js first.")
        sys.exit(1)

    games = q(conn, """
        SELECT gr.game_date, gr.season, gr.home_team, gr.away_team,
               gr.home_score, gr.away_score, gr.home_won, gr.total_runs,
               gr.park_id, gr.day_night,
               gr.home_sp_retro, gr.home_sp_name,
               gr.away_sp_retro, gr.away_sp_name
        FROM game_results gr
        WHERE gr.home_won IS NOT NULL
        ORDER BY gr.game_date
    """)

    print(f"\n   {len(games)} games to process...")

    rows = []
    for idx, g in enumerate(games):
        if idx % 2000 == 0:
            print(f"   {idx}/{len(games)} ({idx/len(games)*100:.0f}%)...")

        home = g["home_team"]
        away = g["away_team"]
        date = g["game_date"]
        season = g["season"]

        feats = {
            "game_date":   date,
            "home_team":   home,
            "away_team":   away,
            "home_won":    g["home_won"],
            "total_runs":  g["total_runs"],
            "year":        season,
            "is_day":      1 if g["day_night"] == "D" else 0,
        }

        # Elo
        home_elo = elo_history.get((home, date), 1500)
        away_elo = elo_history.get((away, date), 1500)
        feats["home_elo"]        = home_elo
        feats["away_elo"]        = away_elo
        feats["elo_diff"]        = home_elo - away_elo
        feats["elo_home_win_exp"] = 1 / (1 + 10**((away_elo - home_elo - 35) / 400))

        # Team records
        feats.update(get_team_record(conn, home, date, season, "home"))
        feats.update(get_team_record(conn, away, date, season, "away"))

        # Derived: win% differential
        hw = feats.get("home_pythag_wpct", 0.5)
        aw = feats.get("away_pythag_wpct", 0.5)
        feats["pythag_diff"] = hw - aw

        # Recent form
        feats.update(get_recent_form(conn, home, season, "home"))
        feats.update(get_recent_form(conn, away, season, "away"))

        # Starting pitchers
        feats.update(get_pitcher_features(
            conn, g["home_sp_retro"], None, season, "home_sp"))
        feats.update(get_pitcher_features(
            conn, g["away_sp_retro"], None, season, "away_sp"))

        # SP ERA differential
        home_era = feats.get("home_sp_era")
        away_era = feats.get("away_sp_era")
        if home_era is not None and away_era is not None:
            feats["sp_era_diff"] = away_era - home_era  # positive = home pitcher better

        # Park
        feats.update(get_park_features(conn, g["park_id"], season))
        feats.update(get_weather_features(conn, g["park_id"], date))

        # Rest/travel
        feats.update(get_rest_travel(conn, home, date, "home"))
        feats.update(get_rest_travel(conn, away, date, "away"))

        # Lineup features (only if daily_lineups has historical data)
        # For historical games these will mostly be null - handled by imputer
        feats.update(get_lineup_features(
            conn, home, date, season,
            sp_hand=None,  # could add SP hand if crosswalk has it
            prefix="home_off"
        ))
        feats.update(get_lineup_features(conn, away, date, season, None, "away_off"))

        rows.append(feats)

    conn.close()
    df = pd.DataFrame(rows)

    print(f"\n   Feature matrix: {df.shape[0]} games x {df.shape[1]} columns")
    print(f"   Home win rate: {df['home_won'].mean():.3f}")

    meta_cols   = ["game_date","home_team","away_team","home_won","total_runs","year"]
    feature_cols = [c for c in df.columns if c not in meta_cols]

    # Feature coverage report
    missing = df[feature_cols].isnull().mean()
    high_missing = missing[missing > 0.5]
    if len(high_missing):
        print(f"\n   [WARN]  {len(high_missing)} features >50% missing (imputer will handle):")
        for col, rate in high_missing.items():
            print(f"      {col}: {rate:.0%}")

    return df, feature_cols


# -----------------------------------------------------------------------------
# Model: stacked ensemble with calibration
# -----------------------------------------------------------------------------

def make_base_pipeline(model):
    return Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler",  StandardScaler()),
        ("model",   model),
    ])


def train_winner_model(df, feature_cols):
    """
    Train the win probability model.
    Ensemble: GBM + Logistic Regression ? Calibrated with isotonic regression.
    """
    print("\n" + "="*60)
    print("  TRAINING WINNER MODEL")
    print("="*60)

    X = df[feature_cols].values.astype(float)
    y = df["home_won"].values.astype(int)
    years = df["year"].values

    # Sort by year for time-series CV
    order = np.argsort(years, kind="stable")
    X, y, years = X[order], y[order], years[order]

    # -- Base models ---------------------------------------------------------

    gbm = make_base_pipeline(GradientBoostingClassifier(
        n_estimators=400,
        max_depth=4,
        learning_rate=0.04,
        subsample=0.75,
        min_samples_leaf=25,
        max_features=0.7,
        random_state=42,
    ))

    lr = make_base_pipeline(LogisticRegression(
        C=0.5,
        max_iter=500,
        random_state=42,
    ))

    # Soft voting ensemble
    ensemble = VotingClassifier(
        estimators=[("gbm", gbm), ("lr", lr)],
        voting="soft",
        weights=[0.7, 0.3],
    )

    # Wrap with isotonic calibration
    calibrated = CalibratedClassifierCV(ensemble, cv=5, method="isotonic")

    # -- Time-series CV -------------------------------------------------------

    tscv = TimeSeriesSplit(n_splits=5)
    cv_aucs, cv_briers, cv_accs, cv_losses = [], [], [], []

    print("\n   >> Time-series cross-validation:")
    for fold, (tr, te) in enumerate(tscv.split(X)):
        Xtr, Xte = X[tr], X[te]
        ytr, yte = y[tr], y[te]

        calibrated.fit(Xtr, ytr)
        probs = calibrated.predict_proba(Xte)[:, 1]
        preds = (probs >= 0.5).astype(int)

        auc   = roc_auc_score(yte, probs)
        brier = brier_score_loss(yte, probs)
        acc   = accuracy_score(yte, preds)
        ll    = log_loss(yte, probs)

        cv_aucs.append(auc)
        cv_briers.append(brier)
        cv_accs.append(acc)
        cv_losses.append(ll)

        yr_range = f"{years[te[0]]}-{years[te[-1]]}"
        print(f"   Fold {fold+1} ({yr_range}): "
              f"AUC={auc:.3f}  Brier={brier:.3f}  "
              f"Acc={acc:.3f}  LogLoss={ll:.3f}")

    print(f"\n   Mean AUC:      {np.mean(cv_aucs):.3f} +/- {np.std(cv_aucs):.3f}")
    print(f"   Mean Accuracy: {np.mean(cv_accs):.3f} +/- {np.std(cv_accs):.3f}")
    print(f"   Mean Brier:    {np.mean(cv_briers):.3f} +/- {np.std(cv_briers):.3f}")
    print(f"   Mean LogLoss:  {np.mean(cv_losses):.3f} +/- {np.std(cv_losses):.3f}")

    # -- Final model on all data ----------------------------------------------
    print("\n   -> Training final model on full dataset...")
    calibrated.fit(X, y)

    # Feature importances from GBM component
    try:
        gbm_pipe = calibrated.estimator.estimators_[0][1]
        gbm_model = gbm_pipe.named_steps["model"]
        importances = gbm_model.feature_importances_
        feat_imp = sorted(zip(feature_cols, importances), key=lambda x: -x[1])

        print("\n   ? Top 25 features (GBM importance):")
        for feat, imp in feat_imp[:25]:
            bar = "?" * int(imp * 400)
            print(f"   {feat:<45} {imp:.4f}  {bar}")
    except Exception:
        pass

    return calibrated, feature_cols, {
        "cv_auc_mean":    float(np.mean(cv_aucs)),
        "cv_acc_mean":    float(np.mean(cv_accs)),
        "cv_brier_mean":  float(np.mean(cv_briers)),
        "cv_logloss_mean":float(np.mean(cv_losses)),
    }


def train_run_total_model(df, feature_cols):
    """
    Separate regression model to predict total runs (over/under).
    Uses Ridge regression on same feature set.
    """
    print("\n" + "="*60)
    print("  TRAINING RUN TOTAL MODEL")
    print("="*60)

    has_runs = df["total_runs"].notna().sum()
    if has_runs < 100:
        print("   [WARN]  Not enough run total data. Skipping.")
        return None

    df_runs = df[df["total_runs"].notna()].copy()
    X = df_runs[feature_cols].values.astype(float)
    y = df_runs["total_runs"].values.astype(float)
    years = df_runs["year"].values

    order = np.argsort(years, kind="stable")
    X, y, years = X[order], y[order], years[order]

    model = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler",  StandardScaler()),
        ("model",   Ridge(alpha=10.0)),
    ])

    tscv = TimeSeriesSplit(n_splits=4)
    maes = []

    print("\n   >> Run total cross-validation:")
    for fold, (tr, te) in enumerate(tscv.split(X)):
        model.fit(X[tr], y[tr])
        preds = model.predict(X[te])
        mae = mean_absolute_error(y[te], preds)
        maes.append(mae)
        print(f"   Fold {fold+1}: MAE = {mae:.2f} runs")

    print(f"\n   Mean MAE: {np.mean(maes):.2f} runs")
    model.fit(X, y)
    return model


# -----------------------------------------------------------------------------
# Predict today
# -----------------------------------------------------------------------------

def build_today_row(conn, matchup, feature_cols, elo_history):
    """Build feature row for one of today's matchups."""
    home   = matchup["home_team"]
    away   = matchup["away_team"] or home
    date   = matchup["game_date"]
    season = matchup["season"] or datetime.now().year

    feats = {"is_day": 0, "park_is_dome": 0}

    # Elo
    home_elo = elo_history.get((home, date), 1500)
    away_elo = elo_history.get((away, date), 1500)
    feats["home_elo"]         = home_elo
    feats["away_elo"]         = away_elo
    feats["elo_diff"]         = home_elo - away_elo
    feats["elo_home_win_exp"] = 1 / (1 + 10**((away_elo - home_elo - 35) / 400))

    # Team records
    feats.update(get_team_record(conn, home, date, season, "home"))
    feats.update(get_team_record(conn, away, date, season, "away"))
    hw = feats.get("home_pythag_wpct", 0.5)
    aw = feats.get("away_pythag_wpct", 0.5)
    feats["pythag_diff"] = hw - aw

    # Recent form
    feats.update(get_recent_form(conn, home, season, "home"))
    feats.update(get_recent_form(conn, away, season, "away"))

    # Pitchers from daily_lineups
    home_sp = q1(conn, """
        SELECT DISTINCT pitcher_mlb_id, pitcher_name, pitcher_handedness
        FROM daily_lineups WHERE team = ? AND game_date = ?
          AND pitcher_mlb_id IS NOT NULL
    """, (home, date))

    away_sp = q1(conn, """
        SELECT DISTINCT pitcher_mlb_id, pitcher_name, pitcher_handedness
        FROM daily_lineups WHERE team = ? AND game_date = ?
          AND pitcher_mlb_id IS NOT NULL
    """, (away, date))

    home_sp_hand = home_sp["pitcher_handedness"] if home_sp else None
    away_sp_hand = away_sp["pitcher_handedness"] if away_sp else None

    if away_sp:
        feats.update(get_pitcher_features(
            conn, None, away_sp["pitcher_mlb_id"], season, "home_sp"))
    if home_sp:
        feats.update(get_pitcher_features(
            conn, None, home_sp["pitcher_mlb_id"], season, "away_sp"))

    home_era = feats.get("home_sp_era")
    away_era = feats.get("away_sp_era")
    if home_era and away_era:
        feats["sp_era_diff"] = away_era - home_era

    # Lineups with platoon splits
    feats.update(get_lineup_features(conn, home, date, season, away_sp_hand, "home_off"))
    feats.update(get_lineup_features(conn, away, date, season, home_sp_hand, "away_off"))

    # Park/weather
    feats.update(get_park_features(conn, matchup.get("park_id"), season))
    feats.update(get_weather_features(conn, matchup.get("park_id"), date))

    # Rest/travel
    feats.update(get_rest_travel(conn, home, date, "home"))
    feats.update(get_rest_travel(conn, away, date, "away"))

    return {col: feats.get(col, np.nan) for col in feature_cols}


def predict_today(winner_model, run_model, feature_cols, elo_history):
    """Score today's matchups."""
    print("\n" + "="*60)
    print("  TODAY'S PREDICTIONS")
    print("="*60)

    conn = get_db()

    today = datetime.now().strftime("%Y-%m-%d")

    # Check if opponent column exists (old schema may not have it)
    has_opponent = False
    try:
        conn.execute("SELECT opponent FROM daily_lineups LIMIT 1")
        has_opponent = True
    except Exception:
        pass

    def fetch_matchups(date):
        if has_opponent:
            return q(conn, """
                SELECT DISTINCT team as home_team, opponent as away_team,
                       game_date, season,
                       pitcher_mlb_id, pitcher_name, pitcher_handedness
                FROM daily_lineups
                WHERE game_date = ? AND batting_order > 0
                  AND opponent IS NOT NULL AND opponent != team
            """, (date,))
        else:
            # Old schema: no opponent column - derive matchups from teams
            # that share the same game_date (they must be playing each other)
            teams = q(conn, """
                SELECT DISTINCT team, game_date, season
                FROM daily_lineups
                WHERE game_date = ? AND batting_order > 0
            """, (date,))
            # Build matchup pairs from shared dates - every 2 teams on same date
            # are opponents (assumes complete lineups loaded)
            seen_teams = {}
            pairs = []
            for t in teams:
                # Each team's first appearance on a date is paired with another
                seen_teams[t["team"]] = t
            team_list = list(seen_teams.keys())
            # Return as pseudo-matchup rows without away_team info
            return [{"home_team": t, "away_team": None,
                     "game_date": seen_teams[t]["game_date"],
                     "season": seen_teams[t]["season"],
                     "pitcher_mlb_id": None, "pitcher_name": None,
                     "pitcher_handedness": None}
                    for t in team_list]

    matchups = fetch_matchups(today)

    if not matchups:
        latest = q1(conn, "SELECT MAX(game_date) as d FROM daily_lineups WHERE batting_order>0")
        if latest and latest["d"]:
            matchups = fetch_matchups(latest["d"])
            print(f"   (Using {latest['d']} - no data for today)")

    if not matchups:
        print("   [ERROR] No lineup data. Run importDailyLineups.js first.")
        conn.close()
        return

    date = matchups[0]["game_date"]
    print(f"\n   Date: {date}\n")

    # Deduplicate using UNORDERED pair - prevents ATH@HOU and HOU@ATH both showing
    seen, unique = set(), []
    for m in matchups:
        home = m["home_team"]
        away = m["away_team"] if "away_team" in m.keys() and m["away_team"] else ""
        key  = frozenset([home, away])   # frozenset is order-independent
        if key not in seen:
            seen.add(key)
            unique.append(m)

    results = []
    for m in unique:
        home = m["home_team"]
        away = m["away_team"]
        try:
            row  = build_today_row(conn, m, feature_cols, elo_history)
            X    = np.array([[row[c] for c in feature_cols]], dtype=float)
            prob = winner_model.predict_proba(X)[0][1]

            run_total = None
            if run_model:
                run_total = run_model.predict(X)[0]

            results.append({
                "home": home, "away": away,
                "home_prob": prob, "away_prob": 1 - prob,
                "run_total": run_total,
                "conf": max(prob, 1 - prob),
                "pick": home if prob >= 0.5 else away,
            })
        except Exception as e:
            results.append({"home": home, "away": away, "error": str(e)})

    conn.close()

    results.sort(key=lambda x: -(x.get("conf") or 0))

    print(f"   {'MATCHUP':<22} {'HOME%':>7} {'AWAY%':>7} "
          f"{'PICK':<8} {'CONF':>6} {'PROJ TOTAL':>11}")
    print("   " + "-"*65)

    for r in results:
        if "error" in r:
            print(f"   {r['away']} @ {r['home']:22}  [WARN]  {r['error'][:40]}")
            continue

        matchup = f"{r['away']} @ {r['home']}"
        mark    = "<" if r["pick"] == r["home"] else ">"
        total   = f"{r['run_total']:.1f}" if r.get("run_total") else "  N/A"

        print(f"   {matchup:<22} {r['home_prob']*100:>6.1f}% "
              f"{r['away_prob']*100:>6.1f}% "
              f"{r['pick']:<8} {mark}  "
              f"{r['conf']*100:>5.1f}%  {total:>7}")

    print()


# -----------------------------------------------------------------------------
# Data check
# -----------------------------------------------------------------------------

def check_readiness():
    print("\n" + "="*60)
    print("  DATA READINESS")
    print("="*60 + "\n")

    conn = get_db()

    checks = [
        ("game_results",          tbl(conn,"game_results"),
         "node importGameResults.js"),
        ("team_records",          tbl(conn,"team_records"),
         "node importGameResults.js (auto-built)"),
        ("hitter_recent_stats",   tbl(conn,"hitter_recent_stats"),
         "node importHitterRecentStats.js"),
        ("savant_pitcher_stats",  tbl(conn,"savant_pitcher_stats"),
         "node importSavantPitcherStats.js"),
        ("pitcher_pitch_type", tbl(conn,"pitcher_pitch_type"),
         "node importPitcherPitchType.js --all"),
        ("hitter_vs_pitch_type",  tbl(conn,"hitter_vs_pitch_type"),
         "node importHitterVsPitchType.js --all"),
        ("park_factors",          tbl(conn,"park_factors"),
         "node importParkFactors.js"),
        ("game_weather",          tbl(conn,"game_weather"),
         "node importGameWeather.js"),
        ("team_rest_travel",      tbl(conn,"team_rest_travel"),
         "node importParkFactors.js (auto-built)"),
        ("daily_lineups",         tbl(conn,"daily_lineups"),
         "node importDailyLineups.js"),
    ]

    conn.close()
    ready = sum(1 for _, s, _ in checks if s)

    for name, status, fix in checks:
        icon = "[OK]" if status else "[ERROR]"
        print(f"  {icon}  {name}")
        if not status:
            print(f"       ? {fix}")

    print(f"\n  {ready}/{len(checks)} data sources ready")
    if ready < 5:
        print("\n  [WARN]  Minimum for useful model: game_results + savant_pitcher_stats + hitter_recent_stats")

# ============================
# ? ADD THIS FUNCTION (NEW)
# ============================

def add_rolling_team_stats(df):
    df = df.sort_values("game_date")

    # Home win %
    df["home_win_pct"] = (
        df.groupby("home_team")["home_won"]
        .transform(lambda x: x.shift().rolling(20, min_periods=5).mean())
    )

    # Away win %
    df["away_win_pct"] = (
        df.groupby("away_team")["home_won"]
        .transform(lambda x: (1 - x).shift().rolling(20, min_periods=5).mean())
    )

    # Runs scored per game
    df["home_rpg"] = (
        df.groupby("home_team")["total_runs"]
        .transform(lambda x: x.shift().rolling(20, min_periods=5).mean())
    )

    df["away_rpg"] = (
        df.groupby("away_team")["total_runs"]
        .transform(lambda x: x.shift().rolling(20, min_periods=5).mean())
    )

    return df


# ============================
# ? ADD THIS FUNCTION (NEW)
# ============================

def add_feature_diffs(df):
    pairs = [
        ("home_win_pct", "away_win_pct"),
        ("home_rpg", "away_rpg"),
        ("home_sp_era", "away_sp_era"),
        ("home_sp_xwoba", "away_sp_xwoba"),
        ("home_off_w_ops", "away_off_w_ops"),
    ]

    for h, a in pairs:
        if h in df.columns and a in df.columns:
            df[f"{h}_diff"] = df[h] - df[a]

    return df


# ============================
# ? MODIFY build_training_data
# ============================

def build_training_data(elo_history):
    print("\n" + "="*60)
    print("  BUILDING TRAINING DATA")
    print("="*60)

    conn = get_db()

    if not tbl(conn, "game_results"):
        print("[ERROR] game_results is empty.")
        sys.exit(1)

    games = q(conn, """
        SELECT game_date, season, home_team, away_team,
               home_score, away_score, home_won, total_runs,
               park_id, day_night,
               home_sp_retro, home_sp_name,
               away_sp_retro, away_sp_name
        FROM game_results
        WHERE home_won IS NOT NULL
        ORDER BY game_date
    """)

    rows = []
    for g in games:
        home = g["home_team"]
        away = g["away_team"]
        date = g["game_date"]
        season = g["season"]

        feats = {
            "game_date": date,
            "home_team": home,
            "away_team": away,
            "home_won": g["home_won"],
            "total_runs": g["total_runs"],
            "year": season,
        }

        # Elo
        home_elo = elo_history.get((home, date), 1500)
        away_elo = elo_history.get((away, date), 1500)
        feats["elo_diff"] = home_elo - away_elo

        # Pitchers
        feats.update(get_pitcher_features(conn, g["home_sp_retro"], None, season, "home_sp"))
        feats.update(get_pitcher_features(conn, g["away_sp_retro"], None, season, "away_sp"))

        # Lineups
        feats.update(get_lineup_features(conn, home, date, season, None, "home_off"))
        feats.update(get_lineup_features(conn, away, date, season, None, "away_off"))

        rows.append(feats)

    conn.close()

    df = pd.DataFrame(rows)

    # ? NEW: rolling stats (fixes 78% missing)
    df = add_rolling_team_stats(df)

    # ? NEW: feature differences
    df = add_feature_diffs(df)

    print(f"\n   Feature matrix: {df.shape}")

    meta_cols = ["game_date","home_team","away_team","home_won","total_runs","year"]
    feature_cols = [c for c in df.columns if c not in meta_cols]

    return df, feature_cols

# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="MLB Predictor v2")
    p.add_argument("--train",   action="store_true")
    p.add_argument("--predict", action="store_true")
    p.add_argument("--check",   action="store_true")
    args = p.parse_args()

    if not any(vars(args).values()):
        check_readiness()
        return

    if args.check:
        check_readiness()

    winner_model = run_model = None
    feature_cols = None

    conn = get_db()
    print("\n??  Computing Elo ratings...")
    elo_history = compute_elo_ratings(conn)
    conn.close()

    if args.train:
        df, feature_cols = build_training_data(elo_history)
        winner_model, feature_cols, metrics = train_winner_model(df, feature_cols)
        run_model = train_run_total_model(df, feature_cols)

        with open(MODEL_PATH, "wb") as f:
            pickle.dump({
                "winner": winner_model,
                "runs":   run_model,
                "feats":  feature_cols,
            }, f)

        with open(FEATURES_PATH, "w") as f:
            json.dump({
                "feature_cols": feature_cols,
                "trained_at":   datetime.now().isoformat(),
                "n_games":      len(df),
                **metrics,
            }, f, indent=2)

        print(f"\n[OK] Model saved to {MODEL_PATH}")

    if args.predict:
        if winner_model is None:
            if not MODEL_PATH.exists():
                print("[ERROR] No model. Run --train first.")
                sys.exit(1)
            with open(MODEL_PATH, "rb") as f:
                saved = pickle.load(f)
            winner_model = saved["winner"]
            run_model    = saved.get("runs")
            feature_cols = saved["feats"]
            with open(FEATURES_PATH) as f:
                meta = json.load(f)
            print(f"\n   Model: {meta['trained_at'][:10]}")
            print(f"   CV AUC: {meta.get('cv_auc_mean','?')}  "
                  f"Acc: {meta.get('cv_acc_mean','?')}")

        predict_today(winner_model, run_model, feature_cols, elo_history)


if __name__ == "__main__":
    main()